// Covers CLI execution paths where the process supervisor keeps stdout capture
// disabled and the runner must parse streamed chunks without relying on tails.
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
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
import { captureCliRunStartTime, type PreparedCliRunContext } from "./types.js";
const executePreparedCliRun = wrapPreparedCliRunWithTestAdmission(executePreparedCliRunImpl);
vi.mock("../../process/supervisor/adapters/child.js", () => ({ createChildAdapter: vi.fn() })); // Gateway unit coverage owns quiet-admission timing. These integration cases only
// need to drain calls already in flight, so skip the repeated 250 ms quiet window.
vi.mock("../../gateway/mcp-http.loopback-runtime.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../gateway/mcp-http.loopback-runtime.js")>();
  return {
    ...actual,
    waitForMcpLoopbackToolCallCaptureIdle: (
      captureKey: string,
      options: Parameters<typeof actual.waitForMcpLoopbackToolCallCaptureIdle>[1],
    ) =>
      actual.waitForMcpLoopbackToolCallCaptureIdle(captureKey, { ...options, admissionGraceMs: 0 }),
  };
});
type ProcessSupervisor = ReturnType<typeof getProcessSupervisor>;
type SupervisorSpawnInput = Parameters<ProcessSupervisor["spawn"]>[0];
const TEST_MESSAGE_CHANNEL = "test-channel";

function jsonl(record: unknown) {
  return JSON.stringify(record) + "\n";
}

function messageRecord(role: "assistant" | "user", content: unknown) {
  return { type: role, message: { role, content } };
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
  supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
    const input = args[0] as SupervisorSpawnInput;
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
  supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
    const input = args[0] as SupervisorSpawnInput;
    emit(input, input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "");
    return createManagedRun({ ...createSuccessfulProcessExit(), ...exit });
  });
}

