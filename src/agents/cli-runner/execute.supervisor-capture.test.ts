// Covers CLI execution paths where the process supervisor keeps stdout capture
// disabled and the runner must parse streamed chunks without relying on tails.
import { assert, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { buildExternalRunFailureReply } from "../../auto-reply/reply/agent-runner-failure-reply.js";
import { buildReplyPayloads } from "../../auto-reply/reply/agent-runner-payloads.js";
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
  waitForDiagnosticEventsDrained,
  type TrustedToolExecutionEvent,
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
import { createPreparedCliContext } from "./prepared-context.test-support.js";
import { prepareCliRunTerminalReply } from "./terminal-reply.js";
import type { PreparedCliRunContext } from "./types.js";
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

function terminal(result = "done", session_id = "session-jsonl") {
  return jsonl({ type: "result", session_id, result });
}
function messageUse(id: string, input: Record<string, unknown>) {
  return toolUse(id, "mcp__openclaw__message", input);
}

function streamDelta(delta: unknown, index?: number) {
  return jsonl({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      ...(index === undefined ? {} : { index }),
      delta,
    },
  });
}

function toolResult(
  tool_use_id: string,
  content: unknown,
  is_error?: boolean,
  type = "tool_result",
) {
  return { type, tool_use_id, content, ...(is_error === undefined ? {} : { is_error }) };
}

type ToolEventSpec = [
  kind: "started" | "completed" | "error" | "blocked",
  toolCallId: string,
  details?: Record<string, unknown>,
];
function expectToolEvents(
  events: TrustedToolExecutionEvent[],
  specs: ToolEventSpec[],
  unordered = false,
) {
  const expected = specs.map(([kind, toolCallId, details]) =>
    expect.objectContaining({ type: `tool.execution.${kind}`, toolCallId, ...details }),
  );
  expect(events).toEqual(unordered ? expect.arrayContaining(expected) : expected);
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
  const context = createPreparedCliContext(
    { provider, model: "model", runId, agentId: "main", sessionKey: "agent:main:main" },
    { id: provider, config: backend, bundleMcp: false, parseJsonlEvent: params.parseJsonlEvent },
  );
  context.preparedBackend.beforeExecution = params.beforeExecution;
  return context;
}

function claudeJsonlContext() {
  return buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" });
}
function captureContext(provider = "claude-cli", output: "text" | "jsonl" = "jsonl") {
  const context = buildPreparedCliRunContext({ output, provider });
  context.mcpDeliveryCapture = true;
  return context;
}

function settledResult(
  context: PreparedCliRunContext,
  output: Awaited<ReturnType<typeof executePreparedCliRun>>,
  preparedReply = prepareCliRunTerminalReply(context, output),
) {
  return buildCliRunResult({
    context,
    output,
    preparedReply,
    usedHistoryPrompt: false,
    userTurnHandled: true,
    sessionBindingDisabled: true,
    preparedContextAgentMeta: {},
  });
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
  const input = supervisorSpawnMock.mock.calls[index]?.[0];
  assert.isDefined(input, "Expected supervisor spawn");
  return input;
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
});

