// Covers CLI execution paths where the process supervisor keeps stdout capture
// disabled and the runner must parse streamed chunks without relying on tails.
import { assert, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { buildExternalRunFailureReply } from "../../auto-reply/reply/agent-runner-failure-reply.js";
import {
  markMcpLoopbackRequestFinished,
  markMcpLoopbackRequestStarted,
  markMcpLoopbackToolCallFinished,
  markMcpLoopbackToolCallStarted,
  recordMcpLoopbackToolCallResult as recordMcpLoopbackToolCallResultForHandle,
  resolveMcpLoopbackYieldContext,
} from "../../gateway/mcp-http.loopback-runtime.js";
import { onAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import {
  areDiagnosticsEnabledForProcess,
  onTrustedToolExecutionEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  type TrustedToolExecutionEvent,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import {
  closeDiagnosticEmbeddedRunOwner,
  createDiagnosticEmbeddedRunOwner,
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunStarted,
  resetDiagnosticRunActivityForTest,
  startDiagnosticRunActivityTracking,
} from "../../logging/diagnostic-run-activity.js";
import type {
  CliBackendParseJsonlEvent,
  CliBackendParsedJsonlEvent,
} from "../../plugins/cli-backend.types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createChildAdapter } from "../../process/supervisor/adapters/child.js";
import type { getProcessSupervisor } from "../../process/supervisor/index.js";
import { createProcessSupervisor } from "../../process/supervisor/supervisor.js";
import { createStubChildAdapter } from "../../process/supervisor/supervisor.test-support.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import { hashCliImageTurnEntryId } from "../cli-image-turn-correlation.js";
import { buildEmbeddedRunPayloads } from "../embedded-agent-runner/run/payloads.js";
import { findCliTerminalStopError } from "../failover-error.js";
import { resolveAgentRunErrorLifecycleFields } from "../run-termination.js";
import { buildCliDeliveredFailure, buildCliRunResult } from "./cli-run-settlement.js";
import { getCliMessagingDeliveryEvidence } from "./delivery-evidence.js";
import { executePreparedCliRun as executePreparedCliRunImpl } from "./execute.js";
import {
  createManagedRun,
  createSuccessfulProcessExit,
  supervisorSpawnMock,
  wrapPreparedCliRunWithTestAdmission,
} from "./execute.test-support.js";
import { prepareCliRunTerminalReply } from "./terminal-reply.js";
import { captureCliRunStartTime, type PreparedCliRunContext } from "./types.js";
const executePreparedCliRun = wrapPreparedCliRunWithTestAdmission(executePreparedCliRunImpl);
vi.mock("../../process/supervisor/adapters/child.js", () => ({ createChildAdapter: vi.fn() }));
type ProcessSupervisor = ReturnType<typeof getProcessSupervisor>;
type SupervisorSpawnInput = Parameters<ProcessSupervisor["spawn"]>[0];
const TEST_MESSAGE_CHANNEL = "test-channel";

function jsonl(record: unknown) {
  return JSON.stringify(record) + "\n";
}

function messageRecord(role: "assistant" | "user", content: unknown) {
  return { type: role, message: { role, content } };
}

function assistant(...content: unknown[]) {
  return jsonl(messageRecord("assistant", content));
}
function user(...content: unknown[]) {
  return jsonl(messageRecord("user", content));
}

function toolUse(id: string, name: string, input: Record<string, unknown>, type = "mcp_tool_use") {
  return { type, id, name, input };
}

function toolResult(
  tool_use_id: string,
  content: unknown,
  is_error?: boolean,
  type = "tool_result",
) {
  return { type, tool_use_id, content, ...(is_error === undefined ? {} : { is_error }) };
}

function toolEvent(
  kind: "started" | "completed" | "error" | "blocked",
  toolCallId: string,
  details: Record<string, unknown> = {},
) {
  return { type: `tool.execution.${kind}`, toolCallId, ...details };
}

function captureAgentEvents(streams?: string[]) {
  const events: Array<{
    stream: string;
    phase?: string;
    text?: string;
    delta?: string;
    isReasoningSnapshot?: true;
  }> = [];
  onTestFinished(
    onAgentEvent(({ stream, data }) => {
      if (streams && !streams.includes(stream)) {
        return;
      }
      events.push({
        stream,
        ...(streams ? {} : { phase: typeof data.phase === "string" ? data.phase : undefined }),
        text: typeof data.text === "string" ? data.text : undefined,
        delta: typeof data.delta === "string" ? data.delta : undefined,
        ...(data.isReasoningSnapshot === true ? { isReasoningSnapshot: true } : {}),
      });
    }),
  );
  return events;
}

function captureToolEvents() {
  const events: TrustedToolExecutionEvent[] = [];
  onTestFinished(onTrustedToolExecutionEvent((event) => events.push(event)));
  return events;
}

function mockOutput(
  chunks: readonly string[],
  exit: Partial<ReturnType<typeof createSuccessfulProcessExit>> = {},
  captured = false,
) {
  supervisorSpawnMock.mockImplementationOnce(async (input) => {
    for (const chunk of chunks) {
      input.onStdout?.(chunk);
    }
    return createManagedRun({
      ...createSuccessfulProcessExit(),
      ...exit,
      ...(captured ? { stdout: input.captureOutput === false ? "" : chunks.join("") } : {}),
    });
  });
}

function mockCaptureSpawn(
  emit: (input: SupervisorSpawnInput, captureKey: string) => void,
  exit: Partial<ReturnType<typeof createSuccessfulProcessExit>> = {},
) {
  supervisorSpawnMock.mockImplementationOnce(async (input) => {
    emit(input, input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "");
    return createManagedRun({ ...createSuccessfulProcessExit(), ...exit });
  });
}

function recordToolOutcome(
  captureKey: string,
  toolName: string,
  args: Record<string, unknown>,
  outcome: "completed" | "failed" | "unknown" = "completed",
  result?: unknown,
) {
  const captureHandle = markMcpLoopbackToolCallStarted({ captureKey, toolName, args });
  if (!captureHandle) {
    return;
  }
  recordMcpLoopbackToolCallResultForHandle({ captureHandle, toolName, args, outcome, result });
  markMcpLoopbackToolCallFinished(captureHandle);
}

function buildPreparedCliRunContext(params: {
  output: "json" | "jsonl" | "text";
  provider?: string;
  runId?: string;
  beforeExecution?: () => Promise<void>;
  parseJsonlEvent?: CliBackendParseJsonlEvent;
}): PreparedCliRunContext {
  const provider = params.provider ?? "codex-cli";
  const runId = params.runId ?? `run-${params.output}`;
  const backend = {
    command: "agent-cli",
    args: [],
    output: params.output,
    input: "stdin" as const,
    serialize: true,
  };
  return {
    params: {
      admittedRunContext: createTestAdmittedRunContext(runId),
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider,
      model: "model",
      timeoutMs: 1_000,
      runId,
    },
    ...captureCliRunStartTime(),
    workspaceDir: "/tmp",
    backendResolved: {
      id: provider,
      config: backend,
      bundleMcp: false,
      parseJsonlEvent: params.parseJsonlEvent,
    },
    executionTarget: { kind: "process" },
    preparedBackend: {
      backend,
      env: {},
      ...(params.beforeExecution ? { beforeExecution: params.beforeExecution } : {}),
    },
    reusableCliSession: { mode: "none" },
    hadSessionFile: false,
    contextEngineConfig: {},
    modelId: "model",
    normalizedModel: "model",
    systemPrompt: "system",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    claudeSkillsPluginArgs: [],
    authEpochVersion: 2,
  };
}

function claudeJsonlContext() {
  return buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" });
}

function installCaptureGrant(context: PreparedCliRunContext) {
  const activateCapture = vi.fn<(captureKey: string, assertCurrent: () => void) => void>();
  const deactivateCapture = vi.fn<(captureKey: string) => void>();
  context.preparedBackend.mcpClientGrantCapture = {
    transportToken: "capture-test-token",
    adoptProcessToken: vi.fn(),
    revokeProcessToken: vi.fn(),
    activate: activateCapture,
    deactivate: deactivateCapture,
  };
  return { activateCapture, deactivateCapture };
}

function requireSupervisorSpawnInput(index = 0): SupervisorSpawnInput {
  const call = supervisorSpawnMock.mock.calls[index];
  if (!call) {
    throw new Error("Expected supervisor spawn");
  }
  return call[0] as SupervisorSpawnInput;
}
beforeEach(() => {
  vi.unstubAllEnvs();
  resetAgentEventsForTest();
  resetDiagnosticEventsForTest();
  supervisorSpawnMock.mockReset(); // These contexts bypass preparation, which normally loads the provider owner.
  // Unknown CLI errors must not materialize bundled plugins inside this fixture.
  const registry = createEmptyPluginRegistry();
  registry.providers.push({
    pluginId: "fixture-cli-provider",
    provider: {
      id: "fixture-cli-provider",
      label: "Fixture CLI provider",
      hookAliases: ["claude-cli", "codex-cli", "google-gemini-cli"],
      auth: [],
    },
    source: "test",
  });
  setActivePluginRegistry(registry);
}); // These cases flip process-global diagnostics state, and the lane runs with
// `--isolate=false`, so every mutation is restored and the event queue drained
// before the next file in this worker observes it.
async function withDiagnosticsEnabled<T>(run: () => Promise<T>): Promise<T> {
  const previouslyEnabled = areDiagnosticsEnabledForProcess();
  setDiagnosticsEnabledForProcess(true);
  startDiagnosticRunActivityTracking();
  try {
    return await run();
  } finally {
    await waitForDiagnosticEventsDrained();
    resetDiagnosticRunActivityForTest();
    resetDiagnosticEventsForTest();
    setDiagnosticsEnabledForProcess(previouslyEnabled);
  }
}

function holdSupervisorRun() {
  const entered = createDeferred();
  const release = createDeferred();
  const exit = createSuccessfulProcessExit();
  const managedRun = createManagedRun(exit);
  managedRun.wait.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    return exit;
  });
  supervisorSpawnMock.mockResolvedValueOnce(managedRun);
  return { entered: entered.promise, release: () => release.resolve() };
}
it("binds Claude image prompts to the persisted local transcript turn", async () => {
  const entryId = "persisted-image-turn";
  const recorder = createUserTurnTranscriptRecorder({
    input: { text: "describe this" },
    target: createTestUserTurnTranscriptTarget(),
  });
  const message = recorder.message;
  if (!message) {
    throw new Error("expected prepared user turn");
  }
  recorder.markRuntimePersisted(message, {
    agentId: "main",
    sessionId: "session-1",
    sessionKey: "agent:main:main",
    storePath: "/tmp/sessions.db",
    generation: "generation-1",
    entryId,
    rawSeq: 1,
    effectiveParentId: null,
    activeMessagePosition: 0,
    logicalTurnId: "logical-turn-1",
    role: "user",
  });
  const context = buildPreparedCliRunContext({ output: "text", provider: "claude-cli" });
  context.preparedBackend.backend.imageArg = "@";
  context.params.userTurnTranscriptRecorder = recorder;
  context.params.images = [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }];
  mockOutput(["done"]);
  await executePreparedCliRun(context);
  const spawnInput = requireSupervisorSpawnInput();
  if (!("input" in spawnInput)) {
    throw new Error("expected direct CLI process input");
  }
  const prompt = spawnInput.input;
  expect(prompt).toContain(hashCliImageTurnEntryId(entryId));
});

