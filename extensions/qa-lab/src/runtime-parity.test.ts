import { createServer } from "node:http";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { stableHash } from "./parity-shared.js";
import type { RuntimeId } from "./runtime-id.js";
import {
  captureRuntimeParityCell,
  isRuntimeParityResultPass,
  resolveRuntimeParityUsagePolicy,
  runRuntimeParityScenario,
  type RuntimeParityCell,
  type RuntimeParityScenarioExecution,
  type RuntimeParityToolCall,
} from "./runtime-parity.js";
import { createRuntimeParityTranscriptHarness } from "./runtime-parity.test-helper.js";

const { seedRuntimeParityTranscript: seedTranscript, cleanup } =
  createRuntimeParityTranscriptHarness();
const PARENT_PROMPT = "Delegate one bounded QA task to a subagent.";
type CellOutcome = Partial<Pick<RuntimeParityScenarioExecution, "status" | "details">> &
  Partial<RuntimeParityCell>;
type CaptureParams = Parameters<typeof captureRuntimeParityCell>[0];

function runPair(codex: CellOutcome = {}, openclaw: CellOutcome = {}) {
  return runRuntimeParityScenario({
    scenarioId: "outcome-fixture",
    runCell: async (runtime) => {
      const { status = "pass", details, ...cell } = runtime === "codex" ? codex : openclaw;
      return {
        status,
        details,
        cell: { ...makeRuntimeParityCell(runtime), ...cell, runtime },
      };
    },
  });
}

function seedRuntimeParityTranscript(
  params: Omit<Parameters<typeof seedTranscript>[0], "sessionId" | "sessionKey"> & {
    sessionId?: string;
    sessionKey?: string;
  },
) {
  const sessionId = params.sessionId ?? "runtime-parity";
  return seedTranscript({
    ...params,
    sessionId,
    sessionKey: params.sessionKey ?? `agent:qa:${sessionId}`,
  });
}

function captureCell(
  runtime: RuntimeId,
  tempRoot: string,
  params: Partial<Omit<CaptureParams, "runtime" | "gateway" | "wallClockMs">> = {},
) {
  return captureRuntimeParityCell({
    runtime,
    gateway: { tempRoot },
    scenarioResult: { status: "pass" },
    wallClockMs: 10,
    ...params,
  });
}
function assistant(...content: unknown[]) {
  return { role: "assistant", content };
}
function user(content: unknown) {
  return { role: "user", content };
}
function toolResult(toolName: string, text: string, toolCallId?: string) {
  return {
    role: "toolResult",
    toolName,
    content: [{ type: "text", text }],
    ...(toolCallId === undefined ? {} : { toolCallId }),
  };
}
function makeToolCall(id: string, name: string, args: Record<string, unknown>) {
  return { type: "toolCall", id, name, arguments: args };
}
function callEvent(toolCallId: string, name: string, args: Record<string, unknown>) {
  return { type: "tool.call", data: { toolCallId, name, arguments: args } };
}
function resultEvent(toolCallId: string, name: string, result: Record<string, unknown>) {
  return { type: "tool.result", data: { toolCallId, name, ...result } };
}
function searchEvents(
  id: string,
  query: string,
  result: Record<string, unknown> = { status: "completed" },
) {
  return [
    callEvent(id, "web_search", { query }),
    resultEvent(id, "web_search", { ...result, result: { status: "completed", query } }),
  ];
}

afterEach(async () => {
  vi.unstubAllGlobals();
  // Join worker cleanup before removing its databases. Agent lease release can reopen
  // shared state, so drain agent resources first and shared state second.
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  await cleanup();
});