function createDiagnosticFixture() {
  const time = { now: 1_000_000 };
  const clock = vi.spyOn(Date, "now").mockImplementation(() => time.now);
  const owners: ReturnType<typeof createDiagnosticEmbeddedRunOwner>[] = [];
  const holds: ReturnType<typeof holdSupervisorRun>[] = [];
  const runs: Promise<unknown>[] = [];
  return {
    time,
    owner(this: void, context: PreparedCliRunContext, bind = true) {
      const owner = createDiagnosticEmbeddedRunOwner(context.params);
      owners.push(owner);
      if (bind) {
        context.params.diagnosticOwner = owner;
      }
      return owner;
    },
    hold(this: void) {
      const held = holdSupervisorRun();
      holds.push(held);
      return held;
    },
    run(this: void, context: PreparedCliRunContext) {
      const pending = executePreparedCliRun(context);
      runs.push(pending);
      return pending;
    },
    async close() {
      holds.forEach((held) => held.release());
      await Promise.allSettled(runs);
      owners.forEach(closeDiagnosticEmbeddedRunOwner);
      clock.mockRestore();
    },
  };
}
// Restore process-global state before the next isolate=false test file observes it.
async function withDiagnosticsEnabled<T>(
  run: (fixture: ReturnType<typeof createDiagnosticFixture>) => Promise<T>,
): Promise<T> {
  const previouslyEnabled = areDiagnosticsEnabledForProcess();
  setDiagnosticsEnabledForProcess(true);
  startDiagnosticRunActivityTracking();
  const fixture = createDiagnosticFixture();
  try {
    return await run(fixture);
  } finally {
    await fixture.close();
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
  await withDiagnosticsEnabled(async ({ time, owner, hold, run }) => {
    const firstContext = buildPreparedCliRunContext({ output: "text", provider: "fixture-cli" });
    const firstOwner = owner(firstContext);
    markDiagnosticEmbeddedRunStarted({ ...firstContext.params, owner: firstOwner });
    const firstHeld = hold();
    const firstRun = run(firstContext);
    const successorOwner = owner(firstContext, false);
    await firstHeld.entered;
    const oldInput = requireSupervisorSpawnInput();
    oldInput.onStdout?.("first");
    await waitForDiagnosticEventsDrained();
    closeDiagnosticEmbeddedRunOwner(firstOwner);
    markDiagnosticEmbeddedRunStarted({ ...firstContext.params, owner: successorOwner });
    time.now += 100;
    const before = getDiagnosticSessionActivitySnapshot(firstContext.params);
    expect(before.activeBackendLivenessDeadlineAtMs).toBeUndefined();
    oldInput.onStdout?.(" late old output");
    await waitForDiagnosticEventsDrained();
    expect(getDiagnosticSessionActivitySnapshot(firstContext.params)).toEqual(before);
    firstHeld.release();
    await firstRun;
    await waitForDiagnosticEventsDrained();
    expect(getDiagnosticSessionActivitySnapshot(firstContext.params)).toEqual(before);
  });
});

it("retains the newer same-session allowance when an overlapping serialize:false call settles", async () => {
  await withDiagnosticsEnabled(async ({ time, owner, hold, run }) => {
    const contexts = ["first", "second"].map((label) => {
      const context = buildPreparedCliRunContext({
        output: "text",
        provider: "fixture-cli",
        runId: `overlap-${label}`,
      });
      context.preparedBackend.backend.serialize = false;
      return context;
    });
    const [first, second] = contexts;
    assert(first && second);
    const firstOwner = owner(first, false);
    const secondOwner = owner(second, false);
    first.params.diagnosticOwner = firstOwner;
    second.params.diagnosticOwner = secondOwner;
    const firstHeld = hold();
    const secondHeld = hold();
    markDiagnosticEmbeddedRunStarted({ ...first.params, owner: firstOwner });
    const firstRun = run(first);
    await firstHeld.entered;
    time.now += 100;
    markDiagnosticEmbeddedRunStarted({ ...second.params, owner: secondOwner });
    const secondRun = run(second);
    await secondHeld.entered;
    const secondInput = requireSupervisorSpawnInput(1);
    const quietMs = secondInput.noOutputTimeoutMs;
    if (quietMs === undefined) {
      throw new Error("Expected the second CLI child's quiet timeout");
    }
    const deadline = time.now + quietMs;
    expect(getDiagnosticSessionActivitySnapshot(second.params)).toMatchObject({
      activeBackendLivenessDeadlineAtMs: deadline,
    });
    requireSupervisorSpawnInput().onStdout?.("first");
    firstHeld.release();
    await expect(firstRun).resolves.toMatchObject({ text: "first" });
    closeDiagnosticEmbeddedRunOwner(firstOwner);
    await waitForDiagnosticEventsDrained();
    expect(getDiagnosticSessionActivitySnapshot(second.params)).toMatchObject({
      hasActiveEmbeddedRun: true,
      activeBackendLivenessDeadlineAtMs: deadline,
    });
    secondInput.onStdout?.("second");
    secondHeld.release();
    await expect(secondRun).resolves.toMatchObject({ text: "second" });
  });
});