it("ignores stdout from a closed owner after a same-id owner replacement", async () => {
  await withDiagnosticsEnabled(async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const firstContext = buildPreparedCliRunContext({ output: "text", provider: "fixture-cli" });
    const firstOwner = createDiagnosticEmbeddedRunOwner(firstContext.params);
    firstContext.params.diagnosticOwner = firstOwner;
    markDiagnosticEmbeddedRunStarted({ ...firstContext.params, owner: firstOwner });
    const firstHeld = holdSupervisorRun();
    const firstRun = executePreparedCliRun(firstContext);
    const successorOwner = createDiagnosticEmbeddedRunOwner(firstContext.params);
    try {
      await firstHeld.entered;
      const oldInput = requireSupervisorSpawnInput();
      oldInput.onStdout?.("first");
      await waitForDiagnosticEventsDrained();
      closeDiagnosticEmbeddedRunOwner(firstOwner);
      markDiagnosticEmbeddedRunStarted({ ...firstContext.params, owner: successorOwner });
      now += 100;
      const before = getDiagnosticSessionActivitySnapshot(firstContext.params);
      expect(before.activeBackendLivenessDeadlineAtMs).toBeUndefined();
      oldInput.onStdout?.(" late old output");
      await waitForDiagnosticEventsDrained();
      expect(getDiagnosticSessionActivitySnapshot(firstContext.params)).toEqual(before);
      firstHeld.release();
      await firstRun;
      await waitForDiagnosticEventsDrained();
      expect(getDiagnosticSessionActivitySnapshot(firstContext.params)).toEqual(before);
    } finally {
      firstHeld.release();
      await Promise.allSettled([firstRun]);
      closeDiagnosticEmbeddedRunOwner(firstOwner);
      closeDiagnosticEmbeddedRunOwner(successorOwner);
      clock.mockRestore();
    }
  });
});

it("retains the newer same-session allowance when an overlapping serialize:false call settles", async () => {
  await withDiagnosticsEnabled(async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const first = buildPreparedCliRunContext({
      output: "text",
      provider: "fixture-cli",
      runId: "overlap-first",
    });
    const second = buildPreparedCliRunContext({
      output: "text",
      provider: "fixture-cli",
      runId: "overlap-second",
    });
    for (const context of [first, second]) {
      context.preparedBackend.backend.serialize = false;
    }
    const firstOwner = createDiagnosticEmbeddedRunOwner(first.params);
    const secondOwner = createDiagnosticEmbeddedRunOwner(second.params);
    first.params.diagnosticOwner = firstOwner;
    second.params.diagnosticOwner = secondOwner;
    const firstHeld = holdSupervisorRun();
    const secondHeld = holdSupervisorRun();
    markDiagnosticEmbeddedRunStarted({ ...first.params, owner: firstOwner });
    const runs = [executePreparedCliRun(first)];
    try {
      await firstHeld.entered;
      now += 100;
      markDiagnosticEmbeddedRunStarted({ ...second.params, owner: secondOwner });
      runs.push(executePreparedCliRun(second));
      await secondHeld.entered;
      const secondInput = requireSupervisorSpawnInput(1);
      const quietMs = secondInput.noOutputTimeoutMs;
      if (quietMs === undefined) {
        throw new Error("Expected the second CLI child's quiet timeout");
      }
      const deadline = now + quietMs;
      expect(getDiagnosticSessionActivitySnapshot(second.params)).toMatchObject({
        activeBackendLivenessDeadlineAtMs: deadline,
      });
      requireSupervisorSpawnInput().onStdout?.("first");
      firstHeld.release();
      await expect(runs[0]).resolves.toMatchObject({ text: "first" });
      closeDiagnosticEmbeddedRunOwner(firstOwner);
      await waitForDiagnosticEventsDrained();
      expect(getDiagnosticSessionActivitySnapshot(second.params)).toMatchObject({
        hasActiveEmbeddedRun: true,
        activeBackendLivenessDeadlineAtMs: deadline,
      });
      secondInput.onStdout?.("second");
      secondHeld.release();
      await expect(runs[1]).resolves.toMatchObject({ text: "second" });
    } finally {
      firstHeld.release();
      secondHeld.release();
      await Promise.allSettled(runs);
      closeDiagnosticEmbeddedRunOwner(firstOwner);
      closeDiagnosticEmbeddedRunOwner(secondOwner);
      clock.mockRestore();
    }
  });
});