function recordMcpLoopbackToolCallResult(params: {
  captureKey: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  isError: boolean;
  outcome?: "blocked" | "cancelled" | "completed" | "failed" | "timed_out" | "unknown";
  deniedReason?: string;
}): void {
  const captureHandle = markMcpLoopbackToolCallStarted(params);
  if (!captureHandle) {
    return;
  }
  const outcome = params.outcome ?? (params.isError ? "failed" : "completed");
  const result =
    outcome === "blocked"
      ? { outcome, deniedReason: params.deniedReason ?? "plugin-before-tool-call" }
      : { outcome, result: params.result };
  recordMcpLoopbackToolCallResultForHandle({
    captureHandle,
    toolName: params.toolName,
    args: params.args,
    ...result,
  });
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
describe("executePreparedCliRun supervisor output capture", () => {
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
      const context = buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" });
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

  it("passes native compaction as an argument and requires backend acknowledgement", async () => {
    const raw = jsonl({ type: "system", subtype: "compacting" });
    mockOutput([raw]);
    const context = buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" });
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
    const result = await executePreparedCliRun(context);
    expect(requireSupervisorSpawnInput()).toEqual(
      expect.objectContaining({
        argv: ["agent-cli", "/compact"],
        input: "",
        noOutputTimeoutMs: context.params.timeoutMs,
      }),
    );
    expect(result).toMatchObject({ text: "", rawText: "", finalPromptText: "/compact" });
  });

  it("rejects a zero-exit native compaction without backend acknowledgement", async () => {
    const raw = jsonl({ type: "system", subtype: "local_command" });
    mockOutput([raw]);
    const context = buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" });
    context.params.prompt = "/compact";
    context.params.controlOperation = "compact";
    context.backendResolved.manualCompaction = {
      input: "arg",
      buildPrompt: () => "/compact",
      validateOutput: () => ({ ok: false, reason: "native compaction was not acknowledged" }),
    };
    await expect(executePreparedCliRun(context)).rejects.toThrow(
      "native compaction was not acknowledged",
    );
  });

  it("runs prepared backend staging inside the serialized execution queue", async () => {
    const firstSpawnEntered = createDeferred();
    const releaseFirstSpawn = createDeferred();
    const events: string[] = [];
    let spawnCount = 0;
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      spawnCount += 1;
      const input = args[0] as SupervisorSpawnInput;
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
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
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
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
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
    await expect(
      executePreparedCliRun(
        buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" }),
      ),
    ).rejects.toMatchObject({ name: "FailoverError", message: "Credit balance is too low" });
  });

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
    await expect(
      executePreparedCliRun(
        buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" }),
      ),
    ).rejects.toMatchObject({
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
    let failure: unknown;
    try {
      await executePreparedCliRun(context, "fork-source");
    } catch (error) {
      failure = error;
    }
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
    const agentEvents: Array<{ stream: string; phase?: string; text?: string }> = [];
    const trustedEvents: TrustedToolExecutionEvent[] = [];
    const stopAgentEvents = onAgentEvent((event) => {
      agentEvents.push({
        stream: event.stream,
        phase: typeof event.data.phase === "string" ? event.data.phase : undefined,
        text: typeof event.data.text === "string" ? event.data.text : undefined,
      });
    });
    const stopTrustedEvents = onTrustedToolExecutionEvent((event) => trustedEvents.push(event));
    const events = new Map<string, CliBackendParsedJsonlEvent>([
      [
        '{"type":"session","session":"custom-session"}',
        { kind: "sessionId", sessionId: "custom-session" },
      ],
      [
        '{"type":"thinking","text":"Checking facts."}',
        { kind: "thinking", text: "Checking facts." },
      ],
      ['{"type":"text","text":"Hello world"}', { kind: "text", text: "Hello world" }],
      [
        '{"type":"tool-start","id":"call-1","name":"search"}',
        { kind: "toolStart", toolCallId: "call-1", name: "search", args: { query: "weather" } },
      ],
      [
        '{"type":"tool-result","id":"call-1","name":"search","result":"sunny"}',
        { kind: "toolResult", toolCallId: "call-1", name: "search", result: "sunny" },
      ],
      [
        '{"type":"result","text":"Hello world","session":"custom-successor"}',
        {
          kind: "result",
          text: "Hello world",
          sessionId: "custom-successor",
          usage: { input: 4, output: 2, total: 6 },
        },
      ],
    ]);
    const parseJsonlEvent: CliBackendParseJsonlEvent = (line) => events.get(line);
    mockOutput([...events.keys()].map((line) => `${line}\n`));
    try {
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
    } finally {
      stopAgentEvents();
      stopTrustedEvents();
    }
  });

  it("streams native thinking snapshots and text with supervisor capture disabled", async () => {
    // Streaming events are emitted from live chunks, not from the final captured
    // stdout string, so users still see deltas when captureOutput is false.
    const agentEvents: Array<{
      stream: string;
      text?: string;
      delta?: string;
      isReasoningSnapshot?: boolean;
    }> = [];
    const stop = onAgentEvent((event) => {
      if (event.stream !== "assistant" && event.stream !== "thinking") {
        return;
      }
      agentEvents.push({
        stream: event.stream,
        text: typeof event.data.text === "string" ? event.data.text : undefined,
        delta: typeof event.data.delta === "string" ? event.data.delta : undefined,
        ...(event.data.isReasoningSnapshot === true ? { isReasoningSnapshot: true } : {}),
      });
    });
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
    try {
      const context = buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" });
      context.params.onExecutionPhase = vi.fn();
      const result = await executePreparedCliRun(context);
      const spawnInput = requireSupervisorSpawnInput();
      expect(spawnInput.captureOutput).toBe(false);
      expect(result.text).toBe("Hello world");
      expect(result.toolSummary).toEqual({ calls: 0, tools: [], failures: 0 });
      expect(agentEvents).toEqual([
        { stream: "thinking", text: "Checking ", delta: "Checking ", isReasoningSnapshot: true },
        { stream: "thinking", text: "Checking facts.", delta: "facts.", isReasoningSnapshot: true },
        {
          stream: "thinking",
          text: "Checking the facts.",
          delta: "the ",
          isReasoningSnapshot: true,
        },
        {
          stream: "thinking",
          text: "Checking the facts. Done.",
          delta: " Done.",
          isReasoningSnapshot: true,
        },
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
    } finally {
      stop();
    }
  });

  it("emits metadata-only lifecycle records for parsed CLI tools", async () => {
    const secret = "secret tool input and result";
    const toolEvents = captureToolEvents();
    const chunks = [
      jsonl(
        messageRecord("assistant", [
          toolUse("call-1", "Bash", { command: `sleep ${secret}` }, "tool_use"),
        ]),
      ),
      jsonl(messageRecord("user", [toolResult("call-1", [{ type: "text", text: secret }])])),
      jsonl({ type: "result", session_id: "session-jsonl", result: "done" }),
    ];
    mockOutput(chunks);
    const context = buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" });
    context.params.sessionKey = "agent:coder:main";
    context.params.agentId = "coder";

    const result = await executePreparedCliRun(context);
    expect(result.toolSummary).toEqual({ calls: 1, tools: ["Bash"], failures: 0 });

    expect(toolEvents).toEqual([
      expect.objectContaining({
        type: "tool.execution.started",
        runId: "run-jsonl",
        sessionKey: "agent:coder:main",
        sessionId: "session-1",
        agentId: "coder",
        toolName: "Bash",
        toolSource: "core",
        toolOwner: "cli-runner",
        toolCallId: "call-1",
      }),
      expect.objectContaining({
        type: "tool.execution.completed",
        runId: "run-jsonl",
        toolCallId: "call-1",
      }),
    ]);
    expect(JSON.stringify(toolEvents)).not.toContain(secret);
  });

  it("binds a loopback call admitted before its parsed CLI identity", async () => {
    const toolEvents = captureToolEvents();
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      const captureHandle = markMcpLoopbackToolCallStarted({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY,
        toolName: "message",
        args: { action: "react", emoji: "early" },
      });
      if (!captureHandle) {
        throw new Error("Expected early loopback capture handle");
      }
      input.onStdout?.(
        jsonl(
          messageRecord("assistant", [
            toolUse("call-early", "mcp__openclaw__message", { action: "react", emoji: "early" }),
          ]),
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
    const context = buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" });
    context.mcpDeliveryCapture = true;

    const result = await executePreparedCliRun(context);
    expect(result.toolSummary).toEqual({
      calls: 1,
      tools: ["mcp__openclaw__message"],
      failures: 1,
    });

    expect(toolEvents).toMatchObject([
      { type: "tool.execution.started", toolCallId: "call-early" },
      { type: "tool.execution.blocked", toolCallId: "call-early", deniedReason: "plugin-approval" },
    ]);
  });

  it("correlates parallel same-name loopback calls by arguments instead of admission order", async () => {
    const toolEvents = captureToolEvents();
    mockCaptureSpawn((input, captureKey) => {
      input.onStdout?.(
        jsonl(
          messageRecord("assistant", [
            toolUse("call-a", "mcp__openclaw__message", { action: "react", emoji: "A" }),
            toolUse("call-b", "mcp__openclaw__message", { action: "react", emoji: "B" }),
          ]),
        ),
      );
      recordMcpLoopbackToolCallResult({
        captureKey,
        toolName: "message",
        args: { action: "react", emoji: "B" },
        isError: true,
        outcome: "failed",
      });
      recordMcpLoopbackToolCallResult({
        captureKey,
        toolName: "message",
        args: { action: "react", emoji: "A" },
        isError: false,
        outcome: "completed",
      });
      input.onStdout?.(
        `${JSON.stringify(messageRecord("user", [toolResult("call-a", "ok"), toolResult("call-b", "failed", true)]))}\n${JSON.stringify({ type: "result", session_id: "session-jsonl", result: "done" })}\n`,
      );
    });
    const context = buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" });
    context.mcpDeliveryCapture = true;

    const result = await executePreparedCliRun(context);
    expect(result.toolSummary).toEqual({
      calls: 2,
      tools: ["mcp__openclaw__message"],
      failures: 1,
    });

    expect(toolEvents).toMatchObject([
      { type: "tool.execution.started", toolCallId: "call-a" },
      { type: "tool.execution.started", toolCallId: "call-b" },
      { type: "tool.execution.completed", toolCallId: "call-a" },
      { type: "tool.execution.error", toolCallId: "call-b", terminalReason: "failed" },
    ]);
  });

  it("keeps identical parallel outcomes unknown with first tool finishes before second CLI identity", async () => {
    const toolEvents = captureToolEvents();
    mockCaptureSpawn((input, captureKey) => {
      const toolArgs = { action: "react", emoji: "same" };
      const emitToolStarts = (toolCallIds: string[]) => {
        input.onStdout?.(
          jsonl(
            messageRecord(
              "assistant",
              toolCallIds.map((id) => toolUse(id, "mcp__openclaw__message", toolArgs)),
            ),
          ),
        );
      };
      const recordOutcome = (outcome: "completed" | "failed") =>
        recordMcpLoopbackToolCallResult({
          captureKey,
          toolName: "message",
          args: toolArgs,
          isError: outcome === "failed",
          outcome,
        });
      const emitToolResults = (toolCallIds: string[]) => {
        input.onStdout?.(
          jsonl(
            messageRecord(
              "user",
              toolCallIds.map((toolCallId) => toolResult(toolCallId, "ok")),
            ),
          ),
        );
      };
      emitToolStarts(["call-identical-a"]);
      recordOutcome("failed");
      recordOutcome("completed");
      emitToolResults(["call-identical-a"]);
      emitToolStarts(["call-identical-b"]);
      emitToolResults(["call-identical-b"]);
      emitToolStarts(["call-identical-later"]);
      recordOutcome("completed");
      input.onStdout?.(
        `${JSON.stringify(messageRecord("user", [toolResult("call-identical-later", "ok")]))}\n${JSON.stringify({ type: "result", session_id: "session-jsonl", result: "done" })}\n`,
      );
    });
    const context = buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" });
    context.mcpDeliveryCapture = true;

    await executePreparedCliRun(context);

    expect(toolEvents).toHaveLength(6);
    expect(toolEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool.execution.started", toolCallId: "call-identical-a" }),
        expect.objectContaining({ type: "tool.execution.started", toolCallId: "call-identical-b" }),
        expect.objectContaining({
          type: "tool.execution.error",
          toolCallId: "call-identical-a",
          errorCode: "tool_outcome_unknown",
        }),
        expect.objectContaining({
          type: "tool.execution.error",
          toolCallId: "call-identical-b",
          errorCode: "tool_outcome_unknown",
        }),
        expect.objectContaining({
          type: "tool.execution.started",
          toolCallId: "call-identical-later",
        }),
        expect.objectContaining({
          type: "tool.execution.completed",
          toolCallId: "call-identical-later",
        }),
      ]),
    );
  });

  it("uses a loopback outcome that settles during the post-process drain", async () => {
    const toolEvents = captureToolEvents();
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
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
    const context = buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" });
    context.mcpDeliveryCapture = true;

    await executePreparedCliRun(context);

    expect(toolEvents).toMatchObject([
      { type: "tool.execution.started", toolCallId: "call-draining" },
      { type: "tool.execution.completed", toolCallId: "call-draining" },
    ]);
  });

  it("cancels an outstanding parsed CLI tool when the enclosing run is aborted", async () => {
    const toolEvents = captureToolEvents();
    const abortController = new AbortController();
    const toolStart = jsonl(
      messageRecord("assistant", [toolUse("call-cancelled", "mcp__openclaw__cron", {})]),
    );
    mockCaptureSpawn(
      (input, captureKey) => {
        input.onStdout?.(toolStart);
        recordMcpLoopbackToolCallResult({
          captureKey,
          toolName: "cron",
          args: {},
          isError: true,
          outcome: "unknown",
        });
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
    const context = buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" });
    context.params.abortSignal = abortController.signal;
    context.mcpDeliveryCapture = true;

    await expect(executePreparedCliRun(context)).rejects.toThrow("aborted");

    expect(toolEvents).toMatchObject([
      { type: "tool.execution.started", toolCallId: "call-cancelled" },
      {
        type: "tool.execution.error",
        toolCallId: "call-cancelled",
        errorCategory: "aborted",
        terminalReason: "cancelled",
      },
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
    const toolStart = jsonl(
      messageRecord("assistant", [
        { type: fixture.type, id: fixture.toolCallId, name: fixture.name, input: {} },
      ]),
    );
    mockCaptureSpawn(
      (input, captureKey) => {
        input.onStdout?.(toolStart);
        if (fixture.type === "mcp_tool_use") {
          recordMcpLoopbackToolCallResult({
            captureKey,
            toolName: "cron",
            args: {},
            isError: true,
            outcome: "unknown",
          });
        }
        if (fixture.type === "server_tool_use") {
          recordMcpLoopbackToolCallResult({
            captureKey,
            toolName: "web_search",
            args: {},
            isError: false,
            outcome: "completed",
          });
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

    const context = buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" });
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
      { type: "tool.execution.started", toolCallId: fixture.toolCallId },
      { type: "tool.execution.error", toolCallId: fixture.toolCallId, ...fixture.expected },
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
      jsonl(messageRecord("assistant", [...starts, ...results])),
      jsonl({ type: "result", session_id: "session-jsonl", result: "done" }),
    ];
    mockOutput(chunks);
    const result = await executePreparedCliRun(
      buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" }),
    );
    expect(result.messagingToolSentTexts).toEqual(["done"]);
    expect(result.messagingToolSentTargets).toHaveLength(64);
    expect(result.messagingToolSentTargets?.[0]?.to).toBe("chat1");
    expect(result.messagingToolSentTargets?.at(-1)?.to).toBe("chat64");
  });

  it.each([
    { label: "send", dryRun: false, expected: true },
    { label: "dry-run", dryRun: true, expected: undefined },
  ])("retains possible delivery only for unresolved $label", async ({ dryRun, expected }) => {
    const chunk = jsonl(
      messageRecord("assistant", [
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
      ]),
    );
    mockOutput([chunk], { exitCode: 1, stderr: "failed" });
    let thrown: unknown;
    try {
      await executePreparedCliRun(
        buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(getCliMessagingDeliveryEvidence(thrown)?.didSendViaMessagingTool).toBe(expected);
  });

  it("records sessions_yield through the serialized MCP capture", async () => {
    const context = buildPreparedCliRunContext({ output: "text", provider: "google-gemini-cli" });
    context.mcpDeliveryCapture = true;
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
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
      recordMcpLoopbackToolCallResult({
        captureKey,
        toolName: "message",
        args: {
          action: "send",
          channel: TEST_MESSAGE_CHANNEL,
          target: "chat123",
          message,
          mediaUrl: "https://example.com/photo.png",
        },
        result: Object.assign(new Error("second chunk failed"), { sentBeforeError: true }),
        isError: true,
        outcome: "unknown",
      });
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
      recordMcpLoopbackToolCallResult({
        captureKey,
        toolName: "message",
        args: { action: "reply", message: "done" },
        result: { ok: true },
        isError: false,
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
    "retains source $action delivery and suppresses assistant output through CLI exit $exitCode",
    async ({ action, exitCode }) => {
      const context = buildPreparedCliRunContext({ output: "text", provider: "google-gemini-cli" });
      context.mcpDeliveryCapture = true;
      context.params.sourceReplyDeliveryMode = "message_tool_only";
      context.params.messageChannel = "webchat";
      mockCaptureSpawn(
        (input, captureKey) => {
          recordMcpLoopbackToolCallResult({
            captureKey,
            toolName: "message",
            args: { action, channel: TEST_MESSAGE_CHANNEL, message: "implicit source reply" },
            result: {
              content: [{ type: "text", text: "sent" }],
              details: {
                messageDelivery: {
                  status: "settled",
                  partialDelivery: false,
                  createdThreadIds: [],
                  sourceReplyDelivered: true,
                },
              },
            },
            isError: false,
          });
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
          usedHistoryPrompt: false,
          userTurnHandled: true,
          sessionBindingDisabled: true,
          preparedContextAgentMeta: {},
        });
      } else {
        let failure: unknown;
        try {
          await executePreparedCliRun(context);
        } catch (error) {
          failure = error;
        }
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
      expect(result.payloads).toBeUndefined();
    },
  );

  it("preserves text and media evidence for confirmed implicit message sends", async () => {
    const context = buildPreparedCliRunContext({ output: "text", provider: "google-gemini-cli" });
    context.mcpDeliveryCapture = true;
    context.params.sourceReplyDeliveryMode = "message_tool_only";
    mockCaptureSpawn((input, captureKey) => {
      for (let delivery = 0; delivery < 2; delivery += 1) {
        recordMcpLoopbackToolCallResult({
          captureKey,
          toolName: "message",
          args: {
            action: "send",
            message: "implicit reply",
            mediaUrl: "https://example.com/implicit.png",
          },
          result: {
            ok: true,
            details: {
              deliveryStatus: "sent",
              sourceReplySink: "internal-ui",
              sourceReply: { text: "implicit reply", mediaUrl: "https://example.com/implicit.png" },
            },
          },
          isError: false,
        });
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
        recordMcpLoopbackToolCallResult({
          captureKey,
          toolName: "message",
          args: {
            action: "send",
            channel: TEST_MESSAGE_CHANNEL,
            accountId,
            target,
            threadId,
            message: "explicit reply",
          },
          result: {
            ok: true,
            details: {
              deliveryStatus: "sent",
              sourceReplySink: "internal-ui",
              sourceReply: { text: "explicit reply" },
            },
          },
          isError: false,
        });
        input.onStdout?.("done");
      });
      const result = await executePreparedCliRun(context);
      expect(result.didDeliverSourceReplyViaMessageTool === true).toBe(expected);
    },
  );

  it("deactivates a Claude live capture when process startup fails", async () => {
    const context = buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" });
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
    const activateCapture = vi.fn<(captureKey: string) => void>();
    const deactivateCapture = vi.fn<(captureKey: string) => void>();
    context.preparedBackend.mcpClientGrantCapture = {
      transportToken: "capture-test-token",
      adoptProcessToken: vi.fn(),
      revokeProcessToken: vi.fn(),
      activate: activateCapture,
      deactivate: deactivateCapture,
    };
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
    const activateCapture = vi.fn<(captureKey: string, assertCurrent: () => void) => void>();
    const deactivateCapture = vi.fn((_captureKey: string) => {
      const assertion = activateCapture.mock.calls.at(-1)?.[1];
      expect(assertion).toBeTypeOf("function");
      expect(assertion).not.toThrow();
    });
    context.preparedBackend.mcpClientGrantCapture = {
      transportToken: "capture-test-token",
      adoptProcessToken: vi.fn(),
      revokeProcessToken: vi.fn(),
      activate: activateCapture,
      deactivate: deactivateCapture,
    };
    const captureKeys: string[] = [];
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      const captureKey = input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "";
      expect(activateCapture.mock.calls.at(-1)?.[1]).not.toThrow();
      captureKeys.push(captureKey);
      recordMcpLoopbackToolCallResult({
        captureKey,
        toolName: "message",
        args: { action: "send", channel: TEST_MESSAGE_CHANNEL, target: "chat123", message: "done" },
        result: { status: "sent" },
        isError: false,
      });
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
    const activateCapture = vi.fn<(captureKey: string, assertCurrent: () => void) => void>();
    const deactivateCapture = vi.fn();
    context.preparedBackend.mcpClientGrantCapture = {
      transportToken: "capture-test-token",
      adoptProcessToken: vi.fn(),
      revokeProcessToken: vi.fn(),
      activate: activateCapture,
      deactivate: deactivateCapture,
    };
    const adapter = createStubChildAdapter();
    vi.mocked(createChildAdapter).mockResolvedValueOnce({
      adapter: { ...adapter, onExit: vi.fn(), onError: vi.fn() },
      ready: Promise.resolve(),
    });
    const supervisor = createProcessSupervisor();
    const spawned = createDeferred<Awaited<ReturnType<ProcessSupervisor["spawn"]>>>();
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
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
}); /* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