it("renews Agent progress only for attributed semantic subagent records", async () => {
  await withDiagnosticsEnabled(async ({ time, owner, hold, run }) => {
    const parentId = "toolu_parent";
    const context = claudeJsonlContext();
    const diagnosticOwner = owner(context);
    markDiagnosticEmbeddedRunStarted({ ...context.params, owner: diagnosticOwner });
    const held = hold();
    const execution = run(context);
    await held.entered;
    const input = requireSupervisorSpawnInput();
    const quietMs = input.noOutputTimeoutMs;
    if (quietMs === undefined) {
      throw new Error("Expected CLI quiet timeout");
    }
    const emit = (record: unknown) => input.onStdout?.(jsonl(record));
    emit(messageRecord("assistant", [toolUse(parentId, "Agent", {}, "tool_use")]));
    await waitForDiagnosticEventsDrained();
    time.now += 800_000;
    emit({
      type: "stream_event",
      parent_tool_use_id: parentId,
      event: {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "still working" },
      },
    });
    emit({
      ...messageRecord("assistant", [toolUse("toolu_child", "Read", {}, "tool_use")]),
      parent_tool_use_id: "toolu_other",
    });
    await waitForDiagnosticEventsDrained();
    expect(getDiagnosticSessionActivitySnapshot(context.params)).toMatchObject({
      activeWorkKind: "tool_call",
      activeToolName: "Agent",
      activeToolCallId: parentId,
      lastProgressReason: "tool:Agent:started",
      lastProgressAgeMs: 800_000,
    });
    emit({
      ...messageRecord("user", [toolResult("toolu_child", "file")]),
      parent_tool_use_id: parentId,
    });
    await waitForDiagnosticEventsDrained();
    expect(getDiagnosticSessionActivitySnapshot(context.params)).toMatchObject({
      activeToolName: "Agent",
      activeToolCallId: parentId,
      lastProgressReason: "tool:Agent:subagent_progress",
      lastProgressAgeMs: 0,
      activeToolAgeMs: 800_000,
    });
    time.now += 800_000;
    input.onStdout?.("noise\n");
    await waitForDiagnosticEventsDrained();
    expect(getDiagnosticSessionActivitySnapshot(context.params)).toMatchObject({
      activeToolName: "Agent",
      lastProgressReason: "tool:Agent:subagent_progress",
      lastProgressAgeMs: 800_000,
      activeToolAgeMs: 1_600_000,
      activeBackendLivenessDeadlineAtMs: time.now + quietMs,
    });
    emit({ type: "result", session_id: "session-agent", result: "done" });
    held.release();
    await expect(execution).resolves.toMatchObject({ text: "done" });
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
  const start = (label: string) =>
    executePreparedCliRun(
      buildPreparedCliRunContext({
        output: "text",
        runId: `run-${label}`,
        beforeExecution: async () => {
          events.push(`stage:${label}`);
        },
      }),
    );
  const first = start("first");
  await firstSpawnEntered.promise;
  const second = start("second");
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
  const stdout = `start-${"x".repeat(textBytes - 10)}-end`;
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
  const largeToolEvent = streamDelta({ type: "tool_delta", text: "x".repeat(2 * 1024 * 1024) });
  const resultEvent = terminal("resumed answer", "resume-jsonl-session");
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
  expect(result).toMatchObject({ text: "resumed answer", sessionId: "resume-jsonl-session" });
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
  const stdout =
    jsonl({
      type: "assistant",
      message: {
        model: "<synthetic>",
        role: "assistant",
        content: [{ type: "text", text: "No response requested." }],
      },
    }) +
    jsonl({ type: "result", subtype: "success", session_id: "claude-synthetic-empty", result: "" });
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

it.each([false, true])(
  "preserves the terminal failure through fork persistence errors (restore fails: %s)",
  async (restoreFails) => {
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
    const restoreError = new Error("fork restoration lost its session ownership");
    const restoreCliSessionFork = restoreFails
      ? vi.fn().mockRejectedValue(restoreError)
      : vi.fn().mockResolvedValue(undefined);
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
    const persistenceFailure = restoreFails ? (failure as AggregateError).errors[0] : failure;
    if (restoreFails) {
      expect((failure as AggregateError).errors).toEqual([persistenceFailure, restoreError]);
      expect((failure as AggregateError).cause).toBe(persistenceFailure);
    }
    expect((persistenceFailure as AggregateError).errors).toEqual([
      expect.objectContaining({ code: "cli_max_turns" }),
      persistenceError,
    ]);
    expect(findCliTerminalStopError(failure)).toMatchObject({ code: "cli_max_turns" });
    expect(resolveAgentRunErrorLifecycleFields(failure, undefined)).toEqual({});
    expect((persistenceFailure as AggregateError).cause).toBe(
      (persistenceFailure as AggregateError).errors[0],
    );
    expect((failure as AggregateError).message).toContain(
      "CLI turn failed and its fork successor could not be persisted",
    );
    expect(persistCliSessionForkSuccessor).toHaveBeenCalledWith("fork-successor");
    expect(restoreCliSessionFork).toHaveBeenCalledTimes(1);
  },
);

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
    ].map(({ index, thinking }) => streamDelta({ type: "thinking_delta", thinking }, index)),
    streamDelta({ type: "text_delta", text: "Hello" }),
    `not-json ${"x".repeat(80 * 1024)}\n`,
    streamDelta({ type: "text_delta", text: " world" }),
    terminal("Hello world"),
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
    terminal(),
  ];
  mockOutput(chunks);
  const context = claudeJsonlContext();
  context.params.sessionKey = "agent:coder:main";
  context.params.agentId = "coder";

  const result = await executePreparedCliRun(context);
  expect(result.toolSummary).toEqual({ calls: 1, tools: ["Bash"], failures: 0 });

  expectToolEvents(toolEvents, [
    [
      "started",
      "call-1",
      {
        runId: "run-jsonl",
        sessionKey: "agent:coder:main",
        sessionId: "session-1",
        agentId: "coder",
        toolName: "Bash",
        toolSource: "core",
        toolOwner: "cli-runner",
      },
    ],
    ["completed", "call-1", { runId: "run-jsonl" }],
  ]);
  expect(JSON.stringify(toolEvents)).not.toContain(secret);
});

