import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  ensureSessionEntrySync,
  loadTranscriptEvents,
  type SessionTranscriptRuntimeTarget,
} from "../config/sessions/session-accessor.js";
import { SessionTranscriptWriterClaimReboundError } from "../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  markMcpLoopbackRequestFinished,
  markMcpLoopbackRequestStarted,
  markMcpLoopbackToolCallFinished,
  markMcpLoopbackToolCallStarted,
  recordMcpLoopbackToolCallResult,
  resolveMcpLoopbackYieldContext,
  updateMcpLoopbackToolCallCapture,
} from "../gateway/mcp-http.loopback-runtime.js";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import type {
  CliBackendConfig,
  CliBackendExecute,
  CliBackendLiveSessionHandle,
} from "../plugins/cli-backend.types.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { getProcessSupervisor } from "../process/supervisor/index.js";
import type { RunExit } from "../process/supervisor/types.js";
import { onInternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { createUserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../sessions/user-turn-transcript.test-support.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import * as sleepModule from "../utils/sleep.js";
import { prepareSystemAgentRunAdmission } from "./admitted-run-context.js";
import { createTestAdmittedRunContext } from "./admitted-run-context.test-support.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import { createLifecycleHooks, setHookRunnerForTest } from "./cli-runner.hooks.test-support.js";
import { runPreparedCliAgent as runPreparedCliAgentCore } from "./cli-runner.js";
import { registerCliReplyCompletionTests } from "./cli-runner.reply-completion.cases.js";
import { failClosedPluginResumeCases } from "./cli-runner.resume.test-fixtures.js";
import {
  createManagedRun,
  enqueueSessionEventMock,
  supervisorSpawnMock,
} from "./cli-runner.test-support.js";
import { registerCliWatchdogNoticeTests } from "./cli-runner.watchdog.cases.js";
import { executePreparedCliRun as executePreparedCliRunCore } from "./cli-runner/execute.js";
import {
  createSuccessfulProcessExit,
  wrapPreparedCliRunWithTestAdmission,
} from "./cli-runner/execute.test-support.js";
import { prepareCliRunContext } from "./cli-runner/prepare.js";
import { hashCliReseedPrompt } from "./cli-runner/reseed-envelope.js";
import { captureCliRunStartTime, type PreparedCliRunContext } from "./cli-runner/types.js";
import { persistCliSessionBindingResult } from "./cli-session-store.js";
import * as cliTranscript from "./command/attempt-execution.helpers.js";
import { runAgentHarnessBeforeMessageWriteHook } from "./harness/hook-helpers.js";
import { MAX_AGENT_HOOK_HISTORY_MESSAGES } from "./harness/hook-history.js";
import { SessionManager } from "./sessions/session-manager.js";

const MAX_CLI_SESSION_HISTORY_MESSAGES = MAX_AGENT_HOOK_HISTORY_MESSAGES;
const runPreparedCliAgent = wrapPreparedCliRunWithTestAdmission(runPreparedCliAgentCore);
const executePreparedCliRun = wrapPreparedCliRunWithTestAdmission(executePreparedCliRunCore);

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

vi.mock("../tts/tts-settings.js", () => ({
  buildTtsSystemPromptHint: vi.fn(() => undefined),
  resolveModelOverridePolicy: vi.fn(),
  setTtsMachinePrefsPathResolver: vi.fn(),
}));

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-cli-hooks-");
let sessionFileEnvSnapshot: ReturnType<typeof captureEnv> | undefined;

function createSessionFixture(params?: {
  history?: Array<{ role: "user"; content: string }>;
  sessionKey?: string;
}) {
  const dir = sessionDirs.make();
  sessionFileEnvSnapshot ??= captureEnv(["OPENCLAW_STATE_DIR"]);
  setTestEnvValue("OPENCLAW_STATE_DIR", dir);
  setRuntimeConfigSnapshot({});
  const storePath = path.join(dir, "agents", "main", "sessions", "sessions.json");
  const sessionTarget: SessionTranscriptRuntimeTarget = {
    agentId: "main",
    sessionId: "s1",
    sessionKey: params?.sessionKey ?? "agent:main:main",
    storePath,
  };
  ensureSessionEntrySync(sessionTarget, { sessionId: "s1", updatedAt: Date.now() });
  const manager = SessionManager.open(sessionTarget, dir);
  for (const [index, entry] of (params?.history ?? []).entries()) {
    manager.appendMessage({ ...entry, timestamp: index + 1 });
  }
  return { dir, sessionFile: sessionTarget.sessionKey, sessionTarget, storePath };
}

type PreparedContextOverrides = Partial<{
  sessionKey: string;
  cliSessionId: string;
  runId: string;
  lane: string;
  openClawHistoryPrompt: string;
  provider: string;
  model: string;
  executionMode: PreparedCliRunContext["params"]["executionMode"];
  allowEmptyAssistantReplyAsSilent: boolean;
}>;

function buildPreparedContext(params: PreparedContextOverrides = {}): PreparedCliRunContext {
  const provider = params?.provider ?? "codex-cli";
  const model = params?.model ?? "gpt-5.4";
  const backend = {
    command: "codex",
    args: ["exec", "--json"],
    output: "text" as const,
    input: "arg" as const,
    modelArg: "--model",
    sessionMode: "existing" as const,
    serialize: true,
  };
  const runId = params?.runId ?? "run-2";
  return {
    params: {
      admittedRunContext: createTestAdmittedRunContext(runId),
      sessionId: "s1",
      sessionKey: params?.sessionKey,
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider,
      model,
      thinkLevel: "low",
      timeoutMs: 1_000,
      runId,
      lane: params?.lane,
      executionMode: params?.executionMode,
      allowEmptyAssistantReplyAsSilent: params?.allowEmptyAssistantReplyAsSilent,
    },
    ...captureCliRunStartTime(),
    workspaceDir: "/tmp",
    backendResolved: {
      id: provider,
      config: backend,
      bundleMcp: false,
      pluginId: provider === "claude-cli" ? "anthropic" : "openai",
    },
    executionTarget: { kind: "process" },
    preparedBackend: {
      backend,
      env: {},
    },
    reusableCliSession: params?.cliSessionId
      ? { mode: "reuse", sessionId: params.cliSessionId }
      : { mode: "none" },
    hadSessionFile: false,
    contextEngineConfig: {},
    modelId: model,
    normalizedModel: model,
    contextWindowInfo: {
      tokens: 150_000,
      referenceTokens: 200_000,
      source: "modelsConfig",
    },
    systemPrompt: "You are a helpful assistant.",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    claudeSkillsPluginArgs: [],
    ...(params?.openClawHistoryPrompt
      ? { openClawHistoryPrompt: params.openClawHistoryPrompt }
      : {}),
    authEpochVersion: 2,
  };
}

function withParams(
  context: PreparedCliRunContext,
  overrides: Partial<PreparedCliRunContext["params"]>,
): PreparedCliRunContext {
  return { ...context, params: { ...context.params, ...overrides } };
}

function sessionParams(
  sessionTarget: SessionTranscriptRuntimeTarget,
  workspaceDir: string,
): Partial<PreparedCliRunContext["params"]> {
  return {
    agentId: "main",
    sessionFile: sessionTarget.sessionKey,
    sessionTarget,
    workspaceDir,
  };
}

function makeClaudePreparedContext(
  overrides: PreparedContextOverrides = {},
): PreparedCliRunContext {
  return buildPreparedContext({ provider: "claude-cli", model: "opus", ...overrides });
}

function capturedContext(
  params: PreparedContextOverrides,
  runParams: Partial<PreparedCliRunContext["params"]> = {},
): PreparedCliRunContext {
  const context = withParams(makeClaudePreparedContext(params), runParams);
  context.mcpDeliveryCapture = true;
  return context;
}

function checkpointContext(
  params: PreparedContextOverrides & { cliSessionId: string },
  armed = false,
): PreparedCliRunContext {
  const context = makeClaudePreparedContext(params);
  Object.assign(context.preparedBackend.backend, {
    resumeArgs: ["--resume", "{sessionId}"],
    forkArg: "--fork-session",
    resumeAtArg: "--resume-session-at",
  });
  context.params.cliSessionBinding = {
    sessionId: params.cliSessionId,
    resumeCheckpointId: "assistant-before-stall",
    ...(armed ? { forkNextResume: true } : {}),
  };
  return context;
}

async function admitPreparedContext(
  context: PreparedCliRunContext,
  runtime: "embedded" | "plugin-harness" = "embedded",
) {
  const admission = prepareSystemAgentRunAdmission(
    {},
    context.params.runId,
    "main",
    "cli-recovery-test",
  );
  context.params.admittedRunContext = await admission.admit(runtime);
  return admission;
}

async function usePluginLiveBackend(context: PreparedCliRunContext, execute: CliBackendExecute) {
  const backend: CliBackendConfig = {
    command: "/bin/sh",
    args: [],
    resumeArgs: ["--resume", "{sessionId}"],
    output: "jsonl",
    jsonlDialect: "claude-stream-json",
    input: "stdin",
    sessionMode: "existing",
    liveSession: "claude-stdio",
    freshSessionRecovery: "invalidated-only",
  };
  context.preparedBackend.backend = backend;
  context.backendResolved.config = backend;
  context.executionTarget = { kind: "plugin", execute };
  const admission = await admitPreparedContext(context, "plugin-harness");
  return { admission, context };
}

async function warmedPluginContext(
  overrides: PreparedContextOverrides,
  execute: (
    execution: Parameters<CliBackendExecute>[0],
    attempt: number,
  ) => ReturnType<CliBackendExecute>,
) {
  let attempts = 0;
  let liveHandle: CliBackendLiveSessionHandle | undefined;
  const { admission, context } = await usePluginLiveBackend(
    makeClaudePreparedContext(overrides),
    async function* (execution) {
      attempts += 1;
      const capability = execution.liveSession;
      if (!capability) {
        throw new Error("Expected a managed live-session capability.");
      }
      if (attempts === 1) {
        const handle: CliBackendLiveSessionHandle = {
          generation: "warm-generation",
          fingerprint: capability.fingerprint,
          isIdle: () => true,
          close: () => capability.remove(handle),
          waitForExit: async () => {},
        };
        liveHandle = handle;
        capability.register(handle);
        yield { type: "result", subtype: "success", is_error: false, result: "warm" };
      } else {
        yield* execute(execution, attempts);
      }
    },
  );
  context.params.timeoutMs = 60_000;
  const close = () => {
    liveHandle?.close("restart");
    admission.close();
  };
  try {
    await executePreparedCliRun({ ...context, openClawHistoryPrompt: undefined }, undefined);
    context.requiredClaudeLiveSessionGeneration = liveHandle?.generation;
    // The warmup is a separate turn and must not consume this run's recovery budget.
    return {
      context: { ...context, ...captureCliRunStartTime() },
      close,
      attempts: () => attempts,
    };
  } catch (error) {
    close();
    throw error;
  }
}

function makeManagedRun(overrides: Partial<RunExit> = {}) {
  return createManagedRun({ ...createSuccessfulProcessExit(), ...overrides });
}

function completeCapturedToolCall(
  call: Parameters<typeof markMcpLoopbackToolCallStarted>[0],
  result: unknown,
) {
  const captureHandle = markMcpLoopbackToolCallStarted(call);
  if (!captureHandle) {
    throw new Error("Expected tool delivery capture");
  }
  recordMcpLoopbackToolCallResult({ ...call, captureHandle, result, outcome: "completed" });
  markMcpLoopbackToolCallFinished(captureHandle);
}

function mockPendingMessage(args: Record<string, unknown>) {
  const started = createDeferred();
  const initialArgs = { ...args };
  delete initialArgs.dryRun;
  supervisorSpawnMock.mockImplementationOnce(async (...spawnArgs: unknown[]) => {
    const input = spawnArgs[0] as Parameters<ReturnType<typeof getProcessSupervisor>["spawn"]>[0];
    const captureHandle = markMcpLoopbackToolCallStarted({
      captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
      toolName: "message",
      args: initialArgs,
    });
    if (!captureHandle) {
      throw new Error("Expected message capture");
    }
    updateMcpLoopbackToolCallCapture(captureHandle, { toolName: "message", args });
    started.resolve();
    return makeNoOutputTimeoutRun();
  });
  return started.promise;
}

function sourceReplyResult(text: string) {
  return {
    details: {
      deliveryStatus: "sent",
      messageDelivery: { status: "settled", partialDelivery: false, createdThreadIds: [] },
      sourceReplySink: "internal-ui",
      sourceReply: { text },
    },
  };
}

function makeNoOutputTimeoutRun() {
  return makeManagedRun({
    reason: "no-output-timeout",
    exitCode: null,
    exitSignal: "SIGKILL",
    durationMs: 200,
    timedOut: true,
    noOutputTimedOut: true,
  });
}

const requireRecord = createRequireRecord("object", "expected-label");

function requireArray(value: unknown, label: string): Array<unknown> {
  expect(Array.isArray(value), label).toBe(true);
  return value as Array<unknown>;
}

function callArg(
  mock: { mock: { calls: Array<Array<unknown>> } },
  callIndex: number,
  argIndex: number,
  label: string,
) {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call: ${label}`);
  }
  if (argIndex >= call.length) {
    throw new Error(`Expected mock call argument ${argIndex}: ${label}`);
  }
  return call[argIndex];
}

function expectTextMessage(value: unknown, fields: { role: string; content: string }) {
  const message = requireRecord(value, "message");
  expect(message.role).toBe(fields.role);
  expect(message.content).toBe(fields.content);
  expect(message.timestamp).toBeTypeOf("number");
}

async function readTranscriptMessages(
  sessionTarget: SessionTranscriptRuntimeTarget,
): Promise<unknown[]> {
  const events = await loadTranscriptEvents(sessionTarget);
  return events.flatMap((entry) =>
    typeof entry === "object" && entry !== null && "message" in entry ? [entry.message] : [],
  );
}

function createCliUserTurnRecorder(params: {
  text: string;
  sessionTarget: SessionTranscriptRuntimeTarget;
  sessionKey?: string;
  workspaceDir: string;
}) {
  return createUserTurnTranscriptRecorder({
    input: { text: params.text },
    target: createTestUserTurnTranscriptTarget({
      ...params.sessionTarget,
      sessionKey: params.sessionKey ?? params.sessionTarget.sessionKey,
      cwd: params.workspaceDir,
    }),
  });
}

const BLOCK_MESSAGE =
  "Your message could not be sent: The agent cannot read this message. (blocked by policy-plugin)";

const CLI_RESEED_PROMPT =
  "Continue this conversation using the OpenClaw transcript below as prior session history.\n\n<conversation_history>\nUser: earlier context\n</conversation_history>\n\n<next_user_message>\nhi\n</next_user_message>";

describe("runCliAgent reliability", () => {
  beforeEach(() => {
    // Failed attempts must not leave queued spawn results for the next case.
    supervisorSpawnMock.mockReset();
    // Binding-flush retry timing has dedicated coverage. Reliability cases only
    // need its stable not-yet-flushed outcome, without filesystem polling/sleeps.
    vi.spyOn(cliTranscript, "claudeCliSessionTranscriptHasContent").mockResolvedValue(false);
    vi.spyOn(sleepModule, "sleep").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.mocked(cliTranscript.claudeCliSessionTranscriptHasContent).mockRestore();
    vi.mocked(sleepModule.sleep).mockRestore();
    vi.mocked(getGlobalHookRunner).mockReset();
    setHookRunnerForTest(null);
    vi.unstubAllEnvs();
    sessionFileEnvSnapshot?.restore();
    sessionFileEnvSnapshot = undefined;
    clearRuntimeConfigSnapshot();
    resetDiagnosticEventsForTest();
    cliBackendsTesting.resetDepsForTest();
    vi.useRealTimers();
  });

  it("does not enqueue watchdog system events for side-question no-output timeouts", async () => {
    enqueueSessionEventMock.mockClear();
    supervisorSpawnMock.mockResolvedValueOnce(makeNoOutputTimeoutRun());

    await expect(
      executePreparedCliRun(
        buildPreparedContext({
          sessionKey: "agent:main:main",
          cliSessionId: "thread-123",
          executionMode: "side-question",
          runId: "run-side-question-timeout",
        }),
        "thread-123",
      ),
    ).rejects.toThrow("produced no output");

    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
  });

  it("falls back to cold reseed when Claude lacks the checkpoint flag", async ({
    onTestFinished,
  }) => {
    supervisorSpawnMock
      .mockResolvedValueOnce(makeNoOutputTimeoutRun())
      .mockResolvedValueOnce(
        makeManagedRun({
          exitCode: 1,
          durationMs: 25,
          stderr: "error: unknown option '--resume-session-at'",
        }),
      )
      .mockResolvedValueOnce(makeManagedRun({ stdout: "fresh fallback" }));
    const prepareForkRetry = vi.fn(async () => true);
    const claimFork = vi.fn(async () => true);
    const restoreFork = vi.fn(async () => {});
    const clearBeforeRetry = vi.fn(async () => true);
    const context = checkpointContext({
      sessionKey: "agent:main:old-claude",
      runId: "run-old-claude",
      cliSessionId: "old-claude-session",
      openClawHistoryPrompt: CLI_RESEED_PROMPT,
    });
    onTestFinished((await admitPreparedContext(context)).close);
    const result = await runPreparedCliAgent(
      withParams(context, {
        onBeforeForkedCliSessionRetry: prepareForkRetry,
        claimCliSessionFork: claimFork,
        restoreCliSessionFork: restoreFork,
        persistCliSessionForkSuccessor: vi.fn(async () => {}),
        onBeforeFreshCliSessionRetry: clearBeforeRetry,
      }),
    );

    expect(result.payloads).toEqual([{ text: "fresh fallback" }]);
    expect(prepareForkRetry).toHaveBeenCalledOnce();
    expect(claimFork).toHaveBeenCalledOnce();
    expect(restoreFork).toHaveBeenCalledOnce();
    expect(clearBeforeRetry).toHaveBeenCalledWith({
      provider: "claude-cli",
      reason: "timeout",
      sessionId: "old-claude-session",
    });
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(3);
  });

  it("does not treat unsupported-flag wording fragments as a Claude downgrade", async ({
    onTestFinished,
  }) => {
    supervisorSpawnMock.mockResolvedValueOnce(
      makeManagedRun({
        exitCode: 1,
        durationMs: 25,
        stderr: "Claude exited unexpectedly while using --resume-session-at",
      }),
    );
    const clearBeforeRetry = vi.fn(async () => true);
    const context = checkpointContext(
      {
        sessionKey: "agent:main:resume-token-boundary",
        runId: "run-resume-token-boundary",
        cliSessionId: "existing-session",
        openClawHistoryPrompt: CLI_RESEED_PROMPT,
      },
      true,
    );
    onTestFinished((await admitPreparedContext(context)).close);
    await expect(
      runPreparedCliAgent(
        withParams(context, {
          forkCliSessionOnResume: true,
          claimCliSessionFork: vi.fn(async () => true),
          restoreCliSessionFork: vi.fn(async () => {}),
          persistCliSessionForkSuccessor: vi.fn(async () => {}),
          onBeforeFreshCliSessionRetry: clearBeforeRetry,
        }),
      ),
    ).rejects.toThrow("exited unexpectedly");

    expect(clearBeforeRetry).not.toHaveBeenCalled();
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
  });

  it("preserves fresh retry for direct CLI callers without a pre-clear hook", async () => {
    // Image preparation must not consume this retry-policy fixture's budget.
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    supervisorSpawnMock.mockResolvedValueOnce(
      makeManagedRun({
        exitCode: 1,
        durationMs: 150,
        stderr: "session expired",
      }),
    );
    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "hello from fresh cli" }));
    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:direct",
      runId: "run-direct-retry",
      cliSessionId: "stale-cli-session",
      openClawHistoryPrompt: CLI_RESEED_PROMPT,
    });
    context.preparedBackend.backend = {
      ...context.preparedBackend.backend,
      resumeArgs: ["exec", "resume", "{sessionId}", "--json"],
      imageArg: "--image",
      imageMode: "repeat",
    };
    const stateDir = sessionDirs.make();
    const workspaceDir = path.join(stateDir, "workspace");
    const inboundDir = path.join(stateDir, "media", "inbound");
    const mediaId = "offloaded.png";
    const offloadedImage = createSolidPngBuffer(1, 1, { r: 255, g: 0, b: 0 });
    const inlineImage = createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 255 });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(inboundDir, { recursive: true });
    fs.writeFileSync(path.join(inboundDir, mediaId), offloadedImage);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const currentTurn = `compare these\n[media attached: media://inbound/${mediaId}]`;
    context.workspaceDir = workspaceDir;
    context.params = {
      ...context.params,
      workspaceDir,
      prompt: `[Retry after failure]\n\n${currentTurn}`,
      imagePrompt: currentTurn,
      images: [
        {
          type: "image",
          data: inlineImage.toString("base64"),
          mimeType: "image/png",
        },
      ],
      imageOrder: ["offloaded", "inline"],
      // Offloaded attachments are carried as structured facts; the trailing
      // marker text is presentation only and is never parsed for hydration.
      media: [{ url: `media://inbound/${mediaId}`, contentType: "image/png" }],
    };

    const result = await runPreparedCliAgent(context);

    expect(result.payloads).toEqual([{ text: "hello from fresh cli" }]);
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
    for (const [index, label] of ["resumed", "fresh"].entries()) {
      const spawn = requireRecord(
        callArg(supervisorSpawnMock, index, 0, `${label} image CLI spawn`),
        `${label} image CLI spawn`,
      );
      const argv = requireArray(spawn.argv, `${label} image CLI argv`);
      const imagePaths = argv.flatMap((arg, argIndex) =>
        arg === "--image" && typeof argv[argIndex + 1] === "string"
          ? [argv[argIndex + 1] as string]
          : [],
      );
      expect(imagePaths).toHaveLength(2);
      expect(fs.readFileSync(expectDefined(imagePaths[0], "imagePaths[0] test invariant"))).toEqual(
        offloadedImage,
      );
      expect(fs.readFileSync(expectDefined(imagePaths[1], "imagePaths[1] test invariant"))).toEqual(
        inlineImage,
      );
      expect(argv.includes("resume")).toBe(index === 0);
      expect(argv.includes("stale-cli-session")).toBe(index === 0);
    }
  });

  registerCliReplyCompletionTests({
    createContext: (params) => capturedContext({}, params),
    completeToolCall: completeCapturedToolCall,
    makeManagedRun,
    admitContext: admitPreparedContext,
    run: runPreparedCliAgent,
    createSessionFixture,
    sessionParams,
    readTranscriptMessages,
  });

  it("projects explicit outbound MCP media without retaining echoed image bytes", async () => {
    const echoedBase64 = "private-echoed-base64";
    const mediaUrls = [
      "https://example.test/one.png",
      "https://example.test/two.png",
      "https://example.test/three.png",
    ];
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as Parameters<ReturnType<typeof getProcessSupervisor>["spawn"]>[0];
      const captureKey = input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "";
      for (const [index, mediaUrl] of mediaUrls.entries()) {
        completeCapturedToolCall(
          {
            captureKey,
            toolName: "image_generate",
            args: { prompt: `image ${index + 1}` },
          },
          {
            content: [
              {
                type: "image",
                data: echoedBase64,
                mimeType: "image/png",
              },
            ],
            details: { media: { mediaUrls: [mediaUrl] } },
          },
        );
      }
      for (const [toolName, media] of [
        ["image", { mediaUrls: ["/tmp/private.png"], outbound: false }],
        ["untrusted_tool", { mediaUrls: ["/tmp/untrusted.png"] }],
      ] as const) {
        completeCapturedToolCall(
          {
            captureKey,
            toolName,
            args: {},
          },
          {
            content: [{ type: "image", data: echoedBase64, mimeType: "image/png" }],
            details: { media },
          },
        );
      }
      return makeManagedRun({ stdout: "done" });
    });
    const context = capturedContext({
      sessionKey: "agent:main:outbound-media",
      runId: "run-outbound-media",
    });

    const result = await runPreparedCliAgent(context);

    expect(result.payloads).toEqual([
      {
        text: "done",
        mediaUrls,
        mediaUrl: mediaUrls[0],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(echoedBase64);
    expect(JSON.stringify(result)).not.toContain("/tmp/private.png");
    expect(JSON.stringify(result)).not.toContain("/tmp/untrusted.png");
  });

  it("deduplicates a CLI Markdown image selected from structured tool media", async () => {
    const mediaUrl = "/root/.openclaw/media/tool-image-generation/our-agent-soviet-meme.png";
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as Parameters<ReturnType<typeof getProcessSupervisor>["spawn"]>[0];
      completeCapturedToolCall(
        {
          captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
          toolName: "image_generate",
          args: { prompt: "our agent" },
        },
        {
          content: [{ type: "text", text: "Image generated" }],
          details: { media: { mediaUrls: [mediaUrl], trustedLocalMedia: true } },
        },
      );
      return makeManagedRun({
        stdout: `Our agent.\n\n![Our Agent meme](${mediaUrl})`,
      });
    });
    const context = capturedContext({
      sessionKey: "agent:main:markdown-tool-media",
      runId: "run-markdown-tool-media",
    });

    const result = await runPreparedCliAgent(context);

    expect(result.payloads).toEqual([
      {
        text: "Our agent.",
        mediaUrls: [mediaUrl],
        mediaUrl,
        trustedLocalMedia: true,
      },
    ]);
  });

  it("preserves first-turn delivery through cleanup without binding the OpenClaw session id", async () => {
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as Parameters<ReturnType<typeof getProcessSupervisor>["spawn"]>[0];
      completeCapturedToolCall(
        {
          captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
          toolName: "message",
          args: {
            action: "send",
            message: "sent before failure",
          },
        },
        sourceReplyResult("sent before failure"),
      );
      return makeNoOutputTimeoutRun();
    });
    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:first-turn-delivered",
      runId: "run-first-turn-delivered",
    });
    context.preparedBackend.backend.sessionMode = "none";
    context.backendResolved.config = context.preparedBackend.backend;
    context.mcpDeliveryCapture = true;
    context.params.sourceReplyDeliveryMode = "message_tool_only";
    context.preparedBackend.cleanup = async () => {
      throw new Error("cleanup failed");
    };

    const result = await runPreparedCliAgent(context);

    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.didDeliverSourceReplyViaMessageTool).toBe(true);
    expect(result.messagingToolSourceReplyPayloads).toEqual([
      { text: "sent before failure", sourceReplyFinal: true },
    ]);
    expect(result.payloads).toEqual([{ text: "sent before failure" }]);
    expect(getReplyPayloadMetadata(result.payloads?.[0] as object)).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
      sourceReplyTranscriptMirror: {
        sessionKey: "agent:main:first-turn-delivered",
        text: "sent before failure",
        idempotencyKey: "run-first-turn-delivered:internal-source-reply:0",
      },
    });
    expect(result.meta.agentMeta?.sessionId).toBe("");
    expect(result.meta.agentMeta?.clearCliSessionBinding).toBe(true);
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
  });

  it("hooks the visible source reply without pre-persisting its dispatch mirror", async () => {
    const { sessionFile, sessionTarget, storePath } = createSessionFixture();
    const hookRunner = createLifecycleHooks(["llm_output", "agent_end"]);
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as Parameters<ReturnType<typeof getProcessSupervisor>["spawn"]>[0];
      completeCapturedToolCall(
        {
          captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
          toolName: "message",
          args: {
            action: "send",
            message: "visible source reply",
          },
        },
        sourceReplyResult("visible source reply"),
      );
      return makeManagedRun({ stdout: "private terminal confirmation" });
    });
    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:main",
      runId: "run-visible-source-reply",
    });
    context.mcpDeliveryCapture = true;
    context.params.sourceReplyDeliveryMode = "message_tool_only";
    context.params.sessionFile = sessionFile;
    context.params.sessionTarget = sessionTarget;
    context.params.storePath = storePath;
    context.params.persistAssistantTranscript = true;

    await runPreparedCliAgent(context);

    const transcriptMessages = await readTranscriptMessages(sessionTarget);
    expect(transcriptMessages).toHaveLength(0);
    const llmOutputEvent = requireRecord(
      callArg(hookRunner.runLlmOutput, 0, 0, "llm_output event"),
      "llm_output event",
    );
    expect(llmOutputEvent.assistantTexts).toEqual(["visible source reply"]);
    const agentEndEvent = requireRecord(
      callArg(hookRunner.runAgentEnd, 0, 0, "agent_end event"),
      "agent_end event",
    );
    const messages = requireArray(agentEndEvent.messages, "agent_end messages");
    const lastMessage = requireRecord(messages.at(-1), "agent_end assistant message");
    expect(lastMessage.role).toBe("assistant");
    expect(lastMessage.content).toEqual([{ type: "text", text: "visible source reply" }]);
  });

  it.each([
    {
      name: "internal reply",
      sessionKey: "agent:main:unresolved-internal-source-reply",
      external: false,
      dryRun: false,
    },
    {
      name: "external session route",
      sessionKey: "agent:main:telegram:direct:123456789",
      external: true,
      dryRun: false,
    },
    {
      name: "prepared dry-run send",
      sessionKey: "agent:main:unresolved-dry-run",
      external: false,
      dryRun: true,
    },
  ])("settles an unresolved $name without retrying", async ({ sessionKey, external, dryRun }) => {
    vi.useFakeTimers();
    const captureStartedPromise = mockPendingMessage({
      action: "send",
      message: "pending source reply",
      ...(dryRun ? { channel: "telegram", target: "chat123", dryRun: true } : {}),
    });
    const context = capturedContext({
      sessionKey,
      runId: `run-unresolved-${external ? "external" : dryRun ? "dry-run" : "internal"}`,
      ...(dryRun
        ? { cliSessionId: "stale-cli-session", openClawHistoryPrompt: CLI_RESEED_PROMPT }
        : {}),
    });
    if (!dryRun) {
      context.params.config = {};
      context.params.messageChannel = "webchat";
      context.params.sourceReplyDeliveryMode = "message_tool_only";
    }
    const resultPromise = runPreparedCliAgent(context);
    const resultAssertion = external
      ? expect(resultPromise).resolves.toMatchObject({ didSendViaMessagingTool: true })
      : expect(resultPromise).rejects.toThrow(
          dryRun ? "produced no output" : "CLI produced no output",
        );
    await captureStartedPromise;
    await vi.runAllTimersAsync();
    await resultAssertion;
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
  });

  it.each(["writer claim", "caller authority", "cleanup"])(
    "keeps a committed final reply successful after losing %s",
    async (failure) => {
      supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "completed task" }));
      const { dir, sessionTarget, storePath } = createSessionFixture();
      const context = makeClaudePreparedContext({
        sessionKey: sessionTarget.sessionKey,
        runId: "run-committed-final",
      });
      context.authBindingFingerprint = "fixture-auth-binding";
      context.preparedBackend.backend.command = process.execPath;
      context.backendResolved.runtimeArtifact = {
        kind: "bundled-package-tree",
        packageName: "@fixture/cli-runner",
        entrypoint: "command",
        nativeExecutableNames: [path.basename(process.execPath)],
      };
      cliBackendsTesting.setDepsForTest({
        resolvePluginSetupCliBackend: () => undefined,
        resolveRuntimeCliBackends: () => [
          {
            id: "claude-cli",
            pluginId: "fixture",
            config: context.preparedBackend.backend,
            runtimeArtifact: context.backendResolved.runtimeArtifact,
          },
        ],
      });
      let committed = false;
      const notifyAuthBinding = vi.fn();
      const error =
        failure === "writer claim"
          ? new SessionTranscriptWriterClaimReboundError()
          : new Error(`${failure} lost after commit`);
      const unsubscribe = onInternalSessionTranscriptUpdate((event) => {
        if (event.runId === context.params.runId && event.message) {
          committed = true;
        }
      });
      context.preparedBackend.backend.sessionMode = "none";
      context.backendResolved.config = context.preparedBackend.backend;
      context.params = {
        ...context.params,
        ...sessionParams(sessionTarget, dir),
        storePath,
        persistAssistantTranscript: true,
        onSuccessfulAuthBinding: notifyAuthBinding,
        assertCurrent: () => {
          if (committed && failure !== "cleanup") {
            throw error;
          }
        },
      };
      context.preparedBackend.cleanup = async () => {
        expect(committed).toBe(true);
        if (failure === "cleanup") {
          throw error;
        }
      };
      try {
        const result = await runPreparedCliAgent(context);
        expect(committed).toBe(true);
        expect(result.payloads).toEqual([{ text: "completed task" }]);
        expect(result.meta.error).toBeUndefined();
        expect(notifyAuthBinding).toHaveBeenCalledTimes(failure === "cleanup" ? 1 : 0);
        expect(result.meta.executionTrace?.attempts).toEqual([
          expect.objectContaining({ result: "success" }),
        ]);
        const settled = await persistCliSessionBindingResult({
          ...sessionTarget,
          provider: "claude-cli",
          result,
          expectedSession: { sessionId: sessionTarget.sessionId, updatedAt: 1 },
          assertSettlementCurrent: () => {
            throw error;
          },
        });
        expect(settled).toBe(result);
        expect(supervisorSpawnMock).toHaveBeenCalledOnce();
        expect(await readTranscriptMessages(sessionTarget)).toMatchObject([
          { role: "assistant", stopReason: "stop" },
        ]);
        expect(await loadTranscriptEvents(sessionTarget)).not.toContainEqual(
          expect.objectContaining({ customType: "run-failed-before-reply" }),
        );
      } finally {
        unsubscribe();
      }
    },
  );

  registerCliWatchdogNoticeTests({
    createContext: makeClaudePreparedContext,
    makeManagedRun,
    run: runPreparedCliAgent,
    historyPrompt: CLI_RESEED_PROMPT,
  });

  it("does not start a fresh CLI attempt when format recovery retains the binding", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      makeManagedRun({
        stdout: [
          JSON.stringify({
            type: "assistant",
            message: {
              model: "<synthetic>",
              content: [{ type: "text", text: "No response requested." }],
            },
          }),
          JSON.stringify({ type: "result", subtype: "success", result: "" }),
        ].join("\n"),
      }),
    );
    const clearBeforeRetry = vi.fn(async () => false);
    const { dir, sessionTarget } = createSessionFixture({
      sessionKey: "agent:main:subagent:retained-format",
      history: [{ role: "user", content: "earlier context" }],
    });

    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:subagent:retained-format",
      runId: "run-retained-format",
      cliSessionId: "retained-cli-session",
      openClawHistoryPrompt: CLI_RESEED_PROMPT,
    });
    context.preparedBackend.backend = {
      ...context.preparedBackend.backend,
      freshSessionRecovery: "invalidated-only",
      output: "jsonl",
      input: "stdin",
      jsonlDialect: "claude-stream-json",
    };
    context.backendResolved.config = context.preparedBackend.backend;

    await expect(
      runPreparedCliAgent(
        withParams(context, {
          ...sessionParams(sessionTarget, dir),
          onBeforeFreshCliSessionRetry: clearBeforeRetry,
        }),
      ),
    ).rejects.toMatchObject({ reason: "format", code: "cli_synthetic_no_response" });

    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
    expect(clearBeforeRetry).not.toHaveBeenCalled();
  });

  it.each(["timeout", "unknown", "context_overflow", "format"] as const)(
    "retries a fresh CLI session after recoverable %s failover without a failed agent_end",
    async (reason) => {
      const runId = `run-retry-${reason}`;
      const modelCallEvents: Array<{ callId: string; type: string }> = [];
      setDiagnosticsEnabledForProcess(true);
      const stopDiagnostics = onTrustedInternalDiagnosticEvent((event) => {
        if (
          event.type !== "model.call.started" &&
          event.type !== "model.call.completed" &&
          event.type !== "model.call.error"
        ) {
          return;
        }
        if (event.runId === runId) {
          modelCallEvents.push({ callId: event.callId, type: event.type });
        }
      });
      const hookRunner = createLifecycleHooks(["llm_input", "llm_output", "agent_end"]);
      enqueueSessionEventMock.mockClear();
      const events: string[] = [];
      let spawnCount = 0;
      supervisorSpawnMock.mockImplementation(async () => {
        spawnCount += 1;
        events.push(`spawn-${spawnCount}`);
        if (spawnCount === 1 && reason === "timeout") {
          return makeNoOutputTimeoutRun();
        }
        if (spawnCount === 1 && reason === "context_overflow") {
          return makeManagedRun({
            exitCode: 1,
            durationMs: 150,
            stderr: "Prompt is too long",
          });
        }
        if (spawnCount === 1 && reason === "format") {
          return makeManagedRun({
            stdout: [
              JSON.stringify({
                type: "assistant",
                message: {
                  model: "<synthetic>",
                  content: [{ type: "text", text: "No response requested." }],
                },
              }),
              JSON.stringify({ type: "result", subtype: "success", result: "" }),
            ].join("\n"),
          });
        }
        if (spawnCount === 1) {
          return makeManagedRun({
            exitCode: 1,
            durationMs: 150,
          });
        }
        if (reason === "format") {
          return makeManagedRun({
            stdout: JSON.stringify({ type: "result", result: "hello from fresh cli" }),
          });
        }
        return makeManagedRun({ stdout: "hello from fresh cli" });
      });
      const { dir, sessionTarget } = createSessionFixture({
        sessionKey: "agent:main:subagent:retry",
        history: [{ role: "user", content: "earlier context" }],
      });
      const clearBeforeRetry = vi.fn(async () => {
        events.push(`clear-${reason}`);
        return true;
      });

      try {
        const context = makeClaudePreparedContext({
          sessionKey: "agent:main:subagent:retry",
          runId,
          cliSessionId: "stale-cli-session",
          openClawHistoryPrompt: CLI_RESEED_PROMPT,
        });
        if (reason === "format") {
          context.preparedBackend.backend = {
            ...context.preparedBackend.backend,
            output: "jsonl",
            input: "stdin",
            jsonlDialect: "claude-stream-json",
          };
          context.backendResolved.config = context.preparedBackend.backend;
        }
        const result = await runPreparedCliAgent(
          withParams(context, {
            ...sessionParams(sessionTarget, dir),
            onBeforeFreshCliSessionRetry: clearBeforeRetry,
          }),
        );

        expect(result.payloads).toEqual([{ text: "hello from fresh cli" }]);
        expect(result.meta.finalPromptText).toContain("User: earlier context");
        expect(result.meta.finalPromptText).toContain("<next_user_message>");
        expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
        expect(events).toEqual(["spawn-1", `clear-${reason}`, "spawn-2"]);
        if (reason === "timeout") {
          expect(enqueueSessionEventMock).not.toHaveBeenCalled();
        }
        expect(clearBeforeRetry).toHaveBeenCalledWith({
          provider: "claude-cli",
          reason,
          sessionId: "stale-cli-session",
        });
        await vi.waitFor(() => {
          expect(hookRunner.runLlmInput).toHaveBeenCalledTimes(1);
          expect(hookRunner.runLlmOutput).toHaveBeenCalledTimes(1);
          expect(hookRunner.runAgentEnd).toHaveBeenCalledTimes(1);
        });
        const agentEndEvent = requireRecord(
          callArg(hookRunner.runAgentEnd, 0, 0, "agent_end event"),
          "agent_end event",
        );
        expect(agentEndEvent.success).toBe(true);
        expect(agentEndEvent.error).toBeUndefined();
        await waitForDiagnosticEventsDrained();
        expect(modelCallEvents.map((event) => event.type)).toEqual([
          "model.call.started",
          "model.call.error",
          "model.call.started",
          "model.call.completed",
        ]);
        expect(modelCallEvents[0]?.callId).toBe(modelCallEvents[1]?.callId);
        expect(modelCallEvents[2]?.callId).toBe(modelCallEvents[3]?.callId);
        expect(modelCallEvents[0]?.callId).not.toBe(modelCallEvents[2]?.callId);
      } finally {
        stopDiagnostics();
      }
    },
  );

  it.each(["telegram", "webchat"])(
    "returns accepted CLI session spawns when sessions_yield pauses the %s requester",
    async (messageChannel) => {
      const { dir, sessionFile, sessionTarget, storePath } = createSessionFixture();
      const requesterTurnRunId = "run-cli-yield";
      const childRunId = "run-cli-child";
      const childSessionKey = "agent:main:subagent:cli-child";
      supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
        const input = args[0] as Parameters<ReturnType<typeof getProcessSupervisor>["spawn"]>[0];
        completeCapturedToolCall(
          {
            captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY,
            toolName: "sessions_spawn",
            args: { task: "review" },
          },
          {
            details: {
              status: "accepted",
              runId: childRunId,
              childSessionKey,
              expectsCompletionMessage: true,
            },
          },
        );
        const captureHandle = markMcpLoopbackRequestStarted(
          input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY,
        );
        await resolveMcpLoopbackYieldContext(captureHandle)?.onYield("waiting on subagents");
        markMcpLoopbackRequestFinished(captureHandle);
        input.onStdout?.(SILENT_REPLY_TOKEN);
        return makeManagedRun();
      });
      const context = buildPreparedContext({
        sessionKey: "agent:main:main",
        runId: requesterTurnRunId,
      });
      context.mcpDeliveryCapture = true;
      Object.assign(context.params, {
        messageChannel,
        sessionFile,
        sessionTarget,
        storePath,
        workspaceDir: dir,
        persistAssistantTranscript: true,
      });

      const result = await runPreparedCliAgent(context);

      expect(result).toMatchObject({
        acceptedSessionSpawns: [
          { runId: childRunId, childSessionKey, expectsCompletionMessage: true },
        ],
        meta: {
          yielded: true,
          livenessState: "paused",
          stopReason: "end_turn",
          completion: {
            finishReason: "end_turn",
            stopReason: "end_turn",
            refusal: false,
          },
        },
      });
      const messages = await readTranscriptMessages(sessionTarget);
      expect(messages).toMatchObject([
        { role: "assistant", content: [{ type: "text", text: SILENT_REPLY_TOKEN }] },
      ]);
      expect(result.payloads).toBeUndefined();
      expect(result.meta.terminalReply).toEqual({ disposition: "silent" });
      expect(result.meta.finalAssistantRawText).toBe(SILENT_REPLY_TOKEN);
    },
  );

  it("keeps raw assistant output separate from transformed visible CLI output", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "hello from cli" }));

    const result = await runPreparedCliAgent({
      ...buildPreparedContext(),
      backendResolved: {
        ...buildPreparedContext().backendResolved,
        textTransforms: {
          output: [{ from: "hello", to: "goodbye" }],
        },
      },
    });

    expect(result.payloads).toEqual([{ text: "goodbye from cli" }]);
    expect(result.meta.finalAssistantVisibleText).toBe("goodbye from cli");
    expect(result.meta.finalAssistantRawText).toBe("hello from cli");
    expect(result.meta.terminalReply).toEqual({
      disposition: "visible",
      text: "goodbye from cli",
    });
  });

  it("does not wait for agent_end hooks before resolving channel-backed CLI runs", async () => {
    let releaseAgentEnd: () => void = () => undefined;
    const agentEndSettled = new Promise<void>((resolve) => {
      releaseAgentEnd = resolve;
    });
    const hookRunner = createLifecycleHooks(["agent_end"], () => agentEndSettled);

    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "hello from cli" }));

    const context = buildPreparedContext();
    let resolved = false;
    const run = runPreparedCliAgent(
      withParams(context, {
        messageProvider: "acp",
        messageChannel: "telegram",
      }),
    ).then((result) => {
      resolved = true;
      return result;
    });

    await vi.waitFor(() => {
      expect(hookRunner.runAgentEnd).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(resolved).toBe(true);
    });

    await expect(run).resolves.toMatchObject({
      payloads: [{ text: "hello from cli" }],
    });
    expect(callArg(hookRunner.runAgentEnd, 0, 2, "agent_end options")).toEqual({
      unrefTimeout: true,
    });

    releaseAgentEnd();
  });

  it.each(["fresh", "missing", "omitted", "persisted"] as const)(
    "records fresh Claude reseed proof for a %s user turn",
    async (proof) => {
      supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "hello from claude" }));
      const { dir, sessionTarget } = createSessionFixture();
      vi.mocked(cliTranscript.claudeCliSessionTranscriptHasContent).mockResolvedValue(true);
      const context = makeClaudePreparedContext({
        model: "claude-opus-4-6",
        openClawHistoryPrompt: CLI_RESEED_PROMPT,
      });
      context.preparedBackend.backend.sessionMode = "always";
      const onUserMessagePersisted = vi.fn();
      context.params = {
        ...context.params,
        ...sessionParams(sessionTarget, dir),
        ...(proof === "missing" ? { transcriptPrompt: "canonical current ask" } : {}),
        ...(proof === "omitted" || proof === "persisted"
          ? { suppressNextUserMessagePersistence: true }
          : {}),
        ...(proof === "persisted" ? { onUserMessagePersisted } : {}),
      };
      if (proof === "fresh") {
        context.backendResolved.textTransforms = { input: [{ from: /[<>]/g, to: "_" }] };
      }
      if (proof !== "missing") {
        const recorder =
          proof === "omitted"
            ? createUserTurnTranscriptRecorder({
                target: createTestUserTurnTranscriptTarget({ ...sessionTarget, cwd: dir }),
              })
            : createCliUserTurnRecorder({ text: "current ask", sessionTarget, workspaceDir: dir });
        if (proof === "omitted") {
          recorder.markBlocked();
        } else if (proof === "persisted") {
          const persisted = await recorder.persistApproved();
          expect(persisted?.messageId).toEqual(expect.any(String));
        }
        context.params.userTurnTranscriptRecorder = recorder;
      }

      const result = await runPreparedCliAgent(context);
      const receipt = result.meta.agentMeta?.cliSessionBinding?.reseedReceipt;
      if (proof === "missing") {
        expect(receipt).toBeUndefined();
        await expect(readTranscriptMessages(sessionTarget)).resolves.not.toContainEqual(
          expect.objectContaining({ role: "user" }),
        );
      } else {
        expect(receipt).toEqual({
          version: 1,
          promptHash: hashCliReseedPrompt(
            proof === "fresh" ? CLI_RESEED_PROMPT.replace(/[<>]/g, "_") : CLI_RESEED_PROMPT,
          ),
          localSessionId: "s1",
          userTurnDisposition: proof === "omitted" ? "omitted" : "persisted",
        });
        if (proof === "omitted") {
          await expect(readTranscriptMessages(sessionTarget)).resolves.toEqual([]);
        } else if (proof === "persisted") {
          expect(onUserMessagePersisted).not.toHaveBeenCalled();
        }
      }
    },
  );

  it("preserves a reseed receipt when reusing the same Claude CLI session", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "hello again" }));
    const reseedReceipt = {
      version: 1 as const,
      promptHash: "a".repeat(64),
      localSessionId: "s1",
      userTurnDisposition: "persisted" as const,
    };
    const context = makeClaudePreparedContext({
      model: "claude-opus-4-6",
      cliSessionId: "existing-cli-session",
    });
    context.params.cliSessionBinding = {
      sessionId: "existing-cli-session",
      reseedReceipt,
    };

    vi.mocked(cliTranscript.claudeCliSessionTranscriptHasContent).mockResolvedValue(true);
    const result = await runPreparedCliAgent(context);

    expect(result.meta.agentMeta?.cliSessionBinding?.reseedReceipt).toEqual(reseedReceipt);
  });

  it.each(["before_message_write", "room_event"] as const)(
    "keeps CLI assistant output out of the transcript for %s",
    async (reason) => {
      const hookRunner = {
        hasHooks: vi.fn((hookName: string) => hookName === "before_message_write"),
        runBeforeMessageWrite: vi.fn(() => ({ block: true })),
      };
      if (reason === "before_message_write") {
        setHookRunnerForTest(hookRunner);
      }
      supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "private CLI output" }));
      const { dir, sessionTarget, storePath } = createSessionFixture();
      const context = buildPreparedContext({
        sessionKey: "agent:main:main",
        runId: `run-private-${reason}`,
      });
      if (reason === "before_message_write") {
        context.preparedBackend.backend.sessionMode = "none";
        context.backendResolved.config = context.preparedBackend.backend;
      }
      const result = await runPreparedCliAgent(
        withParams(context, {
          ...sessionParams(sessionTarget, dir),
          persistAssistantTranscript: true,
          storePath,
          ...(reason === "room_event" ? { currentInboundEventKind: "room_event" } : {}),
        }),
      );
      expect(result.payloads).toEqual([{ text: "private CLI output" }]);
      expect(getReplyPayloadMetadata(result.payloads?.[0] ?? {})).toMatchObject({
        assistantTranscriptOwned: true,
      });
      await expect(readTranscriptMessages(sessionTarget)).resolves.toEqual([]);
      if (reason === "before_message_write") {
        expect(hookRunner.runBeforeMessageWrite).toHaveBeenCalledOnce();
        expect(
          callArg(hookRunner.runBeforeMessageWrite, 0, 1, "before_message_write context"),
        ).toEqual({ agentId: "main", sessionKey: "agent:main:main" });
      }
    },
  );

  it("marks a before_message_write-rejected CLI user turn as blocked", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_message_write"),
      runBeforeMessageWrite: vi.fn(() => ({ block: true })),
    };
    setHookRunnerForTest(hookRunner);
    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "hello from cli" }));
    const { dir, sessionTarget } = createSessionFixture();
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "blocked user turn" },
      target: createTestUserTurnTranscriptTarget({
        sessionId: "s1",
        sessionKey: "agent:main:main",
        cwd: dir,
        storePath: sessionTarget.storePath,
      }),
      beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
    });

    const context = buildPreparedContext({
      sessionKey: "agent:main:main",
      runId: "run-blocked-cli-user-turn",
    });
    const result = await runPreparedCliAgent(
      withParams(context, {
        ...sessionParams(sessionTarget, dir),
        prompt: "runtime prompt",
        userTurnTranscriptRecorder: recorder,
      }),
    );

    expect(result.payloads).toEqual([{ text: "hello from cli" }]);
    expect(recorder.hasPersisted()).toBe(false);
    expect(recorder.isBlocked()).toBe(true);
    await expect(readTranscriptMessages(sessionTarget)).resolves.toEqual([]);
    expect(hookRunner.runBeforeMessageWrite).toHaveBeenCalledOnce();
  });

  it("does not execute the CLI when approved user turn persistence fails", async () => {
    const dir = sessionDirs.make();
    const onUserMessagePersisted = vi.fn();
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "runtime prompt" },
      target: () => undefined,
    });
    vi.spyOn(recorder, "persistApproved").mockRejectedValue(
      new Error("user turn persistence failed"),
    );

    const context = buildPreparedContext({
      sessionKey: "agent:main:main",
      runId: "run-persist-fails",
    });

    await expect(
      runPreparedCliAgent(
        withParams(context, {
          agentId: "main",
          sessionFile: path.join(dir, "s1.jsonl"),
          workspaceDir: dir,
          prompt: "runtime prompt",
          userTurnTranscriptRecorder: recorder,
          onUserMessagePersisted,
        }),
      ),
    ).rejects.toThrow();

    expect(supervisorSpawnMock).not.toHaveBeenCalled();
    expect(onUserMessagePersisted).not.toHaveBeenCalled();
  });

  it("blocks CLI runs before llm_input and model execution when before_agent_run blocks", async () => {
    const agentEndStarted = createDeferred();
    let releaseAgentEnd: () => void = () => undefined;
    const agentEndSettled = new Promise<void>((resolve) => {
      releaseAgentEnd = resolve;
    });
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) =>
        ["before_agent_run", "llm_input", "agent_end"].includes(hookName),
      ),
      runBeforeAgentRun: vi.fn(async () => ({
        pluginId: "policy-plugin",
        decision: {
          outcome: "block" as const,
          reason: "matched secret prompt: secret prompt",
          message: "The agent cannot read this message.",
        },
      })),
      runLlmInput: vi.fn(async () => undefined),
      runAgentEnd: vi.fn(() => {
        agentEndStarted.resolve();
        return agentEndSettled;
      }),
    };
    setHookRunnerForTest(hookRunner);
    const { dir, sessionTarget, storePath } = createSessionFixture({
      history: [{ role: "user", content: "earlier context" }],
    });

    let resolved = false;
    const context = makeClaudePreparedContext({
      sessionKey: "agent:main:main",
      runId: "run-blocked-cli",
    });
    context.preparedBackend.backend.sessionMode = "none";
    const run = runPreparedCliAgent(
      withParams(context, {
        ...sessionParams(sessionTarget, dir),
        storePath,
        prompt: "secret prompt",
      }),
    ).then((result) => {
      resolved = true;
      return result;
    });

    await awaitGateBeforeSettlement(
      agentEndStarted.promise,
      run,
      "Blocked CLI run settled before agent_end",
    );
    expect(hookRunner.runAgentEnd).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(resolved).toBe(false);

    releaseAgentEnd();
    const result = await run;

    expect(result.payloads).toEqual([
      {
        text: BLOCK_MESSAGE,
        isError: true,
      },
    ]);
    expect(result.meta.livenessState).toBe("blocked");
    expect(result.meta.agentMeta?.clearCliSessionBinding).toBe(true);
    expect(result.meta.agentMeta?.contextTokens).toBe(150_000);
    expect(supervisorSpawnMock).not.toHaveBeenCalled();
    expect(hookRunner.runLlmInput).not.toHaveBeenCalled();
    const transcriptEvents = await loadTranscriptEvents({
      agentId: "main",
      sessionId: context.params.sessionId,
      sessionKey: "agent:main:main",
      storePath,
    });
    expect(hookRunner.runBeforeAgentRun.mock.calls[0]).toEqual([
      expect.objectContaining({
        prompt: "secret prompt",
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "user", content: "earlier context" }),
        ]),
      }),
      expect.objectContaining({
        runId: "run-blocked-cli",
        agentId: "main",
        sessionKey: "agent:main:main",
      }),
    ]);
    expect(resolved).toBe(true);
    expect(callArg(hookRunner.runAgentEnd, 0, 0, "agent_end event")).toMatchObject({
      success: false,
      error: BLOCK_MESSAGE,
      messages: expect.arrayContaining([
        expect.objectContaining({ role: "user", content: BLOCK_MESSAGE }),
      ]),
    });
    expect(callArg(hookRunner.runAgentEnd, 0, 1, "agent_end context")).toBeTypeOf("object");
    expect(JSON.stringify(hookRunner.runAgentEnd.mock.calls)).not.toContain("secret prompt");

    const blockedLine = requireRecord(
      expectDefined(
        transcriptEvents.find((entry) => {
          const event = requireRecord(entry, "transcript entry");
          return (
            event.type === "message" &&
            requireRecord(event.message, "transcript message").idempotencyKey ===
              "hook-block:before_agent_run:user:run-blocked-cli"
          );
        }),
        "blocked transcript message",
      ),
      "blocked transcript message",
    );
    const blockedMessage = requireRecord(blockedLine.message, "blocked message");
    expect(blockedLine).toMatchObject({
      type: "message",
      message: { role: "user", content: [{ text: BLOCK_MESSAGE }] },
    });
    expect(JSON.stringify(blockedLine)).not.toContain("secret prompt");
    expect(JSON.stringify(blockedLine)).not.toContain("matched secret prompt");
    const blockedMetadata = requireRecord(blockedMessage["__openclaw"], "blocked metadata");
    const blockedState = requireRecord(blockedMetadata.beforeAgentRunBlocked, "blocked state");
    expect(blockedState.blockedBy).toBe("policy-plugin");
    expect(blockedState).not.toHaveProperty("reason");
    expect(Object.hasOwn(blockedMetadata, "beforeAgentRunBlocked")).toBe(true);
  });

  it("persists a blocked bare-key turn under its fixed-store owner", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_agent_run"),
      runBeforeAgentRun: vi.fn(async () => ({
        pluginId: "policy-plugin",
        decision: {
          outcome: "block" as const,
          message: "Blocked by policy.",
        },
      })),
    };
    setHookRunnerForTest(hookRunner);
    const dir = sessionDirs.make();
    const storePath = path.join(dir, "shared-sessions.json");
    const sessionKey = "global";
    const context = makeClaudePreparedContext({
      sessionKey,
      runId: "run-blocked-fixed-owner",
    });
    context.preparedBackend.backend.sessionMode = "none";

    await expect(
      runPreparedCliAgent(
        withParams(context, {
          config: {
            session: { store: storePath },
            agents: {
              ownership: "explicit",
              defaults: { sessionStore: { agentId: "ops" } },
              entries: { ops: {}, research: {} },
            },
          },
          sessionFile: sessionKey,
          storePath,
          workspaceDir: dir,
          prompt: "secret prompt",
        }),
      ),
    ).resolves.toMatchObject({ meta: { livenessState: "blocked" } });

    await expect(
      loadTranscriptEvents({
        agentId: "ops",
        sessionId: context.params.sessionId,
        sessionKey,
        storePath,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({ role: "user" }),
        }),
      ]),
    );
  });

  it("persists before_agent_run CLI blocks through the canonical recorder", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_agent_run"),
      runBeforeAgentRun: vi.fn(async () => ({
        pluginId: "policy-plugin",
        decision: {
          outcome: "block" as const,
          reason: "matched secret prompt: secret prompt",
          message: "The agent cannot read this message.",
        },
      })),
    };
    setHookRunnerForTest(hookRunner);
    const { dir, sessionFile, sessionTarget, storePath } = createSessionFixture();
    const onUserMessagePersisted = vi.fn();

    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: "secret prompt",
        idempotencyKey: "run-blocked-cli-sqlite:user",
      },
      target: {
        sessionId: "s1",
        sessionKey: "agent:main:main",
        sessionEntry: {
          sessionId: "s1",
          sessionFile,
          updatedAt: 10,
        },
        storePath,
        agentId: "main",
        cwd: dir,
      },
      updateMode: "none",
    });
    const persistBlockedSpy = vi.spyOn(recorder, "persistBlocked");
    const context = buildPreparedContext({
      sessionKey: "agent:main:main",
      runId: "run-blocked-cli-sqlite",
    });

    const result = await runPreparedCliAgent(
      withParams(context, {
        ...sessionParams(sessionTarget, dir),
        prompt: "secret prompt",
        storePath,
        userTurnTranscriptRecorder: recorder,
        onUserMessagePersisted,
      }),
    );

    expect(result.meta.livenessState).toBe("blocked");
    expect(supervisorSpawnMock).not.toHaveBeenCalled();
    expect(persistBlockedSpy).toHaveBeenCalledOnce();
    expect(onUserMessagePersisted).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "user",
        content: [
          {
            type: "text",
            text: BLOCK_MESSAGE,
          },
        ],
      }),
    );
    const messages = await readTranscriptMessages(sessionTarget);
    expect(messages).toContainEqual(
      expect.objectContaining({
        role: "user",
        content: [
          {
            type: "text",
            text: BLOCK_MESSAGE,
          },
        ],
        idempotencyKey: "hook-block:before_agent_run:user:run-blocked-cli-sqlite",
      }),
    );
    expect(JSON.stringify(messages)).not.toContain("secret prompt");
    expect(JSON.stringify(messages)).not.toContain("matched secret prompt");
  });

  it.each([
    { text: "   ", expectation: "optional", disposition: "empty" },
    { text: SILENT_REPLY_TOKEN, expectation: "optional", disposition: "silent" },
    { text: "   ", expectation: "required", disposition: undefined },
    { text: "   ", expectation: "result-required", disposition: undefined },
    { text: SILENT_REPLY_TOKEN, expectation: "result-required", disposition: undefined },
  ] as const)(
    "settles $expectation CLI output $text according to its reply obligation",
    async ({ text, expectation, disposition }) => {
      const hookRunner = createLifecycleHooks(["llm_output"]);
      supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: text }));

      const context = makeClaudePreparedContext({
        model: "claude-sonnet-4-6",
      });
      context.params.messageChannel = "telegram";
      context.params.terminalReplyExpectation = expectation;
      const operation = runPreparedCliAgent(context);
      if (disposition) {
        const result = await operation;
        expect(result.payloads).toBeUndefined();
        expect(result.meta.terminalReply).toEqual({ disposition });
        expect(result.meta.executionTrace?.fallbackUsed).toBe(false);
        expect(hookRunner.runLlmOutput).toHaveBeenCalledOnce();
      } else {
        await expect(operation).rejects.toMatchObject({ reason: "empty_response" });
        expect(hookRunner.runLlmOutput).not.toHaveBeenCalled();
      }
    },
  );

  it("emits agent_end with failure details when the CLI run fails", async () => {
    let releaseAgentEnd: () => void = () => undefined;
    const agentEndSettled = new Promise<void>((resolve) => {
      releaseAgentEnd = resolve;
    });
    const hookRunner = createLifecycleHooks(["llm_input", "agent_end"], () => agentEndSettled);

    supervisorSpawnMock.mockResolvedValueOnce(
      makeManagedRun({
        exitCode: 1,
        stderr: "rate limit exceeded",
      }),
    );

    let settled = false;
    const run = runPreparedCliAgent(buildPreparedContext()).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(hookRunner.runLlmInput).toHaveBeenCalledTimes(1);
      expect(hookRunner.runLlmOutput).not.toHaveBeenCalled();
      expect(hookRunner.runAgentEnd).toHaveBeenCalledTimes(1);
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseAgentEnd();
    await expect(run).rejects.toThrow("rate limit exceeded");
    expect(settled).toBe(true);

    const agentEndEvent = requireRecord(
      callArg(hookRunner.runAgentEnd, 0, 0, "agent_end event"),
      "agent_end event",
    );
    expect(agentEndEvent.success).toBe(false);
    expect(agentEndEvent.error).toBe("rate limit exceeded");
    const messages = requireArray(agentEndEvent.messages, "agent_end messages");
    expect(messages).toHaveLength(1);
    expectTextMessage(messages[0], { role: "user", content: "hi" });
    expect(callArg(hookRunner.runAgentEnd, 0, 1, "agent_end context")).toBeTypeOf("object");
  });

  it("does not emit duplicate llm_input when session-expired recovery succeeds", async () => {
    const hookRunner = createLifecycleHooks(["llm_input", "llm_output", "agent_end"]);
    const { dir, sessionFile, sessionTarget } = createSessionFixture({
      history: Array.from({ length: MAX_CLI_SESSION_HISTORY_MESSAGES + 5 }, (_, index) => ({
        role: "user" as const,
        content: `history-${index}`,
      })),
    });

    supervisorSpawnMock.mockResolvedValueOnce(
      makeManagedRun({
        exitCode: 1,
        stderr: "session expired",
      }),
    );
    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: "recovered output" }));

    const context = buildPreparedContext({
      sessionKey: "agent:main:main",
      runId: "run-retry-success",
      cliSessionId: "thread-123",
      openClawHistoryPrompt:
        "Continue this conversation using the OpenClaw transcript below.\n\nUser: recovered history\n\n<next_user_message>\nhi\n</next_user_message>",
    });
    context.preparedBackend.backend.freshSessionRecovery = "invalidated-only";
    const clearBeforeRetry = vi.fn(async () => true);

    const result = await runPreparedCliAgent(
      withParams(context, {
        agentId: "main",
        onBeforeFreshCliSessionRetry: clearBeforeRetry,
        sessionFile,
        sessionTarget,
        workspaceDir: dir,
      }),
    );

    expect(result.payloads).toEqual([{ text: "recovered output" }]);
    expect(result.meta.finalPromptText).toContain("User: recovered history");
    expect(clearBeforeRetry).toHaveBeenCalledWith({
      provider: "codex-cli",
      reason: "session_expired",
      sessionId: "thread-123",
    });

    await vi.waitFor(() => {
      expect(hookRunner.runLlmInput).toHaveBeenCalledTimes(1);
      expect(hookRunner.runLlmOutput).toHaveBeenCalledTimes(1);
      expect(hookRunner.runAgentEnd).toHaveBeenCalledTimes(1);
    });
    const llmInputEvent = requireRecord(
      callArg(hookRunner.runLlmInput, 0, 0, "llm_input event"),
      "llm_input event",
    );
    const historyMessages = requireArray(llmInputEvent.historyMessages, "history messages");
    expect(historyMessages).toHaveLength(MAX_CLI_SESSION_HISTORY_MESSAGES);
    const firstHistoryMessage = requireRecord(historyMessages[0], "first history message");
    expect(firstHistoryMessage.role).toBe("user");
    expect(firstHistoryMessage.content).toBe(`history-5`);
  });

  it.each([false, true])(
    "recovers an invalidated plugin resume once (fresh failure=%s)",
    async (failFresh) => {
      const hookRunner = createLifecycleHooks(["llm_input", "llm_output", "agent_end"]);
      const freshError = new Error("fresh plugin attempt failed");
      const fixture = await warmedPluginContext(
        {
          sessionKey: "agent:main:plugin-resume-recovery",
          runId: "run-plugin-resume-recovery",
          cliSessionId: "warm-session",
          openClawHistoryPrompt: CLI_RESEED_PROMPT,
        },
        async function* (execution, attempt) {
          if (attempt === 2) {
            expect(execution.useResume).toBe(true);
            yield { type: "system", subtype: "init", session_id: "warm-session" };
            execution.liveSession?.current()?.close("abort");
            return;
          }
          expect(execution.useResume).toBe(false);
          expect(execution.prompt).toContain("earlier context");
          if (failFresh) {
            throw freshError;
          }
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "recovered output",
            session_id: "fresh-session",
          };
        },
      );
      const clearBeforeRetry = vi.fn(async () => true);
      try {
        const run = runPreparedCliAgent(
          withParams(fixture.context, {
            onBeforeFreshCliSessionRetry: clearBeforeRetry,
          }),
        );
        if (failFresh) {
          await expect(run).rejects.toBe(freshError);
        } else {
          expect((await run).payloads).toEqual([{ text: "recovered output" }]);
          expect(hookRunner.runLlmInput).toHaveBeenCalledOnce();
          expect(hookRunner.runLlmOutput).toHaveBeenCalledOnce();
          expect(hookRunner.runAgentEnd).toHaveBeenCalledOnce();
        }
        expect(fixture.attempts()).toBe(3);
        expect(clearBeforeRetry).toHaveBeenCalledOnce();
      } finally {
        fixture.close();
      }
    },
  );

  it.each(failClosedPluginResumeCases)(
    "keeps the original failure after $name",
    async ({ name, event, invalidate }) => {
      const streamError = new Error("plugin stream failed without a retry-safe termination");
      const fixture = await warmedPluginContext(
        {
          runId: `run-plugin-fail-closed-${name.replaceAll(" ", "-")}`,
          openClawHistoryPrompt: CLI_RESEED_PROMPT,
        },
        async function* (execution) {
          yield { type: "system", subtype: "init", session_id: "warm-session" };
          if (event) {
            yield event;
          }
          if (invalidate) {
            execution.liveSession?.current()?.close("abort");
          }
          throw streamError;
        },
      );
      try {
        await expect(executePreparedCliRun(fixture.context, "warm-session")).rejects.toBe(
          streamError,
        );
        expect(fixture.attempts()).toBe(2);
      } finally {
        fixture.close();
      }
    },
  );

  it("keeps native control operations out of restrictive prompt preparation", async () => {
    const { dir, sessionFile, sessionTarget } = createSessionFixture({
      history: [{ role: "user", content: "earlier ask" }],
    });
    const config: OpenClawConfig = { agents: { defaults: { workspace: dir } } };
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [
        {
          id: "control-cli",
          pluginId: "test-control",
          config: {
            command: "claude",
            args: ["-p"],
            resumeArgs: ["-p", "--resume", "{sessionId}"],
            output: "jsonl",
            input: "arg",
            sessionMode: "existing",
          },
        },
      ],
    });
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_prompt_build"),
      runBeforePromptBuild: vi.fn(async () => ({
        prependContext: "mutated",
        toolsAllow: [],
      })),
    };
    setHookRunnerForTest(hookRunner);

    const admission = prepareSystemAgentRunAdmission(
      config,
      "run-native-compact",
      "main",
      "cli-native-control-fixture",
    );
    try {
      const context = await prepareCliRunContext({
        preparedRunAdmission: admission,
        sessionId: "s1",
        sessionFile,
        sessionTarget,
        workspaceDir: dir,
        config,
        prompt: "/compact",
        extraSystemPrompt: "must not attach to a control operation",
        finalizePromptForResolvedTools: () => "mutated",
        provider: "control-cli",
        model: "model",
        timeoutMs: 180_000,
        runId: "run-native-compact",
        cliSessionId: "native-session",
        cliSessionBinding: {
          sessionId: "native-session",
          mcpConfigHash: "persisted-mcp-config",
          mcpResumeHash: "persisted-mcp-resume",
        },
        controlOperation: "compact",
      });

      expect(hookRunner.runBeforePromptBuild).not.toHaveBeenCalled();
      expect(context.params.prompt).toBe("/compact");
      expect(context.params.cliToolAvailability).toBeUndefined();
      expect(context.reusableCliSession).toEqual({ mode: "reuse", sessionId: "native-session" });
      expect(context.systemPrompt).toBe("");
      expect(context.contextEngine).toBeUndefined();
      expect(context.claudeSkillsPluginArgs).toEqual([]);
    } finally {
      admission.close();
    }
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