it("renews Agent progress only for attributed semantic subagent records", async () => {
  await withDiagnosticsEnabled(async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const parentId = "toolu_parent";
    const line = (record: unknown) => jsonl(record);
    const context = claudeJsonlContext();
    const owner = createDiagnosticEmbeddedRunOwner(context.params);
    context.params.diagnosticOwner = owner;
    markDiagnosticEmbeddedRunStarted({ ...context.params, owner });
    const held = holdSupervisorRun();
    const run = executePreparedCliRun(context);
    try {
      await held.entered;
      const input = requireSupervisorSpawnInput();
      const quietMs = input.noOutputTimeoutMs;
      if (quietMs === undefined) {
        throw new Error("Expected CLI quiet timeout");
      }
      input.onStdout?.(
        line(messageRecord("assistant", [toolUse(parentId, "Agent", {}, "tool_use")])),
      );
      await waitForDiagnosticEventsDrained();
      now += 800_000;
      input.onStdout?.(
        line({
          type: "stream_event",
          parent_tool_use_id: parentId,
          event: {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "still working" },
          },
        }),
      );
      input.onStdout?.(
        line({
          type: "assistant",
          parent_tool_use_id: "toolu_other",
          message: {
            role: "assistant",
            content: [toolUse("toolu_child", "Read", {}, "tool_use")],
          },
        }),
      );
      await waitForDiagnosticEventsDrained();
      expect(getDiagnosticSessionActivitySnapshot(context.params)).toMatchObject({
        activeWorkKind: "tool_call",
        activeToolName: "Agent",
        activeToolCallId: parentId,
        lastProgressReason: "tool:Agent:started",
        lastProgressAgeMs: 800_000,
      });
      input.onStdout?.(
        line({
          type: "user",
          parent_tool_use_id: parentId,
          message: { role: "user", content: [toolResult("toolu_child", "file")] },
        }),
      );
      await waitForDiagnosticEventsDrained();
      expect(getDiagnosticSessionActivitySnapshot(context.params)).toMatchObject({
        activeToolName: "Agent",
        activeToolCallId: parentId,
        lastProgressReason: "tool:Agent:subagent_progress",
        lastProgressAgeMs: 0,
        activeToolAgeMs: 800_000,
      });
      now += 800_000;
      input.onStdout?.("noise\n");
      await waitForDiagnosticEventsDrained();
      expect(getDiagnosticSessionActivitySnapshot(context.params)).toMatchObject({
        activeToolName: "Agent",
        lastProgressReason: "tool:Agent:subagent_progress",
        lastProgressAgeMs: 800_000,
        activeToolAgeMs: 1_600_000,
        activeBackendLivenessDeadlineAtMs: now + quietMs,
      });
      input.onStdout?.(line({ type: "result", session_id: "session-agent", result: "done" }));
      held.release();
      await expect(run).resolves.toMatchObject({ text: "done" });
    } finally {
      held.release();
      await Promise.allSettled([run]);
      closeDiagnosticEmbeddedRunOwner(owner);
      clock.mockRestore();
    }
  });
});

it.each(["compacting", "local_command"])(
  "requires acknowledgement when native compaction returns %s",
  async (subtype) => {
    mockOutput([jsonl({ type: "system", subtype })]);
    const context = claudeJsonlContext();
    context.params.prompt = "/compact";
    context.params.controlOperation = "compact";
    context.backendResolved.textTransforms = { input: [{ from: "/compact", to: "mutated" }] };
    context.backendResolved.manualCompaction = {
      input: "arg",
      buildPrompt: () => "/compact",
      validateOutput: (output) =>
        output.includes('"subtype":"compacting"')
          ? { ok: true }
          : { ok: false, reason: "native compaction was not acknowledged" },
    };
    const execution = executePreparedCliRun(context);
    if (subtype !== "compacting") {
      await expect(execution).rejects.toThrow("native compaction was not acknowledged");
      return;
    }
    expect(await execution).toMatchObject({ text: "", rawText: "", finalPromptText: "/compact" });
    expect(requireSupervisorSpawnInput()).toMatchObject({
      argv: ["agent-cli", "/compact"],
      input: "",
      noOutputTimeoutMs: context.params.timeoutMs,
    });
  },
);

it("runs prepared backend staging inside the serialized execution queue", async () => {
  const firstSpawnEntered = createDeferred();
  const releaseFirstSpawn = createDeferred();
  const events: string[] = [];
  let spawnCount = 0;
  supervisorSpawnMock.mockImplementation(async (input) => {
    spawnCount += 1;
    const label = spawnCount === 1 ? "first" : "second";
    events.push(`spawn:${label}`);
    input.onStdout?.(`answer ${label}`);
    if (label === "first") {
      firstSpawnEntered.resolve();
      await releaseFirstSpawn.promise;
    }
    return createManagedRun(createSuccessfulProcessExit());
  });
  const first = executePreparedCliRun(
    buildPreparedCliRunContext({
      output: "text",
      runId: "run-first",
      beforeExecution: async () => {
        events.push("stage:first");
      },
    }),
  );
  await firstSpawnEntered.promise;
  const second = executePreparedCliRun(
    buildPreparedCliRunContext({
      output: "text",
      runId: "run-second",
      beforeExecution: async () => {
        events.push("stage:second");
      },
    }),
  );
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(events).toEqual(["stage:first", "spawn:first"]);
  releaseFirstSpawn.resolve();
  await Promise.all([first, second]);
  expect(events).toEqual(["stage:first", "spawn:first", "stage:second", "spawn:second"]);
});

it("rejects fragmented text one byte over the parse limit", async () => {
  const textBytes = 1024 * 1024 + 1;
  const fullText = `start-${"x".repeat(textBytes - 10)}-end`;
  const stdout = fullText;
  supervisorSpawnMock.mockImplementationOnce(async (input) => {
    for (let offset = 0; offset < stdout.length; offset += 4096) {
      input.onStdout?.(stdout.slice(offset, offset + 4096));
    }
    return createManagedRun(createSuccessfulProcessExit());
  });
  await expect(
    executePreparedCliRun(buildPreparedCliRunContext({ output: "text" })),
  ).rejects.toMatchObject({
    reason: "format",
    message: "CLI stdout exceeded 1048576 bytes; refusing to parse truncated output.",
  });
  const spawnInput = requireSupervisorSpawnInput();
  expect(spawnInput.captureOutput).toBe(false);
});

it("parses oversized resume JSONL output from the effective resume output mode", async () => {
  const largeToolEvent = jsonl({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "tool_delta", text: "x".repeat(2 * 1024 * 1024) },
    },
  });
  const resultEvent = jsonl({
    type: "result",
    session_id: "resume-jsonl-session",
    result: "resumed answer",
  });
  const context = buildPreparedCliRunContext({ output: "text", provider: "resume-jsonl-cli" }); // Resume can switch the backend from text to JSONL, so the executor must
  // derive parser mode from the effective resume config instead of the base.
  Object.assign(context.preparedBackend.backend, {
    jsonlDialect: "claude-stream-json" as const,
    resumeArgs: ["resume", "{sessionId}"],
    resumeOutput: "jsonl" as const,
    sessionMode: "existing" as const,
  });
  mockOutput([largeToolEvent, resultEvent], {}, true);
  const result = await executePreparedCliRun(context, "resume-jsonl-session");
  expect(result.text).toBe("resumed answer");
  expect(result.sessionId).toBe("resume-jsonl-session");
});

it("classifies failed stderr from the retained prefix (clipped UTF-8: true)", async () => {
  // The error classifier needs the retained parse buffer; the human-facing
  // diagnostic tail may contain only noise once stdout grows large.
  const errorPrefix = "429 rate limit exceeded: ";
  const noisyTail = "x".repeat(1024 * 1024 - Buffer.byteLength(errorPrefix) - 1);
  const expectedMessage = `${errorPrefix}${noisyTail}\uFFFD`;
  supervisorSpawnMock.mockImplementationOnce(async (input) => {
    const emit = input.onStderr;
    emit?.(errorPrefix);
    for (let offset = 0; offset < noisyTail.length; offset += 4093) {
      emit?.(noisyTail.slice(offset, offset + 4093));
    } // Only the first byte of this code point fits in the retained prefix.
    emit?.("🙂");
    emit?.("discarded after the prefix");
    input.onStdout?.("Credit balance is too low");
    return createManagedRun({ ...createSuccessfulProcessExit(), exitCode: 1 });
  });
  await expect(
    executePreparedCliRun(buildPreparedCliRunContext({ output: "text" })),
  ).rejects.toMatchObject({ reason: "rate_limit", status: 429, message: expectedMessage });
});