it("binds a loopback call admitted before its parsed CLI identity", async () => {
  const toolEvents = captureToolEvents();
  mockCaptureSpawn((input, captureKey) => {
    const args = { action: "react", emoji: "early" };
    const captureHandle = markMcpLoopbackToolCallStarted({
      captureKey,
      toolName: "message",
      args,
    });
    if (!captureHandle) {
      throw new Error("Expected early loopback capture handle");
    }
    input.onStdout?.(assistant(messageUse("call-early", args)));
    recordMcpLoopbackToolCallResultForHandle({
      captureHandle,
      toolName: "message",
      args,
      outcome: "blocked",
      deniedReason: "plugin-approval",
    });
    markMcpLoopbackToolCallFinished(captureHandle);
    input.onStdout?.(`${user(toolResult("call-early", "blocked", true))}${terminal()}`);
  });
  const context = captureContext();

  const result = await executePreparedCliRun(context);
  expect(result.toolSummary).toEqual({
    calls: 1,
    tools: ["mcp__openclaw__message"],
    failures: 1,
  });

  expectToolEvents(toolEvents, [
    ["started", "call-early"],
    ["blocked", "call-early", { deniedReason: "plugin-approval" }],
  ]);
});

it("correlates parallel same-name loopback calls by arguments instead of admission order", async () => {
  const toolEvents = captureToolEvents();
  mockCaptureSpawn((input, captureKey) => {
    input.onStdout?.(
      assistant(
        messageUse("call-a", { action: "react", emoji: "A" }),
        messageUse("call-b", { action: "react", emoji: "B" }),
      ),
    );
    recordToolOutcome(captureKey, "message", { action: "react", emoji: "B" }, "failed");
    recordToolOutcome(captureKey, "message", { action: "react", emoji: "A" });
    input.onStdout?.(
      `${user(toolResult("call-a", "ok"), toolResult("call-b", "failed", true))}${terminal()}`,
    );
  });
  const context = captureContext();

  const result = await executePreparedCliRun(context);
  expect(result.toolSummary).toEqual({
    calls: 2,
    tools: ["mcp__openclaw__message"],
    failures: 1,
  });

  expectToolEvents(toolEvents, [
    ["started", "call-a"],
    ["started", "call-b"],
    ["completed", "call-a"],
    ["error", "call-b", { terminalReason: "failed" }],
  ]);
});

