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
import { readQaScenarioFile } from "./scenario-catalog.js";
import { buildQaToolCoverageReport } from "./tool-coverage-report.js";

const { seedRuntimeParityTranscript: seedTranscript, cleanup } =
  createRuntimeParityTranscriptHarness();
const PARENT_PROMPT = "Delegate one bounded QA task to a subagent.";
type CellOutcome = Partial<Pick<RuntimeParityScenarioExecution, "status" | "details">> &
  Partial<RuntimeParityCell>;

function runPair(
  codex: CellOutcome = {},
  openclaw: CellOutcome = {},
  scenarioId = "outcome-fixture",
) {
  return runRuntimeParityScenario({
    scenarioId,
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
  params: Partial<
    Omit<Parameters<typeof captureRuntimeParityCell>[0], "runtime" | "gateway" | "wallClockMs">
  > = {},
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

async function captureRuntimeParityWithMockRequests(params: {
  messages?: Array<Record<string, unknown>>;
  requests: Array<Record<string, unknown>>;
  scenarioResult?: Parameters<typeof captureRuntimeParityCell>[0]["scenarioResult"];
  trajectoryEvents?: Array<{
    data?: Record<string, unknown>;
    type: string;
  }>;
}) {
  const tempRoot = await seedRuntimeParityTranscript({
    messages: params.messages ?? [{ role: "user", content: PARENT_PROMPT }],
    trajectoryEvents: params.trajectoryEvents,
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
      messages: [{ role: "user", content: PARENT_PROMPT }],
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
    "counts successful %s reads containing failure prose in tool coverage",
    async (format) => {
      const results = [
        {
          id: "read-happy",
          args: { path: "QA_KICKOFF_TASK.md" },
          text: "Track what worked, what failed, what was blocked, and what you observed.",
          isError: false,
        },
        {
          id: "read-denied",
          args: { __qaFailureMode: "denied-input" },
          text: 'Validation failed for tool "read":\n  - path: must have required properties path',
          isError: true,
        },
        { id: "read-typed-error", args: {}, text: "Unavailable", isError: true },
        { id: "read-untyped-error", args: {}, text: "ENOENT: missing file" },
        ...(format === "tool_result"
          ? [{ id: "read-error-block", args: {}, text: "Unavailable", isError: false }]
          : []),
      ];
      const tempRoot = await seedRuntimeParityTranscript({
        messages: results.flatMap(({ id, args, text, isError }) => [
          assistant({ type: "toolCall", id, name: "read", arguments: args }),
          format === "toolResult"
            ? {
                role: "toolResult",
                toolCallId: id,
                toolName: "read",
                content: [{ type: "text", text }],
                ...(isError === undefined ? {} : { isError }),
              }
            : {
                role: "user",
                content: [
                  {
                    type: id === "read-error-block" ? "tool_result_error" : "tool_result",
                    tool_use_id: id,
                    content: [{ type: "text", text }],
                    ...(isError === undefined ? {} : { is_error: isError }),
                  },
                ],
              },
        ]),
      });
      const openclaw = await captureCell("openclaw", tempRoot);
      const scenario = readQaScenarioFile("qa/scenarios/runtime/tools/fs-read.yaml");
      const runtimeParity = await runPair(
        { toolCalls: [{ tool: "bash", argsHash: "native-read", resultHash: "file-contents" }] },
        openclaw,
        scenario.id,
      );
      const report = buildQaToolCoverageReport({
        scenarios: [scenario],
        summary: { scenarios: [{ name: scenario.id, status: "pass", runtimeParity }] },
      });

      expect(report.pass).toBe(true);
      expect(report.failures).toEqual([]);
      expect(report.rows[0]).toMatchObject({
        tool: "fs.read",
        openclawToolCalls: results.length,
        openclawSuccessfulToolCalls: 1,
      });
      expect(openclaw.toolCalls.map((call) => call.errorClass)).toEqual([
        undefined,
        ...results.slice(1).map(() => "tool-result-error"),
      ]);
    },
  );

  it("captures SQLite transcript text and merges trajectory-only calls without duplicates", async () => {
    const tempRoot = await seedRuntimeParityTranscript({
      messages: [
        { role: "user", content: [{ type: "text", text: "Read, run, search, and generate." }] },
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

    expect(cell.transcriptBytes).toContain('"role":"toolResult"');
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

  it("skips newer trajectory-only heartbeat sessions", async () => {
    const now = Date.now();
    const tempRoot = await seedRuntimeParityTranscript({
      sessionId: "web-search-session",
      messages: [],
      updatedAt: now - 1_000,
      trajectoryEvents: searchEvents("search-1", "release marker"),
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

    const cell = await captureCell("codex", tempRoot);

    expect(cell.toolCalls.map((toolCall) => toolCall.tool)).toEqual(["web_search"]);
    expect(cell.toolCalls[0]?.errorClass).toBeUndefined();
    expect(cell.toolCalls[0]?.argsHash).toBe(stableHash({ query: "release marker" }));
  });

  it("captures fixture-owned evidence across multiple root sessions", async () => {
    const now = Date.now();
    const tempRoot = await seedRuntimeParityTranscript({
      sessionId: "session-status-happy",
      sessionKey: "agent:qa:runtime-tool:session_status:happy",
      messages: [{ role: "user", content: "tool search qa check target=session_status" }],
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
      sessionId: "session-status-failure",
      sessionKey: "agent:qa:runtime-tool:session_status:failure",
      messages: [{ role: "user", content: "tool search qa failure target=session_status" }],
      updatedAt: now,
    });
    await seedRuntimeParityTranscript({
      tempRoot,
      sessionId: "unrelated-newer-root",
      sessionKey: "agent:qa:unrelated-newer-root",
      messages: [{ role: "user", content: "Unrelated setup." }],
      updatedAt: now + 1_000,
    });

    const cell = await captureCell("codex", tempRoot, {
      scenarioResult: {
        status: "pass",
        steps: [
          {
            status: "pass",
            details: [
              "RUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:session_status:happy",
              "RUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:session_status:failure",
            ].join("\n"),
          },
        ],
      },
    });

    expect(cell.transcriptBytes).toContain("target=session_status");
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

  it("still classifies terminal scenario failure diagnostics", async () => {
    const cell = await captureCell(
      "openclaw",
      `/tmp/openclaw-qa-runtime-parity-missing-${process.pid}`,
      { scenarioResult: { status: "fail", details: "timed out after 20000ms" } },
    );

    expect(cell.runtimeErrorClass).toBe("timeout");
  });

  it.each([
    { name: "object", toolOutput: '{"ok":true}', expected: { ok: true } },
    { name: "array", toolOutput: '[{"ok":true}]', expected: '[{"ok":true}]' },
    { name: "malformed JSON", toolOutput: "not-json", expected: "not-json" },
  ])(
    "records resolved mock calls as provider-plan evidence ($name)",
    async ({ toolOutput, expected }) => {
      const cell = await captureRuntimeParityWithMockRequests({
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

      const result = await runPair(cell, cell);

      expect(result.drift).toBe("none");
      expect(result.runtimeParityUsage).toEqual({ expectation: "assistant-message-required" });
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
    expect(resolveRuntimeParityUsagePolicy({ expectation: "not-applicable" })).toEqual({
      expectation: "assistant-message-required",
    });
    expect(
      resolveRuntimeParityUsagePolicy({ expectation: "not-applicable", reason: "   " }),
    ).toEqual({ expectation: "assistant-message-required" });
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
    const cell = await captureRuntimeParityWithMockRequests({
      requests: [{ plannedToolName: "image_generate", plannedToolArgs: { prompt: "same" } }],
      messages: [
        { role: "user", content: "Generate the QA image." },
        assistant(makeToolCall("image-call", "image_generate", { prompt: "same" })),
      ],
      scenarioResult: { status: "pass", steps: [{ status, details }] },
    });
    expect(cell.toolCalls[0]?.errorClass).toBe(expected);
  });

  it("scopes process-global mock requests to the parent session prompt", async () => {
    const child = "Fanout worker alpha: inspect the QA workspace and finish with exactly ALPHA-OK.";
    const followup = "Continue the bounded QA task with the retained child result.";
    const cell = await captureRuntimeParityWithMockRequests({
      messages: [PARENT_PROMPT, followup].map((content) => ({ role: "user", content })),
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
    const modelSwitchEvidence = {
      primary: { runId: "run-1", responseModel: "primary-model" },
      alternate: { runId: "run-2", responseModel: "alternate-model" },
    };
    const cell = await captureRuntimeParityWithMockRequests({
      requests: [],
      scenarioResult: { status: "pass", modelSwitchEvidence },
    });
    expect(cell.modelSwitchEvidence).toEqual(modelSwitchEvidence);
    expect(cell.providerPlanToolCalls).toEqual([]);
  });
});

describe("runtime parity outcomes", () => {
  it("keeps a skip diagnostic out of runtime error classification", async () => {
    const cell = await captureCell(
      "codex",
      `/tmp/openclaw-qa-runtime-parity-missing-${process.pid}`,
      {
        scenarioResult: {
          status: "skip",
          details: "expected-unavailable tool: this fixture is report-only",
        },
      },
    );

    expect(cell.runtimeErrorClass).toBeUndefined();
  });

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

  it("requires every canonical runtime-pair cell status to pass", async () => {
    const result = await runPair();

    expect(isRuntimeParityResultPass(result)).toBe(true);

    expect(
      isRuntimeParityResultPass({
        ...result,
        cells: { ...result.cells, codex: { ...result.cells.codex, status: "skip" } },
      }),
    ).toBe(false);

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
    [["codex", "openclaw"], false],
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
      expect(Object.keys(result.cells)).toEqual(["openclaw", "codex"]);
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