it("classifies a structured stdout failure after its diagnostic tail is displaced", async () => {
  mockOutput(
    [
      jsonl({ type: "result", is_error: true, result: "429 rate limit exceeded" }),
      "x".repeat(80 * 1024),
    ],
    { exitCode: 1 },
  );
  await expect(
    executePreparedCliRun(buildPreparedCliRunContext({ output: "text" })),
  ).rejects.toMatchObject({
    reason: "rate_limit",
    status: 429,
    message: "429 rate limit exceeded",
  });
});

it("fails one-shot Claude is_error results even when the process exits successfully", async () => {
  const stdout = jsonl({
    type: "result",
    subtype: "success",
    is_error: true,
    result: "Credit balance is too low",
    session_id: "session-jsonl-error",
  });
  mockOutput([stdout], {}, true);
  await expect(executePreparedCliRun(claudeJsonlContext())).rejects.toMatchObject({
    name: "FailoverError",
    message: "Credit balance is too low",
  });
});

it.each([0, 1])(
  "preserves the prepared backend failure code through process exit %i and reply copy",
  async (exitCode) => {
    const message =
      "Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute, and if it persists close other Claude Code processes or sign in again";
    mockOutput(
      [
        jsonl({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: [message],
          session_id: "session-refresh-contention",
        }),
      ],
      { exitCode },
    );
    const context = claudeJsonlContext();
    const classifyErrorCode = vi.fn(() => "refresh_contention");
    context.backendResolved.classifyErrorCode = classifyErrorCode;

    const error = await executePreparedCliRun(context).catch((caught: unknown) => caught);

    assert(error instanceof Error);
    expect(classifyErrorCode).toHaveBeenCalledExactlyOnceWith(message);
    expect(error).toMatchObject({ name: "FailoverError", code: "refresh_contention", message });
    expect(buildExternalRunFailureReply({ message: error.message, error })).toEqual({
      text: "Another sign-in is still in progress. Wait a moment, then try again.",
      isGenericRunnerFailure: false,
    });
  },
);

it("surfaces a local Claude synthetic empty terminal through the output error path", async () => {
  const stdout = [
    JSON.stringify({
      type: "assistant",
      message: {
        model: "<synthetic>",
        role: "assistant",
        content: [{ type: "text", text: "No response requested." }],
      },
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "claude-synthetic-empty",
      result: "",
    }),
    "",
  ].join("\n");
  mockOutput([stdout], {}, true);
  await expect(executePreparedCliRun(claudeJsonlContext())).rejects.toMatchObject({
    name: "FailoverError",
    reason: "format",
    code: "cli_synthetic_no_response",
    rawError: "Claude CLI returned a synthetic no-response result.",
  });
});

it("surfaces a Claude hook-stopped terminal result from JSON output", async () => {
  const stdout = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "claude-hook-stopped",
    stop_reason: "tool_use",
    terminal_reason: "hook_stopped",
    result: "",
    num_turns: 4,
    permission_denials: [],
  });

  mockOutput([stdout], {}, true);

  await expect(
    executePreparedCliRun(
      buildPreparedCliRunContext({
        output: "json",
        provider: "claude-cli",
        runId: "run-hook-stopped",
      }),
    ),
  ).rejects.toMatchObject({
    name: "FailoverError",
    message:
      "Claude CLI ended the turn without a reply (terminal_reason: hook_stopped, stop_reason: tool_use). " +
      "OpenClaw run: run-hook-stopped. OpenClaw session: session-1. " +
      "Claude session: claude-hook-stopped. Tool actions may already have run; verify their effects before retrying. " +
      "A Claude Code hook stopped this turn; user-scope hooks (including plugin hooks) " +
      "apply to headless runs — move or disable that hook.",
    reason: "unknown",
    code: "cli_turn_stopped",
    rawError:
      "Claude CLI ended the turn without a reply (terminal_reason: hook_stopped, stop_reason: tool_use).",
  });
});

it("preserves the terminal failure through fork persistence errors", async () => {
  const stdout = jsonl({
    type: "result",
    subtype: "error_max_turns",
    session_id: "fork-successor",
    terminal_reason: "max_turns",
    errors: ["Reached maximum number of turns (1)"],
  });
  mockOutput([stdout], { exitCode: 1 }, true);
  const persistenceError = new Error("fork successor persistence failed");
  persistenceError.name = "TimeoutError";
  const persistCliSessionForkSuccessor = vi.fn().mockRejectedValue(persistenceError);
  const restoreCliSessionFork = vi.fn().mockResolvedValue(undefined);
  const context = buildPreparedCliRunContext({
    output: "jsonl",
    provider: "claude-cli",
    runId: "run-fork-primary-failure",
  });
  context.preparedBackend.backend.resumeArgs = ["--resume", "{sessionId}"];
  context.preparedBackend.backend.forkArg = "--fork-session";
  context.params.forkCliSessionOnResume = true;
  const admission = prepareSystemAgentRunAdmission({}, context.params.runId, "main", "fork-test");
  onTestFinished(admission.close);
  context.params.admittedRunContext = await admission.admit("embedded");
  context.params.claimCliSessionFork = vi.fn().mockResolvedValue(true);
  context.params.persistCliSessionForkSuccessor = persistCliSessionForkSuccessor;
  context.params.restoreCliSessionFork = restoreCliSessionFork;
  const failure = await executePreparedCliRun(context, "fork-source").catch(
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([
    expect.objectContaining({ code: "cli_max_turns" }),
    persistenceError,
  ]);
  expect(findCliTerminalStopError(failure)).toMatchObject({ code: "cli_max_turns" });
  expect(resolveAgentRunErrorLifecycleFields(failure, undefined)).toEqual({});
  expect((failure as AggregateError).cause).toBe((failure as AggregateError).errors[0]);
  expect(persistCliSessionForkSuccessor).toHaveBeenCalledWith("fork-successor");
  expect(restoreCliSessionFork).toHaveBeenCalledTimes(1);
});

it("composes plugin-owned JSONL parsing into the production executor", async () => {
  const agentEvents = captureAgentEvents();
  const trustedEvents = captureToolEvents();
  const parsed: CliBackendParsedJsonlEvent[] = [
    { kind: "sessionId", sessionId: "custom-session" },
    { kind: "thinking", text: "Checking facts." },
    { kind: "text", text: "Hello world" },
    { kind: "toolStart", toolCallId: "call-1", name: "search", args: { query: "weather" } },
    { kind: "toolResult", toolCallId: "call-1", name: "search", result: "sunny" },
    {
      kind: "result",
      text: "Hello world",
      sessionId: "custom-successor",
      usage: { input: 4, output: 2, total: 6 },
    },
  ];
  // Only the plugin parser understands these opaque JSONL records.
  const events = new Map(parsed.map((event, index) => [JSON.stringify({ index }), event]));
  const parseJsonlEvent: CliBackendParseJsonlEvent = (line) => events.get(line);
  mockOutput([...events.keys()].map((line) => `${line}\n`));
  const context = buildPreparedCliRunContext({
    output: "jsonl",
    provider: "acme-cli",
    parseJsonlEvent,
  });
  const result = await executePreparedCliRun(context);
  expect(result).toMatchObject({
    text: "Hello world",
    sessionId: "custom-successor",
    usage: { input: 4, output: 2, total: 6 },
    toolSummary: { calls: 1, tools: ["search"], failures: 0 },
  });
  expect(getCliMessagingDeliveryEvidence(context.params.runId)).toBeUndefined();
  expect(agentEvents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ stream: "thinking", text: "Checking facts." }),
      expect.objectContaining({ stream: "assistant", text: "Hello world" }),
      expect.objectContaining({ stream: "tool", phase: "start" }),
      expect.objectContaining({ stream: "tool", phase: "result" }),
    ]),
  );
  expect(trustedEvents).toEqual([]);
});