it("keeps identical parallel outcomes unknown with first tool finishes before second CLI identity", async () => {
  const toolEvents = captureToolEvents();
  const recordEvent = vi.fn();
  mockCaptureSpawn((input, captureKey) => {
    const toolArgs = { action: "react", emoji: "same" };
    input.onStdout?.(assistant(messageUse("call-identical-a", toolArgs)));
    recordToolOutcome(captureKey, "message", toolArgs, "failed");
    recordToolOutcome(captureKey, "message", toolArgs, "completed");
    input.onStdout?.(user(toolResult("call-identical-a", "ok")));
    input.onStdout?.(assistant(messageUse("call-identical-b", toolArgs)));
    input.onStdout?.(user(toolResult("call-identical-b", "ok")));
    input.onStdout?.(assistant(messageUse("call-identical-later", toolArgs)));
    recordToolOutcome(captureKey, "message", toolArgs, "completed");
    input.onStdout?.(`${user(toolResult("call-identical-later", "ok"))}${terminal()}`);
  });
  const context = captureContext();
  context.trajectoryRecorder = { recordEvent };

  await executePreparedCliRun(context);
  const results = recordEvent.mock.calls.filter(([type]) => type === "tool.result");
  const outcomes = results.map(([, row]) => [row?.toolCallId, row?.status, row?.success]);
  expect(outcomes).toEqual([
    ["call-identical-a", "unknown", undefined],
    ["call-identical-b", "unknown", undefined],
    ["call-identical-later", "completed", true],
  ]);
  expect(toolEvents).toHaveLength(6);
  expectToolEvents(
    toolEvents,
    [
      ["started", "call-identical-a"],
      ["started", "call-identical-b"],
      ["error", "call-identical-a", { errorCode: "tool_outcome_unknown" }],
      ["error", "call-identical-b", { errorCode: "tool_outcome_unknown" }],
      ["started", "call-identical-later"],
      ["completed", "call-identical-later"],
    ],
    true,
  );
});