async function captureMock(params: {
  messages?: Array<Record<string, unknown>>;
  requests: Array<Record<string, unknown>>;
  scenarioResult?: CaptureParams["scenarioResult"];
}) {
  const tempRoot = await seedRuntimeParityTranscript({
    messages: params.messages ?? [user(PARENT_PROMPT)],
  });
  const requests = params.requests.map((request) => ({
    prompt: PARENT_PROMPT,
    allInputText: PARENT_PROMPT,
    ...request,
  }));
  const server = createServer((request, response) => {
    if (request.url !== "/debug/requests") {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(requests));
  });
  const port = await listenOnLoopback(server);
  try {
    return await captureCell("openclaw", tempRoot, {
      mockBaseUrl: `http://127.0.0.1:${port}`,
      scenarioResult: params.scenarioResult ?? { status: "pass" },
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function makeRuntimeParityCell(
  runtime: RuntimeId,
  toolCalls: RuntimeParityToolCall[] = [],
): RuntimeParityCell {
  return {
    runtime,
    transcriptBytes: '{"message":{"role":"assistant","content":"done"}}\n',
    toolCalls,
    finalText: "done",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    wallClockMs: 10,
    bootStateLines: [],
  };
}

describe("runtime parity", () => {
  it("cancels a failed mock-request response before falling back to transcript calls", async () => {
    const tempRoot = await seedRuntimeParityTranscript({
      messages: [user(PARENT_PROMPT)],
    });
    const cancel = vi.fn(() => {
      throw new Error("cancel failed");
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 503 })),
    );

    const cell = await captureCell("openclaw", tempRoot, { mockBaseUrl: "http://127.0.0.1:43123" });

    expect(cancel).toHaveBeenCalledOnce();
    expect(cell.toolCalls).toEqual([]);
  });

  it.each(["toolResult", "tool_result"] as const)(
    "distinguishes successful %s reads containing failure prose from errors",
    async (format) => {
      const results = [
        ["read-happy", { path: "QA_KICKOFF_TASK.md" }, "Track what worked and what failed.", false],
        ["read-typed-error", {}, "Unavailable", true],
        ["read-untyped-error", {}, "ENOENT: missing file", undefined],
        ...(format === "tool_result"
          ? [["read-error-block", {}, "Unavailable", false] as const]
          : []),
      ] as const;
      const tempRoot = await seedRuntimeParityTranscript({
        messages: results.flatMap(([id, args, text, isError]) => [
          assistant(makeToolCall(id, "read", args)),
          format === "toolResult"
            ? {
                ...toolResult("read", text, id),
                ...(isError === undefined ? {} : { isError }),
              }
            : user([
                {
                  type: id === "read-error-block" ? "tool_result_error" : "tool_result",
                  tool_use_id: id,
                  content: [{ type: "text", text }],
                  ...(isError === undefined ? {} : { is_error: isError }),
                },
              ]),
        ]),
      });
      const openclaw = await captureCell("openclaw", tempRoot);
      expect(openclaw.toolCalls.map((call) => call.errorClass)).toEqual([
        undefined,
        ...results.slice(1).map(() => "tool-result-error"),
      ]);
    },
  );

  it("captures SQLite transcript text and merges trajectory-only calls without duplicates", async () => {
    const tempRoot = await seedRuntimeParityTranscript({
      messages: [
        user([{ type: "text", text: "Read, run, search, and generate." }]),
        assistant(makeToolCall("call-image-1", "image_generate", { prompt: "QA lighthouse" })),
        toolResult("image_generate", "Image generation started", "call-image-1"),
        assistant(
          makeToolCall("read-1", "read", { path: "README.md" }),
          makeToolCall("exec-1", "exec", { command: "pwd" }),
        ),
        toolResult("read", "README contents", "read-1"),
        assistant({ type: "toolCall", name: "web_search", arguments: { query: "same marker" } }),
        toolResult("web_search", "result A"),
        assistant(
          "  plain  ",
          { type: "output_text", content: "nested" },
          { type: "message", content: "message" },
          { type: "unknown", text: " priority ", content: "ignored" },
          { type: "toolResult", content: "ignored tool result" },
          { type: "Output_Text", content: "ignored normalized type" },
        ),
      ],
      trajectoryEvents: [
        resultEvent("exec-1", "exec", {
          success: true,
          contentItems: [{ type: "text", text: "/workspace" }],
        }),
        ...searchEvents("search-b", "same marker"),
      ],
    });

    const cell = await captureCell("codex", tempRoot);

    expect(cell.finalText).toBe("plain nested message priority");
    expect(cell.toolCalls.map((toolCall) => toolCall.tool)).toEqual([
      "image_generate",
      "read",
      "exec",
      "web_search",
      "web_search",
    ]);
    expect(cell.toolCalls[0]?.errorClass).toBeUndefined();
    expect(cell.toolCalls[1]?.errorClass).toBeUndefined();
    expect(cell.toolCalls[2]?.errorClass).toBeUndefined();
    expect(cell.toolCalls[2]?.argsHash).toBe(stableHash({ command: "pwd" }));
    expect(cell.toolCalls[3]?.argsHash).toBe(cell.toolCalls[4]?.argsHash);
  });

  it("selects fixture-owned root evidence without newer heartbeat or unrelated sessions", async () => {
    const now = Date.now();
    const prefix = "agent:qa:runtime-tool:session_status";
    const tempRoot = await seedRuntimeParityTranscript({
      sessionId: "session-status-happy",
      sessionKey: `${prefix}:happy`,
      messages: [user("tool search qa check target=session_status")],
      updatedAt: now - 1_000,
      trajectoryEvents: [
        callEvent("session-status-1", "session_status", {}),
        resultEvent("session-status-1", "session_status", {
          status: "completed",
          result: { status: "completed" },
        }),
      ],
    });
    await seedRuntimeParityTranscript({
      tempRoot,
      sessionId: "heartbeat-session",
      sessionKey: "agent:qa:main:heartbeat",
      heartbeatIsolatedBaseSessionKey: "agent:qa:main",
      messages: [],
      updatedAt: now,
      trajectoryEvents: searchEvents("heartbeat-1", "heartbeat background search", {
        success: true,
      }),
    });
    const unfiltered = await captureCell("codex", tempRoot);
    expect(unfiltered.toolCalls).toEqual([
      expect.objectContaining({ tool: "session_status", argsHash: stableHash({}) }),
    ]);
    expect(unfiltered.toolCalls[0]?.errorClass).toBeUndefined();
    await seedRuntimeParityTranscript({
      tempRoot,
      sessionId: "session-status-failure",
      sessionKey: `${prefix}:failure`,
      messages: [user("tool search qa failure target=session_status")],
      updatedAt: now,
    });
    await seedRuntimeParityTranscript({
      tempRoot,
      sessionId: "unrelated-newer-root",
      sessionKey: "agent:qa:unrelated-newer-root",
      messages: [user("Unrelated setup.")],
      updatedAt: now + 1_000,
    });

    const cell = await captureCell("codex", tempRoot, {
      scenarioResult: {
        status: "pass",
        steps: [
          {
            status: "pass",
            details: ["happy", "failure"]
              .map((suffix) => `RUNTIME_PARITY_SESSION_KEY=${prefix}:${suffix}`)
              .join("\n"),
          },
        ],
      },
    });

    expect(cell.transcriptBytes).toContain("failure target=session_status");
    expect(cell.transcriptBytes).not.toContain("Unrelated setup.");
    expect(cell.toolCalls).toEqual([expect.objectContaining({ tool: "session_status" })]);

    const missingCell = await captureCell("codex", tempRoot, {
      scenarioResult: {
        status: "fail",
        details: "RUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:missing:happy",
      },
    });
    expect(missingCell.transcriptBytes).toBe("");
    expect(missingCell.toolCalls).toEqual([]);
  });

  it.each([
    ["openclaw", "fail", "timed out after 20000ms", "timeout"],
    ["codex", "skip", "expected-unavailable tool: this fixture is report-only", undefined],
  ] as const)("classifies %s/%s diagnostics", async (runtime, status, details, expected) => {
    const cell = await captureCell(
      runtime,
      `/tmp/openclaw-qa-runtime-parity-missing-${process.pid}`,
      { scenarioResult: { status, details } },
    );
    expect(cell.runtimeErrorClass).toBe(expected);
  });

  it.each([
    { name: "object", toolOutput: '{"ok":true}', expected: { ok: true } },
    { name: "array", toolOutput: '[{"ok":true}]', expected: '[{"ok":true}]' },
    { name: "malformed JSON", toolOutput: "not-json", expected: "not-json" },
  ])(
    "records resolved mock calls as provider-plan evidence ($name)",
    async ({ toolOutput, expected }) => {
      const cell = await captureMock({
        requests: [
          { plannedToolName: "read_file", plannedToolArgs: { path: "README.md" } },
          { toolOutput },
        ],
      });

      expect(cell.toolCalls).toEqual([]);
      expect(cell.providerPlanToolCalls).toEqual([
        {
          tool: "read_file",
          argsHash: stableHash({ path: "README.md" }),
          resultHash: stableHash(expected),
        },
      ]);
    },
  );

  it("preserves explicit usage-not-applicable metadata on parity results", async () => {
    const result = await runRuntimeParityScenario({
      scenarioId: "local-fixture",
      runtimeParityUsage: {
        expectation: "not-applicable",
        reason: " Local fixture only; no assistant turn runs. ",
      },
      runCell: async (runtime) => ({ status: "pass", cell: makeRuntimeParityCell(runtime, []) }),
    });
    expect(result.runtimeParityUsage).toEqual({
      expectation: "not-applicable",
      reason: "Local fixture only; no assistant turn runs.",
    });
  });

  it("defaults malformed usage metadata to assistant-message-required", () => {
    for (const reason of [undefined, "   "]) {
      expect(resolveRuntimeParityUsagePolicy({ expectation: "not-applicable", reason })).toEqual({
        expectation: "assistant-message-required",
      });
    }
  });

  it("treats matching controlled tool errors as equivalent results", async () => {
    const tool = { tool: "web_search", argsHash: "same-args", errorClass: "tool-result-error" };
    const result = await runPair(
      { runtimeErrorClass: "tool-error", toolCalls: [{ ...tool, resultHash: "provider-error" }] },
      { toolCalls: [{ ...tool, resultHash: "validation-error" }] },
    );

    expect(result.drift).toBe("none");
    expect(isRuntimeParityResultPass(result)).toBe(true);
  });

  it.each([
    ["pass", "QA-CAPABILITY-1234\nimage_generate=true\nMEDIA:/tmp/qa-image.png", undefined],
    ["pass", "MEDIA:/tmp/unrelated-screenshot.png", "tool-result-missing"],
    ["fail", "image_generate=true\nMEDIA:/tmp/failed-image.png", "tool-result-missing"],
  ] as const)("requires linked image evidence for %s/%s", async (status, details, expected) => {
    const cell = await captureMock({
      requests: [{ plannedToolName: "image_generate", plannedToolArgs: { prompt: "same" } }],
      messages: [
        user("Generate the QA image."),
        assistant(makeToolCall("image-call", "image_generate", { prompt: "same" })),
      ],
      scenarioResult: { status: "pass", steps: [{ status, details }] },
    });
    expect(cell.toolCalls[0]?.errorClass).toBe(expected);
  });

  it("scopes process-global mock requests to the parent session prompt", async () => {
    const child = "Fanout worker alpha: inspect the QA workspace and finish with exactly ALPHA-OK.";
    const followup = "Continue the bounded QA task with the retained child result.";
    const cell = await captureMock({
      messages: [PARENT_PROMPT, followup].map(user),
      requests: [
        {
          prompt: child,
          allInputText: `${PARENT_PROMPT} ${child}`,
          plannedToolName: "read",
        },
        { plannedToolName: "sessions_spawn" },
        {
          prompt: followup,
          allInputText: `${PARENT_PROMPT} ${followup}`,
          plannedToolName: "sessions_spawn",
        },
        {
          prompt: undefined,
          allInputText: "Inspect the QA workspace and return one concise protocol note.",
          plannedToolName: "read",
        },
        {
          allInputText: `${PARENT_PROMPT} Tool result: child accepted.`,
          toolOutput: "child accepted",
        },
      ],
    });

    expect(cell.toolCalls).toEqual([]);
    expect(cell.providerPlanToolCalls?.map(({ tool, errorClass }) => [tool, errorClass])).toEqual([
      ["sessions_spawn", undefined],
      ["sessions_spawn", "tool-result-missing"],
    ]);
  });

  it("copies model-switch evidence into the runtime parity cell", async () => {
    const modelSwitchEvidence = { primary: { runId: "run-1" } };
    const cell = await captureMock({
      requests: [],
      scenarioResult: { status: "pass", modelSwitchEvidence },
    });
    expect(cell.modelSwitchEvidence).toEqual(modelSwitchEvidence);
    expect(cell.providerPlanToolCalls).toEqual([]);
  });
});

describe("runtime parity outcomes", () => {
  const skipped = { status: "skip", details: "implementation unavailable" } as const;
  const knownGap = { status: "skip", details: "known-harness-gap exec: tracked" } as const;
  it.each([
    [{ runtimeErrorClass: "scenario-failure" }, {}, "at least one runtime failed", false],
    [skipped, skipped, "both canonical runtime-pair cells skipped", false],
    [knownGap, {}, "known harness gap in codex runtime; paired runtime passed", true],
    [skipped, {}, "runtime-pair cell status differs (pass vs skip)", false],
    [knownGap, { status: "skip" }, "both canonical runtime-pair cells skipped", false],
    [
      { ...knownGap, runtimeErrorClass: "auth" },
      {},
      "at least one runtime hit a hard runtime failure",
      false,
    ],
  ] as const)("classifies cells %j / %j", async (codex, openclaw, driftDetails, pass) => {
    const result = await runPair(codex, openclaw);
    expect(result).toMatchObject({
      cells: { codex, openclaw: { status: "pass", ...openclaw } },
      drift: pass ? "structural" : "failure-mode",
      driftDetails,
    });
    expect(isRuntimeParityResultPass(result)).toBe(pass);
  });

  it("rejects a missing canonical runtime-pair cell", async () => {
    const result = await runPair();
    expect(
      isRuntimeParityResultPass({
        ...result,
        cells: { openclaw: result.cells.openclaw } as typeof result.cells,
      }),
    ).toBe(false);
  });
});

describe("runtime parity execution order", () => {
  it.each([
    [undefined, false],
    [["codex", "openclaw"], true],
  ] satisfies Array<[[RuntimeId, RuntimeId] | undefined, boolean]>)(
    "runs pair %j (Codex failure: %s) with canonical result cells",
    async (runtimePair, failCodex) => {
      const runCell = vi.fn(async (runtime: RuntimeId) => ({
        status: failCodex && runtime === "codex" ? ("fail" as const) : ("pass" as const),
        ...(failCodex && runtime === "codex" ? { details: "Codex scenario failed" } : {}),
        cell: makeRuntimeParityCell(runtime, [
          { tool: "web_search", argsHash: "same", resultHash: failCodex ? runtime : "same" },
        ]),
      }));
      const result = await runRuntimeParityScenario({
        scenarioId: "runtime-execution-order",
        ...(runtimePair ? { runtimePair } : {}),
        runCell,
      });
      expect(runCell.mock.calls.map(([runtime]) => runtime)).toEqual(
        runtimePair ?? ["openclaw", "codex"],
      );
      expect(result.runtimeParityUsage).toEqual({ expectation: "assistant-message-required" });
      expect(result).toMatchObject({
        cells: {
          openclaw: { runtime: "openclaw", status: "pass" },
          codex: { runtime: "codex", status: failCodex ? "fail" : "pass" },
        },
        drift: failCodex ? "failure-mode" : "none",
      });
      if (failCodex) {
        expect(result.cells.codex.details).toBe("Codex scenario failed");
        expect(result.driftDetails).toBe("runtime-pair cell status differs (pass vs fail)");
        expect(isRuntimeParityResultPass(result)).toBe(false);
      }
    },
  );

  it("rejects duplicate runtimes before executing a parity cell", async () => {
    const runCell = vi.fn(async (runtime: RuntimeId) => ({
      status: "pass" as const,
      cell: makeRuntimeParityCell(runtime),
    }));
    await expect(
      runRuntimeParityScenario({
        scenarioId: "duplicate-runtime-pair",
        runtimePair: ["openclaw", "openclaw"],
        runCell,
      }),
    ).rejects.toThrow(/different|distinct|duplicate/i);
    expect(runCell).not.toHaveBeenCalled();
  });
});