it("streams native thinking snapshots and text with supervisor capture disabled", async () => {
  // Streaming events are emitted from live chunks, not from the final captured
  // stdout string, so users still see deltas when captureOutput is false.
  const agentEvents = captureAgentEvents(["assistant", "thinking"]);
  const chunks = [
    jsonl({ type: "init", session_id: "session-jsonl" }),
    ...[
      { index: 0, thinking: "Checking " },
      { index: 1, thinking: "facts." },
      { index: 0, thinking: "the " },
      { index: 1, thinking: " Done." },
    ].map(({ index, thinking }) =>
      jsonl({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index,
          delta: { type: "thinking_delta", thinking },
        },
      }),
    ),
    jsonl({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
    }),
    `not-json ${"x".repeat(80 * 1024)}\n`,
    jsonl({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: " world" } },
    }),
    jsonl({ type: "result", session_id: "session-jsonl", result: "Hello world" }),
  ];
  mockOutput(chunks, {}, true);
  const context = claudeJsonlContext();
  context.params.onExecutionPhase = vi.fn();
  const result = await executePreparedCliRun(context);
  const spawnInput = requireSupervisorSpawnInput();
  expect(spawnInput.captureOutput).toBe(false);
  expect(result.text).toBe("Hello world");
  expect(result.toolSummary).toEqual({ calls: 0, tools: [], failures: 0 });
  expect(agentEvents).toEqual([
    ...[
      ["Checking ", "Checking "],
      ["Checking facts.", "facts."],
      ["Checking the facts.", "the "],
      ["Checking the facts. Done.", " Done."],
    ].map(([text, delta]) => ({ stream: "thinking", text, delta, isReasoningSnapshot: true })),
    { stream: "assistant", text: "Hello", delta: "Hello" },
    { stream: "assistant", text: "Hello world", delta: " world" },
  ]);
  expect(context.params.onExecutionPhase).toHaveBeenCalledTimes(2);
  expect(context.params.onExecutionPhase).toHaveBeenNthCalledWith(2, {
    phase: "assistant_output_started",
    provider: "claude-cli",
    model: "model",
    backend: "claude-cli",
  });
});

it("emits metadata-only lifecycle records for parsed CLI tools", async () => {
  const secret = "secret tool input and result";
  const toolEvents = captureToolEvents();
  const chunks = [
    assistant(toolUse("call-1", "Bash", { command: `sleep ${secret}` }, "tool_use")),
    user(toolResult("call-1", [{ type: "text", text: secret }])),
    jsonl({ type: "result", session_id: "session-jsonl", result: "done" }),
  ];
  mockOutput(chunks);
  const context = claudeJsonlContext();
  context.params.sessionKey = "agent:coder:main";
  context.params.agentId = "coder";

  const result = await executePreparedCliRun(context);
  expect(result.toolSummary).toEqual({ calls: 1, tools: ["Bash"], failures: 0 });

  expect(toolEvents).toEqual([
    expect.objectContaining(
      toolEvent("started", "call-1", {
        runId: "run-jsonl",
        sessionKey: "agent:coder:main",
        sessionId: "session-1",
        agentId: "coder",
        toolName: "Bash",
        toolSource: "core",
        toolOwner: "cli-runner",
      }),
    ),
    expect.objectContaining(toolEvent("completed", "call-1", { runId: "run-jsonl" })),
  ]);
  expect(JSON.stringify(toolEvents)).not.toContain(secret);
});

it("binds a loopback call admitted before its parsed CLI identity", async () => {
  const toolEvents = captureToolEvents();
  supervisorSpawnMock.mockImplementationOnce(async (input) => {
    const captureHandle = markMcpLoopbackToolCallStarted({
      captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY,
      toolName: "message",
      args: { action: "react", emoji: "early" },
    });
    if (!captureHandle) {
      throw new Error("Expected early loopback capture handle");
    }
    input.onStdout?.(
      assistant(
        toolUse("call-early", "mcp__openclaw__message", { action: "react", emoji: "early" }),
      ),
    );
    recordMcpLoopbackToolCallResultForHandle({
      captureHandle,
      toolName: "message",
      args: { action: "react", emoji: "early" },
      outcome: "blocked",
      deniedReason: "plugin-approval",
    });
    markMcpLoopbackToolCallFinished(captureHandle);
    input.onStdout?.(
      `${JSON.stringify(messageRecord("user", [toolResult("call-early", "blocked", true)]))}\n${JSON.stringify({ type: "result", session_id: "session-jsonl", result: "done" })}\n`,
    );
    return createManagedRun(createSuccessfulProcessExit());
  });
  const context = claudeJsonlContext();
  context.mcpDeliveryCapture = true;

  const result = await executePreparedCliRun(context);
  expect(result.toolSummary).toEqual({
    calls: 1,
    tools: ["mcp__openclaw__message"],
    failures: 1,
  });

  expect(toolEvents).toMatchObject([
    toolEvent("started", "call-early"),
    toolEvent("blocked", "call-early", { deniedReason: "plugin-approval" }),
  ]);
});

it("correlates parallel same-name loopback calls by arguments instead of admission order", async () => {
  const toolEvents = captureToolEvents();
  mockCaptureSpawn((input, captureKey) => {
    input.onStdout?.(
      assistant(
        toolUse("call-a", "mcp__openclaw__message", { action: "react", emoji: "A" }),
        toolUse("call-b", "mcp__openclaw__message", { action: "react", emoji: "B" }),
      ),
    );
    recordToolOutcome(captureKey, "message", { action: "react", emoji: "B" }, "failed");
    recordToolOutcome(captureKey, "message", { action: "react", emoji: "A" });
    input.onStdout?.(
      `${JSON.stringify(messageRecord("user", [toolResult("call-a", "ok"), toolResult("call-b", "failed", true)]))}\n${JSON.stringify({ type: "result", session_id: "session-jsonl", result: "done" })}\n`,
    );
  });
  const context = claudeJsonlContext();
  context.mcpDeliveryCapture = true;

  const result = await executePreparedCliRun(context);
  expect(result.toolSummary).toEqual({
    calls: 2,
    tools: ["mcp__openclaw__message"],
    failures: 1,
  });

  expect(toolEvents).toMatchObject([
    toolEvent("started", "call-a"),
    toolEvent("started", "call-b"),
    toolEvent("completed", "call-a"),
    toolEvent("error", "call-b", { terminalReason: "failed" }),
  ]);
});

it("keeps identical parallel outcomes unknown with first tool finishes before second CLI identity", async () => {
  const toolEvents = captureToolEvents();
  mockCaptureSpawn((input, captureKey) => {
    const toolArgs = { action: "react", emoji: "same" };
    const emitToolStarts = (...ids: string[]) =>
      input.onStdout?.(
        assistant(...ids.map((id) => toolUse(id, "mcp__openclaw__message", toolArgs))),
      );
    const recordOutcome = (outcome: "completed" | "failed") =>
      recordToolOutcome(captureKey, "message", toolArgs, outcome);
    const emitToolResults = (...ids: string[]) =>
      input.onStdout?.(user(...ids.map((id) => toolResult(id, "ok"))));
    emitToolStarts("call-identical-a");
    recordOutcome("failed");
    recordOutcome("completed");
    emitToolResults("call-identical-a");
    emitToolStarts("call-identical-b");
    emitToolResults("call-identical-b");
    emitToolStarts("call-identical-later");
    recordOutcome("completed");
    input.onStdout?.(
      `${JSON.stringify(messageRecord("user", [toolResult("call-identical-later", "ok")]))}\n${JSON.stringify({ type: "result", session_id: "session-jsonl", result: "done" })}\n`,
    );
  });
  const context = claudeJsonlContext();
  context.mcpDeliveryCapture = true;

  await executePreparedCliRun(context);

  expect(toolEvents).toHaveLength(6);
  expect(toolEvents).toEqual(
    expect.arrayContaining([
      expect.objectContaining(toolEvent("started", "call-identical-a")),
      expect.objectContaining(toolEvent("started", "call-identical-b")),
      expect.objectContaining(
        toolEvent("error", "call-identical-a", { errorCode: "tool_outcome_unknown" }),
      ),
      expect.objectContaining(
        toolEvent("error", "call-identical-b", { errorCode: "tool_outcome_unknown" }),
      ),
      expect.objectContaining(toolEvent("started", "call-identical-later")),
      expect.objectContaining(toolEvent("completed", "call-identical-later")),
    ]),
  );
});