it("uses a loopback outcome that settles during the post-process drain", async () => {
  const toolEvents = captureToolEvents();
  mockCaptureSpawn((input, captureKey) => {
    const toolArgs = { action: "react", emoji: "A" };
    input.onStdout?.(`${assistant(messageUse("call-draining", toolArgs))}${terminal()}`);
    const captureHandle = markMcpLoopbackToolCallStarted({
      captureKey,
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
  });
  const context = captureContext();

  await executePreparedCliRun(context);

  expectToolEvents(toolEvents, [
    ["started", "call-draining"],
    ["completed", "call-draining"],
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
    },
  );
  const context = captureContext();
  context.params.abortSignal = abortController.signal;

  await expect(executePreparedCliRun(context)).rejects.toThrow("aborted");

  expectToolEvents(toolEvents, [
    ["started", "call-cancelled"],
    [
      "error",
      "call-cancelled",
      {
        errorCategory: "aborted",
        terminalReason: "cancelled",
      },
    ],
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
  const toolStart = assistant(toolUse(fixture.toolCallId, fixture.name, {}, fixture.type));
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
      timedOut: true,
    },
  );
  const context = captureContext();
  const recordEvent = vi.fn();
  context.trajectoryRecorder = { recordEvent };
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
  expect(recordEvent.mock.calls.map(([type]) => type)).not.toContain("tool.result");

  expectToolEvents(toolEvents, [
    ["started", fixture.toolCallId],
    ["error", fixture.toolCallId, { ...fixture.expected }],
  ]);
  if (fixture.type === "server_tool_use") {
    expect(toolEvents[1]).not.toHaveProperty("terminalReason");
  }
});

it("bounds pending and committed JSONL message delivery evidence", async () => {
  const starts = Array.from({ length: 65 }, (_, index) =>
    messageUse(`message-send-${index}`, {
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
  const chunks = [assistant(...starts, ...results), terminal()];
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
    messageUse(dryRun ? "message-dry-run-unresolved" : "message-send-unresolved", {
      action: "send",
      channel: TEST_MESSAGE_CHANNEL,
      target: "chat123",
      message: "done",
      ...(dryRun ? { dryRun: true } : {}),
    }),
  );
  mockOutput([chunk], { exitCode: 1, stderr: "failed" });
  const thrown = await executePreparedCliRun(claudeJsonlContext()).catch((error: unknown) => error);
  expect(getCliMessagingDeliveryEvidence(thrown)?.didSendViaMessagingTool).toBe(expected);
});

it("records sessions_yield through the serialized MCP capture", async () => {
  const context = captureContext("google-gemini-cli", "text");
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
  expect(await executePreparedCliRun(context)).toMatchObject({
    yielded: true,
    yieldAcknowledgment: "Research started; results will follow.",
  });
});

type MessageCaptureOptions = {
  params?: Partial<PreparedCliRunContext["params"]>;
  outcome?: "completed" | "unknown";
  count?: number;
  provider?: string;
};
const sentSourceReply = (reply: { text: string; mediaUrl?: string }) => ({
  ok: true,
  details: { deliveryStatus: "sent", sourceReplySink: "internal-ui", sourceReply: { ...reply } },
});
async function captureMessage(
  args: Record<string, unknown>,
  response: unknown,
  options: MessageCaptureOptions = {},
) {
  const context = captureContext(options.provider ?? "google-gemini-cli", "text");
  Object.assign(context.params, options.params);
  mockCaptureSpawn((input, captureKey) => {
    for (let i = 0; i < (options.count ?? 1); i++) {
      recordToolOutcome(captureKey, "message", args, options.outcome ?? "completed", response);
    }
    input.onStdout?.("done");
  });
  return executePreparedCliRun(context);
}
it("retains partial delivery from unknown MCP outcome", async () => {
  const message = "x".repeat(20 * 1024);
  const result = await captureMessage(
    {
      action: "send",
      channel: TEST_MESSAGE_CHANNEL,
      target: "chat123",
      message,
      mediaUrl: "https://example.com/photo.png",
    },
    Object.assign(new Error("second chunk failed"), { sentBeforeError: true }),
    { outcome: "unknown" },
  );
  expect(result).toMatchObject({
    didSendViaMessagingTool: true,
    messagingToolSentTargets: [
      expect.objectContaining({
        tool: "message",
        provider: TEST_MESSAGE_CHANNEL,
        to: "chat123",
        text: message,
        mediaUrls: ["https://example.com/photo.png"],
      }),
    ],
  });
});
it("retains confirmed implicit reply current-target evidence", async () => {
  const result = await captureMessage(
    { action: "reply", message: "done" },
    { ok: true },
    { params: { messageChannel: TEST_MESSAGE_CHANNEL, currentChannelId: "chat123" } },
  );
  expect(result).toMatchObject({
    didSendViaMessagingTool: true,
    messagingToolSentTargets: [
      expect.objectContaining({ tool: "message", provider: TEST_MESSAGE_CHANNEL, to: "chat123" }),
    ],
  });
});
it("retains text and media evidence for repeated implicit sends", async () => {
  const mediaReply = { text: "implicit reply", mediaUrl: "https://example.com/implicit.png" };
  const result = await captureMessage(
    { action: "send", message: mediaReply.text, mediaUrl: mediaReply.mediaUrl },
    sentSourceReply(mediaReply),
    { count: 2, params: { sourceReplyDeliveryMode: "message_tool_only" } },
  );
  expect(result).toMatchObject({
    didSendViaMessagingTool: true,
    didDeliverSourceReplyViaMessageTool: true,
    messagingToolSentTexts: [mediaReply.text],
    messagingToolSentMediaUrls: [mediaReply.mediaUrl],
    messagingToolSourceReplyPayloads: [0, 1].map(() =>
      Object.assign({}, mediaReply, { sourceReplyFinal: true }),
    ),
  });
  expect(result.messagingToolSentTargets).toBeUndefined();
  expect(result.sourceReplyDelivered).toBeUndefined();
});
it.each(["thread-1", "thread-2"])("retains explicit send to %s", async (threadId) => {
  const result = await captureMessage(
    {
      action: "send",
      channel: TEST_MESSAGE_CHANNEL,
      accountId: "account-1",
      target: "chat123",
      threadId,
      message: "explicit reply",
    },
    sentSourceReply({ text: "explicit reply" }),
    {
      provider: "local-cli",
      params: {
        sourceReplyDeliveryMode: "message_tool_only",
        messageChannel: TEST_MESSAGE_CHANNEL,
        agentAccountId: "account-1",
        currentChannelId: "chat123",
        currentThreadTs: "thread-1",
      },
    },
  );
  expect(result.didDeliverSourceReplyViaMessageTool === true).toBe(threadId === "thread-1");
});

it.each([
  { action: "send", exitCode: 0 },
  { action: "poll", exitCode: 1 },
])(
  "retains the final source $action reply through CLI exit $exitCode",
  async ({ action, exitCode }) => {
    const context = captureContext("google-gemini-cli", "text");
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
      result = settledResult(context, output);
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
  ["explicit final", true, "source", "required", "Tool-authored answer", true],
  ["default final", undefined, "source", "required", "Tool-authored answer", true],
  ["explicit short final", true, "source", "required", "Done", true, "Done"],
  ["default short final", undefined, "source", "required", "Done", true, "Done"],
  ["short progress repeat", false, "source", "required", "Done", true, "Done"],
  ["trimmed short final", true, "source", "required", "Done", true, " Done "],
  ["distinct short final", true, "source", "required", "No", false, "Done"],
  ["short prefix correction", true, "source", "required", "Done, but failed", false, "Done"],
  ["short other conversation", true, "other", "required", "Done", false, "Done"],
  ["identical emoji final", true, "source", "required", "✅", true, "✅"],
  ["distinct emoji final", true, "source", "required", "❌", false, "✅"],
  ["continued work", undefined, "source", "required", "The operation failed", false],
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
  async (_label, final, delivery, terminalReplyExpectation, text, suppress, sentText?: string) => {
    const context = captureContext("local-cli", "text");
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
          message: sentText ?? "Tool-authored answer",
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
      if (_label === "continued work") {
        recordToolOutcome(captureKey, "exec", { command: "check-result" }, "completed");
      }
      input.onStdout?.(text);
    });
    const output = await executePreparedCliRun(context);
    const preparedReply = prepareCliRunTerminalReply(context, output);
    const result = settledResult(context, output, preparedReply);
    const { replyPayloads } = await buildReplyPayloads({
      payloads: result.payloads ?? [],
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
      replyToMode: "off",
      messageProvider: TEST_MESSAGE_CHANNEL,
      originatingTo: "source-chat",
      messagingToolSentTexts: result.messagingToolSentTexts,
      messagingToolSentTargets: result.messagingToolSentTargets,
    });
    expect(replyPayloads.map((payload) => payload.text)).toEqual(suppress ? [] : [text]);
    if (text === "NO_REPLY") {
      expect(result.meta.terminalReply).toEqual({ disposition: "silent" });
    }
  },
);

it("deactivates a Claude live capture when process startup fails", async () => {
  const context = captureContext();
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
  const context = captureContext("local-cli");
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
  const context = captureContext("local-cli", "text");
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
