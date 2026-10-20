import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  countSessionLogMentions,
  countSystemPromptChars,
  outputText,
  outputToolNames,
} from "./fixture-utils.js";
import {
  createQaGatewayChildLogAccess,
  createQaGatewayChildLogCollector,
} from "./gateway-child-process.js";
import { QA_TOOL_SEARCH_SECONDARY_TARGET as secondaryTarget } from "./providers/mock-openai/mock-openai-tooling.js";
import {
  qaMockRequestCursorUrl as cursorUrl,
  qaMockRequestsAfterUrl as requestsAfterUrl,
  readQaMockRequestCursor as readCursor,
} from "./providers/shared/debug-request-cursor.js";
import { runQaSuiteScenarioSteps } from "./suite-runtime-flow.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";
import {
  assertToolSearchBatchLaneResult,
  assertToolSearchLaneResults,
  readToolSearchGatewayFetchLimits as readFetchLimits,
  runToolSearchGatewayLane,
} from "./tool-search-gateway.fixture.js";

afterEach(vi.unstubAllGlobals);

const targetTool = "fake_plugin_tool_17";
const targetToolIdentity = { source: "plugin", pluginId: "tool-search-e2e-fixture" };

describe("tool search gateway fetch configuration", () => {
  it("builds and validates mock request cursor reads", () => {
    const baseUrl = "http://mock.test/";
    expect(readCursor({ cursor: 42 })).toBe(42);
    expect(cursorUrl(baseUrl)).toBe("http://mock.test/debug/request-cursor");
    expect(requestsAfterUrl(baseUrl, 42)).toBe("http://mock.test/debug/requests?after=42");
    for (const invalid of [{ cursor: -1 }, []]) {
      expect(() => readCursor(invalid)).toThrow(
        "mock provider request cursor response was invalid",
      );
    }
  });

  it("rejects loose numeric env limits instead of parsing prefixes", () => {
    for (const [option, value] of [
      ["TIMEOUT_MS", "1e3"],
      ["BODY_MAX_BYTES", "1000ms"],
    ]) {
      const name = `OPENCLAW_TOOL_SEARCH_GATEWAY_E2E_FETCH_${option}`;
      expect(() => readFetchLimits({ [name]: value })).toThrow(`invalid ${name}: ${value}`);
    }
    expect(
      readFetchLimits({
        OPENCLAW_TOOL_SEARCH_GATEWAY_E2E_FETCH_BODY_MAX_BYTES: "4096",
        OPENCLAW_TOOL_SEARCH_GATEWAY_E2E_FETCH_TIMEOUT_MS: "5000",
      }),
    ).toEqual({ bodyMaxBytes: 4096, timeoutMs: 5_000 });
  });
});