it("uses a loopback outcome that settles during the post-process drain", async () => {
  const toolEvents = captureToolEvents();
  supervisorSpawnMock.mockImplementationOnce(async (input) => {
    const toolArgs = { action: "react", emoji: "A" };
    input.onStdout?.(
      `${JSON.stringify(messageRecord("assistant", [toolUse("call-draining", "mcp__openclaw__message", toolArgs)]))}\n${JSON.stringify({ type: "result", session_id: "session-jsonl", result: "done" })}\n`,
    );
    const captureHandle = markMcpLoopbackToolCallStarted({
      captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY,
      toolName: "message",
      args: toolArgs,
    });
    if (!captureHandle) {
      throw new Error("Expected loopback capture handle");
    }
    setTimeout(() => {
      recordMcpLoopbackToolCallResultForHandle({
        captureHandle,
        toolName: "message",
        args: toolArgs,
        outcome: "completed",
        result: { ok: true },
      });
      markMcpLoopbackToolCallFinished(captureHandle);
    }, 10);
    return createManagedRun(createSuccessfulProcessExit());
  });
  const context = claudeJsonlContext();
  context.mcpDeliveryCapture = true;

  await executePreparedCliRun(context);

  expect(toolEvents).toMatchObject([
    toolEvent("started", "call-draining"),
    toolEvent("completed", "call-draining"),
  ]);
});

it("cancels an outstanding parsed CLI tool when the enclosing run is aborted", async () => {
  const toolEvents = captureToolEvents();
  const abortController = new AbortController();
  const toolStart = assistant(toolUse("call-cancelled", "mcp__openclaw__cron", {}));
  mockCaptureSpawn(
    (input, captureKey) => {
      input.onStdout?.(toolStart);
      recordToolOutcome(captureKey, "cron", {}, "unknown");
      abortController.abort();
    },
    {
      reason: "manual-cancel",
      exitCode: null,
      exitSignal: "SIGTERM",
      durationMs: 50,
      stdout: "",
      stderr: "",
      timedOut: false,
      noOutputTimedOut: false,
    },
  );
  const context = claudeJsonlContext();
  context.params.abortSignal = abortController.signal;
  context.mcpDeliveryCapture = true;

  await expect(executePreparedCliRun(context)).rejects.toThrow("aborted");

  expect(toolEvents).toMatchObject([
    toolEvent("started", "call-cancelled"),
    toolEvent("error", "call-cancelled", {
      errorCategory: "aborted",
      terminalReason: "cancelled",
    }),
  ]);
});

it.each([
  {
    label: "MCP tool",
    type: "mcp_tool_use",
    toolCallId: "call-timeout",
    name: "mcp__openclaw__cron",
    expected: { terminalReason: "timed_out" },
  },
  {
    label: "server-native tool",
    type: "server_tool_use",
    toolCallId: "call-native-unknown",
    name: "web_search",
    expected: { errorCode: "tool_outcome_unknown" },
  },
] as const)("classifies an outstanding parsed $label when the run times out", async (fixture) => {
  const toolEvents = captureToolEvents();
  const toolStart = assistant({
    type: fixture.type,
    id: fixture.toolCallId,
    name: fixture.name,
    input: {},
  });
  mockCaptureSpawn(
    (input, captureKey) => {
      input.onStdout?.(toolStart);
      if (fixture.type === "mcp_tool_use") {
        recordToolOutcome(captureKey, "cron", {}, "unknown");
      }
      if (fixture.type === "server_tool_use") {
        recordToolOutcome(captureKey, "web_search", {});
      }
    },
    {
      reason: "overall-timeout",
      exitCode: null,
      exitSignal: "SIGTERM",
      durationMs: 1_000,
      stdout: "",
      stderr: "",
      timedOut: true,
      noOutputTimedOut: false,
    },
  );

  const context = claudeJsonlContext();
  context.mcpDeliveryCapture = true;
  context.params.onExecutionPhase = vi.fn();
  await expect(executePreparedCliRun(context)).rejects.toMatchObject({
    message: expect.stringMatching(/exceeded timeout/i),
    code: "cli_overall_timeout",
    cliTimeout: {
      mode: "overall",
      timeoutSeconds: 1,
      observedActivity: true,
      activeToolCount: 1,
      backgroundTaskCount: 0,
    },
  });
  expect(context.params.onExecutionPhase).toHaveBeenCalledWith({
    phase: "tool_execution_started",
    provider: "claude-cli",
    model: "model",
    backend: "claude-cli",
  });

  expect(toolEvents).toMatchObject([
    toolEvent("started", fixture.toolCallId),
    toolEvent("error", fixture.toolCallId, { ...fixture.expected }),
  ]);
  if (fixture.type === "server_tool_use") {
    expect(toolEvents[1]).not.toHaveProperty("terminalReason");
  }
});

it("bounds pending and committed JSONL message delivery evidence", async () => {
  const starts = Array.from({ length: 65 }, (_, index) =>
    toolUse(`message-send-${index}`, "mcp__openclaw__message", {
      action: "send",
      channel: TEST_MESSAGE_CHANNEL,
      target: `chat${index}`,
      text: "done",
    }),
  );
  const results = starts.map((start) =>
    toolResult(
      start.id,
      [{ type: "text", text: JSON.stringify({ status: "sent" }) }],
      undefined,
      "mcp_tool_result",
    ),
  );
  const chunks = [
    assistant(...starts, ...results),
    jsonl({ type: "result", session_id: "session-jsonl", result: "done" }),
  ];
  mockOutput(chunks);
  const result = await executePreparedCliRun(claudeJsonlContext());
  expect(result.messagingToolSentTexts).toEqual(["done"]);
  expect(result.messagingToolSentTargets).toHaveLength(64);
  expect(result.messagingToolSentTargets?.[0]?.to).toBe("chat1");
  expect(result.messagingToolSentTargets?.at(-1)?.to).toBe("chat64");
});

it.each([
  { label: "send", dryRun: false, expected: true },
  { label: "dry-run", dryRun: true, expected: undefined },
])("retains possible delivery only for unresolved $label", async ({ dryRun, expected }) => {
  const chunk = assistant(
    toolUse(
      dryRun ? "message-dry-run-unresolved" : "message-send-unresolved",
      "mcp__openclaw__message",
      {
        action: "send",
        channel: TEST_MESSAGE_CHANNEL,
        target: "chat123",
        message: "done",
        ...(dryRun ? { dryRun: true } : {}),
      },
    ),
  );
  mockOutput([chunk], { exitCode: 1, stderr: "failed" });
  const thrown = await executePreparedCliRun(claudeJsonlContext()).catch((error: unknown) => error);
  expect(getCliMessagingDeliveryEvidence(thrown)?.didSendViaMessagingTool).toBe(expected);
});

it("records sessions_yield through the serialized MCP capture", async () => {
  const context = buildPreparedCliRunContext({ output: "text", provider: "google-gemini-cli" });
  context.mcpDeliveryCapture = true;
  supervisorSpawnMock.mockImplementationOnce(async (input) => {
    const captureHandle = markMcpLoopbackRequestStarted(input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY);
    await resolveMcpLoopbackYieldContext(captureHandle)?.onYield(
      "private continuation",
      "Research started; results will follow.",
    );
    markMcpLoopbackRequestFinished(captureHandle);
    input.onStdout?.("yield acknowledged");
    return createManagedRun(createSuccessfulProcessExit());
  });
  const result = await executePreparedCliRun(context);
  expect(result.yielded).toBe(true);
  expect(result.yieldAcknowledgment).toBe("Research started; results will follow.");
});

it("preserves partial delivery evidence from unknown MCP message outcomes", async () => {
  const message = "x".repeat(20 * 1024);
  const context = buildPreparedCliRunContext({ output: "text", provider: "google-gemini-cli" });
  context.mcpDeliveryCapture = true;
  mockCaptureSpawn((input, captureKey) => {
    recordToolOutcome(
      captureKey,
      "message",
      {
        action: "send",
        channel: TEST_MESSAGE_CHANNEL,
        target: "chat123",
        message,
        mediaUrl: "https://example.com/photo.png",
      },
      "unknown",
      Object.assign(new Error("second chunk failed"), { sentBeforeError: true }),
    );
    input.onStdout?.("done");
  });
  const result = await executePreparedCliRun(context);
  expect(result.didSendViaMessagingTool).toBe(true);
  expect(result.messagingToolSentTargets).toEqual([
    expect.objectContaining({
      tool: "message",
      provider: TEST_MESSAGE_CHANNEL,
      to: "chat123",
      text: message,
      mediaUrls: ["https://example.com/photo.png"],
    }),
  ]);
});

it("records current-target evidence for confirmed implicit reply delivery", async () => {
  const context = buildPreparedCliRunContext({ output: "text", provider: "google-gemini-cli" });
  context.mcpDeliveryCapture = true;
  context.params.messageChannel = TEST_MESSAGE_CHANNEL;
  context.params.currentChannelId = "chat123";
  mockCaptureSpawn((input, captureKey) => {
    recordToolOutcome(captureKey, "message", { action: "reply", message: "done" }, "completed", {
      ok: true,
    });
    input.onStdout?.("done");
  });
  const result = await executePreparedCliRun(context);
  expect(result.didSendViaMessagingTool).toBe(true);
  expect(result.messagingToolSentTargets).toEqual([
    expect.objectContaining({ tool: "message", provider: TEST_MESSAGE_CHANNEL, to: "chat123" }),
  ]);
});

it.each([
  { action: "send", exitCode: 0 },
  { action: "poll", exitCode: 1 },
])(
  "retains the final source $action reply through CLI exit $exitCode",
  async ({ action, exitCode }) => {
    const context = buildPreparedCliRunContext({ output: "text", provider: "google-gemini-cli" });
    context.mcpDeliveryCapture = true;
    context.params.sourceReplyDeliveryMode = "message_tool_only";
    context.params.messageChannel = "webchat";
    mockCaptureSpawn(
      (input, captureKey) => {
        recordToolOutcome(
          captureKey,
          "message",
          {
            action,
            channel: TEST_MESSAGE_CHANNEL,
            message: "implicit source reply",
            final: true,
          },
          "completed",
          {
            content: [{ type: "text", text: "sent" }],
            details: {
              deliveryStatus: "sent",
              sourceReplySink: "internal-ui",
              sourceReply: { text: "implicit source reply" },
              messageDelivery: {
                status: "settled",
                partialDelivery: false,
                createdThreadIds: [],
                sourceReplyDelivered: true,
              },
            },
          },
        );
        input.onStdout?.("done");
      },
      { exitCode, stderr: exitCode === 0 ? "" : "CLI failed after delivery" },
    );
    let result: ReturnType<typeof buildCliRunResult>;
    if (exitCode === 0) {
      const output = await executePreparedCliRun(context);
      expect(output.messagingToolSentTargets).toBeUndefined();
      result = buildCliRunResult({
        context,
        output,
        preparedReply: prepareCliRunTerminalReply(context, output),
        usedHistoryPrompt: false,
        userTurnHandled: true,
        sessionBindingDisabled: true,
        preparedContextAgentMeta: {},
      });
    } else {
      const failure = await executePreparedCliRun(context).catch((error: unknown) => error);
      const evidence = getCliMessagingDeliveryEvidence(failure);
      expect(evidence?.messagingToolSentTargets).toBeUndefined();
      if (!evidence) {
        throw new Error("expected CLI failure to retain confirmed delivery evidence");
      }
      result = buildCliDeliveredFailure({
        error: failure,
        evidence,
        context,
        preparedContextAgentMeta: {},
        sessionBindingDisabled: true,
      });
    }
    expect(result.sourceReplyDelivered).toBe(true);
    expect(result.messagingToolSentTargets).toBeUndefined();
    expect(result.messagingToolSourceReplyPayloads).toEqual([
      { text: "implicit source reply", sourceReplyFinal: true },
    ]);
    expect(result.payloads).toEqual([{ text: "implicit source reply" }]);
    expect(result.meta.terminalReply).toEqual({
      disposition: "visible",
      text: "implicit source reply",
    });
    if (exitCode !== 0) {
      expect(result.meta.error).toMatchObject({ kind: "incomplete_turn", fallbackSafe: false });
    }
  },
);

it.each([
  ["explicit final", true, "source", "required", "Delivery complete", true],
  ["default final", undefined, "source", "required", "Delivery complete", true],
  ["progress", false, "source", "required", "Final answer", false],
  ["other conversation", true, "other", "required", "Final answer", false],
  ["partial delivery", true, "partial", "required", "Final answer", false],
  ["failed delivery", true, "failed", "required", "Final answer", false],
  ["dry run", true, "dry-run", "required", "Final answer", false],
  ["unconfirmed delivery", true, "unconfirmed", "required", "Final answer", false],
  ["result obligation", true, "source", "result-required", "Private result", false],
  ["authored silence", true, "source", "required", "NO_REPLY", true],
] as const)(
  "settles automatic external source delivery with %s evidence",
  async (_label, final, delivery, terminalReplyExpectation, text, suppress) => {
    const context = buildPreparedCliRunContext({ output: "text", provider: "local-cli" });
    context.mcpDeliveryCapture = true;
    context.params.sourceReplyDeliveryMode = "automatic";
    context.params.messageChannel = TEST_MESSAGE_CHANNEL;
    context.params.currentChannelId = "source-chat";
    context.params.terminalReplyExpectation = terminalReplyExpectation;
    mockCaptureSpawn((input, captureKey) => {
      recordToolOutcome(
        captureKey,
        "message",
        {
          action: "send",
          channel: TEST_MESSAGE_CHANNEL,
          target: delivery === "other" ? "other-chat" : "source-chat",
          message: "Tool-authored answer",
          ...(final !== undefined ? { final } : {}),
          ...(delivery === "dry-run" ? { dryRun: true } : {}),
        },
        delivery === "failed" || delivery === "partial" ? "failed" : "completed",
        {
          details: {
            ...(delivery !== "other" ? { sourceReplyRoute: "current-source" } : {}),
            ...(delivery !== "unconfirmed"
              ? {
                  messageDelivery: {
                    status:
                      delivery === "failed"
                        ? "failed"
                        : delivery === "dry-run"
                          ? "dryRun"
                          : "settled",
                    partialDelivery: delivery === "partial",
                    createdThreadIds: [],
                    ...(delivery === "source" ? { sourceReplyDelivered: true } : {}),
                  },
                }
              : {}),
          },
        },
      );
      input.onStdout?.(text);
    });
    const output = await executePreparedCliRun(context);
    expect(output.messagingToolSourceReplyPayloads).toBeUndefined();
    const preparedReply = prepareCliRunTerminalReply(context, output);
    const result = buildCliRunResult({
      context,
      output,
      preparedReply,
      usedHistoryPrompt: false,
      userTurnHandled: true,
      sessionBindingDisabled: true,
      preparedContextAgentMeta: {},
    });
    expect(result.payloads).toEqual(suppress ? undefined : [{ text }]);
    if (text === "NO_REPLY") {
      expect(result.meta.terminalReply).toEqual({ disposition: "silent" });
    }
    if (terminalReplyExpectation === "result-required") {
      expect(preparedReply.completedFinalSource).toBe(false);
    } else {
      expect(
        buildEmbeddedRunPayloads({
          ...output,
          assistantTexts: [text],
          lastAssistant: undefined,
          sessionKey: context.params.sessionKey ?? "",
          sourceReplyDeliveryMode: "automatic",
        }),
      ).toEqual(suppress ? [] : [{ text, replyToTag: false }]);
    }
  },
);