it("counts target mentions from zstd SQLite transcript rows", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tool-search-sqlite-"));
  const sqlitePath = path.join(stateDir, "agents", "qa", "agent", "openclaw-agent.sqlite");
  await fs.mkdir(path.dirname(sqlitePath), { recursive: true });
  const db = new DatabaseSync(sqlitePath);
  try {
    db.exec(`
        CREATE TABLE transcript_events (
          session_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          event_json TEXT,
          event_zstd BLOB,
          event_utf8_bytes INTEGER
        );
      `);
    const insert = db.prepare(
      "INSERT INTO transcript_events (session_id, seq, event_zstd, event_utf8_bytes) VALUES (?, ?, ?, ?)",
    );
    const messages = [
      { role: "user", content: "tool search qa check target=fake_plugin_tool_17" },
      {
        role: "assistant",
        content: 'FAKE_PLUGIN_OK fake_plugin_tool_17 via dispatch_action quoted_call("alpha")',
      },
      {
        role: "toolResult",
        toolName: "fake_plugin_tool_17",
        content: [{ type: "text", text: "FAKE_PLUGIN_OK" }],
      },
    ];
    for (const [index, message] of messages.entries()) {
      const bytes = Buffer.from(JSON.stringify({ message }), "utf8");
      insert.run("sqlite-session", index + 1, zstdCompressSync(bytes), bytes.byteLength);
    }
    await expect(
      countSessionLogMentions({
        sessionsDir: path.join(stateDir, "agents", "qa", "sessions"),
        needles: {
          fake_plugin_tool_17: "fake_plugin_tool_17",
          quoted_call: 'quoted_call("alpha")',
          dispatch_action: "dispatch_action",
        },
      }),
    ).resolves.toEqual({ fake_plugin_tool_17: 2, quoted_call: 1, dispatch_action: 1 });
  } finally {
    db.close();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

describe("tool search gateway e2e lane result", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
  });
  const jsonResponse = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      ...init,
    });

  async function createLaneHarness(logs?: () => string) {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tool-search-lane-"));
    roots.push(tempRoot);
    const configPath = path.join(tempRoot, "openclaw.json");
    await fs.writeFile(configPath, "{}\n", "utf8");
    const gatewayCall = vi.fn(async () => ({
      groups: [{ tools: [{ id: "fake_plugin_tool_17", ...targetToolIdentity }] }],
    }));
    const env: QaSuiteRuntimeEnv = {
      alternateModel: "openai/gpt-5.6-luna",
      cfg: {},
      gateway: {
        baseUrl: "http://gateway.test",
        call: gatewayCall,
        logs,
        restartAfterStateMutation: (mutateState) =>
          mutateState({
            configPath,
            runtimeEnv: {},
            stateDir: path.join(tempRoot, "state"),
            tempRoot,
          }),
        runtimeEnv: { OPENCLAW_GATEWAY_TOKEN: "test-token" },
        tempRoot,
        workspaceDir: tempRoot,
      },
      mock: { baseUrl: "http://mock-openai.test" },
      outputDir: path.join(tempRoot, "output"),
      primaryModel: "openai/gpt-5.6-luna",
      providerMode: "mock-openai",
      repoRoot: tempRoot,
      transport: {} as QaSuiteRuntimeEnv["transport"],
    };
    const runLane = () =>
      runToolSearchGatewayLane({
        env,
        fixture: { fakePluginDir: tempRoot, targetTool },
        lane: "tools",
      });
    return { configPath, env, gatewayCall, tempRoot, runLane };
  }

  it("preserves wire-stage evidence and surrogate pairs in provider request snippets", async () => {
    const { configPath, gatewayCall, runLane } = await createLaneHarness();
    const inputPrefix = "i".repeat(499);
    const searchOutput = '{"results":[{"query":"first"}]}';
    const toolOutput = `${"o".repeat(3_999)}😀tail`;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ cursor: 0 }))
      .mockResolvedValueOnce(jsonResponse({ output: [], status: "completed" }))
      .mockResolvedValueOnce(
        jsonResponse([
          { plannedToolName: "tool_search" },
          {
            plannedToolName: targetTool,
            plannedWireToolName: "dispatch_action",
            toolOutput: searchOutput,
          },
          {
            allInputText: `${inputPrefix}😀tail\n### Deferred Tool Schemas\n- fake_plugin_tool_17: Fake plugin target`,
            body: { tools: [] },
            raw: "{}",
            toolOutput,
          },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await runLane();

    expect(result).toMatchObject({
      providerInputSnippet: inputPrefix,
      providerToolOutputSnippet: `${searchOutput}\n${"o".repeat(4_000 - searchOutput.length - 1)}`,
      providerDirectoryContainsTarget: true,
    });
    expect(result.providerPlannedTools).toEqual(["tool_search", "dispatch_action"]);
    expect(result.providerToolSearchResult).toEqual(JSON.parse(searchOutput));
    expect(result.targetToolIdentity).toEqual(targetToolIdentity);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(gatewayCall).toHaveBeenCalledWith(
      "tools.effective",
      { sessionKey: "tool-search-gateway-tools" },
      { timeoutMs: expect.any(Number) },
    );
    const laneConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      memory?: { search?: Record<string, unknown> };
    };
    expect(laneConfig.memory?.search).toMatchObject({ enabled: false });
    expect(laneConfig.memory?.search).not.toHaveProperty("sync");
  });

  it.each(["retained", "rolled", "unavailable"] as const)(
    "renders safe failure evidence with %s gateway logs",
    async (logMode) => {
      const gatewaySecret = "gateway-secret-value";
      const responseSecret = "raw-response-secret";
      const promptSecret = "raw-prompt-secret";
      const toolOutputSecret = "raw-tool-output-secret";
      const logs = createQaGatewayChildLogCollector();
      logs.push("stdout", Buffer.from("before-request-log tool_describe\n"));
      const { env, tempRoot, runLane } = await createLaneHarness(() => logs.text());
      if (logMode !== "unavailable") {
        Object.assign(env.gateway, createQaGatewayChildLogAccess(logs));
      }
      const sessionsDir = path.join(tempRoot, "state", "agents", "qa", "sessions");
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith("/debug/request-cursor")) {
          return jsonResponse({ cursor: 0 });
        }
        if (url.endsWith("/v1/responses")) {
          logs.push(
            "stdout",
            Buffer.from(
              `${logMode === "rolled" ? "old-log-line\n".repeat(6_000) : ""}OPENAI_API_KEY=${gatewaySecret}\n${promptSecret}\n${toolOutputSecret}\ndispatch_action\nfake_plugin_tool_17-variant\n`,
            ),
          );
          await fs.mkdir(sessionsDir, { recursive: true });
          await fs.writeFile(
            path.join(sessionsDir, "failed.jsonl"),
            '{"message":{"role":"assistant","content":"dispatch_action tool_describe fake_plugin_tool_17-variant"}}\n',
            "utf8",
          );
          return jsonResponse({ error: { message: responseSecret } }, { status: 502 });
        }
        if (url.includes("/debug/requests?after=0")) {
          return jsonResponse([
            {
              body: { tools: [{ type: "function", name: "dispatch_action" }] },
              plannedToolName: "dispatch_action",
              raw: responseSecret,
              prompt: promptSecret,
              toolOutput: `${toolOutputSecret} FAKE_PLUGIN_OK fake_plugin_tool_17`,
            },
          ]);
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const scenario = await runQaSuiteScenarioSteps("Tool Search failure evidence", [
        {
          name: "runs the compact lane",
          run: async () => {
            await runLane();
          },
        },
      ]);

      expect(scenario.status).toBe("fail");
      const renderedError = scenario.details ?? "";
      for (const evidence of [
        "Tool Search tools lane gateway request failed (HTTP 502)",
        'providerRequests=[{"plannedToolName":"dispatch_action","declaredToolCount":1,"targetDeclared":false,"targetResultObserved":true}]',
        'sessionMentions={"tool_search":0,"tool_describe":1,"dispatch_action":1,"fake_plugin_tool_17":0}',
        `gatewayLogFacts={"captured":${logMode !== "unavailable"},"mentions":{"tool_search":false,"tool_describe":false,"dispatch_action":${logMode !== "unavailable"},"fake_plugin_tool_17":false}}`,
      ]) {
        expect(renderedError).toContain(evidence);
      }
      for (const secret of [gatewaySecret, responseSecret, promptSecret, toolOutputSecret]) {
        expect(renderedError).not.toContain(secret);
      }
      expect(renderedError.length).toBeLessThan(6_000);
    },
  );
});