it("preserves text and media evidence for confirmed implicit message sends", async () => {
  const context = buildPreparedCliRunContext({ output: "text", provider: "google-gemini-cli" });
  context.mcpDeliveryCapture = true;
  context.params.sourceReplyDeliveryMode = "message_tool_only";
  mockCaptureSpawn((input, captureKey) => {
    for (let delivery = 0; delivery < 2; delivery += 1) {
      recordToolOutcome(
        captureKey,
        "message",
        {
          action: "send",
          message: "implicit reply",
          mediaUrl: "https://example.com/implicit.png",
        },
        "completed",
        {
          ok: true,
          details: {
            deliveryStatus: "sent",
            sourceReplySink: "internal-ui",
            sourceReply: { text: "implicit reply", mediaUrl: "https://example.com/implicit.png" },
          },
        },
      );
    }
    input.onStdout?.("done");
  });
  const result = await executePreparedCliRun(context);
  expect(result.didSendViaMessagingTool).toBe(true);
  expect(result.messagingToolSentTexts).toEqual(["implicit reply"]);
  expect(result.messagingToolSentMediaUrls).toEqual(["https://example.com/implicit.png"]);
  expect(result.messagingToolSentTargets).toBeUndefined();
  expect(result.didDeliverSourceReplyViaMessageTool).toBe(true);
  expect(result.sourceReplyDelivered).toBeUndefined();
  expect(result.messagingToolSourceReplyPayloads).toEqual([
    {
      text: "implicit reply",
      mediaUrl: "https://example.com/implicit.png",
      sourceReplyFinal: true,
    },
    {
      text: "implicit reply",
      mediaUrl: "https://example.com/implicit.png",
      sourceReplyFinal: true,
    },
  ]);
});

it.each([
  ["the exact source route", "account-1", "chat123", "thread-1", true],
  ["the same target in another thread", "account-1", "chat123", "thread-2", false],
] as const)(
  "records explicit message sends only for %s",
  async (_label, accountId, target, threadId, expected) => {
    const context = buildPreparedCliRunContext({ output: "text", provider: "local-cli" });
    context.mcpDeliveryCapture = true;
    context.params.sourceReplyDeliveryMode = "message_tool_only";
    context.params.messageChannel = TEST_MESSAGE_CHANNEL;
    context.params.agentAccountId = "account-1";
    context.params.currentChannelId = "chat123";
    context.params.currentThreadTs = "thread-1";
    mockCaptureSpawn((input, captureKey) => {
      recordToolOutcome(
        captureKey,
        "message",
        {
          action: "send",
          channel: TEST_MESSAGE_CHANNEL,
          accountId,
          target,
          threadId,
          message: "explicit reply",
        },
        "completed",
        {
          ok: true,
          details: {
            deliveryStatus: "sent",
            sourceReplySink: "internal-ui",
            sourceReply: { text: "explicit reply" },
          },
        },
      );
      input.onStdout?.("done");
    });
    const result = await executePreparedCliRun(context);
    expect(result.didDeliverSourceReplyViaMessageTool === true).toBe(expected);
  },
);

it("deactivates a Claude live capture when process startup fails", async () => {
  const context = claudeJsonlContext();
  context.mcpDeliveryCapture = true;
  const controller = new AbortController();
  context.params.abortSignal = controller.signal;
  const addListener = vi.spyOn(controller.signal, "addEventListener");
  const removeListener = vi.spyOn(controller.signal, "removeEventListener");
  context.preparedBackend.backend.liveSession = "claude-stdio";
  const secretInput = {
    fd: 3,
    fingerprint: "credential-a",
    createData: () => Buffer.from("secret"),
  };
  context.preparedBackend.secretInput = secretInput;
  const { activateCapture, deactivateCapture } = installCaptureGrant(context);
  supervisorSpawnMock.mockRejectedValueOnce(new Error("spawn failed"));
  await expect(executePreparedCliRun(context)).rejects.toThrow("spawn failed");
  const abortListener = addListener.mock.calls.find(([event]) => event === "abort")?.[1];
  expect(abortListener).toBeTypeOf("function");
  expect(removeListener).toHaveBeenCalledWith("abort", abortListener);
  expect(activateCapture).toHaveBeenCalledOnce();
  expect(requireSupervisorSpawnInput()).toEqual(expect.objectContaining({ secretInput }));
  expect(deactivateCapture).toHaveBeenCalledExactlyOnceWith(activateCapture.mock.calls[0]?.[0]);
  expect(activateCapture.mock.invocationCallOrder[0]).toBeLessThan(
    supervisorSpawnMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
  );
});

it("captures non-Claude JSONL sends and fences every attempt with a unique key", async () => {
  const context = buildPreparedCliRunContext({ output: "jsonl", provider: "local-cli" });
  context.mcpDeliveryCapture = true;
  const { activateCapture, deactivateCapture } = installCaptureGrant(context);
  deactivateCapture.mockImplementation(() => {
    const assertion = activateCapture.mock.calls.at(-1)?.[1];
    expect(assertion).toBeTypeOf("function");
    expect(assertion).not.toThrow();
  });
  const captureKeys: string[] = [];
  supervisorSpawnMock.mockImplementation(async (input) => {
    const captureKey = input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "";
    expect(activateCapture.mock.calls.at(-1)?.[1]).not.toThrow();
    captureKeys.push(captureKey);
    recordToolOutcome(
      captureKey,
      "message",
      { action: "send", channel: TEST_MESSAGE_CHANNEL, target: "chat123", message: "done" },
      "completed",
      { status: "sent" },
    );
    input.onStdout?.(jsonl({ item: { type: "message", text: "done" } }));
    return createManagedRun(createSuccessfulProcessExit());
  });
  const first = await executePreparedCliRun(context);
  const second = await executePreparedCliRun(context);
  expect(first.didSendViaMessagingTool).toBe(true);
  expect(second.didSendViaMessagingTool).toBe(true);
  expect(captureKeys).toHaveLength(2);
  expect(captureKeys[0]).not.toBe(captureKeys[1]);
  expect(activateCapture.mock.calls.map(([captureKey]) => captureKey)).toEqual(captureKeys);
  expect(deactivateCapture.mock.calls.map(([captureKey]) => captureKey)).toEqual(captureKeys);
  expect(deactivateCapture.mock.invocationCallOrder[0]).toBeLessThan(
    activateCapture.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
  );
});

it("revokes MCP capture at the supervisor deadline before native exit", async () => {
  vi.useFakeTimers();
  const context = buildPreparedCliRunContext({ output: "text", provider: "local-cli" });
  context.mcpDeliveryCapture = true;
  const { activateCapture, deactivateCapture } = installCaptureGrant(context);
  const adapter = createStubChildAdapter();
  vi.mocked(createChildAdapter).mockResolvedValueOnce({
    adapter: { ...adapter, onExit: vi.fn(), onError: vi.fn() },
    ready: Promise.resolve(),
  });
  const supervisor = createProcessSupervisor();
  const spawned = createDeferred<Awaited<ReturnType<ProcessSupervisor["spawn"]>>>();
  supervisorSpawnMock.mockImplementationOnce(async (input) => {
    if (input.mode !== "child") {
      throw new Error("Expected the CLI child transport");
    } // The shared execution fixture already expands the deferred arguments.
    const { resolveArgs: _resolveArgs, ...spawnInput } = input;
    const managed = await supervisor.spawn(spawnInput);
    spawned.resolve(managed);
    return managed;
  });
  const execution = executePreparedCliRun(context);
  const settled = execution.catch(() => undefined);
  try {
    const managed = await Promise.race([
      spawned.promise,
      execution.then(() => {
        throw new Error("CLI completed before the supervisor started");
      }),
    ]);
    const assertCaptureCurrent = activateCapture.mock.calls[0]?.[1];
    expect(assertCaptureCurrent).toBeTypeOf("function");
    expect(assertCaptureCurrent).not.toThrow();
    adapter.killMock.mockImplementation(() => {
      expect(assertCaptureCurrent).toThrow("CLI process authority is no longer active");
    });
    await vi.advanceTimersByTimeAsync(context.params.timeoutMs); // Deadline decisions wait one timer turn for pending child exit notifications.
    await vi.advanceTimersToNextTimerAsync();
    expect(adapter.killMock).toHaveBeenCalledOnce();
    expect(managed.activity.resultSettled).toBe(false);
    expect(deactivateCapture).not.toHaveBeenCalled();
    expect(assertCaptureCurrent).toThrow("CLI process authority is no longer active");
    adapter.settle(null, "SIGTERM");
    await expect(execution).rejects.toMatchObject({ reason: "timeout" });
    expect(deactivateCapture).toHaveBeenCalledOnce();
  } finally {
    adapter.settle(0);
    await settled;
    await supervisor.shutdown();
    vi.mocked(createChildAdapter).mockReset();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