it("reads Responses API text, function call names, and prompt sizing", () => {
  const payload = {
    output: [
      { type: "function_call", name: "fake_plugin_tool_17" },
      { type: "message", content: [{ text: "alpha" }, { text: "beta" }] },
    ],
  };

  expect(outputToolNames(payload)).toEqual(["fake_plugin_tool_17"]);
  expect(outputText(payload)).toBe("alpha\nbeta");
  expect(
    countSystemPromptChars({
      instructions: "abc",
      input: [
        { role: "system", content: [{ type: "input_text", text: "def" }] },
        { role: "developer", content: "ghi" },
        { role: "user", content: [{ type: "input_text", text: "ignored" }] },
      ],
    }),
  ).toBe(9);
});

describe("tool search gateway e2e lane assertions", () => {
  const normal = {
    gatewayOutputText: `FAKE_PLUGIN_OK ${targetTool}`,
    providerDeclaredToolCount: 36,
    providerDirectoryContainsTarget: false,
    providerPlannedTools: [targetTool],
    providerRawBytes: 12_000,
    sessionLogToolMentions: { [targetTool]: 1 },
    targetToolIdentity,
  };

  const groupedSearchResult = {
    results: [
      { query: targetTool, candidates: [{ name: targetTool }] },
      { query: secondaryTarget, candidates: [{ name: secondaryTarget }] },
    ],
  };
  const tools: Parameters<typeof assertToolSearchBatchLaneResult>[0]["tools"] = {
    ...normal,
    providerDirectoryContainsTarget: true,
    providerRawBytes: 4_000,
    status: "completed",
    providerToolCallResult: {
      tool: { name: targetTool },
      result: { details: { status: "ok", tool: targetTool } },
    },
    providerToolOutputSnippet: JSON.stringify(groupedSearchResult),
    providerDeclaredToolCount: 3,
    providerDeclaredToolNames: ["tool_search", "tool_describe", "dispatch_action"],
    providerPlannedTools: ["tool_search", "dispatch_action"],
    providerToolSearchResult: groupedSearchResult,
    sessionLogToolMentions: { tool_search: 1, dispatch_action: 1, [targetTool]: 1 },
  };
  const assertBatch = (overrides: Partial<typeof tools> = {}) =>
    assertToolSearchBatchLaneResult({ targetTool, tools: { ...tools, ...overrides } });

  it("accepts structured lane proof only when the target plugin tool output is present", () => {
    expect(() => assertToolSearchLaneResults({ normal, targetTool, tools })).not.toThrow();
  });

  it("accepts one structured batch search followed by one catalog call", () => {
    expect(() => assertBatch()).not.toThrow();
  });

  it("rejects structured proof that reuses the first query candidate for the second group", () => {
    const result = {
      results: [
        { query: targetTool, candidates: [{ name: targetTool }] },
        { query: secondaryTarget, candidates: [{ name: targetTool }] },
      ],
    };
    expect(() =>
      assertBatch({
        providerToolOutputSnippet: JSON.stringify(result),
        providerToolSearchResult: result,
      }),
    ).toThrow("did not return both grouped search results");
  });

  it("rejects structured proof without a typed target tool result", () => {
    expect(() =>
      assertBatch({
        providerToolCallResult: undefined,
        sessionLogToolMentions: { tool_search: 1, dispatch_action: 1, [targetTool]: 2 },
      }),
    ).toThrow(`structured lane did not call ${targetTool}`);
  });

  it("preserves surrogate pairs in both lane debug output snippets", () => {
    const outputPrefix = `FAKE_PLUGIN_OK ${targetTool} `;
    const normalOutput = `${outputPrefix}${"n".repeat(299 - outputPrefix.length)}`;
    const toolsOutput = `${outputPrefix}${"c".repeat(299 - outputPrefix.length)}`;
    const withOutput = (lane: typeof normal | typeof tools, output: string) => ({
      ...lane,
      gatewayOutputText: `${output}😀tail`,
    });
    const assertInvalidLaneResults = () =>
      assertToolSearchLaneResults({
        targetTool,
        normal: withOutput(normal, normalOutput),
        tools: {
          ...withOutput(tools, toolsOutput),
          providerPlannedTools: ["dispatch_action", targetTool],
        },
      });

    expect(assertInvalidLaneResults).toThrow(`"output": "${normalOutput}"`);
    expect(assertInvalidLaneResults).toThrow(`"output": "${toolsOutput}"`);
  });
});
