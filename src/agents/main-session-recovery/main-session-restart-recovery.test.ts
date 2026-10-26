// Verifies restart recovery marks and resumes interrupted main-agent sessions.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { WorkerTaskError } from "@openclaw/worker-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/index.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import {
  emptySqliteCounts,
  observeParentSqlite,
} from "../../../test/helpers/sqlite-parent-observer.js";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { resolveReplyRunDeliveryContext } from "../../auto-reply/reply/agent-runner-core.js";
import { markInboundContextLabel } from "../../auto-reply/reply/inbound-context-marker.js";
import { createReplyRestartRecoveryClaimController } from "../../auto-reply/reply/restart-recovery-claim.js";
import { createReplyRecoveryActorFixture } from "../../auto-reply/reply/restart-recovery-claim.test-support.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import type { CliDeps } from "../../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../../config/config.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import * as configSessions from "../../config/sessions.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import {
  loadSessionEntry,
  appendTranscriptMessage,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { readSessionEntrySummariesInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { resolveAgentRestartRecoveryExecutionIdentityAdmission } from "../../gateway/agent-turn/agent-restart-recovery-context.js";
import { callGateway } from "../../gateway/call.js";
import type { RestartRecoveryCandidate } from "../../gateway/chat-abort.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { createMockGatewayRecoveryRuntime } from "../../gateway/server-recovery-runtime.test-support.js";
import { persistGatewaySessionLifecycleEvent } from "../../gateway/session-lifecycle-state.js";
import * as transcriptReaders from "../../gateway/session-transcript-readers.js";
import {
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
  onAgentEvent,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import {
  registerAgentRunContext,
  claimAgentRunContext,
  releaseAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { completeDeliveryQueueEntryInDatabase } from "../../infra/delivery-queue-sqlite.kernel.js";
import {
  loadDeliveryQueueEntry,
  seedDeliveryQueueEntry,
} from "../../infra/delivery-queue-sqlite.test-support.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "../../infra/outbound/delivery-queue-media-staging.js";
import type { QueuedDelivery } from "../../infra/outbound/delivery-queue-types.js";
import { createUnmodifiedPreparedOutboundBatch } from "../../infra/outbound/prepared-batch.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { addTestHook } from "../../plugins/hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  setActivePluginRegistry,
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
} from "../../plugins/runtime.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  getQueueSize,
  setCommandLaneConcurrency,
} from "../../process/command-queue.js";
import * as gatewayWorkAdmission from "../../process/gateway-work-admission.js";
import {
  GatewayDrainingError,
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { CommandLane } from "../../process/lanes.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import {
  captureSessionTarget,
  beginSessionEffect,
  isSessionControllerWorkActive,
  isSessionMutationActive,
  runSessionMutation,
} from "../../sessions/session-controller.lifecycle.js";
import {
  hasReplyOperationExecutionStarted,
  markReplyOperationExecutionStarted,
} from "../../sessions/session-controller.state.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  buildRunUserTurnIdempotencyKey,
  createUserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import {
  createAgentDatabaseInspectionRefusal,
  preparePendingAgentDatabase,
  recordAgentDatabaseAdmissions,
} from "../../state/agent-database-admission.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  beginAgentDeletionJournal,
  removeAgentDeletionJournal,
} from "../../test-utils/agent-deletion-journal.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { buildCurrentRunRestartRecoveryClaim } from "../agent-command-restart-recovery.js";
import { deliverAgentCommandResult } from "../command/delivery.js";
import type { EmbeddedAgentQueueHandle } from "../embedded-agent-runner/runs.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
} from "../embedded-agent-runner/runs.test-support.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../internal-runtime-context.js";
import {
  createRestartRecoveryRequesterSource,
  readRestartRecoveryRequesterSource,
} from "../requester-run-recovery-source.js";
import {
  AGENT_RUN_RESTART_ABORT_ERROR_CODE,
  resolveAgentRunErrorLifecycleFields,
} from "../run-termination.js";
import { SessionManager } from "../sessions/session-manager.js";
import {
  createAssistantToolCallMessage,
  createSessionEntry,
  createSubagentRunRecord,
  type SessionEntryFixture,
  expectRecord,
  mockCallArg,
  waitForFast,
} from "../subagent-test-fixtures.test-helpers.js";
import {
  resolveRequesterRecoveryDelivery,
  hasMessagingToolDeliveryToSource,
} from "../subagents/announce/subagent-announce-completion-delivery.js";
import { subagentRuns } from "../subagents/registry/subagent-registry-memory.js";
import { registerHarnessCompletionRecoveryCases } from "./main-session-harness-completion.test-harness.js";
import { registerParentRestartRecoveryCases } from "./main-session-parent-recovery.test-harness.js";
import * as recoveryOwnerRelease from "./main-session-recovery-owner-release.js";
import { registerReplayBoundaryRecoveryCases } from "./main-session-recovery-replay-boundary.test-harness.js";
import {
  createRecoveryRuntimeFixture,
  observeRecoveryRoots,
  runRecoveryCommandDuringStop,
} from "./main-session-recovery-runtime.test-support.js";
import * as recoveryStore from "./main-session-recovery-store.js";
import {
  claimMainSessionRecoveryOwner,
  commitMainSessionRecovery,
} from "./main-session-recovery-store.js";
import { dispatchRestartRecoveryUntilStarted } from "./main-session-restart-dispatch-start.js";
import { readStartupRecoveryWarning } from "./main-session-restart-recovery-diagnostics.js";
import {
  createRestartRecoveryStoreFixture,
  mainSessionEntry,
  makePendingFinalDelivery,
  readStore,
  runningSessionEntry,
} from "./main-session-restart-recovery-fixture.test-support.js";
import {
  discoverRestartRecoveryStoreTargets,
  mainSessionRecoveryLog,
} from "./main-session-restart-recovery-shared.js";
import { recoverStore } from "./main-session-restart-recovery-store.js";
import {
  codeModeCheckpointMessage,
  codeModeWaitCallMessage,
  textContent,
  toolCall,
  makeAssistantTextMessage,
  makeMessageDeliveryTranscript,
  makeMessageToolCall,
  makeMessageToolResult,
  makeToolResultMessage,
  makeUserMessage,
} from "./main-session-restart-recovery-transcript.test-support.js";
import {
  markRestartAbortedMainSessions as markRestartAbortedMainSessionsBase,
  markStartupOrphanedMainSessionsForRecovery as markStartupOrphanedMainSessionsForRecoveryBase,
  recoverRestartAbortedMainSessions as recoverRestartAbortedMainSessionsBase,
  retryRestartAbortedMainSessionRecovery as retryRestartAbortedMainSessionRecoveryBase,
  scheduleRestartAbortedMainSessionRecoveryAfterOwnerRelease,
  scheduleRestartAbortedMainSessionRecovery as scheduleRestartAbortedMainSessionRecoveryBase,
} from "./main-session-restart-recovery.js";
import { registerTerminalApprovalRecoveryCases } from "./main-session-terminal-approval.test-harness.js";

const transcriptMocks = vi.hoisted(() => ({ appendAssistantMessageToSessionTranscript: vi.fn() }));
const discordDeliveryContext = { channel: "discord", to: "discord:dm:123" } as const;
const executionIdentityEnabledConfig = {
  logging: { audit: { executionIdentity: true } },
} satisfies OpenClawConfig;

vi.mock("../../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({ runId: "run-resumed" })),
}));

const sendRecoveryNotice = vi.fn<GatewayRecoveryRuntime["sendRecoveryNotice"]>(async () => ({
  suppressed: false,
}));
let dispatchSettlement = createDeferred();
const mockRecoveryRuntime = createRecoveryRuntimeFixture({
  callGateway,
  getDispatchSettlement: () => dispatchSettlement.promise,
  sendRecoveryNotice,
});

type RecoveryParams<T extends { gatewayRuntime: unknown }> = Omit<T, "gatewayRuntime"> &
  Partial<Pick<T, "gatewayRuntime">>;

const recover = (
  params: RecoveryParams<Parameters<typeof recoverRestartAbortedMainSessionsBase>[0]>,
) =>
  recoverRestartAbortedMainSessionsBase({
    stateDir: tmpDir,
    gatewayRuntime: mockRecoveryRuntime,
    ...params,
  });
const retryRecovery = (
  params: RecoveryParams<Parameters<typeof retryRestartAbortedMainSessionRecoveryBase>[0]>,
) => retryRestartAbortedMainSessionRecoveryBase({ gatewayRuntime: mockRecoveryRuntime, ...params });

const markInterrupted = (
  params: Omit<Parameters<typeof markRestartAbortedMainSessionsBase>[0], "resolveGatewayContext">,
) => markRestartAbortedMainSessionsBase({ stateDir: tmpDir, resolveGatewayContext, ...params });
const markOrphans = (
  params: Parameters<typeof markStartupOrphanedMainSessionsForRecoveryBase>[0],
) => markStartupOrphanedMainSessionsForRecoveryBase({ stateDir: tmpDir, ...params });
const scheduleRecovery = (
  params: Omit<
    RecoveryParams<Parameters<typeof scheduleRestartAbortedMainSessionRecoveryBase>[0]>,
    "getConfig"
  > & { getConfig?: () => OpenClawConfig },
) =>
  scheduleRestartAbortedMainSessionRecoveryBase({
    gatewayRuntime: mockRecoveryRuntime,
    getConfig: () => ({}),
    stateDir: tmpDir,
    ...params,
  });

async function expectRecovery(
  expected: Partial<{ started: number; settled: number; failed: number; skipped: number }>,
  cfg?: Parameters<typeof recover>[0]["cfg"],
): Promise<void> {
  const params = cfg === undefined ? { stateDir: tmpDir } : { cfg, stateDir: tmpDir };
  await expect(recover(params)).resolves.toEqual(recoveryCounts(expected));
}

function recoveryCounts(
  overrides: Partial<{ started: number; settled: number; failed: number; skipped: number }> = {},
) {
  return { started: 0, settled: 0, failed: 0, skipped: 0, ...overrides };
}

function expectCleared(entry: SessionEntry | undefined, ...keys: (keyof SessionEntry)[]) {
  for (const key of keys) {
    expect(entry?.[key], key).toBeUndefined();
  }
}

type DispatchArgs = Parameters<GatewayRecoveryRuntime["dispatchAgent"]>;

function agentRequests() {
  return vi
    .mocked(callGateway)
    .mock.calls.map(([request]) => request)
    .filter(({ method }) => method === "agent");
}

function retryMainClaim(
  storePath: string,
  gatewayRuntime: GatewayRecoveryRuntime = mockRecoveryRuntime,
) {
  return retryRecovery({
    cfg: {},
    expectedRecoveryRunId: "recovery-main",
    expectedRecoverySourceRunId: "source-main",
    expectedSessionId: "main-session",
    sessionKey: "agent:main:main",
    storePath,
    gatewayRuntime,
  });
}

function queueTimeoutRuntime(
  dispatchAgent: GatewayRecoveryRuntime["dispatchAgent"],
  withNotices = false,
) {
  return createMockGatewayRecoveryRuntime({
    dispatchAgent,
    ...(withNotices ? { sendRecoveryNotice } : {}),
    waitForAgent: vi.fn(async () => ({
      runId: "recovery-main",
      status: "timeout",
      timeoutPhase: "queue",
      providerStarted: false,
    })) as GatewayRecoveryRuntime["waitForAgent"],
  });
}

async function admitRecovery(storePath: string, runId: string, sessionKey = "agent:main:main") {
  await commitMainSessionRecovery({
    command: {
      kind: "admit_recovery",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      now: Date.now(),
      runId,
      sessionId: "main-session",
    },
    requireWriteSuccess: true,
    target: { sessionKey, storePath },
  });
}

function gatewayParams(callIndex = 0): Record<string, unknown> {
  return expectRecord(mockCallArg(callGateway, callIndex).params, "gateway params");
}

function pauseFirstDurableWrite() {
  const entered = createDeferred();
  const release = createDeferred();
  const apply = sessionAccessor.applySessionEntryReplacements;
  let paused = false;
  const spy = vi
    .spyOn(sessionAccessor, "applySessionEntryReplacements")
    .mockImplementation(async (params) => {
      if (params.requireWriteSuccess === true && !paused) {
        paused = true;
        entered.resolve();
        await release.promise;
      }
      return await apply(params);
    });
  return { entered, release, spy };
}

function observeRetryTimer() {
  const scheduled = createDeferred();
  const setTimeout = globalThis.setTimeout;
  const spy = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation((...args: Parameters<typeof setTimeout>) => {
      const timer = setTimeout(...args);
      if (args[1] === 5_000) {
        scheduled.resolve();
      }
      return timer;
    });
  return { scheduled, spy };
}

vi.mock("../../config/sessions/transcript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/transcript.js")>();
  transcriptMocks.appendAssistantMessageToSessionTranscript.mockImplementation(
    actual.appendAssistantMessageToSessionTranscript,
  );
  return {
    ...actual,
    appendAssistantMessageToSessionTranscript:
      transcriptMocks.appendAssistantMessageToSessionTranscript,
  };
});

let tmpDir: string;
let freshTmpDir: string;
const {
  makeSessionsDir,
  writeStorePath,
  writeStore,
  writeMainSession,
  makeMainSessionFixture,
  transcriptFixture,
  writeTranscript,
  writeCompletedToolTranscript,
} = createRestartRecoveryStoreFixture(() => tmpDir);

async function makeCompletedToolFixture(
  overrides: Parameters<typeof makeMainSessionFixture>[0] = {},
  human = false,
) {
  const fixture = await makeMainSessionFixture(overrides);
  await writeCompletedToolTranscript(fixture.sessionsDir, human);
  return fixture;
}

async function makeStoreFixture(entries: Record<string, SessionEntryFixture>, agentId = "main") {
  const sessionsDir = await makeSessionsDir(agentId);
  const storePath = path.join(sessionsDir, "sessions.json");
  await writeStore(sessionsDir, entries);
  return { sessionsDir, storePath };
}

async function writeUserTurn(sessionsDir: string, text: string, sessionId = "main-session") {
  await writeTranscript(sessionsDir, sessionId, [makeUserMessage(text)]);
}

async function writeToolTurn(
  sessionsDir: string,
  text: string,
  result: string,
  sessionId = "main-session",
) {
  await writeTranscript(sessionsDir, sessionId, [
    makeUserMessage(text),
    makeToolResultMessage(result),
  ]);
}

function currentTurn(...messages: unknown[]) {
  return [makeUserMessage("do the thing"), ...messages];
}

function failedWaitResult(toolCallId: string | undefined, current = false) {
  const error = current ? "code mode execution aborted" : "Error: The operation was aborted.";
  const code = current ? "aborted" : "internal_error";
  return makeToolResultMessage(
    textContent(current ? JSON.stringify({ status: "failed", code, error }) : error),
    {
      toolName: "wait",
      ...(toolCallId ? { toolCallId } : {}),
      details: { status: "failed", error, code, ...(current ? { replaySafe: true } : {}) },
      isError: true,
    },
  );
}

function seedQueuedFinal(id: string, text: string): void {
  const entry: QueuedDelivery = {
    id,
    enqueuedAt: Date.now(),
    retryCount: 0,
    attemptCount: 0,
    channel: "discord",
    to: "discord:dm:123",
    preparedBatch: createUnmodifiedPreparedOutboundBatch([{ text }]),
    queuePolicy: "required",
    completionRetention: "permanent",
    retainOnFailure: true,
  };
  seedDeliveryQueueEntry({ queueName: OUTBOUND_DELIVERY_QUEUE_NAME, stateDir: tmpDir, entry });
}
const resolveGatewayContext = () => undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  dispatchSettlement = createDeferred();
  vi.mocked(callGateway).mockReset();
  vi.mocked(callGateway).mockImplementation(async () => ({ runId: "run-resumed" }));
  resetAgentEventsForTest();
  resetGatewayWorkAdmission();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-main-restart-recovery-"));
  freshTmpDir = tmpDir;
  setRuntimeConfigSnapshot({});
});

afterEach(async () => {
  resetGatewayWorkAdmission();
  const caseDir = tmpDir;
  tmpDir = freshTmpDir;
  try {
    await transcriptFixture.reset(caseDir);
  } finally {
    await cleanupSessionStateForTest({ stateDir: tmpDir });
    await fs.rm(tmpDir, { recursive: true, force: true });
    clearRuntimeConfigSnapshot();
  }
});

function activeRestartRun(
  sessionKey = "agent:main:main",
  sessionId = "main-session",
  overrides: Partial<RestartRecoveryCandidate> = {},
): RestartRecoveryCandidate {
  return {
    storePath: path.join(tmpDir, "agents", "main", "sessions", "sessions.json"),
    agentId: "main",
    sessionKey,
    sessionId,
    runId: "restart-run",
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    ...overrides,
  };
}

function deliveredReceiptEntry(
  toolCallId = "message-call-1",
  sourceRunId = "discord-message-1",
): Partial<SessionEntry> {
  return {
    restartRecoveryDeliveryReceiptState: "delivered-terminal",
    restartRecoveryDeliveryToolCallId: toolCallId,
    restartRecoveryDeliveryRunId: "recovery-1",
    restartRecoveryDeliverySourceRunId: sourceRunId,
    restartRecoveryDeliveryContext: discordDeliveryContext,
  };
}

function makeDeliveredReceiptFixture(
  toolCallId = "message-call-1",
  sourceRunId = "discord-message-1",
  overrides: SessionEntryFixture = {},
) {
  return makeMainSessionFixture({
    sessionKey: "agent:main:discord:direct:123",
    ...deliveredReceiptEntry(toolCallId, sourceRunId),
    ...overrides,
  });
}

function makeControlUiRecoveryFixture(overrides: SessionEntryFixture = {}) {
  return makeMainSessionFixture({
    restartRecoveryDeliveryRequestFingerprint: "request-fingerprint",
    restartRecoveryDeliveryRunId: "control-ui-run",
    restartRecoveryDeliverySourceRunId: "control-ui-run",
    restartRecoverySourceIngress: "control-ui",
    ...overrides,
  });
}

async function prepareTranscript(
  messages: readonly unknown[],
  entry: SessionEntryFixture = {},
): Promise<string> {
  tmpDir = transcriptFixture.prepareRoot();
  const sessionsDir = await makeSessionsDir();
  await writeMainSession({ sessionsDir, ...entry });
  await writeTranscript(sessionsDir, "main-session", messages);
  return sessionsDir;
}

async function loadTestTranscript(
  sessionKey: string,
  storePath: string,
): Promise<Array<{ message?: Record<string, unknown> }>> {
  return (await loadTranscriptEvents({
    sessionId: "main-session",
    sessionKey,
    storePath,
  })) as Array<{ message?: Record<string, unknown> }>;
}

async function deliverRecoveryReply(
  request: Record<string, unknown>,
  sessionEntry: SessionEntry | undefined,
  text: string,
) {
  const runId = String(request.idempotencyKey);
  const sessionKey = String(request.sessionKey);
  const result = { payloads: [{ text }], meta: { durationMs: 1 } };
  await deliverAgentCommandResult({
    cfg: {} as OpenClawConfig,
    deps: {} as CliDeps,
    runtime: { log: vi.fn(), error: vi.fn() } as never,
    opts: {
      message: String(request.message),
      deliver: request.deliver === true,
      bestEffortDeliver: request.bestEffortDeliver === true,
      channel: String(request.channel),
      to: String(request.to),
      accountId: String(request.accountId),
      threadId: String(request.threadId),
      sessionKey,
      runId,
    },
    outboundSession: { key: sessionKey, agentId: "main" },
    sessionEntry,
    payloads: result.payloads,
    result,
  } as Parameters<typeof deliverAgentCommandResult>[0]);
  return { runId, status: "ok" };
}

function getHarnessRecoveryFixture() {
  return {
    tmpDir,
    makeSessionsDir,
    mainSessionEntry,
    writeStore,
    writeTranscript,
    expectRecovery,
    loadSessionEntry,
    sendRecoveryNotice,
    dispatchSettlement,
    discordDeliveryContext,
    runningSessionEntry,
    gatewayParams,
  };
}

describe("main-session-restart-recovery", () => {
  const expectMarked = (work: ReturnType<typeof markInterrupted>, marked = 1, skipped = 0) =>
    expect(work).resolves.toEqual({ marked, skipped });
  const sessionTarget = (storePath: string, agentId = "main", sessionKey = "global") => ({
    agentId,
    storePath,
    sessionKey,
  });
  const idleEntry = (sessionId: string) =>
    mainSessionEntry({
      sessionId,
      status: "done",
      abortedLastRun: false,
      mainRestartRecovery: undefined,
    });
  const pendingEntry = (sessionId: string, abortedLastRun = true) =>
    mainSessionEntry({
      sessionId,
      abortedLastRun,
      pendingFinalDelivery: makePendingFinalDelivery(),
      restartRecoveryForceSafeTools: true,
    });
  const admitStoreTurn = (scope: string, identities: string[]) =>
    beginSessionEffect({
      resolveGatewayContext,
      scope,
      identities,
      assertAllowed: () => undefined,
    });
  const withStateDir = (work: () => Promise<void>) =>
    withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, work);

  it.for(["finish", "stop"] as const)(
    "starts recovery in interruption order across stores and preserves waiting work on %s",
    async (outcome, { signal }) => {
      const cfg = { agents: { entries: { main: {}, worker: {} } } };
      const sessions = Array.from({ length: 8 }, (_, index) => {
        const agentId = index % 2 === 0 ? "worker" : "main";
        return {
          agentId,
          sessionKey: `agent:${agentId}:dashboard:recovery-${7 - index}`,
          entry: mainSessionEntry({
            sessionId: `recovery-${index}`,
            endedAt: index + 1,
            updatedAt: 100 - index,
          }),
        };
      });
      for (const agentId of ["main", "worker"]) {
        const owned = sessions.filter((session) => session.agentId === agentId);
        const { sessionsDir } = await makeStoreFixture(
          Object.fromEntries(owned.map(({ sessionKey, entry }) => [sessionKey, entry])),
          agentId,
        );
        for (const { entry } of owned) {
          await writeUserTurn(sessionsDir, "finish the interrupted task", entry.sessionId);
        }
      }
      const originalConcurrency = getCommandLaneSnapshot(CommandLane.RestartRecovery).maxConcurrent;
      expect(originalConcurrency).toBe(4);
      const cancellation = new AbortController();
      const gates = sessions.map(() => createDeferred());
      const backgroundStarted = createDeferred();
      const releaseBackground = createDeferred();
      const background = enqueueCommandInLane(CommandLane.Background, async () => {
        backgroundStarted.resolve();
        await releaseBackground.promise;
      });
      await backgroundStarted.promise;
      const started: number[] = [];
      const firstFourStarted = createDeferred();
      let active = 0;
      let peak = 0;
      const runtime: GatewayRecoveryRuntime = {
        ...mockRecoveryRuntime,
        dispatchAgent: <T>(
          request: DispatchArgs[0],
          _timeout?: number,
          options?: DispatchArgs[2],
        ) => {
          const index = sessions.findIndex(({ sessionKey }) => sessionKey === request.sessionKey);
          let executionStarted = false;
          options?.onStartOwner?.({
            observe: () => ({ executionStarted, startDeadlineAtMs: Date.now() + 60_000 }),
            abort: () => false,
          });
          options?.onAccepted?.({ runId: request.idempotencyKey });
          return enqueueCommandInLane(request.lane ?? "main", async () => {
            active++;
            peak = Math.max(peak, active);
            started.push(index);
            executionStarted = true;
            options?.onExecutionStarted?.();
            if (started.length === 4) {
              firstFourStarted.resolve();
            }
            try {
              await gates[index]!.promise;
              return { runId: request.idempotencyKey, status: "ok" } as T;
            } finally {
              active--;
            }
          });
        },
      };
      const recovery = recover({
        cfg,
        signal: cancellation.signal,
        shouldContinue: () => !cancellation.signal.aborted,
        gatewayRuntime: runtime,
      });
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            firstFourStarted.promise,
            recovery,
            "recovery settled before four interrupted sessions started",
          ),
          signal,
        );
        expect(started).toEqual([0, 1, 2, 3]);
        await waitForFast(() => expect(getQueueSize(CommandLane.RestartRecovery)).toBe(5));
        await expect(enqueueCommandInLane("main", async () => "interactive reply")).resolves.toBe(
          "interactive reply",
        );
        expect(peak).toBe(4);
        if (outcome === "stop") {
          cancellation.abort(new Error("recovery stopped"));
          await expect(recovery).rejects.toThrow("recovery stopped");
          for (const { agentId, sessionKey } of sessions.slice(4)) {
            expect(
              loadSessionEntry({
                agentId,
                storePath: path.join(tmpDir, "agents", agentId, "sessions", "sessions.json"),
                sessionKey,
              }),
            ).toMatchObject({
              status: "interrupted",
              abortedLastRun: true,
              mainRestartRecovery: { chargedAttempts: 0 },
            });
          }
        } else {
          for (const gate of gates.slice(0, 4)) {
            gate.resolve();
          }
          await expect(recovery).resolves.toEqual(recoveryCounts({ started: 8 }));
          expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        }
      } finally {
        cancellation.abort(new Error("recovery test finished"));
        releaseBackground.resolve();
        for (const gate of gates) {
          gate.resolve();
        }
        await Promise.all([background, recovery.catch(() => {})]);
        setCommandLaneConcurrency(CommandLane.RestartRecovery, originalConcurrency);
      }
      expect(started).toEqual(outcome === "finish" ? [0, 1, 2, 3, 4, 5, 6, 7] : [0, 1, 2, 3]);
      expect(peak).toBe(4);
    },
  );

  it("preserves exact restart identities against stale same-id rows", async () => {
    const sessionKeys = ["agent:main:active", "agent:main:sibling"];
    const { storePath } = await makeStoreFixture(
      Object.fromEntries(sessionKeys.map((key) => [key, runningSessionEntry("shared-session")])),
    );
    const run = activeRestartRun("agent:main:active", "shared-session", { runId: "run-active" });
    registerAgentRunContext(run.runId, run);
    await expectMarked(markInterrupted({ activeRuns: [run], isActiveRun: () => true }));
    const store = readStore(storePath);
    expect(store[sessionKeys[0]!]).toMatchObject({
      abortedLastRun: true,
      restartRecoveryRuns: [{ runId: run.runId, lifecycleGeneration: run.lifecycleGeneration }],
    });
    expectCleared(store[sessionKeys[1]!], "abortedLastRun", "restartRecoveryRuns");
  });

  it("marks only recoverable sessions owned by active runs", async () => {
    const { sessionsDir } = await makeStoreFixture({
      "agent:main:main": runningSessionEntry("main-session"),
      "agent:main:completed": {
        sessionId: "completed-session",
        updatedAt: Date.now() - 10_000,
        status: "done",
      },
      "agent:main:subagent:child": { ...runningSessionEntry("child-session"), spawnDepth: 1 },
      "cron:nightly": runningSessionEntry("cron-session"),
      "agent:main:other": runningSessionEntry("other-session"),
    });

    registerAgentRunContext("restart-run", {
      sessionKey: "agent:main:main",
      sessionId: "main-session",
    });
    registerAgentRunContext("key-only-run", { sessionKey: "agent:main:main" });
    registerAgentRunContext("stale-session-run", {
      sessionKey: "agent:main:main",
      sessionId: "stale-session",
    });
    const result = await markInterrupted({
      activeRuns: [
        activeRestartRun(),
        activeRestartRun("agent:main:subagent:child", "child-session"),
      ],
    });

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 2, skipped: 0 });
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:subagent:child"]?.abortedLastRun).toBe(true);
    for (const key of ["agent:main:completed", "cron:nightly", "agent:main:other"]) {
      expectCleared(store[key], "abortedLastRun");
    }
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    expect(store["agent:main:main"]?.restartRecoveryRuns).toEqual([
      { runId: "key-only-run", lifecycleGeneration },
      { runId: "restart-run", lifecycleGeneration },
    ]);
  });

  it.each<[name: string, identities: string[][], expected: string[]]>([
    ["ID-only turn", [["session-main"]], ["main", "stale"]],
    [
      "crossed pairs from separate turns",
      [
        ["main", "session-sibling"],
        ["sibling", "session-main"],
      ],
      [],
    ],
  ])("recovers an admitted %s without a chat run", async (_name, identities, expected) => {
    const storePath = path.join(tmpDir, "admitted-channel", "sessions.json");
    const otherStorePath = path.join(tmpDir, "other-admitted-channel", "sessions.json");
    const key = (name: string) => `agent:main:${name}`;
    const entries = {
      [key("main")]: runningSessionEntry("session-main"),
      [key("sibling")]: runningSessionEntry("session-sibling"),
      [key("stale")]: runningSessionEntry("session-main"),
    };
    await writeStorePath(storePath, entries);
    await writeStorePath(otherStorePath, entries);
    const admissions = await Promise.all(
      identities.map((group) =>
        admitStoreTurn(
          storePath,
          group.map((identity) =>
            ["main", "sibling"].includes(identity) ? key(identity) : identity,
          ),
        ),
      ),
    );
    try {
      await expectMarked(
        markInterrupted({
          cfg: { session: { store: otherStorePath } },
          activeRuns: [],
        }),
        expected.length,
      );
      const store = readStore(storePath);
      for (const name of ["main", "sibling", "stale"]) {
        const marked = expected.includes(name) ? true : undefined;
        expect([
          store[key(name)]?.abortedLastRun,
          store[key(name)]?.restartRecoveryForceSafeTools,
        ]).toEqual([marked, marked]);
        expect(readStore(otherStorePath)[key(name)]?.abortedLastRun).toBeUndefined();
      }
    } finally {
      admissions.forEach((admission) => admission.release());
    }
  });

  it("does not scan stale stores for agents absent from the configured roster", async () => {
    const configuredSessionsDir = await makeSessionsDir("main");
    await writeMainSession({ sessionsDir: configuredSessionsDir });
    const staleSessionsDir = await makeSessionsDir("amnesia-probe");
    await writeMainSession({
      sessionsDir: staleSessionsDir,
      sessionKey: "agent:amnesia-probe:main",
    });

    const cfg = { agents: { entries: { main: {} } } } as OpenClawConfig;
    const observer = observeParentSqlite();
    try {
      const storeTargets = await discoverRestartRecoveryStoreTargets({ cfg, stateDir: tmpDir });

      expect(storeTargets).toContainEqual({
        agentId: "main",
        storePath: path.join(configuredSessionsDir, "sessions.json"),
      });
      expect(storeTargets).not.toContainEqual({
        agentId: "amnesia-probe",
        storePath: path.join(staleSessionsDir, "sessions.json"),
      });
      expect(observer.counts).toEqual(emptySqliteCounts());
    } finally {
      observer.restore();
    }
  });

  it("marks an admitted custom-store turn after a deleted agent leaves its directory behind", async () => {
    await withStateDir(async () => {
      const staleSessionsDir = await makeSessionsDir("retired-probe");
      await writeMainSession({
        sessionsDir: staleSessionsDir,
        sessionKey: "agent:retired-probe:main",
      });
      closeOpenClawAgentDatabasesForTest();
      const deletion = beginAgentDeletionJournal({
        agentId: "retired-probe",
        operationId: randomUUID(),
        agentDir: path.join(tmpDir, "agents", "retired-probe", "agent"),
        workspaceDir: path.join(tmpDir, "workspace-retired-probe"),
        sessionsDir: staleSessionsDir,
        deleteFiles: false,
      });
      const storePath = path.join(tmpDir, "active-custom-store", "sessions.json");
      const sessionKey = "agent:main:custom";
      let admission: Awaited<ReturnType<typeof beginSessionEffect>> | undefined;
      try {
        await writeStorePath(storePath, { [sessionKey]: runningSessionEntry("custom-session") });
        admission = await admitStoreTurn(storePath, [sessionKey, "custom-session"]);
        await expectMarked(
          markInterrupted({
            cfg: { agents: { entries: { main: {} } } },
            activeRuns: [],
          }),
        );
        expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
          sessionId: "custom-session",
          abortedLastRun: true,
          restartRecoveryForceSafeTools: true,
        });
      } finally {
        admission?.release();
        removeAgentDeletionJournal(deletion.agentId, deletion.operationId);
      }
    });
  });

  it("marks an admitted removed owner without duplicate scans in a shared store", async () => {
    await withStateDir(async () => {
      const storePath = path.join(tmpDir, "retired-active", "shared.sqlite");
      const retired = sessionTarget(storePath);
      const configured = sessionTarget(storePath, "ops", "agent:ops:idle");
      await replaceSessionEntry(retired, runningSessionEntry("retired-active-session"));
      await replaceSessionEntry(configured, idleEntry("configured-idle-session"));
      const configuredBefore = sessionAccessor.loadSessionEntry(configured);
      const admission = await admitStoreTurn(storePath, [
        retired.sessionKey,
        "retired-active-session",
      ]);
      try {
        await expectMarked(
          markInterrupted({
            cfg: {
              agents: { ownership: "explicit", entries: { ops: {} } },
              session: { store: storePath },
            },
            activeRuns: [],
          }),
        );
        expect(sessionAccessor.loadSessionEntry(retired)).toMatchObject({
          sessionId: "retired-active-session",
          abortedLastRun: true,
          restartRecoveryForceSafeTools: true,
        });
        expect(sessionAccessor.loadSessionEntry(configured)).toEqual(configuredBefore);
      } finally {
        admission.release();
      }
    });
  });

  it("preserves the yielded global requester owner in a shared store", async () => {
    await withStateDir(async () => {
      const storePath = path.join(tmpDir, "yielded", "shared.sqlite");
      const cfg = {
        agents: {
          ownership: "explicit",
          entries: { main: {}, ops: {} },
          defaults: { sessionStore: { agentId: "ops" } },
        },
        session: { scope: "global", store: storePath },
      } satisfies OpenClawConfig;
      await replaceSessionEntry(
        sessionTarget(storePath, "main", "agent:main:unrelated"),
        idleEntry("unrelated"),
      );
      const target = sessionTarget(storePath, "ops");
      await replaceSessionEntry(
        target,
        mainSessionEntry({
          sessionId: "yielded-requester",
          status: undefined,
          endedAt: 10,
          abortedLastRun: false,
        }),
      );
      const child = createSubagentRunRecord({
        runId: `yielded-owner-shared`,
        childSessionKey: `agent:ops:subagent:yielded-shared`,
        requesterSessionKey: "global",
        requesterAgentId: "ops",
        expectsCompletionMessage: true,
        requesterSettleWake: {
          status: "pending",
          attemptCount: 0,
          requesterYieldBatch: true,
          rearmGeneration: 1,
          batchRunIds: [`yielded-owner-shared`],
        },
      });
      subagentRuns.set(child.runId, child);
      try {
        await expectMarked(
          markInterrupted({
            cfg,
            activeRuns: [activeRestartRun("global", "yielded-requester", target)],
          }),
          0,
        );
        expect(sessionAccessor.loadSessionEntry(target)?.abortedLastRun).toBe(false);

        await sessionAccessor.patchSessionEntryCore(target, () => ({
          abortedLastRun: true,
          mainRestartRecovery: { cycleId: "yielded-cycle", revision: 1, chargedAttempts: 0 },
        }));
        await expectMarked(markOrphans({ cfg }), 0, 1);
        expect(sessionAccessor.loadSessionEntry(target)?.abortedLastRun).toBe(false);
        expect(sessionAccessor.loadSessionEntry(target)?.mainRestartRecovery).toBeUndefined();
        expect(child.requesterSettleWake?.rearmGeneration).toBe(1);
        expect(callGateway).not.toHaveBeenCalled();
      } finally {
        subagentRuns.delete(child.runId);
      }
    });
  });

  it.each(["templated", "shared-global"] as const)(
    "preserves startup recovery ownership for an actual ops row: %s",
    async (layout) => {
      await withStateDir(async () => {
        const sessionKey = "global";
        const configuredStore =
          layout === "templated"
            ? path.join(tmpDir, "agents", "{agentId}", "sessions", "sessions.json")
            : path.join(tmpDir, "stores", "shared.sqlite");
        const cfg = {
          agents: {
            ownership: "explicit",
            entries: { main: {}, ops: {} },
            ...(layout === "shared-global"
              ? { defaults: { sessionStore: { agentId: "ops" } } }
              : {}),
          },
          session: { store: configuredStore, scope: "global" },
        } satisfies OpenClawConfig;
        const storePath = configSessions.resolveSessionStorePathCore(configuredStore, {
          agentId: "ops",
        });
        const mainStorePath = configSessions.resolveSessionStorePathCore(configuredStore, {
          agentId: "main",
        });
        const mainTarget = sessionTarget(mainStorePath, "main", "agent:main:unrelated");
        await replaceSessionEntry(mainTarget, idleEntry("unrelated-main-session"));
        const mainBefore = sessionAccessor.loadExactSessionEntryReadOnly(mainTarget)?.entry;
        const target = sessionTarget(storePath, "ops");
        await replaceSessionEntry(target, pendingEntry("ops-startup-session"));
        if (layout === "shared-global") {
          openOpenClawAgentDatabase({ agentId: "main", path: storePath });
        }
        await expect(recover({ cfg })).resolves.toEqual(recoveryCounts({ started: 1 }));
        const request = gatewayParams();
        expect(request).toMatchObject({
          agentId: "ops",
          sessionKey,
          idempotencyKey: expect.any(String),
        });
        expect(sessionAccessor.loadExactSessionEntryReadOnly(target)?.entry).toMatchObject({
          sessionId: "ops-startup-session",
          restartRecoveryDeliveryRunId: request.idempotencyKey,
        });
        expect(sessionAccessor.loadExactSessionEntryReadOnly(mainTarget)?.entry).toEqual(
          mainBefore,
        );
      });
    },
  );

  it.each(["checkpoint", "dispatch"] as const)(
    "keeps two flat-store owners distinct during %s",
    async (phase) => {
      await withStateDir(async () => {
        const storePath = path.join(tmpDir, "two-owners", "sessions.json");
        const cfg = {
          agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
          session: { store: storePath, scope: "global" },
        } satisfies OpenClawConfig;
        const targets = ["main", "ops"].map((agentId) => sessionTarget(storePath, agentId));
        for (const target of targets) {
          await replaceSessionEntry(
            target,
            pendingEntry(`${target.agentId}-startup-session`, false),
          );
        }
        const startupCheckedStorePaths = new Set<string>();
        if (phase === "checkpoint") {
          await expectMarked(
            markOrphans({
              cfg: { ...cfg, agents: { ...cfg.agents, entries: { main: {} } } },
              startupCheckedStorePaths,
            }),
          );
          const mainBefore = sessionAccessor.loadSessionEntry(targets[0]!);
          await expectMarked(markOrphans({ cfg, startupCheckedStorePaths }));
          expect(sessionAccessor.loadSessionEntry(targets[0]!)).toEqual(mainBefore);
        } else {
          await expectMarked(markOrphans({ cfg, startupCheckedStorePaths }), 2);
        }
        for (const target of targets) {
          expect(sessionAccessor.loadSessionEntry(target)?.abortedLastRun).toBe(true);
        }
        if (phase === "dispatch") {
          const handledSessionKeys = new Set<string>();
          await expect(recover({ cfg, handledSessionKeys })).resolves.toEqual(
            recoveryCounts({ started: 2 }),
          );
          expect(agentRequests().map(({ params }) => params)).toEqual(
            expect.arrayContaining(
              targets.map(({ agentId, sessionKey }) =>
                expect.objectContaining({ agentId, sessionKey }),
              ),
            ),
          );
          await expect(recover({ cfg, handledSessionKeys })).resolves.toMatchObject({
            started: 0,
            failed: 0,
          });
          expect(agentRequests()).toHaveLength(2);
        }
      });
    },
  );

  it("dispatches a config-less bare recovery under the legacy implicit owner", async () => {
    const storePath = path.join(tmpDir, "legacy-shared", "sessions.json");
    await writeStorePath(storePath, { global: pendingEntry("main-session") });

    await expect(
      recoverStore({
        gatewayRuntime: mockRecoveryRuntime,
        handledSessionKeys: new Set(),
        storePath,
      }),
    ).resolves.toEqual(recoveryCounts({ started: 1 }));
    expect(gatewayParams()).toMatchObject({ agentId: "main", sessionKey: "global" });
  });

  it("marks queued abort-registry runs before lifecycle start", async () => {
    tmpDir = transcriptFixture.prepareRoot();

    const { storePath } = await makeStoreFixture({
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "done",
        startedAt: 1_000,
        endedAt: 2_000,
        runtimeMs: 1_000,
      },
    });

    using _ = vi.spyOn(Date, "now").mockReturnValue(3_000);
    const result = await markInterrupted({
      activeRuns: [
        activeRestartRun("agent:main:main", "main-session", {
          runId: "queued-run",
          lifecycleGeneration: "pre-restart",
        }),
      ],
    });

    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(readStore(storePath)["agent:main:main"]).toMatchObject({
      status: "interrupted",
      abortedLastRun: true,
      restartRecoveryRuns: [{ runId: "queued-run", lifecycleGeneration: "pre-restart" }],
      endedAt: 3_000,
    });
    expectCleared(readStore(storePath)["agent:main:main"], "startedAt", "runtimeMs");
  });

  it.each([
    [
      "does not reopen a queued run that completed before store persistence",
      undefined,
      undefined,
      false,
      false,
    ],
    [
      "does not reopen a terminal row written at the observed event timestamp",
      2_000,
      2_000,
      true,
      false,
    ],
    [
      "does not reopen a completed session via current-generation maintenance-expired abort controller",
      3_000,
      5_000,
      true,
      true,
    ],
  ] as const)("%s", async (runId, updatedAt, observedAt, isActive, currentGeneration) => {
    tmpDir = transcriptFixture.prepareRoot();

    const { storePath } = await makeStoreFixture({
      "agent:main:main": createSessionEntry({
        sessionId: "main-session",
        updatedAt: updatedAt ?? Date.now() - 10_000,
        status: "done",
      }),
    });

    const result = await markInterrupted({
      activeRuns: [
        activeRestartRun("agent:main:main", "main-session", {
          runId,
          lifecycleGeneration: currentGeneration
            ? getAgentEventLifecycleGeneration()
            : "pre-restart",
          ...(observedAt === undefined ? {} : { observedAt }),
        }),
      ],
      isActiveRun: () => isActive,
    });

    expect(result).toEqual({ marked: 0, skipped: 0 });
    expect(readStore(storePath)["agent:main:main"]?.status).toBe("done");
    expectCleared(readStore(storePath)["agent:main:main"], "restartRecoveryRuns");
  });

  it.each([
    ["preserves current-generation markers across repeated restart marking", true],
    ["replaces an older marker when the same run id is active after another restart", false],
  ] as const)("%s", async (_name, repeated) => {
    tmpDir = transcriptFixture.prepareRoot();
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const previous = {
      runId: repeated ? "first-restart-run" : "shared-run",
      lifecycleGeneration: repeated ? lifecycleGeneration : "first-generation",
    };
    const next = {
      runId: repeated ? "second-restart-run" : "shared-run",
      lifecycleGeneration: repeated ? lifecycleGeneration : "second-generation",
    };
    const { readEntry } = await makeMainSessionFixture({ restartRecoveryRuns: [previous] });
    await markInterrupted({
      activeRuns: [activeRestartRun("agent:main:main", "main-session", next)],
    });
    expect(readEntry()?.restartRecoveryRuns).toEqual(repeated ? [previous, next] : [next]);
  });

  it("re-marks an in-flight recovered turn and resumes it once after another restart", async () => {
    const { sessionsDir, sessionKey, readEntry } = await makeMainSessionFixture();
    await writeUserTurn(sessionsDir, "finish the interrupted task");
    await expectRecovery({ started: 1 });
    const recoveryRunId = String(gatewayParams().idempotencyKey);
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const cycleId = readEntry()?.mainRestartRecovery?.cycleId;
    expect(readEntry()).toMatchObject({
      abortedLastRun: false,
      lifecycleRunId: recoveryRunId,
      mainRestartRecovery: { chargedAttempts: 1 },
    });
    const mark = () =>
      markInterrupted({
        activeRuns: [
          activeRestartRun(sessionKey, "main-session", {
            runId: recoveryRunId,
            lifecycleGeneration,
          }),
        ],
      });
    await expectMarked(mark());
    await expectMarked(mark());
    expect(readEntry()).toMatchObject({
      abortedLastRun: true,
      status: "interrupted",
      mainRestartRecovery: { cycleId, chargedAttempts: 1 },
      restartRecoveryRuns: [{ runId: recoveryRunId, lifecycleGeneration }],
    });
    rotateAgentEventLifecycleGeneration();
    try {
      await expectRecovery({ started: 1 });
      expect(String(gatewayParams(1).idempotencyKey)).not.toBe(recoveryRunId);
      await expectRecovery({});
      expect(callGateway).toHaveBeenCalledTimes(2);
      expect(readEntry()).toMatchObject({ abortedLastRun: false });
    } finally {
      dispatchSettlement.resolve();
    }
  });

  it("uses active pairs to avoid marking stale duplicate keys in another store", async () => {
    const defaultSessionsDir = await makeSessionsDir();
    await writeStore(defaultSessionsDir, {
      "agent:main:issue-82433": runningSessionEntry("stale-default-session"),
    });

    const storePath = path.join(tmpDir, "custom-duplicate-key", "sessions.json");
    await writeStorePath(storePath, {
      "agent:main:issue-82433": runningSessionEntry("active-custom-session"),
    });

    const result = await markInterrupted({
      cfg: { session: { store: storePath } },
      activeRuns: [
        activeRestartRun("agent:main:issue-82433", "active-custom-session", { storePath }),
      ],
    });

    const defaultStore = readStore(path.join(defaultSessionsDir, "sessions.json"));
    const customStore = readStore(storePath);
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(defaultStore["agent:main:issue-82433"]?.abortedLastRun).toBeUndefined();
    expect(customStore["agent:main:issue-82433"]?.abortedLastRun).toBe(true);
  });

  it("resumes when durable commentary is mirrored after the restart recovery mark", async () => {
    tmpDir = transcriptFixture.prepareRoot();

    const sessionKey = "agent:main:main";
    const { sessionsDir, storePath } = await makeStoreFixture({
      [sessionKey]: runningSessionEntry("main-session"),
    });
    await writeUserTurn(sessionsDir, "finish the interrupted long-running turn");

    await expectMarked(
      markInterrupted({
        activeRuns: [activeRestartRun(sessionKey)],
        reason: "gateway restart drain",
      }),
    );

    const progress = [
      "Checking the remaining background task.",
      "The restart handoff is in progress.",
    ];
    await writeTranscript(
      sessionsDir,
      "main-session",
      progress.map((text, index) =>
        makeAssistantTextMessage(text, {
          stopReason: "stop",
          openclawStreamFallback: {
            replacementText: text,
            source: "segment",
            itemId: `progress-after-recovery-mark-${index}`,
          },
        }),
      ),
    );

    await expectRecovery({ started: 1 });
    expect(gatewayParams().sessionKey).toBe(sessionKey);
    expect(readStore(storePath)[sessionKey]?.status).toBeUndefined();
    expect(readStore(storePath)[sessionKey]?.abortedLastRun).toBe(false);

    const transcript = await loadTestTranscript(sessionKey, storePath);
    expect(
      transcript
        .map((event) => event.message)
        .filter(
          (message) =>
            message?.role === "assistant" &&
            (message as { openclawStreamFallback?: { source?: unknown } }).openclawStreamFallback
              ?.source === "segment",
        ),
    ).toHaveLength(2);
  });

  it("resumes a drain-marked turn that settles normally before the replacement starts", async () => {
    await withStateDir(async () => {
      const sessionKey = "agent:main:main";
      const runId = "drain-overlap-run";
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      const { sessionsDir, storePath } = await makeStoreFixture({
        [sessionKey]: runningSessionEntry("main-session"),
      });
      await writeUserTurn(sessionsDir, "finish the admitted work after the restart");

      const rootAdmission = tryBeginGatewayRootWorkAdmission();
      expect(rootAdmission).not.toBeNull();
      await rootAdmission?.run(async () => {
        await expectMarked(
          markInterrupted({
            activeRuns: [
              activeRestartRun(sessionKey, "main-session", {
                storePath,
                agentId: "main",
                runId,
                lifecycleGeneration,
              }),
            ],
            reason: "gateway restart drain",
          }),
        );
        markGatewayRestartDraining();
        await expect(
          runWithGatewayIndependentRootWorkAdmission(async () => undefined),
        ).rejects.toBeInstanceOf(GatewayDrainingError);
        await writeTranscript(sessionsDir, "main-session", [
          makeToolResultMessage(textContent("Gateway restart admission is closed."), {
            toolName: "sessions_spawn",
            isError: true,
          }),
          makeAssistantTextMessage("The Gateway is restarting; retry after it comes back."),
        ]);
        await persistGatewaySessionLifecycleEvent({
          sessionKey,
          agentId: "main",
          event: {
            ts: Date.now(),
            sessionId: "main-session",
            runId,
            lifecycleGeneration,
            data: { phase: "end", stopReason: "stop" },
          },
        });
      });
      rootAdmission?.release();

      expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
        status: "interrupted",
        abortedLastRun: true,
      });
      expect(loadSessionEntry({ sessionKey, storePath })?.restartRecoveryRuns).toBeUndefined();

      resetGatewayWorkAdmission();
      rotateAgentEventLifecycleGeneration();
      const recovery = scheduleRecovery({ maxRetries: 1 });
      await mockRecoveryRuntime.expectAdmission(1, recovery, { sessionKey, storePath });

      expect(gatewayParams()).toMatchObject({
        expectedExistingSessionId: "main-session",
        inputProvenance: {
          kind: "internal_system",
          sourceSessionKey: sessionKey,
          sourceTool: "main_session_restart_recovery",
        },
        sessionKey,
      });
      expect(gatewayParams().idempotencyKey).not.toBe(runId);
    });
  });

  registerParentRestartRecoveryCases({
    makeSessionsDir,
    writeStore,
    writeTranscript,
    writePreparedMainSessionTranscript: prepareTranscript,
    expectRecovery,
    gatewayParams,
  });

  registerHarnessCompletionRecoveryCases(getHarnessRecoveryFixture);
  registerTerminalApprovalRecoveryCases({
    stateDir: () => tmpDir,
    makeControlUiRecoveryFixture,
    writeTranscript,
    expectRecovery,
    gatewayParams,
  });
  registerReplayBoundaryRecoveryCases({
    writePreparedMainSessionTranscript: prepareTranscript,
    expectRecovery,
    gatewayParams,
  });

  it.each(["discord", "telegram"] as const)(
    "delivers a resumed reply through the interrupted %s route",
    async (channel) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
        try {
          const isTelegram = channel === "telegram";
          const sessionKey = isTelegram
            ? "agent:main:telegram:direct:12345:thread:12345:99"
            : "agent:main:discord:direct:123";
          const deliveryContext = {
            channel: "telegram",
            to: "telegram:12345",
            accountId: "work",
            threadId: "99",
          } as const;
          const delivery = {
            kind: "external" as const,
            context: deliveryContext,
            route: {
              channel: "telegram",
              accountId: "work",
              target: { to: "telegram:12345", chatType: "direct" as const },
              thread: { id: "99", kind: "topic" as const, source: "turn" as const },
            },
            origin: {
              provider: "telegram",
              to: "telegram:12345",
              accountId: "work",
              threadId: "99",
            },
          };
          if (isTelegram) {
            expect(
              resolveReplyRunDeliveryContext({
                cfg: {},
                sessionCtx: {
                  Provider: "telegram",
                  OriginatingChannel: "telegram",
                  OriginatingTo: "telegram:12345",
                  AccountId: "work",
                  MessageThreadId: 99,
                  TransportThreadId: 99,
                  SessionKey: sessionKey,
                },
                sessionEntry: mainSessionEntry({ delivery }),
                sessionKey,
              }),
            ).toEqual({ ...deliveryContext, threadId: 99 });
          }
          const deliveredText = vi.fn();
          const hookHandler = vi.fn(
            async (event: { payload: { text?: string } }, context: Record<string, unknown>) => ({
              payload: { ...event.payload, text: `hooked: ${event.payload.text ?? ""}` },
              metadata: context,
            }),
          );
          const outbound: ChannelOutboundAdapter = {
            deliveryMode: "direct",
            sendText: async ({ to, text, threadId }) => {
              deliveredText(isTelegram ? { to, text, threadId } : { to, text });
              return { channel, messageId: isTelegram ? "delivered-telegram-1" : "delivered-1" };
            },
          };
          const registry = createTestRegistry([
            {
              pluginId: channel,
              source: "test",
              plugin: createOutboundTestPlugin({ id: channel, outbound }),
            },
          ]);
          if (!isTelegram) {
            addTestHook({
              registry,
              pluginId: "recovery-hook-test",
              hookName: "reply_payload_sending",
              handler: hookHandler,
            });
          }
          resetGlobalHookRunner();
          if (!isTelegram) {
            initializeGlobalHookRunner(registry);
          }
          setActivePluginRegistry(registry);
          const { readEntry } = await makeCompletedToolFixture({
            sessionKey,
            ...(isTelegram
              ? { delivery }
              : {
                  deliveryContext: { channel: "discord", to: "discord:dm:stale", accountId: "old" },
                  restartRecoveryDeliveryContext: {
                    channel: "discord",
                    to: "discord:dm:123",
                    accountId: "main",
                    threadId: 123,
                  },
                }),
          });
          const answer = isTelegram ? "recovered private-topic reply" : "final answer";
          vi.mocked(callGateway).mockImplementationOnce(async ({ params }) => {
            const request = params as Record<string, unknown>;
            const current = readEntry();
            if (isTelegram) {
              if (!current) {
                throw new Error("expected claimed Telegram recovery session");
              }
              const runId = String(request.idempotencyKey);
              expect(
                buildCurrentRunRestartRecoveryClaim({ deliveryContext, entry: current, runId }),
              ).toMatchObject({
                restartRecoveryDeliveryContext: deliveryContext,
                restartRecoveryDeliveryRunId: runId,
              });
            }
            return await deliverRecoveryReply(request, current, answer);
          });
          await expectRecovery({ settled: 1 });
          if (isTelegram) {
            expect(gatewayParams()).toMatchObject({
              sessionKey,
              channel: "telegram",
              accountId: "work",
            });
            expect(deliveredText).toHaveBeenCalledWith({
              to: "telegram:12345",
              text: answer,
              threadId: "99",
            });
            expect(sendRecoveryNotice).not.toHaveBeenCalled();
            const completed = readEntry();
            expect(completed).toMatchObject({ status: "done", abortedLastRun: false });
            expectCleared(
              completed,
              "restartRecoveryDeliveryRunId",
              "restartRecoveryDeliveryContext",
            );
            if (!completed) {
              throw new Error("expected completed Telegram recovery session");
            }
            expect(
              buildCurrentRunRestartRecoveryClaim({
                deliveryContext,
                entry: completed,
                runId: "telegram-follow-up-run",
                sourceIngress: "channel",
                sourceRunId: "telegram-follow-up-source",
              }),
            ).toMatchObject({
              restartRecoveryDeliveryContext: deliveryContext,
              restartRecoveryDeliveryRunId: "telegram-follow-up-run",
              restartRecoveryDeliverySourceRunId: "telegram-follow-up-source",
            });
          } else {
            const resumeParams = gatewayParams();
            expect(resumeParams).toMatchObject({
              bestEffortDeliver: true,
              lane: "restart-recovery",
              threadId: "123",
            });
            const recoveryRunId = String(resumeParams.idempotencyKey);
            expect(hookHandler.mock.calls[0]?.[1]).toMatchObject({
              channelId: channel,
              accountId: "main",
              conversationId: "discord:dm:123",
              sessionKey,
              runId: recoveryRunId,
            });
            expect(deliveredText).toHaveBeenCalledExactlyOnceWith({
              to: "discord:dm:123",
              text: "hooked: final answer",
            });
          }
        } finally {
          try {
            await cleanupSessionStateForTest({ stateDir: tmpDir });
          } finally {
            resetGlobalHookRunner();
            setActivePluginRegistry(createEmptyPluginRegistry());
          }
        }
      });
    },
  );

  it("releases recovered Telegram notice authority after a transport failure", async () => {
    const sessionsDir = await makeSessionsDir();
    const sessionKey = "agent:main:telegram:group:-100123:topic:99";
    await writeMainSession({
      sessionsDir,
      sessionKey,
      deliveryContext: {
        channel: "telegram",
        to: "telegram:-100123",
        accountId: "work",
        threadId: 99,
      },
    });
    await writeCompletedToolTranscript(sessionsDir);
    let currentAtSend: boolean | undefined;
    sendRecoveryNotice.mockImplementationOnce(async (notice) => {
      currentAtSend = notice.isCurrent?.({});
      throw new Error("temporary transport failure");
    });
    await expectRecovery({ started: 1 });
    expect(currentAtSend).toBe(true);
    const notice = sendRecoveryNotice.mock.calls[0]?.[0];
    expect(notice).toMatchObject({
      channel: "telegram",
      to: "telegram:-100123",
      accountId: "work",
      threadId: 99,
      text: expect.stringContaining("Recovery did not grant new permission"),
      idempotencyKey: `main-session-restart-recovery:${String(gatewayParams().idempotencyKey)}:resumed-notice`,
    });
    expect(notice?.isCurrent?.({})).toBe(false);
    const current = loadSessionEntry({
      sessionKey,
      storePath: path.join(sessionsDir, "sessions.json"),
    });
    if (!current) {
      throw new Error("Recovered session fixture is missing");
    }
    await writeStore(sessionsDir, {
      [sessionKey]: { ...current, sessionId: "replacement-session" },
    });
    expect(notice?.isCurrent?.({})).toBe(false);
    await writeStore(sessionsDir, { [sessionKey]: current });
    expect(notice?.isCurrent?.({})).toBe(false);
    dispatchSettlement.resolve();
  });

  it("reuses a transcript-only claim without inferring historical session routes", async () => {
    const { readEntry } = await makeCompletedToolFixture(
      {
        sessionKey: "agent:main:discord:direct:123",
        restartRecoveryDeliveryRunId: "control-ui-run",
        restartRecoveryDeliverySourceRunId: "control-ui-run",
        restartRecoverySourceIngress: "internal",
        restartRecoverySourceReplyDeliveryMode: "message_tool_only",
        deliveryContext: { channel: "discord", to: "discord:dm:stale", accountId: "old" },
      },
      true,
    );
    let claimAtDispatch: SessionEntry | undefined;
    vi.mocked(callGateway).mockImplementationOnce(async ({ params }) => {
      claimAtDispatch = readEntry();
      return { runId: String((params as { idempotencyKey?: unknown }).idempotencyKey) };
    });

    await expectRecovery({ started: 1 });
    const resumeParams = gatewayParams() as Record<string, unknown>;
    expect(resumeParams).toMatchObject({
      deliver: false,
      sourceReplyDeliveryMode: "message_tool_only",
    });
    expect(claimAtDispatch).toMatchObject({
      restartRecoveryDeliveryRunId: resumeParams.idempotencyKey,
      restartRecoveryDeliverySourceRunId: "control-ui-run",
    });
    expect(resumeParams.idempotencyKey).not.toBe("control-ui-run");
    expect(readEntry()?.mainRestartRecovery?.executionIdentity).toBeUndefined();
    expect(gatewayParams()).not.toHaveProperty("internalExecutionIdentityRetry");
    expect(gatewayParams().internalExecutionIdentityRecoveryAttempt).toBe(1);
  });

  it("resumes an admitted queued user turn under a distinct recovery identity", async () => {
    const inputRunId = "queued-human-input";
    const executionRunId = "queued-followup-execution";
    const sourceTurnId = buildRunUserTurnIdempotencyKey(inputRunId);
    const { sessionsDir, storePath, sessionKey, readEntry } = await makeMainSessionFixture({
      abortedLastRun: false,
      mainRestartRecovery: undefined,
      status: "done",
    });
    let entry = readEntry()!;
    {
      const recorder = createUserTurnTranscriptRecorder({
        message: {
          role: "user",
          content: "finish the synthetic task",
          timestamp: 1,
          idempotencyKey: sourceTurnId,
        },
        target: {
          agentId: "main",
          storePath,
          sessionKey,
          sessionId: entry.sessionId,
          sessionEntry: entry,
        },
        updateMode: "none",
      });
      await using actor = createReplyRecoveryActorFixture({
        agentId: "main",
        storePath,
        sessionKey,
        getSessionId: () => entry.sessionId,
      });
      const controller = createReplyRestartRecoveryClaimController({
        agentId: "main",
        storePath,
        sessionKey,
        acquireSessionActor: () => actor.acquireSessionActor(),
        admissionRunId: inputRunId,
        executionRunId,
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        sourceTurnId,
        getEntry: () => entry,
        getSessionId: () => entry.sessionId,
        setEntry: (next) => {
          entry = next;
        },
        isRestartAbort: () => false,
        resolveDeliveryContext: () => discordDeliveryContext,
      });
      await expect(controller.admitUserTurn(recorder)).resolves.toBe("admitted");
    }
    expect(readEntry()).toMatchObject({
      restartRecoveryDeliveryRunId: inputRunId,
      restartRecoveryDeliverySourceRunId: sourceTurnId,
    });
    await markInterrupted({
      activeRuns: [activeRestartRun(sessionKey, entry.sessionId, { runId: executionRunId })],
      isActiveRun: () => true,
    });
    let resumedRunId: string | undefined;
    vi.mocked(callGateway).mockImplementationOnce(async ({ params }) => {
      const request = expectRecord(params, "recovery request");
      resumedRunId = String(request.idempotencyKey);
      await appendTranscriptMessage(
        { storePath, sessionKey, sessionId: entry.sessionId },
        {
          cwd: sessionsDir,
          message: makeUserMessage(String(request.message), {
            idempotencyKey: buildRunUserTurnIdempotencyKey(resumedRunId),
          }),
        },
      );
      return { runId: resumedRunId };
    });
    const result = await recover({ stateDir: tmpDir });
    await expect(vi.mocked(callGateway).mock.results[0]?.value).resolves.toEqual({
      runId: resumedRunId,
    });
    expect(result).toEqual(recoveryCounts({ started: 1 }));
    expect(resumedRunId).not.toBe(inputRunId);
    expect(readEntry()?.restartRecoveryDeliverySourceRunId).toBe(sourceTurnId);
    const transcript = await loadTestTranscript(sessionKey, storePath);
    expect(
      transcript.filter((event) => event.message?.idempotencyKey === sourceTurnId),
    ).toHaveLength(1);
  });

  it.each(["control-ui-run", "control-ui-run:user"])(
    "keeps ambiguous recovery identity unbound for source %s",
    async (sourceRunId) => {
      const { readEntry } = await makeCompletedToolFixture({
        restartRecoveryDeliveryRunId: "control-ui-run",
        restartRecoveryDeliverySourceRunId: sourceRunId,
      });
      vi.mocked(callGateway).mockRejectedValueOnce(new Error("gateway unavailable"));

      await expectRecovery({ failed: 1 }, executionIdentityEnabledConfig);

      const firstRecoveryRunId = gatewayParams().idempotencyKey;
      expect(firstRecoveryRunId).toEqual(expect.any(String));
      expect(firstRecoveryRunId).not.toBe("control-ui-run");
      const pending = readEntry();
      expect(pending).toMatchObject({
        abortedLastRun: true,
        mainRestartRecovery: { chargedAttempts: 1 },
        restartRecoveryDeliveryRunId: firstRecoveryRunId,
        restartRecoveryDeliverySourceRunId: sourceRunId,
        sessionId: "main-session",
        status: "interrupted",
      });
      expect(pending?.mainRestartRecovery?.reservation).toBeUndefined();
      expect(pending?.mainRestartRecovery?.executionIdentity).toBeUndefined();
      expect(gatewayParams()).toMatchObject({
        internalExecutionIdentityRetry: false,
        internalExecutionIdentityRecoveryAttempt: 1,
      });

      await expectRecovery({ started: 1 }, executionIdentityEnabledConfig);
      const runIds = agentRequests().map(
        ({ params }) => expectRecord(params, "agent params").idempotencyKey,
      );
      expect(runIds).toEqual([firstRecoveryRunId, firstRecoveryRunId]);
      const recovered = readEntry();
      expect(recovered).toMatchObject({
        abortedLastRun: false,
        mainRestartRecovery: { chargedAttempts: 2 },
        restartRecoveryDeliveryRunId: firstRecoveryRunId,
        restartRecoveryDeliverySourceRunId: sourceRunId,
      });
      expect(recovered?.status).toBeUndefined();
      expect(agentRequests()[1]).toMatchObject({
        params: {
          internalExecutionIdentityRetry: true,
          internalExecutionIdentityRecoveryAttempt: 2,
        },
      });
    },
  );

  it("preserves recovery identity when a prior-lifecycle delivery run rotates", async () => {
    const previousRecoveryRunId = "recovery-run-a";
    const sourceRunId = "channel-run";
    const previousExecutionIdentity = createExecutionIdentityAdmissionToken(previousRecoveryRunId, {
      contextId: "recovery-context",
      executionId: "recovery-execution",
      now: 123,
    });
    const { sessionsDir, storePath, sessionKey, readEntry } = await makeMainSessionFixture({
      sessionKey: "agent:main:discord:direct:123",
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 1,
        chargedAttempts: 1,
        executionIdentity: previousExecutionIdentity,
      },
      restartRecoveryDeliveryRunId: previousRecoveryRunId,
      restartRecoveryDeliverySourceRunId: sourceRunId,
      restartRecoveryDeliveryContext: discordDeliveryContext,
      restartRecoveryRuns: [
        { runId: previousRecoveryRunId, lifecycleGeneration: "previous-generation" },
      ],
    });
    await writeTranscript(sessionsDir, "main-session", [
      makeUserMessage("original channel turn", { idempotencyKey: `${sourceRunId}:user` }),
      makeUserMessage("first restart continuation", {
        idempotencyKey: `${previousRecoveryRunId}:user`,
      }),
      makeMessageToolCall("later-tool-call"),
      makeMessageToolResult("later-tool-call"),
    ]);
    let dispatchedRunId: string | undefined;
    vi.mocked(callGateway).mockImplementationOnce(async ({ method, params }) => {
      expect(method).toBe("agent");
      dispatchedRunId = String((params as { idempotencyKey?: unknown }).idempotencyKey);
      const sessionManager = SessionManager.open(
        { agentId: "main", sessionId: "main-session", sessionKey, storePath },
        sessionsDir,
      );
      const gatewayAdmission = resolveAgentRestartRecoveryExecutionIdentityAdmission({
        collectionEnabled: true,
        isRestartRecoveryResumeRun: true,
        retryOnly:
          (params as { internalExecutionIdentityRetry?: unknown })
            .internalExecutionIdentityRetry === true,
        runId: dispatchedRunId,
        sessionEntry: readEntry(),
      });
      expect(gatewayAdmission?.consume(dispatchedRunId)).toEqual({
        accepted: true,
        token: previousExecutionIdentity,
      });
      sessionManager.appendMessage({
        role: "user",
        content: "[System] continue after restart",
        idempotencyKey: `${dispatchedRunId}:user`,
        timestamp: Date.now(),
      });
      return { runId: dispatchedRunId };
    });

    const recoveryResult = await recover({ cfg: executionIdentityEnabledConfig });

    await expect(vi.mocked(callGateway).mock.results[0]?.value).resolves.toEqual({
      runId: dispatchedRunId,
    });
    expect(recoveryResult).toEqual(recoveryCounts({ started: 1 }));
    expect(dispatchedRunId).toEqual(expect.any(String));
    expect(dispatchedRunId).not.toBe(previousRecoveryRunId);
    expect(gatewayParams()).toMatchObject({
      channel: "discord",
      idempotencyKey: dispatchedRunId,
      to: "discord:dm:123",
    });
    const recoveredEntry = readEntry();
    expect(recoveredEntry).toMatchObject({
      restartRecoveryDeliveryContext: discordDeliveryContext,
      restartRecoveryDeliveryRunId: dispatchedRunId,
      restartRecoveryDeliverySourceRunId: sourceRunId,
    });
    expect(recoveredEntry?.mainRestartRecovery?.executionIdentity).toEqual(
      previousExecutionIdentity,
    );
    const transcript = await loadTestTranscript(sessionKey, storePath);
    expect(
      transcript
        .map((event) => event.message?.idempotencyKey)
        .filter((key) => typeof key === "string"),
    ).toEqual([`${sourceRunId}:user`, `${previousRecoveryRunId}:user`, `${dispatchedRunId}:user`]);
  });

  it.each(["cleanup", "preparation", "rejection", "settlement"] as const)(
    "preserves reservation accounting after a %s failure",
    async (failure) => {
      const { readEntry } = await makeCompletedToolFixture();
      let dispatchFailed = false;
      if (failure === "cleanup") {
        vi.mocked(callGateway).mockImplementationOnce(async () => {
          dispatchFailed = true;
          throw new Error("gateway unavailable");
        });
      } else if (failure === "rejection") {
        vi.mocked(callGateway).mockRejectedValueOnce(
          new GatewayClientRequestError({
            code: "UNAVAILABLE",
            message: "restart recovery reservation is stale",
            retryable: false,
          }),
        );
      } else if (failure === "settlement") {
        vi.mocked(callGateway).mockImplementation(async (request) => {
          if (request.method === "agent") {
            dispatchFailed = true;
            throw new Error("ambiguous dispatch transport failure");
          }
          return { runId: "recovery-run", status: "ok", endedAt: Date.now() };
        });
      }
      const scheduleSpy =
        failure === "cleanup"
          ? vi
              .spyOn(recoveryOwnerRelease, "scheduleMainSessionRecoveryPendingTarget")
              .mockImplementation(() => {})
          : undefined;
      const apply = sessionAccessor.applySessionEntryReplacements;
      let cleanupFailures = 0,
        postDispatchWrites = 0,
        injected = false;
      const replacementSpy =
        failure === "rejection"
          ? undefined
          : vi
              .spyOn(sessionAccessor, "applySessionEntryReplacements")
              .mockImplementation(async (params) => {
                if (failure === "cleanup" && dispatchFailed && params.requireWriteSuccess) {
                  cleanupFailures++;
                  throw new Error("extended session-store failure");
                }
                if (
                  failure === "preparation" &&
                  !injected &&
                  params.requireWriteSuccess !== true &&
                  readEntry()?.mainRestartRecovery?.reservation
                ) {
                  injected = true;
                  return false;
                }
                if (
                  failure === "settlement" &&
                  dispatchFailed &&
                  params.requireWriteSuccess !== true &&
                  ++postDispatchWrites === 2
                ) {
                  injected = true;
                  throw new Error("settlement store failure");
                }
                return await apply(params);
              });
      try {
        await expectRecovery({ failed: 1 }, {});
        if (failure === "cleanup") {
          expect(readEntry()?.mainRestartRecovery?.reservation).toBeDefined();
          expect(scheduleSpy).not.toHaveBeenCalled();
        }
      } finally {
        scheduleSpy?.mockRestore();
        replacementSpy?.mockRestore();
      }
      const entry = readEntry();
      expect(entry?.mainRestartRecovery).toMatchObject({
        chargedAttempts: failure === "preparation" || failure === "rejection" ? 0 : 1,
      });
      if (failure === "cleanup") {
        expect(cleanupFailures).toBe(1);
      } else {
        expect(entry?.mainRestartRecovery?.reservation).toBeUndefined();
        if (failure !== "rejection") {
          expect(injected).toBe(true);
        }
        if (failure === "preparation") {
          expect(callGateway).not.toHaveBeenCalled();
        } else {
          expect(entry).toMatchObject({ status: "interrupted", abortedLastRun: true });
        }
        if (failure === "rejection") {
          expect(callGateway).toHaveBeenCalledOnce();
        }
      }
    },
  );

  it("settles an admitted recovery that completed before its ambiguous response", async () => {
    const { storePath, readEntry } = await makeCompletedToolFixture();
    vi.mocked(callGateway).mockImplementation(async (request) => {
      if (request.method === "agent") {
        const recoveryRunId = String(
          (request.params as { idempotencyKey?: unknown }).idempotencyKey,
        );
        const current = readEntry()!;
        const completed: SessionEntry = {
          ...current,
          status: "done",
          abortedLastRun: false,
          restartRecoveryDeliveryRunId: undefined,
          restartRecoveryDeliverySourceRunId: undefined,
          restartRecoveryRuns: undefined,
          restartRecoveryTerminalRunIds: [recoveryRunId],
          mainRestartRecovery: current.mainRestartRecovery
            ? { ...current.mainRestartRecovery, reservation: undefined }
            : undefined,
        };
        await replaceSessionEntry({ sessionKey: "agent:main:main", storePath }, completed);
        throw new Error("accepted response was lost after completion");
      }
      return { runId: "recovery-run", status: "ok", endedAt: Date.now() };
    });

    await expectRecovery({ settled: 1 }, {});
    expect(readEntry()).toMatchObject({ abortedLastRun: false, status: "done" });
  });

  it("settles a reused recovery RPC whose accepted cache already completed", async () => {
    const { readEntry } = await makeCompletedToolFixture({
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
    });
    vi.mocked(callGateway)
      .mockResolvedValueOnce({ runId: "recovery-run", status: "accepted" })
      .mockResolvedValueOnce({ runId: "recovery-run", status: "ok", endedAt: Date.now() });

    await expectRecovery({ settled: 1 }, {});

    expect(gatewayParams().idempotencyKey).toBe("recovery-run");
    expect(readEntry()).toMatchObject({
      abortedLastRun: false,
      endedAt: expect.any(Number),
      restartRecoveryTerminalRunIds: ["control-ui-run", "recovery-run"],
      sessionId: "main-session",
      status: "done",
    });
    const settled = readEntry();
    expectCleared(
      settled,
      "restartRecoveryDeliveryRunId",
      "restartRecoveryDeliverySourceRunId",
      "mainRestartRecovery",
    );
  });

  it("does not settle a cached terminal response after a foreground owner wins admission", async () => {
    const { storePath, readEntry } = await makeCompletedToolFixture({
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
    });
    let foregroundClaimed = false;
    vi.mocked(callGateway).mockImplementation(async (request) => {
      if (request.method === "agent") {
        return { runId: "recovery-run", status: "accepted" };
      }
      if (!foregroundClaimed) {
        const owner = await claimMainSessionRecoveryOwner({
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
          sessionId: "main-session",
          target: { sessionKey: "agent:main:main", storePath },
        });
        expect(owner.kind).toBe("claimed");
        foregroundClaimed = true;
      }
      return { runId: "recovery-run", status: "ok", endedAt: Date.now() };
    });

    await expectRecovery({ failed: 1 }, {});
    expect(readEntry()).toMatchObject({
      abortedLastRun: true,
      status: "interrupted",
      mainRestartRecovery: { foregroundClaims: { tokens: [expect.any(String)] } },
    });
  });

  it("honors session send-policy denial for the interrupted route", async () => {
    await makeCompletedToolFixture({
      sessionKey: "agent:main:discord:direct:123",
      restartRecoveryDeliveryContext: {
        channel: "discord",
        to: "discord:dm:123",
        accountId: "main",
      },
    });

    const result = await recover({ cfg: { session: { sendPolicy: { default: "deny" } } } });

    expect(result).toEqual(recoveryCounts({ started: 1 }));
    expect(gatewayParams().deliver).toBe(false);
  });

  it("resumes safely when pending final delivery identities are missing", async () => {
    const pendingPayload = "The final answer is 42.";
    await makeCompletedToolFixture({
      restartRecoveryForceSafeTools: true,
      pendingFinalDelivery: {
        kind: "replayable",
        text: pendingPayload,
        createdAt: Date.now() - 5_000,
        context: { channel: "discord", to: "discord:dm:final", accountId: "main" },
      },
      restartRecoveryBeforeAgentReplyState: "handled-reply",
      restartRecoveryDeliveryRunId: "discord-message-1",
      restartRecoveryDeliverySourceRunId: "discord-message-1",
      restartRecoverySourceIngress: "channel",
      restartRecoveryDeliveryContext: {
        channel: "discord",
        to: "discord:dm:stale",
        accountId: "old",
      },
    });
    await expectRecovery({ started: 1 }, {});
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
    expect(gatewayParams().message).toContain(pendingPayload);
    expect(sendRecoveryNotice).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/:resumed-notice$/) }),
    );
  });

  type FinalRecoveryOptions = {
    queue?: "pending" | "completed" | "settling";
    kind?: "transport-only";
    noIdentity?: boolean;
    noContext?: boolean;
    notice?: "owed" | "acknowledged";
  };
  it.each<
    [
      string,
      Array<"delivered" | "suppressed" | "queued" | "unknown" | "prepared">,
      "started" | "skipped" | "settled",
      FinalRecoveryOptions,
    ]
  >([
    ["mixed pending", ["delivered", "queued"], "skipped", { queue: "pending" }],
    [
      "terminal residual",
      ["delivered", "suppressed"],
      "settled",
      { queue: "pending", noContext: true },
    ],
    ["identity-less", ["unknown"], "started", { kind: "transport-only", noIdentity: true }],
    ["unqueued media", ["prepared"], "settled", { kind: "transport-only", notice: "owed" }],
    ["acknowledged", ["unknown"], "settled", { notice: "acknowledged" }],
    ["mixed unknown", ["unknown", "prepared"], "settled", { notice: "owed" }],
    ["completed queue", ["prepared"], "settled", { queue: "completed", notice: "owed" }],
    ["settling queue", ["prepared"], "skipped", { queue: "settling" }],
  ])(
    "reconciles pending final: %s",
    async (_name, states, outcome, { queue, kind, noIdentity, noContext, notice }) => {
      const createdAt = Date.now();
      const intentId = "pending-final";
      const deliveries = states.map((state, index) => ({ id: `delivery-${index}`, state }));
      // The mixed pending case queues its second delivery; all other cases queue the first.
      const deliveryId = deliveries[states.indexOf("queued") === -1 ? 0 : 1]!.id;
      try {
        if (queue) {
          seedQueuedFinal(deliveryId, "Saved final.");
          if (queue === "settling") {
            const entry = loadDeliveryQueueEntry(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryId, tmpDir)!;
            seedDeliveryQueueEntry({
              queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
              entry: { ...entry, recoveryState: "settlement_pending" },
              status: "failed",
              stateDir: tmpDir,
            });
          } else if (queue === "completed") {
            completeDeliveryQueueEntryInDatabase(
              openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir } }),
              OUTBOUND_DELIVERY_QUEUE_NAME,
              deliveryId,
            );
          }
        }
        const { readEntry } = await makeMainSessionFixture({
          pendingFinalDelivery: {
            ...(kind ? { kind } : { kind: "replayable", text: "Saved final." }),
            createdAt,
            deliveries,
            intentId: noIdentity ? undefined : intentId,
            context: noIdentity || noContext ? undefined : discordDeliveryContext,
          },
          pendingDeliveryNotice:
            notice === "acknowledged"
              ? {
                  createdAt,
                  context: discordDeliveryContext,
                  intentId,
                  state: "acknowledged",
                }
              : undefined,
        });
        await expectRecovery({ [outcome]: 1 });
        if (outcome === "started") {
          expect(callGateway).toHaveBeenCalledOnce();
          expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
        } else {
          expect(callGateway).not.toHaveBeenCalled();
          expect(sendRecoveryNotice).not.toHaveBeenCalled();
        }
        if (outcome === "settled") {
          expect(readEntry()).toMatchObject({ status: "done", abortedLastRun: false });
          expect(readEntry()?.pendingFinalDelivery).toBeUndefined();
        }
        if (notice) {
          expect(readEntry()?.pendingDeliveryNotice).toMatchObject({
            intentId,
            state: notice,
            context: discordDeliveryContext,
          });
        }
      } finally {
        closeOpenClawStateDatabaseForTest();
      }
    },
  );

  it("retains restart safety when the first restart follows pending final persistence", async () => {
    const sessionsDir = await prepareTranscript(
      currentTurn(
        makeToolResultMessage(
          textContent(JSON.stringify({ status: "completed", value: "done", replaySafe: true })),
          { toolName: "exec" },
        ),
        makeAssistantTextMessage("Safe work finished."),
      ),
      {
        pendingFinalDelivery: makePendingFinalDelivery("Safe work finished.", {
          createdAt: Date.now() - 5_000,
        }),
      },
    );

    await expectRecovery({ started: 1 });
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.restartRecoveryForceSafeTools).toBe(true);
  });

  it("sanitizes durable pending final delivery payloads before resume prompts", async () => {
    tmpDir = transcriptFixture.prepareRoot();
    const pendingPayload = [
      "The final answer is 42.",
      INTERNAL_RUNTIME_CONTEXT_BEGIN,
      "internal recovery detail",
      INTERNAL_RUNTIME_CONTEXT_END,
      "",
      markInboundContextLabel("Conversation info:"),
      "```json",
      '{"message_id":"msg-1"}',
      "```",
    ].join("\n");
    const { readEntry } = await makeCompletedToolFixture({
      pendingFinalDelivery: makePendingFinalDelivery(pendingPayload, {
        createdAt: Date.now() - 5_000,
      }),
    });
    await expectRecovery({ started: 1 });
    expect(gatewayParams().message).toContain("The final answer is 42.");
    expect(gatewayParams().message).not.toContain(INTERNAL_RUNTIME_CONTEXT_BEGIN);
    expect(gatewayParams().message).not.toContain("Conversation info");

    expect(readEntry()?.pendingFinalDelivery).toMatchObject({
      kind: "replayable",
      text: "The final answer is 42.",
    });
  });

  it("resumes an unguarded pending final delivery without a transcript", async () => {
    await makeStoreFixture({
      "agent:main:main": {
        ...runningSessionEntry("missing-transcript-session", { status: "interrupted" }),
        abortedLastRun: true,
        pendingFinalDelivery: makePendingFinalDelivery("The durable final answer.", {
          createdAt: Date.now() - 5_000,
        }),
      },
    });

    await expectRecovery({ started: 1 });
    expect(gatewayParams().message).toContain("The durable final answer.");
    expect(gatewayParams()).not.toHaveProperty("forceRestartSafeTools");
  });

  function interruptedRun(sessionId: string, overrides: SessionEntryFixture = {}) {
    return runningSessionEntry(sessionId, {
      status: "interrupted",
      abortedLastRun: true,
      ...overrides,
    });
  }

  async function makeClaimFixture(overrides: SessionEntryFixture = {}) {
    const fixture = await makeMainSessionFixture({
      restartRecoveryDeliveryRunId: "recovery-main",
      restartRecoveryDeliverySourceRunId: "source-main",
      ...overrides,
    });
    await writeUserTurn(fixture.sessionsDir, "recover this interrupted turn");
    return fixture;
  }

  function scheduleOwnerRelease(storePath: string, maxRetries: number) {
    scheduleRestartAbortedMainSessionRecoveryAfterOwnerRelease({
      delayMs: 0,
      expectedSessionId: "main-session",
      getConfig: () => ({}),
      getGatewayRuntime: () => mockRecoveryRuntime,
      maxRetries,
      sessionKey: "agent:main:main",
      storePath,
    });
  }

  function expectTombstone(entry: SessionEntry | undefined, extra: Partial<SessionEntry> = {}) {
    expect(entry).toMatchObject({
      status: "failed",
      abortedLastRun: false,
      mainRestartRecovery: { tombstone: expect.any(Object) },
      ...extra,
    });
  }

  it("skips restart-aborted sessions with live controller work in the same store", async () => {
    const { sessionsDir } = await makeStoreFixture({
      "agent:main:active-key": interruptedRun("active-key-session"),
      "agent:main:active-id": interruptedRun("active-id-session"),
      "agent:main:recoverable": interruptedRun("recoverable-session"),
    });
    await writeToolTurn(sessionsDir, "new run owns this key", "done", "active-key-session");
    await writeToolTurn(sessionsDir, "new run owns this id", "done", "active-id-session");
    await writeToolTurn(sessionsDir, "recover this one", "done", "recoverable-session");

    const storePath = path.join(sessionsDir, "sessions.json");
    const liveWork = await Promise.all([
      beginSessionEffect({
        scope: storePath,
        identities: ["agent:main:active-key"],
        assertAllowed: () => {},
      }),
      beginSessionEffect({
        scope: storePath,
        identities: ["agent:main:active-id", "active-id-session"],
        assertAllowed: () => {},
      }),
    ]);
    let result: Awaited<ReturnType<typeof recover>>;
    try {
      result = await recover({ stateDir: tmpDir });
    } finally {
      liveWork.forEach((work) => work.release());
    }

    expect(result).toEqual(recoveryCounts({ started: 1, skipped: 2 }));
    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:active-key"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:active-id"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:recoverable"]?.abortedLastRun).toBe(false);
  });

  it("recovers a restart-aborted row while the same key runs in another store", async () => {
    const { sessionsDir } = await makeStoreFixture({
      "agent:main:main": interruptedRun("stale-session"),
    });
    await writeToolTurn(sessionsDir, "recover the stale duplicate", "done", "stale-session");

    const otherStoreWork = await beginSessionEffect({
      scope: path.join(tmpDir, "other-store", "sessions.json"),
      identities: ["agent:main:main", "new-current-session"],
      assertAllowed: () => {},
    });
    let result: Awaited<ReturnType<typeof recover>>;
    try {
      result = await recover({ stateDir: tmpDir });
    } finally {
      otherStoreWork.release();
    }

    expect(result).toEqual(recoveryCounts({ started: 1 }));
    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
  });

  it("does not create empty agent databases while scanning startup recovery", async () => {
    const agentIds = ["main", "worker"];
    const databasePaths = await Promise.all(
      agentIds.map(async (agentId) => {
        await makeSessionsDir(agentId);
        return path.join(tmpDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
      }),
    );

    await expect(markOrphans({})).resolves.toEqual({ marked: 0, skipped: 0 });
    for (const databasePath of databasePaths) {
      await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("keeps corrupt existing agent databases on the startup recovery error path", async () => {
    await makeSessionsDir();
    const databasePath = path.join(tmpDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    await fs.writeFile(databasePath, "not a sqlite database");

    await expect(markOrphans({})).resolves.toEqual({
      marked: 0,
      skipped: 0,
      failedTargets: [
        {
          agentId: "main",
          storePath: path.join(tmpDir, "agents", "main", "sessions", "sessions.json"),
        },
      ],
    });
    expect(readStartupRecoveryWarning()).toBeDefined();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it.each([
    ["current owner before delayed stale registration", "current-first"],
    ["stale owner before current registration", "stale-first"],
  ] as const)("keeps a live session running with %s", async (_label, registrationOrder) => {
    const cutoff = Date.now();
    const sessionKey = "agent:main:generation-race";
    const sessionId = "generation-race-session";
    const { sessionsDir, storePath } = await makeStoreFixture({
      [sessionKey]: {
        sessionId,
        updatedAt: cutoff - 10_000,
        restartRecoveryDeliveryRunId: "generation-race-run",
      },
      "agent:main:control": {
        sessionId: "control-session",
        updatedAt: cutoff - 10_000,
        restartRecoveryDeliveryRunId: "control-run",
      },
    });
    await writeToolTurn(sessionsDir, "resume the control session", "done", "control-session");

    const createHandle = (runId: string): EmbeddedAgentQueueHandle => ({
      kind: "embedded",
      runId,
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: () => {},
    });
    const priorLifecycleGeneration = getAgentEventLifecycleGeneration();
    const staleHandle = createHandle("stale-generation-run");
    const register = (handle: EmbeddedAgentQueueHandle, generation?: string) =>
      setActiveEmbeddedRun(
        sessionId,
        handle,
        sessionKey,
        undefined,
        undefined,
        undefined,
        generation,
        { storeScope: storePath },
      );
    if (registrationOrder === "stale-first") {
      register(staleHandle, priorLifecycleGeneration);
    }

    rotateAgentEventLifecycleGeneration();
    const currentHandle = createHandle("current-generation-run");
    register(currentHandle);
    if (registrationOrder === "current-first") {
      register(staleHandle, priorLifecycleGeneration);
    }

    const recovery = scheduleRecovery({});
    try {
      await mockRecoveryRuntime.expectAdmission(1, recovery, {
        sessionKey: "agent:main:control",
        storePath,
      });

      const activeEntry = loadSessionEntry({ sessionKey, storePath });
      expectCleared(activeEntry, "status", "abortedLastRun");
    } finally {
      clearActiveEmbeddedRun(sessionId, currentHandle, sessionKey);
      clearActiveEmbeddedRun(sessionId, staleHandle, sessionKey);
    }
  });

  it("cancels a stale startup owner after a mid-scan lifecycle rotation", async () => {
    const sessionKey = "agent:main:generation-race";
    const sessionId = "generation-race-session";
    const { storePath } = await makeStoreFixture({
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now() - 10_000,
        restartRecoveryDeliveryRunId: "generation-race-run",
      },
    });

    const {
      entered: markerEntered,
      release: releaseMarker,
      spy: replacementSpy,
    } = pauseFirstDurableWrite();
    const recovery = scheduleRecovery({});
    await markerEntered.promise;
    expect(getActiveGatewayRootWorkCount()).toBe(1);

    // Rotate mid-scan; stop must join the stale owner's in-flight write.
    rotateAgentEventLifecycleGeneration();
    const liveAbort = vi.fn();
    const liveHandle: EmbeddedAgentQueueHandle = {
      kind: "embedded",
      runId: "live-run",
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: liveAbort,
    };
    setActiveEmbeddedRun(sessionId, liveHandle, sessionKey);
    let stopSettled = false;
    const stopping = recovery.stop().then(() => {
      stopSettled = true;
    });
    try {
      await Promise.resolve();
      expect(stopSettled).toBe(false);

      releaseMarker.resolve();
      await stopping;

      expect(callGateway).not.toHaveBeenCalled();
      const entry = loadSessionEntry({ sessionKey, storePath });
      expectCleared(entry, "status", "abortedLastRun", "mainRestartRecovery");
      expect(liveAbort).not.toHaveBeenCalled();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      releaseMarker.resolve();
      await stopping;
      replacementSpy.mockRestore();
      clearActiveEmbeddedRun(sessionId, liveHandle, sessionKey);
    }
  });

  it("recovers only the configured store for duplicate startup-orphaned session keys", async () => {
    const cutoff = Date.now();

    const { sessionsDir: defaultSessionsDir } = await makeStoreFixture({
      "agent:main:main": {
        sessionId: "default-main-session",
        updatedAt: cutoff - 10_000,
        restartRecoveryDeliveryRunId: "default-main-run",
      },
    });
    await writeToolTurn(defaultSessionsDir, "resume", "done", "default-main-session");

    const customStorePath = path.join(tmpDir, "custom-startup-duplicate", "sessions.json");
    await writeStorePath(customStorePath, {
      "agent:main:main": {
        sessionId: "custom-main-session",
        updatedAt: cutoff - 10_000,
        restartRecoveryDeliveryRunId: "custom-main-run",
      },
    });
    await writeToolTurn(path.dirname(customStorePath), "resume", "done", "custom-main-session");

    const recovery = scheduleRecovery({
      getConfig: () => ({ session: { store: customStorePath } }),
    });
    await mockRecoveryRuntime.expectAdmission(1, recovery, {
      sessionKey: "agent:main:main",
      storePath: customStorePath,
    });

    const defaultStore = readStore(path.join(defaultSessionsDir, "sessions.json"));
    const customStore = readStore(customStorePath);
    expect(defaultStore["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(customStore["agent:main:main"]?.abortedLastRun).toBe(false);
  });

  it("rediscovers a restored configured store between startup marking and recovery", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeMainSession({ sessionsDir, abortedLastRun: undefined });
    await writeToolTurn(sessionsDir, "resume the interrupted main session", "main result");

    const lateSessionsDir = path.join(tmpDir, "agents", "late", "sessions");
    const lateStorePath = path.join(lateSessionsDir, "sessions.json");
    const cfg = { agents: { entries: { main: {}, late: {} } } } as OpenClawConfig;
    const originalApply = sessionAccessor.applySessionEntryReplacements;
    let restoredLateStore = false;
    const replacementSpy = vi
      .spyOn(sessionAccessor, "applySessionEntryReplacements")
      .mockImplementation(async (params) => {
        const result = await originalApply(params);
        if (params.requireWriteSuccess === true && !restoredLateStore) {
          restoredLateStore = true;
          await writeStorePath(lateStorePath, {
            "agent:late:main": {
              sessionId: "late-session",
              updatedAt: 1,
              status: "interrupted",
              abortedLastRun: true,
              restartRecoveryDeliveryRunId: "late-run",
            },
          });
          await writeToolTurn(lateSessionsDir, "resume", "done", "late-session");
        }
        return result;
      });

    const firstDispatch = createDeferred();
    vi.mocked(callGateway).mockImplementationOnce(async () => {
      firstDispatch.resolve();
      return { runId: "run-resumed" };
    });
    const recovery = scheduleRecovery({
      getConfig: () => cfg,
    });
    try {
      await firstDispatch.promise;
      await mockRecoveryRuntime.expectAdmission(
        2,
        recovery,
        { storePath, sessionKey: "agent:main:main" },
        { storePath: lateStorePath, sessionKey: "agent:late:main" },
      );

      expect(readStore(storePath)["agent:main:main"]?.abortedLastRun).toBe(false);
      expect(readStore(lateStorePath)["agent:late:main"]?.abortedLastRun).toBe(false);
    } finally {
      dispatchSettlement.resolve();
      await recovery.stop();
      replacementSpy.mockRestore();
    }
  });

  it("stops startup recovery while its Gateway admission is suspended", async ({ signal }) => {
    tmpDir = transcriptFixture.prepareRoot();
    const { readEntry } = await makeMainSessionFixture({
      pendingFinalDelivery: makePendingFinalDelivery(),
    });
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension).not.toBeNull();
    const admission = observeRecoveryRoots("main-session:startup-recovery", 1);
    const recovery = scheduleRecovery({});
    try {
      await withinTest(admission.requested, signal);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      await withinTest(recovery.stop(), signal);

      suspension?.rollback();
      expect(callGateway).not.toHaveBeenCalled();
      expect(readEntry()).toMatchObject({ status: "interrupted", abortedLastRun: true });
    } finally {
      suspension?.rollback();
      await recovery.stop();
      admission.restore();
    }
  });

  it("waits for startup release while preserving the registration cutoff", async () => {
    const releaseStartup = createDeferred();
    const { sessionsDir, storePath } = await makeStoreFixture({
      "agent:main:main": { ...runningSessionEntry("pre-start-session"), updatedAt: 1 },
    });
    await writeToolTurn(sessionsDir, "resume the interrupted work", "done", "pre-start-session");

    const recovery = scheduleRecovery({
      waitForStart: () => releaseStartup.promise,
    });
    await Promise.resolve();
    expect(callGateway).not.toHaveBeenCalled();

    const postRegistrationUpdatedAt = Date.now() + 60_000;
    await writeStore(sessionsDir, {
      ...readStore(storePath),
      "agent:main:fresh": {
        ...runningSessionEntry("post-start-session"),
        updatedAt: postRegistrationUpdatedAt,
      },
    });
    await writeToolTurn(sessionsDir, "new work from this gateway", "done", "post-start-session");

    releaseStartup.resolve();
    await mockRecoveryRuntime.expectAdmission(1, recovery, {
      storePath,
      sessionKey: "agent:main:main",
    });

    const store = readStore(storePath);
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
    expect(store["agent:main:fresh"]).toMatchObject({ sessionId: "post-start-session" });
    expectCleared(store["agent:main:fresh"], "status", "abortedLastRun");
  });

  it("uses the live configured roster after the startup recovery barrier", async () => {
    const sessionsDir = await makeSessionsDir("work");
    const storePath = path.join(sessionsDir, "sessions.json");
    const releaseStartup = createDeferred();
    await writeMainSession({ sessionsDir, sessionKey: "agent:work:main" });
    await writeToolTurn(sessionsDir, "resume after config reload", "done");
    let currentConfig = { agents: { entries: { main: {} } } } as OpenClawConfig;

    const recovery = scheduleRecovery({
      getConfig: () => currentConfig,
      waitForStart: () => releaseStartup.promise,
    });
    await Promise.resolve();
    currentConfig = { agents: { entries: { main: {}, work: {} } } } as OpenClawConfig;
    releaseStartup.resolve();

    await mockRecoveryRuntime.expectAdmission(1, recovery, {
      storePath,
      sessionKey: "agent:work:main",
    });
    expect(loadSessionEntry({ sessionKey: "agent:work:main", storePath })).toMatchObject({
      abortedLastRun: false,
    });
  });

  it("stops without waiting for an unresolved startup release", async () => {
    tmpDir = transcriptFixture.prepareRoot();
    const releaseStartup = createDeferred();
    const { readEntry } = await makeMainSessionFixture({
      pendingFinalDelivery: makePendingFinalDelivery(),
    });

    const recovery = scheduleRecovery({
      waitForStart: () => releaseStartup.promise,
    });
    await Promise.all([recovery.stop(), recovery.stop()]);
    releaseStartup.resolve();
    await Promise.resolve();

    expect(callGateway).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(readEntry()).toMatchObject({ status: "interrupted", abortedLastRun: true });
  });

  it.each(["claim", "dispatch", "probe"] as const)(
    "fences and joins startup recovery stopped during %s",
    async (phase) => {
      tmpDir = transcriptFixture.prepareRoot();
      const { readEntry } = await makeMainSessionFixture({
        pendingFinalDelivery: makePendingFinalDelivery(),
      });
      const gate =
        phase === "claim"
          ? pauseFirstDurableWrite()
          : { entered: createDeferred(), release: createDeferred(), spy: undefined };
      let recoveryRunId: string | undefined;
      if (phase === "dispatch") {
        vi.mocked(callGateway).mockImplementationOnce(async () => {
          gate.entered.resolve();
          await gate.release.promise;
          return { runId: "run-resumed" };
        });
      } else if (phase === "probe") {
        vi.mocked(callGateway).mockImplementation(async (request) => {
          if (request.method === "agent") {
            recoveryRunId = String((request.params as { idempotencyKey?: unknown }).idempotencyKey);
            throw new Error("ambiguous recovery dispatch transport failure");
          }
          if (request.method === "agent.wait") {
            gate.entered.resolve();
            await gate.release.promise;
            return { runId: recoveryRunId, status: "ok", endedAt: Date.now() };
          }
          return { runId: "run-resumed" };
        });
      }
      const recovery = scheduleRecovery({});
      let stopping: Promise<void> | undefined;
      try {
        await gate.entered.promise;
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        if (phase === "probe") {
          expect(recoveryRunId).toEqual(expect.any(String));
        }
        let stopSettled = false;
        stopping = recovery.stop().then(() => {
          stopSettled = true;
        });
        await Promise.resolve();
        expect(stopSettled).toBe(false);
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        if (phase === "claim") {
          expect(callGateway).not.toHaveBeenCalled();
        } else if (phase === "probe") {
          expect(callGateway).toHaveBeenCalledTimes(2);
        }
        gate.release.resolve();
        await stopping;
        expect(callGateway).toHaveBeenCalledTimes(
          phase === "claim" ? 0 : phase === "dispatch" ? 1 : 2,
        );
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        if (phase === "claim") {
          expect(readEntry()).toMatchObject({
            status: "interrupted",
            abortedLastRun: true,
            mainRestartRecovery: { cycleId: "interrupted-cycle", revision: 1, chargedAttempts: 0 },
          });
        } else if (phase === "probe") {
          const entry = readEntry();
          expect(entry).toMatchObject({
            status: "interrupted",
            abortedLastRun: true,
            pendingFinalDelivery: { kind: "replayable", text: "interrupted response" },
            mainRestartRecovery: { chargedAttempts: 1 },
          });
          expect(entry?.mainRestartRecovery?.reservation).toBeUndefined();
          expect(entry?.restartRecoveryTerminalRunIds ?? []).not.toContain(recoveryRunId);
          expect(entry?.restartRecoveryRuns ?? []).not.toEqual(
            expect.arrayContaining([expect.objectContaining({ runId: recoveryRunId })]),
          );
        }
      } finally {
        gate.release.resolve();
        await (stopping ?? recovery.stop());
        gate.spy?.mockRestore();
      }
    },
  );

  it.each([false, true])(
    "resumes healthy stores when another startup marker fails (transient=%s)",
    async (transient) => {
      const cfg = { agents: { entries: { main: {}, worker: {} } } };
      for (const agentId of ["main", "worker"]) {
        const { sessionsDir } = await makeStoreFixture(
          {
            [`agent:${agentId}:main`]: {
              sessionId: `${agentId}-session`,
              updatedAt: 1,
              restartRecoveryDeliveryRunId: `${agentId}-run`,
              lifecycleRunId: `${agentId}-run`,
              abortedLastRun: false,
            },
          },
          agentId,
        );
        await writeToolTurn(sessionsDir, "resume", "done", `${agentId}-session`);
      }
      const apply = sessionAccessor.applySessionEntryReplacements;
      const failedMark = createDeferred();
      let failedOnce = false;
      const replacementSpy = vi
        .spyOn(sessionAccessor, "applySessionEntryReplacements")
        .mockImplementation(async (params) => {
          if (params.agentId === "main" && (!transient || !failedOnce)) {
            failedOnce = true;
            failedMark.resolve();
            throw new Error("startup store temporarily locked");
          }
          return await apply(params);
        });
      const firstDispatch = createDeferred();
      vi.mocked(callGateway).mockImplementationOnce(async () => {
        firstDispatch.resolve();
        return { runId: "run-resumed" };
      });
      const attempts = observeRecoveryRoots("main-session:startup-recovery", transient ? 2 : 1);
      vi.useFakeTimers();
      const { scheduled: retryScheduled, spy: setTimeoutSpy } = observeRetryTimer();
      const recovery = scheduleRecovery({
        getConfig: () => cfg,
        maxRetries: transient ? 2 : 1,
      });
      try {
        await failedMark.promise;
        if (transient) {
          await firstDispatch.promise;
          expect(callGateway).toHaveBeenCalledOnce();
          dispatchSettlement.resolve(); // Retried stores share the same bounded recovery slot.
          await retryScheduled.promise;
          await vi.advanceTimersByTimeAsync(5_000);
        }
        await attempts.completed;
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        await recovery.stop();
        expect(callGateway).toHaveBeenCalledTimes(transient ? 2 : 1);
        expect(gatewayParams()).toMatchObject({
          agentId: "worker",
          sessionKey: "agent:worker:main",
        });
        expect(
          loadSessionEntry({
            agentId: "main",
            sessionKey: "agent:main:main",
            storePath: path.join(tmpDir, "agents", "main", "sessions", "sessions.json"),
          }),
        ).toMatchObject({ abortedLastRun: false });
        if (transient) {
          expect(readStartupRecoveryWarning()).toBeUndefined();
        } else {
          expect(readStartupRecoveryWarning()).toContain("startup store temporarily locked");
        }
      } finally {
        dispatchSettlement.resolve();
        await recovery.stop();
        attempts.restore();
        replacementSpy.mockRestore();
        setTimeoutSpy.mockRestore();
        vi.useRealTimers();
        rotateAgentEventLifecycleGeneration();
      }
    },
  );

  it("continues past candidate capacity failure and retries its retained interruption mark", async () => {
    const busyKey = "agent:main:dashboard:busy";
    const healthyKey = "agent:main:dashboard:healthy";
    const { sessionsDir, storePath } = await makeStoreFixture({
      [busyKey]: mainSessionEntry({ sessionId: "busy-session", endedAt: 1 }),
      [healthyKey]: mainSessionEntry({ sessionId: "healthy-session", endedAt: 2 }),
    });
    for (const sessionId of ["busy-session", "healthy-session"]) {
      await writeUserTurn(sessionsDir, "finish the interrupted task", sessionId);
    }
    const commit = recoveryStore.commitMainSessionRecovery;
    let rejected = false;
    const commitSpy = vi
      .spyOn(recoveryStore, "commitMainSessionRecovery")
      .mockImplementation(async (params) => {
        if (
          !rejected &&
          params.target.sessionKey === busyKey &&
          params.command.kind === "observe"
        ) {
          rejected = true;
          throw new WorkerTaskError("Session row preparation capacity reached", "overloaded");
        }
        return await commit(params);
      });
    vi.useFakeTimers();
    const { scheduled: retryScheduled, spy: setTimeoutSpy } = observeRetryTimer();
    let recovery: ReturnType<typeof scheduleRecovery> | undefined;
    try {
      recovery = scheduleRecovery({ maxRetries: 2 });
      await retryScheduled.promise;
      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(gatewayParams()).toMatchObject({ sessionKey: healthyKey });
      expect(loadSessionEntry({ storePath, sessionKey: busyKey })).toMatchObject({
        status: "interrupted",
        abortedLastRun: true,
        mainRestartRecovery: { chargedAttempts: 0 },
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(callGateway).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await mockRecoveryRuntime.expectAdmission(2, recovery, { storePath, sessionKey: busyKey });
      expect(gatewayParams(1)).toMatchObject({ sessionKey: busyKey });
      expect(loadSessionEntry({ storePath, sessionKey: busyKey })).toMatchObject({
        abortedLastRun: false,
        mainRestartRecovery: { chargedAttempts: 1 },
      });
    } finally {
      dispatchSettlement.resolve();
      await recovery?.stop();
      commitSpy.mockRestore();
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("retries startup capacity failures without dropping or charging interruption marks", async () => {
    const { sessionsDir, storePath, sessionKey, readEntry } = await makeMainSessionFixture();
    await writeUserTurn(sessionsDir, "finish the interrupted task");
    const cycleId = readEntry()?.mainRestartRecovery?.cycleId;
    const firstPreparation = createDeferred();
    let preparationCount = 0;
    const runtime: GatewayRecoveryRuntime = {
      ...mockRecoveryRuntime,
      prepareRestartRecovery: () => {
        if (++preparationCount === 1) {
          firstPreparation.resolve();
          throw new WorkerTaskError("worker task capacity reached", "overloaded");
        }
        return undefined;
      },
    };
    vi.useFakeTimers();
    const { scheduled: retryScheduled, spy: setTimeoutSpy } = observeRetryTimer();
    let recovery: ReturnType<typeof scheduleRecovery> | undefined;
    try {
      recovery = scheduleRecovery({ maxRetries: 2, gatewayRuntime: runtime });
      await firstPreparation.promise;
      await retryScheduled.promise;
      expect(readEntry()).toMatchObject({
        abortedLastRun: true,
        status: "interrupted",
        mainRestartRecovery: { cycleId, chargedAttempts: 0 },
      });
      expect(callGateway).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(preparationCount).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await mockRecoveryRuntime.expectAdmission(1, recovery, { storePath, sessionKey });
      expect(preparationCount).toBe(2);
      expect(readEntry()).toMatchObject({
        abortedLastRun: false,
        mainRestartRecovery: { cycleId, chargedAttempts: 1 },
      });
    } finally {
      dispatchSettlement.resolve();
      await recovery?.stop();
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("retains canonical retry backoff when startup recovery begins immediately", async () => {
    const { sessionsDir } = await makeMainSessionFixture({
      pendingFinalDelivery: makePendingFinalDelivery(),
    });
    const firstDispatch = createDeferred();
    const secondDispatch = createDeferred();
    let firstAgentDispatch = true;
    vi.mocked(callGateway).mockImplementation(async (request) => {
      if (request.method === "agent") {
        if (firstAgentDispatch) {
          firstAgentDispatch = false;
          firstDispatch.resolve();
          throw new Error("transient startup failure");
        }
        secondDispatch.resolve();
      }
      return { runId: "run-resumed" };
    });

    vi.useFakeTimers();
    const { scheduled: retryScheduled, spy: setTimeoutSpy } = observeRetryTimer();
    const countAgentDispatches = () => agentRequests().length;
    let recovery: ReturnType<typeof scheduleRecovery> | undefined;
    try {
      recovery = scheduleRecovery({ maxRetries: 2 });
      await firstDispatch.promise;
      await retryScheduled.promise;
      expect(countAgentDispatches()).toBe(1);

      await writeStore(sessionsDir, {
        "agent:main:late-startup-row": {
          sessionId: "late-startup-session",
          updatedAt: 1,
          restartRecoveryDeliveryRunId: "late-startup-run",
        },
      });
      await writeToolTurn(sessionsDir, "resume", "done", "late-startup-session");

      await vi.advanceTimersByTimeAsync(4_999);
      expect(countAgentDispatches()).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      await secondDispatch.promise;
      await recovery.stop();

      expect(countAgentDispatches()).toBe(2);
      const lateEntry = loadSessionEntry({
        sessionKey: "agent:main:late-startup-row",
        storePath: path.join(sessionsDir, "sessions.json"),
      });
      expectCleared(lateEntry, "status", "abortedLastRun");
    } finally {
      await recovery?.stop();
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("retries only the requested abandoned durable claim", async () => {
    const { sessionsDir, storePath } = await makeStoreFixture({
      "agent:main:main": {
        ...mainSessionEntry(),
        restartRecoveryDeliveryRunId: "recovery-main",
        restartRecoveryDeliverySourceRunId: "source-main",
        restartRecoverySourceIngress: "channel",
        restartRecoverySourceReplyDeliveryMode: "message_tool_only",
        restartRecoveryDeliveryContext: {
          channel: "discord",
          to: "discord:dm:main",
          accountId: "work",
        },
      },
      "agent:main:other": interruptedRun("other-session", {
        restartRecoveryDeliveryRunId: "recovery-other",
        restartRecoveryDeliverySourceRunId: "source-other",
      }),
    });
    await writeUserTurn(sessionsDir, "recover only me");
    await writeUserTurn(sessionsDir, "leave me pending", "other-session");

    await expect(retryMainClaim(storePath)).resolves.toEqual(recoveryCounts({ started: 1 }));
    expect(sendRecoveryNotice).not.toHaveBeenCalled();
    expect(gatewayParams()).toMatchObject({
      idempotencyKey: "recovery-main",
      expectedExistingSessionId: "main-session",
      sessionKey: "agent:main:main",
      sourceReplyDeliveryMode: "message_tool_only",
      deliver: false,
      channel: "discord",
      to: "discord:dm:main",
      accountId: "work",
    });
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      abortedLastRun: false,
      restartRecoveryDeliveryRunId: "recovery-main",
    });
    expect(loadSessionEntry({ sessionKey: "agent:main:other", storePath })).toMatchObject({
      abortedLastRun: true,
      restartRecoveryDeliveryRunId: "recovery-other",
    });
  });

  it("retries only the exact interrupted row released by its final foreground owner", async () => {
    const { sessionsDir, storePath } = await makeStoreFixture({
      "agent:main:main": { ...mainSessionEntry() },
      "agent:main:other": { ...runningSessionEntry("other-session"), abortedLastRun: true },
    });
    await writeCompletedToolTranscript(sessionsDir);
    await writeUserTurn(sessionsDir, "leave this row pending", "other-session");

    const result = await retryRecovery({
      expectedSessionId: "main-session",
      sessionKey: "agent:main:main",
      storePath,
    });

    expect(result).toEqual(recoveryCounts({ started: 1 }));
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      abortedLastRun: false,
    });
    expect(loadSessionEntry({ sessionKey: "agent:main:other", storePath })).toMatchObject({
      abortedLastRun: true,
    });
    expect(isSessionControllerWorkActive(storePath, ["agent:main:main", "main-session"])).toBe(
      false,
    );
  });

  it("retries a failed exact owner-release recovery with bounded backoff", async () => {
    const { storePath, readEntry } = await makeCompletedToolFixture({
      restartRecoveryDeliveryRunId: "control-ui-run",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
    });
    vi.mocked(callGateway)
      .mockRejectedValueOnce(new Error("temporary dispatch failure"))
      .mockResolvedValueOnce({ runId: "run-resumed", status: "running" })
      .mockResolvedValueOnce({ runId: "run-resumed" });

    const attempts = observeRecoveryRoots("main-session:restart-recovery", 2);
    try {
      scheduleOwnerRelease(storePath, 2);

      await attempts.completed;
      expect(callGateway).toHaveBeenCalledTimes(3);
      expect(readEntry()).toMatchObject({ abortedLastRun: false });
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      attempts.restore();
    }
  });

  it("rejects foreground takeover while tombstoning exhausted recovery", async () => {
    tmpDir = transcriptFixture.prepareRoot();
    const { sessionsDir, storePath, sessionKey, readEntry } = await makeMainSessionFixture({
      mainRestartRecovery: { cycleId: "cycle-exhausted", revision: 1, chargedAttempts: 3 },
    });
    await writeUserTurn(sessionsDir, "continue this turn");
    const appendAssistantMessageToSessionTranscript =
      transcriptMocks.appendAssistantMessageToSessionTranscript.getMockImplementation();
    if (!appendAssistantMessageToSessionTranscript) {
      throw new Error("expected transcript append implementation");
    }
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockImplementationOnce(
      async (params) => {
        const owner = await claimMainSessionRecoveryOwner({
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
          sessionId: "main-session",
          target: { sessionKey, storePath },
        });
        expect(owner).toEqual({ kind: "invalidated", reason: "recovery_exhausted" });
        return await appendAssistantMessageToSessionTranscript(params);
      },
    );

    await expectRecovery({ skipped: 1 });

    expectTombstone(readEntry());
    const notices = (
      await loadTranscriptEvents({
        agentId: "main",
        sessionId: "main-session",
        sessionKey,
        storePath,
      })
    ).filter((event) => {
      const record = event as { type?: unknown; message?: { idempotencyKey?: unknown } };
      return (
        record.type === "message" &&
        typeof record.message?.idempotencyKey === "string" &&
        record.message.idempotencyKey.endsWith(":failed-notice")
      );
    });
    expect(notices).toHaveLength(1);
  });

  it("retries tombstoning on the next recovery pass after a transcript conflict", async () => {
    tmpDir = transcriptFixture.prepareRoot();
    const { sessionsDir, readEntry } = await makeMainSessionFixture({
      mainRestartRecovery: { cycleId: "cycle-exhausted", revision: 1, chargedAttempts: 3 },
    });
    await writeUserTurn(sessionsDir, "continue this turn");
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockResolvedValueOnce({
      ok: false,
      code: "session-rebound",
      reason: "session metadata changed",
    });

    await expectRecovery({ failed: 1 });
    expect(readEntry()?.mainRestartRecovery?.tombstone).toBeUndefined();
    expect(callGateway).not.toHaveBeenCalled();

    await expectRecovery({ skipped: 1 });

    expectTombstone(readEntry());
  });

  it("tombstones when the final owner-release retry consumes the last charge", async () => {
    const { sessionsDir, storePath, readEntry } = await makeControlUiRecoveryFixture({
      mainRestartRecovery: { cycleId: "cycle-final-attempt", revision: 1, chargedAttempts: 2 },
    });
    await writeCompletedToolTranscript(sessionsDir);
    vi.mocked(callGateway)
      .mockRejectedValueOnce(new Error("final ambiguous dispatch failure"))
      .mockResolvedValueOnce({ runId: "run-resumed", status: "running" });

    const attempts = observeRecoveryRoots("main-session:restart-recovery", 2);
    scheduleOwnerRelease(storePath, 1);

    try {
      await attempts.completed;
      expect(readEntry()).toMatchObject({
        status: "failed",
        lastRunId: "control-ui-run",
        mainRestartRecovery: { tombstone: expect.any(Object) },
      });
      expect(callGateway).toHaveBeenCalledTimes(2);
    } finally {
      attempts.restore();
    }
  });

  it("tombstones when message-tool-only authority cannot be reconstructed", async () => {
    tmpDir = transcriptFixture.prepareRoot();
    const { sessionsDir, readEntry } = await makeMainSessionFixture({
      restartRecoveryDeliveryRunId: "recovery-main",
      restartRecoverySourceIngress: "channel",
      restartRecoverySourceReplyDeliveryMode: "message_tool_only",
      restartRecoveryDeliveryContext: {
        channel: "discord",
        to: "discord:dm:main",
        accountId: "work",
      },
    });
    await writeUserTurn(sessionsDir, "recover only with delivery authority");

    await expectRecovery({ skipped: 1 });
    expect(sendRecoveryNotice).toHaveBeenCalledWith({
      accountId: "work",
      channel: "discord",
      to: "discord:dm:main",
      threadId: undefined,
      idempotencyKey: "main-session-restart-recovery:recovery-main:failed-notice",
      text: expect.stringContaining("use Resume to continue in this session"),
    });
    expectTombstone(readEntry(), {
      restartRecoveryDeliveryRunId: "recovery-main",
      restartRecoverySourceReplyDeliveryMode: "message_tool_only",
    });
  });

  it("does not restore channel authority from a generic session route", async () => {
    tmpDir = transcriptFixture.prepareRoot();
    const { sessionsDir, storePath, readEntry } = await makeMainSessionFixture({
      channel: "discord",
      lastTo: "discord:dm:fallback",
      restartRecoveryDeliveryRunId: "recovery-main",
      restartRecoveryDeliverySourceRunId: "source-main",
      restartRecoverySourceIngress: "channel",
      restartRecoverySourceReplyDeliveryMode: "message_tool_only",
    });
    await writeUserTurn(sessionsDir, "do not inherit a fallback route");

    await expectRecovery({ skipped: 1 });
    expect(callGateway).not.toHaveBeenCalled();
    const events = await loadTranscriptEvents({
      agentId: "main",
      sessionId: "main-session",
      sessionKey: "agent:main:main",
      storePath,
    });
    expect(events.at(-1)).toMatchObject({
      message: {
        role: "assistant",
        content: textContent(expect.stringContaining("use Resume to continue in this session")),
      },
    });
    expectTombstone(readEntry());
  });

  it("waits for an abandoned durable claim to reach execution in its owning Gateway", async () => {
    const { storePath } = await makeClaimFixture();
    const dispatchAgent = vi.fn(
      async (_params: unknown, _timeoutMs: number | undefined, options: DispatchArgs[2]) => {
        options?.onAccepted?.({ runId: "recovery-main", status: "accepted" });
        options?.onStartOwner?.({
          observe: () => ({ executionStarted: true, startDeadlineAtMs: Date.now() + 60_000 }),
          abort: () => false,
        });
        options?.onExecutionStarted?.();
        return await new Promise<never>(() => {});
      },
    );

    const result = await retryMainClaim(
      storePath,
      createMockGatewayRecoveryRuntime({
        resumeChatInput: async () => {
          throw new Error("Unexpected chat input recovery");
        },
        dispatchAgent: dispatchAgent as GatewayRecoveryRuntime["dispatchAgent"],
      }),
    );

    expect(result).toEqual(recoveryCounts({ started: 1 }));
    expect(dispatchAgent).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "recovery-main", sessionKey: "agent:main:main" }),
      undefined,
      expect.objectContaining({
        expectFinal: true,
        onAccepted: expect.any(Function),
        onExecutionStarted: expect.any(Function),
      }),
    );
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("aborts an exact recovery accepted after the execution-start deadline", async () => {
    vi.useFakeTimers();
    let accept: (() => void) | undefined;
    const abort = vi.fn(() => true);
    const dispatchAgent = vi.fn(
      async (_request: DispatchArgs[0], _timeoutMs: DispatchArgs[1], options: DispatchArgs[2]) => {
        accept = () => {
          options?.onStartOwner?.({
            observe: () => ({ executionStarted: false, startDeadlineAtMs: Date.now() + 60_000 }),
            abort,
          });
          options?.onAccepted?.({ runId: "recovery-main", status: "accepted" });
        };
        return await new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("execution-start wait aborted")),
            { once: true },
          );
        });
      },
    );

    try {
      const outcome = dispatchRestartRecoveryUntilStarted({
        agentParams: {
          agentId: "main",
          idempotencyKey: "recovery-main",
          message: "resume",
          sessionKey: "agent:main:main",
        },
        gatewayRuntime: createMockGatewayRecoveryRuntime({
          dispatchAgent: dispatchAgent as GatewayRecoveryRuntime["dispatchAgent"],
          waitForAgent: vi.fn(),
        }),
      });

      await vi.advanceTimersByTimeAsync(10_000);
      await expect(outcome).resolves.toMatchObject({ kind: "failed" });
      expect(accept).toBeTypeOf("function");
      accept?.();
      expect(abort).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores accepted recovery refused during stop and reports bounded exhaustion", async ({
    signal,
  }) => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
      const { sessionsDir, storePath, sessionKey, readEntry } = await makeMainSessionFixture({
        restartRecoveryDeliveryRunId: "recovery-main",
        restartRecoveryDeliverySourceRunId: "source-main",
        restartRecoveryDeliveryContext: discordDeliveryContext,
      });
      const entry = expectDefined(readEntry(), "interrupted source session");
      const requesterSource = expectDefined(
        createRestartRecoveryRequesterSource({
          agentId: "main",
          sessionKey,
          sourceRunId: "source-main",
          entry,
          requesterOrigin: {
            sessionKey: "agent:research:telegram:group:requesters",
            messageProvider: "telegram",
            accountId: "work",
            senderId: "bob",
          },
        }),
        "original channel requester source",
      );
      await replaceSessionEntry(
        { sessionKey, storePath },
        { ...entry, restartRecoveryRequesterSource: requesterSource },
      );
      await writeUserTurn(sessionsDir, "recover without losing the owner");
      // Runtime imports and I/O must settle before the unrelated start watchdog can expire.
      vi.useFakeTimers();
      const previousRegistry = captureActivePluginRegistrySnapshot();
      setActivePluginRegistry(createEmptyPluginRegistry());
      const scheduleSpy = vi
        .spyOn(recoveryOwnerRelease, "scheduleMainSessionRecoveryPendingTarget")
        .mockImplementation(() => {});
      const commandErrors: unknown[] = [];
      const emittedErrors: Record<string, unknown>[] = [];
      const persistedEntries: Array<ReturnType<typeof loadSessionEntry>> = [];
      const dispatchSettlements: Promise<void>[] = [];
      const dispatchRecoveryCommand = async (
        request: DispatchArgs[0],
        _timeoutMs: DispatchArgs[1],
        options: DispatchArgs[2],
      ): Promise<never> => {
        const runId = request.idempotencyKey!;
        await admitRecovery(storePath, runId, sessionKey);
        options?.onAccepted?.({ runId, status: "accepted" });
        const admittedEntry = readEntry()!;
        const requesterTarget = expectDefined(
          options?.restartRecoveryRequesterTarget,
          "successor dispatch requester custody",
        );
        expect(requesterTarget).toEqual({
          agentId: "main",
          sessionKey,
          sessionId: "main-session",
          storePath,
          sourceRunId: "source-main",
          recoveryRunId: runId,
        });
        const requesterOrigin = expectDefined(
          readRestartRecoveryRequesterSource({ ...requesterTarget, entry: admittedEntry }),
          "requester restored from the successor's current claim",
        );
        expect(requesterOrigin).toEqual(requesterSource.requesterOrigin);
        const terminalEvents: Parameters<typeof persistGatewaySessionLifecycleEvent>[0]["event"][] =
          [];
        const terminalObserved =
          createDeferred<Parameters<typeof persistGatewaySessionLifecycleEvent>[0]["event"]>();
        const unsubscribe = onAgentEvent((event) => {
          if (
            event.runId === runId &&
            event.stream === "lifecycle" &&
            event.data.phase === "error"
          ) {
            terminalEvents.push(event);
            terminalObserved.resolve(event);
          }
        });
        // Observe the expected rejection immediately, then join its real lifecycle settlement.
        const commandSettlement = runRecoveryCommandDuringStop({
          entry: admittedEntry,
          requesterOrigin,
          runId,
          sessionKey,
          storePath,
          stateDir: tmpDir,
          signal,
        }).then(
          () => undefined,
          (error: unknown) => error,
        );
        let commandError: unknown;
        try {
          await withinTest(
            awaitGateBeforeSettlement(
              terminalObserved.promise,
              commandSettlement,
              "Expected command error lifecycle before shutdown command settled",
            ),
            signal,
          );
        } finally {
          commandError = await commandSettlement;
          unsubscribe();
        }
        commandErrors.push(commandError);
        for (const event of terminalEvents) {
          emittedErrors.push(event.data ?? {});
          await persistGatewaySessionLifecycleEvent({ sessionKey, agentId: "main", event });
        }
        persistedEntries.push(readEntry());
        throw commandError;
      };
      const dispatchAgent = vi.fn((...args: Parameters<typeof dispatchRecoveryCommand>) => {
        const dispatch = dispatchRecoveryCommand(...args);
        dispatchSettlements.push(
          dispatch.then(
            () => {},
            () => {},
          ),
        );
        return dispatch;
      });
      const gatewayRuntime = queueTimeoutRuntime(dispatchAgent, true);
      try {
        await expect(retryMainClaim(storePath, gatewayRuntime)).resolves.toEqual(
          recoveryCounts({ failed: 1 }),
        );
        expect(commandErrors).toEqual([expect.any(GatewayDrainingError)]);
        expect(emittedErrors).toEqual([
          expect.objectContaining({ executionStarted: false, providerStarted: false }),
        ]);
        expect(persistedEntries[0]?.status).toBeUndefined();
        expect(persistedEntries[0]?.restartRecoveryRequesterSource).toEqual(requesterSource);
        expect(persistedEntries[0]).toMatchObject({
          mainRestartRecovery: { cycleId: "interrupted-cycle", chargedAttempts: 1 },
          restartRecoveryRuns: [
            { runId: "recovery-main", lifecycleGeneration: getAgentEventLifecycleGeneration() },
          ],
        });
        const restored = readEntry();
        expect(restored?.restartRecoveryRequesterSource).toEqual(requesterSource);
        expect(restored).toMatchObject({
          status: "interrupted",
          abortedLastRun: true,
          restartRecoveryDeliverySourceRunId: "source-main",
          mainRestartRecovery: { chargedAttempts: 1 },
          restartRecoveryRuns: [{ runId: "recovery-main" }],
        });
        expectCleared(restored, "restartRecoveryDeliveryRunId");
        expect(scheduleSpy).toHaveBeenCalledWith({
          agentId: "main",
          sessionId: "main-session",
          sessionKey,
          storePath,
        });

        for (const attempt of [2, 3]) {
          resetGatewayWorkAdmission();
          rotateAgentEventLifecycleGeneration();
          await expect(recover({ cfg: {}, gatewayRuntime })).resolves.toEqual(
            recoveryCounts({ failed: 1 }),
          );
          expect(readEntry()?.restartRecoveryRequesterSource).toEqual(requesterSource);
          expect(readEntry()).toMatchObject({
            status: "interrupted",
            restartRecoveryDeliverySourceRunId: "source-main",
            mainRestartRecovery: { chargedAttempts: attempt },
          });
          expect(dispatchAgent).toHaveBeenCalledTimes(attempt);
        }
        expect(commandErrors).toEqual(
          Array.from({ length: 3 }, () => expect.any(GatewayDrainingError)),
        );
        expect(emittedErrors).toHaveLength(3);
        resetGatewayWorkAdmission();
        rotateAgentEventLifecycleGeneration();
        await expect(recover({ cfg: {}, gatewayRuntime })).resolves.toEqual(
          recoveryCounts({ skipped: 1 }),
        );
        expect(dispatchAgent).toHaveBeenCalledTimes(3);
        expect(sendRecoveryNotice).toHaveBeenCalledWith(
          expect.objectContaining({
            text: expect.stringContaining("use Resume to continue in this session"),
          }),
        );
        expect(sendRecoveryNotice).toHaveBeenCalledWith(
          expect.objectContaining({ text: expect.stringContaining("/new or /reset") }),
        );
        expect(readEntry()).toMatchObject({
          status: "failed",
          mainRestartRecovery: { tombstone: expect.any(Object) },
        });
      } finally {
        await Promise.all(dispatchSettlements);
        scheduleSpy.mockRestore();
        restoreActivePluginRegistrySnapshot(previousRegistry);
        vi.useRealTimers();
      }
    });
  });

  it.each([
    ["confirmed cancellation", true, false],
    ["unconfirmed cancellation", false, false],
    ["cached in-flight cancellation", true, true],
  ] as const)(
    "restores an accepted claim only after %s when execution never starts",
    async (_label, aborted, cached) => {
      vi.useFakeTimers();
      const { storePath, readEntry } = await makeClaimFixture();
      const scheduleSpy = vi
        .spyOn(recoveryOwnerRelease, "scheduleMainSessionRecoveryPendingTarget")
        .mockImplementation(() => {});
      const accepted = createDeferred();
      const abort = vi.fn(() => aborted);
      const dispatchAgent = vi.fn(
        async (request: DispatchArgs[0], _timeoutMs: DispatchArgs[1], options: DispatchArgs[2]) => {
          const runId = request.idempotencyKey!;
          const startDeadlineAtMs = Date.now() + 10_000;
          options?.onStartOwner?.({
            observe: () => ({ executionStarted: false, startDeadlineAtMs }),
            abort,
          });
          await admitRecovery(storePath, runId);
          if (cached) {
            accepted.resolve();
            return { runId, status: "in_flight" };
          }
          options?.onAccepted?.({ runId, status: "accepted" });
          accepted.resolve();
          return await new Promise<never>((_resolve, reject) => {
            const signal = options?.signal;
            if (!signal) {
              reject(new Error("expected execution-start abort signal"));
              return;
            }
            signal.addEventListener(
              "abort",
              () => {
                // A start callback that loses the deadline race cannot reclaim ownership.
                options?.onExecutionStarted?.();
                const abortError =
                  signal.reason instanceof Error
                    ? signal.reason
                    : new Error("execution-start wait aborted");
                void Promise.resolve(options?.onSignalAbort?.()).then(
                  () => reject(abortError),
                  () => reject(abortError),
                );
              },
              { once: true },
            );
          });
        },
      );

      try {
        const recovery = retryMainClaim(
          storePath,
          queueTimeoutRuntime(dispatchAgent as GatewayRecoveryRuntime["dispatchAgent"]),
        );

        await accepted.promise;
        await vi.advanceTimersByTimeAsync(10_000);
        await expect(recovery).resolves.toEqual(recoveryCounts({ failed: 1 }));
        expect(abort).toHaveBeenCalledOnce();
        expect(scheduleSpy).toHaveBeenCalledTimes(aborted ? 1 : 0);
        expect(readEntry()?.status).toBe(aborted ? "interrupted" : undefined);
        expect(readEntry()).toMatchObject({
          abortedLastRun: aborted,
          restartRecoveryDeliverySourceRunId: "source-main",
        });
        expect(readEntry()?.restartRecoveryDeliveryRunId).toBe(
          aborted ? undefined : "recovery-main",
        );
      } finally {
        scheduleSpy.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it("holds lifecycle replacement behind the targeted recovery dispatch", async () => {
    const sessionKey = "agent:main:main";
    const sessionId = "main-session";
    const { sessionsDir, storePath } = await makeStoreFixture({
      [sessionKey]: interruptedRun(sessionId, {
        restartRecoveryDeliveryRunId: "recovery-main",
        restartRecoveryDeliverySourceRunId: "source-main",
      }),
    });
    await writeUserTurn(sessionsDir, "recover me", sessionId);
    const dispatchEntered = createDeferred();
    const releaseDispatch = createDeferred();
    const gatewayRuntime: GatewayRecoveryRuntime = {
      ...mockRecoveryRuntime,
      dispatchAgent: async <T>(
        request: DispatchArgs[0],
        _timeoutMs: DispatchArgs[1],
        options: DispatchArgs[2],
      ) => {
        if (!options?.controllerInput) {
          throw new Error("expected the reserved recovery source");
        }
        return await withSessionTurn(
          {
            sessionKey,
            sessionId,
            target: captureSessionTarget({
              storeScope: storePath,
              sessionKey,
              incarnation: sessionId,
            }),
            controllerInput: options?.controllerInput,
          },
          async (operation) => {
            if (!operation) {
              throw new Error("expected the recovery source to own a turn");
            }
            options?.onStartOwner?.({
              observe: () => ({
                executionStarted: hasReplyOperationExecutionStarted(operation),
                startDeadlineAtMs: null,
              }),
              abort: () => operation.abort(),
            });
            dispatchEntered.resolve();
            await releaseDispatch.promise;
            options?.onAccepted?.({ runId: request.idempotencyKey, status: "accepted" });
            markReplyOperationExecutionStarted(operation);
            options?.onExecutionStarted?.();
            return { runId: request.idempotencyKey, status: "ok" } as T;
          },
        );
      },
    };

    const recovery = retryMainClaim(storePath, gatewayRuntime);
    let mutationRan = false;
    let mutation: Promise<void> | undefined;
    try {
      await dispatchEntered.promise;
      expect(isSessionControllerWorkActive(storePath, [sessionKey, sessionId])).toBe(true);
      mutation = runSessionMutation({
        scope: storePath,
        identities: [sessionKey, sessionId],
        run: async () => {
          mutationRan = true;
        },
      });
      await waitForFast(() =>
        expect(isSessionMutationActive(storePath, [sessionKey, sessionId])).toBe(true),
      );
      expect(mutationRan).toBe(false);

      releaseDispatch.resolve();
      await expect(recovery).resolves.toEqual(recoveryCounts({ started: 1 }));
      await mutation;
      expect(mutationRan).toBe(true);
    } finally {
      releaseDispatch.resolve();
      await Promise.allSettled([recovery, ...(mutation ? [mutation] : [])]);
    }
  });

  it("does not retry a replacement durable claim", async () => {
    const { sessionsDir, storePath } = await makeStoreFixture({
      "agent:main:main": interruptedRun("replacement-session", {
        restartRecoveryDeliveryRunId: "replacement-recovery",
        restartRecoveryDeliverySourceRunId: "replacement-source",
      }),
    });
    await writeUserTurn(sessionsDir, "replacement turn", "replacement-session");

    const result = await retryRecovery({
      expectedRecoveryRunId: "stale-recovery",
      expectedRecoverySourceRunId: "stale-source",
      expectedSessionId: "stale-session",
      sessionKey: "agent:main:main",
      storePath,
    });

    expect(result).toEqual(recoveryCounts());
    expect(callGateway).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      abortedLastRun: true,
      restartRecoveryDeliveryRunId: "replacement-recovery",
      restartRecoveryDeliverySourceRunId: "replacement-source",
      sessionId: "replacement-session",
    });
  });

  it("completes an interrupted turn whose exact terminal source reply was delivered", async () => {
    const sessionKey = "agent:main:discord:direct:123";
    const { sessionsDir, storePath } = await makeStoreFixture({
      [sessionKey]: {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        startedAt: Date.now() - 20_000,
        status: "interrupted",
        abortedLastRun: true,
        restartRecoveryBeforeAgentReplyState: "pending",
        restartRecoveryDeliveryRunId: "recovery-1",
        restartRecoveryDeliverySourceRunId: "discord-message-1",
        restartRecoveryDeliveryContext: discordDeliveryContext,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      makeUserMessage("do the thing", { idempotencyKey: "discord-message-1" }),
      makeMessageToolCall(),
      makeAssistantTextMessage("delivered answer", {
        stopReason: "stop",
        openclawDeliveryMirror: {
          kind: "message-tool-source-reply",
          final: true,
          sourceTurnId: "discord-message-1",
          toolCallId: "message-call-1",
        },
      }),
      makeToolResultMessage(textContent("sent"), {
        toolCallId: "message-call-1",
        toolName: "message",
      }),
    ]);

    await expectRecovery({ settled: 1 });

    expect(callGateway).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      status: "done",
      abortedLastRun: false,
      restartRecoveryTerminalRunIds: ["discord-message-1"],
    });
    const completed = loadSessionEntry({ sessionKey, storePath });
    expectCleared(
      completed,
      "lastRunId",
      "restartRecoveryDeliveryRunId",
      "restartRecoveryDeliverySourceRunId",
      "restartRecoveryDeliveryContext",
      "restartRecoveryBeforeAgentReplyState",
      "pendingFinalDelivery",
    );
  });

  it.each<{
    name: string;
    entry: SessionEntryFixture & { sessionKey?: string };
    sourceRunId?: string;
  }>([
    {
      name: "resumes with restart-safe tools while a terminal provider outcome remains unknown",
      entry: {
        restartRecoveryDeliveryReceiptState: "terminal-pending",
        restartRecoveryDeliveryToolCallId: "message-call-1",
      },
      sourceRunId: "discord-message-1",
    },
    {
      name: "resumes safely for a source-less silent before_agent_reply checkpoint",
      entry: {
        sessionKey: "agent:main:custom:direct:123",
        restartRecoveryBeforeAgentReplyState: "handled-silent",
      },
    },
    ...(["pending", "handled-reply", "handled-unrecoverable"] as const).map(
      (restartRecoveryBeforeAgentReplyState) => ({
        name: `resumes safely for a ${restartRecoveryBeforeAgentReplyState} before_agent_reply checkpoint without a recoverable result`,
        entry: { restartRecoveryBeforeAgentReplyState },
        sourceRunId: "discord-message-1",
      }),
    ),
  ])("$name", async ({ entry, sourceRunId }) => {
    const { sessionsDir, readEntry } = await makeMainSessionFixture({
      sessionKey: "agent:main:discord:direct:123",
      restartRecoveryDeliveryRunId: "recovery-1",
      restartRecoveryDeliverySourceRunId: sourceRunId,
      restartRecoveryDeliveryContext: discordDeliveryContext,
      ...entry,
    });
    await writeTranscript(sessionsDir, "main-session", [
      sourceRunId
        ? makeUserMessage("do the thing", { idempotencyKey: sourceRunId })
        : makeUserMessage("quiet"),
    ]);
    await expectRecovery({ started: 1 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
    expect(sendRecoveryNotice).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/:resumed-notice$/) }),
    );
    expect(readEntry()?.status).toBeUndefined();
    expect(readEntry()).toMatchObject({ abortedLastRun: false });
  });

  it.each([
    [["delivered"] as const, "sent", 1],
    [["suppressed"] as const, "suppressed", 0],
    [["delivered", "suppressed"] as const, "sent", 1],
  ] as const)(
    "retains completion evidence for settled queue receipts: %s",
    async (states, status, resultCount) => {
      const sourceRunId = "announce:checkpoint-queue";
      const { readEntry } = await makeMainSessionFixture({
        restartRecoveryDeliveryRunId: "recovery-queue",
        restartRecoveryDeliverySourceRunId: sourceRunId,
        pendingFinalDelivery: makePendingFinalDelivery("finished result", {
          deliveries: states.map((state, index) => ({ id: `settled-${index}`, state })),
        }),
      });

      await expectRecovery({ settled: 1 });

      expect(callGateway).not.toHaveBeenCalled();
      expect(resolveRequesterRecoveryDelivery(readEntry(), sourceRunId)).toMatchObject({
        kind: "result",
        result: { captured: true, deliveryStatus: { status, resultCount } },
      });
      expect(readEntry()?.pendingFinalDelivery).toBeUndefined();
    },
  );

  it.each([undefined, 0, "topic-7"])(
    "reconciles a receipt delivered during a restart-recovery continuation (thread=%s)",
    async (threadId) => {
      const route = {
        ...discordDeliveryContext,
        ...(threadId !== undefined ? { threadId: String(threadId) } : {}),
      };
      const { sessionsDir, storePath, sessionKey, readEntry } = await makeDeliveredReceiptFixture(
        "message-call-recovered",
        "discord-message-1",
        { restartRecoveryDeliveryContext: { ...discordDeliveryContext, threadId } },
      );
      await writeTranscript(
        sessionsDir,
        "main-session",
        makeMessageDeliveryTranscript({
          toolCallId: "message-call-recovered",
          beforeCall: [
            makeAssistantTextMessage("starting"),
            makeUserMessage("[System] continue after restart", {
              idempotencyKey: "recovery-1:user",
            }),
          ],
        }),
      );

      await expectRecovery({ settled: 1 });

      expect(callGateway).not.toHaveBeenCalled();
      expect(readEntry()).toMatchObject({
        status: "done",
        abortedLastRun: false,
        restartRecoveryTerminalRunIds: ["discord-message-1"],
      });
      const completion = resolveRequesterRecoveryDelivery(readEntry(), "discord-message-1");
      expect(completion?.kind).toBe("result");
      if (completion?.kind !== "result") {
        throw new Error("Confirmed recovery delivery did not retain its completion receipt");
      }
      expect(
        hasMessagingToolDeliveryToSource(completion.result, route, { requireFinalReply: true }),
      ).toBe(true);
      expect(
        hasMessagingToolDeliveryToSource(
          completion.result,
          { channel: "discord", to: "discord:dm:other" },
          { requireFinalReply: true },
        ),
      ).toBe(false);
      const transcript = await loadTestTranscript(sessionKey, storePath);
      expect(
        transcript
          .map((event) => event.message)
          .some(
            (message) =>
              message?.idempotencyKey ===
              "restart-recovery:message-tool-result:discord-message-1:message-call-recovered",
          ),
      ).toBe(true);
    },
  );

  it.each([
    [
      "missing message tool call",
      "discord-message-1",
      [makeUserMessage("do the thing", { idempotencyKey: "discord-message-1" })],
    ],
    ["missing durable source turn", "discord-message-missing", [makeMessageToolCall()]],
    [
      "checkpoint from an earlier turn",
      "discord-message-current",
      [
        makeUserMessage("current turn", { idempotencyKey: "discord-message-current" }),
        makeMessageToolCall("message-call-1", "current answer"),
        makeUserMessage("later turn", { idempotencyKey: "discord-message-later" }),
      ],
    ],
    [
      "unfinished sibling tool work",
      "discord-message-1",
      [
        makeUserMessage("do the thing", { idempotencyKey: "discord-message-1" }),
        createAssistantToolCallMessage([
          toolCall("message-call-1", "message", { action: "send", message: "current answer" }),
          toolCall("pending-write", "write", {}),
        ]),
        makeMessageToolResult("message-call-1"),
      ],
    ],
    [
      "non-successful existing tool result",
      "discord-message-1",
      [
        ...makeMessageDeliveryTranscript(),
        makeToolResultMessage(textContent("transport reported failure"), {
          toolCallId: "message-call-1",
          toolName: "message",
          isError: true,
        }),
      ],
    ],
  ] as const)(
    "resumes safely when terminal completion cannot reconcile %s",
    async (_label, sourceTurnId, messages) => {
      const { sessionsDir, readEntry } = await makeDeliveredReceiptFixture(
        "message-call-1",
        sourceTurnId,
      );
      await writeTranscript(sessionsDir, "main-session", messages);

      await expectRecovery({ started: 1 });

      expect(callGateway).toHaveBeenCalledOnce();
      expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
      expect(sendRecoveryNotice).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ idempotencyKey: expect.stringMatching(/:resumed-notice$/) }),
      );
      expect(readEntry()?.status).toBeUndefined();
      expect(readEntry()).toMatchObject({ abortedLastRun: false });
    },
  );

  it("matches a checkpointed Control UI hook to its run-keyed user turn", async () => {
    tmpDir = transcriptFixture.prepareRoot();
    const { sessionsDir, readEntry } = await makeControlUiRecoveryFixture({
      restartRecoveryBeforeAgentReplyState: "handled-silent",
    });
    await writeTranscript(sessionsDir, "main-session", [
      makeUserMessage("quiet", { idempotencyKey: "control-ui-run:user" }),
    ]);

    await expectRecovery({ settled: 1 });

    expect(callGateway).not.toHaveBeenCalled();
    expect(readEntry()).toMatchObject({
      status: "done",
      abortedLastRun: false,
      lastRunId: "control-ui-run",
      restartRecoveryTerminalRunIds: ["control-ui-run"],
    });
    expect(resolveRequesterRecoveryDelivery(readEntry(), "control-ui-run")).toMatchObject({
      kind: "result",
      result: { captured: true, meta: { terminalReply: { disposition: "silent" } } },
    });
  });

  it.each([
    ["progress delivery", false, "discord-message-1"],
    ["an older turn's terminal delivery", true, "discord-message-0"],
  ])("does not complete from %s", async (_label, final, sourceTurnId) => {
    const sessionsDir = await makeSessionsDir();
    const sessionKey = "agent:main:discord:direct:123";
    await writeMainSession({
      sessionsDir,
      sessionKey,
      restartRecoveryDeliveryRunId: "recovery-1",
      restartRecoveryDeliverySourceRunId: "discord-message-1",
      restartRecoveryDeliveryContext: discordDeliveryContext,
    });
    await writeTranscript(
      sessionsDir,
      "main-session",
      currentTurn(
        makeAssistantTextMessage("not this turn's terminal answer", {
          stopReason: "stop",
          openclawDeliveryMirror: {
            kind: "message-tool-source-reply",
            final,
            sourceTurnId,
            toolCallId: "message-call-1",
          },
        }),
      ),
    );

    await expectRecovery({ started: 1 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(sendRecoveryNotice).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/:resumed-notice$/) }),
    );
  });

  it("reconciles a provider error carrying a non-restart abort code", async () => {
    await prepareTranscript(
      currentTurn(
        makeAssistantTextMessage("", {
          stopReason: "error",
          errorMessage: "This operation was aborted",
          errorCode: "OPENCLAW_FIRST_EVENT_TIMEOUT",
        }),
      ),
    );

    await expectRecovery({ started: 1 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(gatewayParams()).not.toHaveProperty("forceRestartSafeTools");
  });

  function interruptedWaitTurn(current: boolean) {
    return currentTurn(
      codeModeCheckpointMessage(),
      codeModeWaitCallMessage(),
      failedWaitResult("call-wait-1", current),
      {
        role: "assistant",
        content: [],
        stopReason: "aborted",
        errorMessage: current ? "agent run aborted for restart" : "Request was aborted",
        ...(current ? { errorCode: "OPENCLAW_RESTART_ABORT" } : {}),
      },
    );
  }

  function checkpointedReadTurn(earlier: boolean) {
    return [
      makeUserMessage(earlier ? "finish the earlier turn" : "do the thing"),
      codeModeCheckpointMessage("exec"),
      ...(earlier ? [makeUserMessage("start the current turn")] : []),
      createAssistantToolCallMessage([
        toolCall("call-read-current", "read", { path: "README.md" }),
      ]),
      makeToolResultMessage(textContent("current read result"), {
        toolName: "read",
        toolCallId: "call-read-current",
      }),
    ];
  }

  it.each<
    [
      name: string,
      messages: unknown[],
      safeTools?: "required" | "unrestricted",
      codeMode?: "required" | "absent",
      promptIncludes?: string[],
    ]
  >([
    [
      "resumes a pre-upgrade errored tail without an abort code",
      currentTurn({
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Request was aborted",
      }),
    ],
    [
      "reads a provider-native Code Mode wait input",
      currentTurn(
        codeModeCheckpointMessage("exec"),
        createAssistantToolCallMessage([
          { type: "tool_use", id: "call-wait-1", name: "wait", input: { runId: "cm_interrupted" } },
        ]),
      ),
      "required",
      "required",
    ],
    [
      "withholds Code Mode tools for an unsafe direct waiting checkpoint",
      currentTurn(
        codeModeCheckpointMessage("exec", {
          status: "waiting",
          runId: "cm_interrupted",
          replaySafe: false,
        }),
      ),
      "required",
      "absent",
    ],
    [
      "keeps restart safety after a failed Code Mode result",
      currentTurn(
        makeToolResultMessage(
          textContent(
            JSON.stringify({ status: "failed", replaySafe: true, error: "safe failure" }),
          ),
          { toolName: "wait" },
        ),
      ),
      "required",
    ],
    [
      "resumes safely without replaying visible assistant text beside a Code Mode wait",
      currentTurn(
        codeModeCheckpointMessage("exec"),
        createAssistantToolCallMessage([
          { type: "text", text: "I already sent this part." },
          toolCall("call-wait-1", "wait", { runId: "cm_interrupted" }),
        ]),
      ),
      "required",
      "absent",
    ],
    [
      "keeps partial provider-abort output under replay-safe recovery",
      currentTurn(
        codeModeCheckpointMessage("exec"),
        codeModeWaitCallMessage(),
        makeAssistantTextMessage("partial answer", {
          stopReason: "error",
          errorMessage: "Request was aborted",
          errorCode: AGENT_RUN_RESTART_ABORT_ERROR_CODE,
        }),
      ),
      "required",
    ],
    [
      "resumes a partial streamed answer interrupted by a restart",
      currentTurn(
        makeAssistantTextMessage("Here is the first half of the answer", {
          stopReason: "aborted",
          errorMessage: "This operation was aborted",
        }),
      ),
      "unrestricted",
    ],
    [
      "reports an interrupted native tool outcome as unknown",
      [
        makeUserMessage("run the command"),
        createAssistantToolCallMessage([toolCall("call-bash-1", "bash", { command: "true" })]),
        makeToolResultMessage("aborted", {
          toolName: "bash",
          toolCallId: "call-bash-1",
          details: { reason: "missing_tool_result" },
          isError: true,
        }),
      ],
      "required",
      undefined,
      [
        "interrupted by a gateway restart",
        "marked interrupted, missing, or aborted",
        "unknown outcome",
        "not proof of tool failure",
        "never claim completion or success",
      ],
    ],
    [
      "keeps a dangling side-effecting call in an aborted tail restricted",
      currentTurn({
        role: "assistant",
        content: [
          { type: "text", text: "Kicking that off." },
          toolCall("call-bash-1", "bash", { command: "true" }),
        ],
        stopReason: "aborted",
        errorMessage: "This operation was aborted",
      }),
      "required",
    ],
    [
      "resumes an interrupted replay-safe tool call without restricting tools",
      currentTurn(
        createAssistantToolCallMessage([
          { type: "text", text: "Let me look that up." },
          toolCall("call-read-1", "read", { path: "README.md" }),
        ]),
      ),
      "unrestricted",
    ],
    [
      "resumes through the shutdown error persisted for an interrupted Code Mode wait",
      interruptedWaitTurn(false),
      "required",
      "required",
      [
        "Continue from the existing transcript",
        "the tool surface has been narrowed to replay-safe tools",
        "the full tool surface restores on the next user turn",
      ],
    ],
    [
      "resumes through the current Code Mode abort persisted for an interrupted wait",
      interruptedWaitTurn(true),
      "required",
      "required",
    ],
    [
      "resumes a mixed Code Mode wait and side-effecting tool tail safely",
      currentTurn(
        codeModeCheckpointMessage("exec"),
        createAssistantToolCallMessage([
          toolCall("call-wait-1", "wait", { runId: "cm_interrupted" }),
          toolCall("call-write-1", "write", { path: "result.txt", content: "done" }),
        ]),
      ),
      "required",
      "absent",
    ],
  ])("%s", async (_name, messages, safeTools, codeMode, promptIncludes) => {
    await prepareTranscript(messages);
    await expectRecovery({ started: 1 });
    expect(callGateway).toHaveBeenCalledOnce();
    const request = gatewayParams();
    if (safeTools === "required") {
      expect(request).toMatchObject({ forceRestartSafeTools: true });
    }
    if (safeTools === "unrestricted") {
      expect(request).not.toMatchObject({ forceRestartSafeTools: true });
    }
    if (codeMode === "required") {
      expect(request).toMatchObject({ forceCodeModeTools: true });
    }
    if (codeMode === "absent") {
      expect(request).not.toHaveProperty("forceCodeModeTools");
    }
    for (const text of promptIncludes ?? []) {
      expect(request.message).toContain(text);
    }
  });

  it.each([
    ["a replay-safe checkpoint earlier in the interrupted turn", checkpointedReadTurn(false), true],
    ["a replay-safe checkpoint from an earlier user turn", checkpointedReadTurn(true), false],
  ] as const)(
    "preserves the restart-safe boundary after an ordinary tool result with %s",
    async (_label, messages, forceRestartSafeTools) => {
      await prepareTranscript(messages);

      await expectRecovery({ started: 1 });
      if (forceRestartSafeTools) {
        expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
      } else {
        expect(gatewayParams()).not.toMatchObject({ forceRestartSafeTools: true });
      }
    },
  );

  it.each([
    ["inherited full access", "full", undefined, false],
    ["explicit guarded access", "full", "guarded", true],
  ] as const)(
    "continues interrupted work with %s",
    async (_label, mode, permissionMode, restricted) => {
      const sessionsDir = await prepareTranscript(
        currentTurn(
          createAssistantToolCallMessage([
            { type: "text", text: "Running the check now." },
            toolCall("call-exec-1", "exec", { code: "await shell({command: 'true'})" }),
          ]),
        ),
        { permissionMode, restartRecoveryForceSafeTools: true },
      );

      await expectRecovery({ started: 1 }, { tools: { exec: { mode } } });
      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(gatewayParams().forceRestartSafeTools === true).toBe(restricted);
      expect(gatewayParams()).not.toHaveProperty("forceCodeModeTools");
      expect(gatewayParams().message).toContain("unknown outcome");
      expect(
        loadSessionEntry({
          storePath: path.join(sessionsDir, "sessions.json"),
          sessionKey: "agent:main:main",
        })?.restartRecoveryForceSafeTools === true,
      ).toBe(restricted);
    },
  );

  it.each([
    ["mismatched failed-wait result identity", ["call-other"]],
    ["missing failed-wait result identity", [undefined]],
    ["duplicate failed-wait result identities", ["call-wait-1", "call-wait-1"]],
  ] as const)("does not restore Code Mode tools for %s", async (_label, toolCallIds) => {
    await prepareTranscript([
      makeUserMessage("do the thing"),
      codeModeCheckpointMessage(),
      codeModeWaitCallMessage(),
      ...toolCallIds.map((toolCallId) => failedWaitResult(toolCallId)),
    ]);

    await expectRecovery({ started: 1 });
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
    expect(gatewayParams()).not.toHaveProperty("forceCodeModeTools");
  });

  it.each([
    [
      "non-replay-safe checkpoint",
      {
        status: "waiting",
        runId: "cm_interrupted",
        reason: "pending_tools",
        replaySafe: false,
      },
    ],
    [
      "replay-safe checkpoint for another run",
      { status: "waiting", runId: "cm_other", reason: "yield", replaySafe: true },
    ],
  ] as const)("resumes a Code Mode wait safely after a %s", async (_label, checkpoint) => {
    await prepareTranscript(
      currentTurn(codeModeCheckpointMessage("wait", checkpoint), codeModeWaitCallMessage()),
    );

    await expectRecovery({ started: 1 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
    expect(gatewayParams()).not.toHaveProperty("forceCodeModeTools");
  });
});
describe("main-session startup recovery", () => {
  it("settles a legacy requester once while retrying temporary startup preparation", async ({
    signal,
  }) => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
      const { resetSubagentRegistryForTests } =
        await import("../subagents/registry/subagent-registry.test-helpers.js");
      await resetSubagentRegistryForTests({ persist: false });

      const sessionKey = "agent:main:main";
      const sourceRunId = "announce:requester-settle:legacy-cohort";
      const sessionRoot = path.join(tmpDir, "preserved-workspace");
      await fs.mkdir(sessionRoot);
      await fs.writeFile(path.join(sessionRoot, "work.txt"), "unfinished work\n");
      const { sessionsDir, storePath } = await makeStoreFixture({
        [sessionKey]: mainSessionEntry({
          lifecycleRevision: "legacy-lifecycle",
          sessionRoot,
          restartRecoveryDeliveryRunId: "legacy-recovery-run",
          restartRecoveryDeliverySourceRunId: sourceRunId,
          restartRecoverySourceIngress: "internal",
          pendingFinalDelivery: makePendingFinalDelivery("Saved work from the interrupted turn.", {
            intentId: "legacy-final",
            deliveries: [{ id: "legacy-prepared", state: "prepared" }],
          }),
          restartRecoveryRuns: [
            { runId: "legacy-recovery-run", lifecycleGeneration: "previous-gateway" },
          ],
        }),
      });
      await writeUserTurn(sessionsDir, "Continue the interrupted child results.");
      const target = { agentId: "main", storePath, sessionKey, sessionId: "main-session" };
      const originalTranscript = await loadTranscriptEvents(target);
      const otherDir = await makeSessionsDir("other");
      const transient = {
        agentId: "other",
        sessionKey: "agent:other:main",
        storePath: path.join(otherDir, "sessions.json"),
      };
      await writeStore(otherDir, {
        [transient.sessionKey]: mainSessionEntry({
          sessionId: "transient-session",
          pendingFinalDelivery: makePendingFinalDelivery(),
        }),
      });
      const cfg: OpenClawConfig = { agents: { entries: { main: {}, other: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const read = transcriptReaders.readSessionMessagesAsync;
      let transientReads = 0;
      const readSpy = vi
        .spyOn(transcriptReaders, "readSessionMessagesAsync")
        .mockImplementation(async (...args) => {
          if (args[0].sessionId === "transient-session" && transientReads++ === 0) {
            throw new Error("Session reader is temporarily unavailable");
          }
          return await read(...args);
        });
      const passes = [createDeferred<unknown>(), createDeferred<unknown>()];
      const admit = gatewayWorkAdmission.runWithGatewayIndependentRootWorkAdmission;
      let passIndex = 0;
      const admissionSpy = vi
        .spyOn(gatewayWorkAdmission, "runWithGatewayIndependentRootWorkAdmission")
        .mockImplementation(
          async <T>(run: () => Promise<T>, origin?: string, admissionSignal?: AbortSignal) => {
            const pass =
              origin === "main-session:startup-recovery" ? passes[passIndex++] : undefined;
            try {
              const result = await admit(run, origin, admissionSignal);
              pass?.resolve(result);
              return result;
            } catch (error) {
              pass?.reject(error);
              throw error;
            }
          },
        );
      vi.useFakeTimers();
      const recovery = scheduleRecovery({
        getConfig: () => cfg,
        maxRetries: 2,
      });
      try {
        expect(await withinTest(passes[0]!.promise, signal)).toMatchObject({
          started: 0,
          settled: 1,
          failed: 1,
        });
        expect(callGateway).not.toHaveBeenCalled();
        expect(sendRecoveryNotice).not.toHaveBeenCalled();
        const settled = loadSessionEntry(target);
        expect(settled).toMatchObject({
          sessionId: "main-session",
          lifecycleRevision: "legacy-lifecycle",
          sessionRoot,
          status: "interrupted",
          abortedLastRun: false,
          restartRecoveryTerminalRunIds: expect.arrayContaining([sourceRunId]),
        });
        expectCleared(
          settled,
          "mainRestartRecovery",
          "restartRecoveryRuns",
          "restartRecoveryDeliveryRunId",
          "restartRecoveryDeliverySourceRunId",
          "pendingFinalDelivery",
        );
        const transcript = await loadTranscriptEvents(target);
        expect(transcript.slice(0, originalTranscript.length)).toEqual(originalTranscript);
        expect(transcript).toHaveLength(originalTranscript.length + 1);
        expect(transcript.at(-1)).toMatchObject({
          message: {
            role: "assistant",
            idempotencyKey: `main-session-restart-recovery:${sourceRunId}:interrupted`,
            content: textContent(
              expect.stringContaining(
                "Saved reply (delivery unconfirmed):\nSaved work from the interrupted turn.",
              ),
            ),
          },
        });

        await vi.advanceTimersByTimeAsync(5_000);
        expect(await withinTest(passes[1]!.promise, signal)).toMatchObject({
          started: 1,
          settled: 0,
          failed: 0,
        });
        await mockRecoveryRuntime.expectAdmission(1, recovery, transient);
        expect(transientReads).toBe(2);
        expect(await loadTranscriptEvents(target)).toEqual(transcript);
        expect(await fs.readFile(path.join(sessionRoot, "work.txt"), "utf8")).toBe(
          "unfinished work\n",
        );

        resetAgentEventsForTest();
        await resetSubagentRegistryForTests({ persist: false });
        await markOrphans({ cfg, agentIds: new Set(["main"]) });
        expect(
          await readSessionEntrySummariesInWorker({ ...target, mainSessionRecovery: "claims" }),
        ).toEqual([]);
        expect(await recover({ cfg, agentIds: new Set(["main"]) })).toEqual(recoveryCounts());
        expect(await loadTranscriptEvents(target)).toEqual(transcript);
        expect(callGateway).toHaveBeenCalledOnce();
        expect(sendRecoveryNotice).not.toHaveBeenCalled();
      } finally {
        dispatchSettlement.resolve();
        await recovery.stop();
        admissionSpy.mockRestore();
        readSpy.mockRestore();
        vi.useRealTimers();
        await resetSubagentRegistryForTests({ persist: false });
      }
    });
  });

  it("keeps archived interruptions out of writer preparation", async () => {
    const { storePath } = await makeStoreFixture({
      "agent:main:archived": mainSessionEntry({ archivedAt: 1 }),
    });
    const before = readStore(storePath);
    const replacements = vi.spyOn(sessionAccessor, "applySessionEntryReplacements");
    try {
      expect(await markOrphans({})).toEqual({ marked: 0, skipped: 0 });
      expect(replacements).not.toHaveBeenCalled();
      expect(readStore(storePath)).toEqual(before);
    } finally {
      replacements.mockRestore();
    }
  });

  it("automatically dispatches a continuation from a persisted restart-admission refusal", async () => {
    const sessionKey = "agent:main:main";
    const { sessionsDir, storePath } = await makeStoreFixture({
      [sessionKey]: mainSessionEntry({
        status: undefined,
        abortedLastRun: false,
        mainRestartRecovery: undefined,
        lifecycleRunId: "refused-turn",
        startedAt: 1,
      }),
    });
    await writeUserTurn(sessionsDir, "Finish the review.");
    const cfg = { session: { store: storePath } };
    setRuntimeConfigSnapshot(cfg);
    gatewayWorkAdmission.markGatewayRestartDraining();
    const error = new gatewayWorkAdmission.GatewayDrainingError();
    await persistGatewaySessionLifecycleEvent({
      sessionKey,
      agentId: "main",
      event: {
        runId: "refused-turn",
        sessionId: "main-session",
        ts: Date.now(),
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        data: {
          phase: "error",
          error: error.message,
          ...resolveAgentRunErrorLifecycleFields(error, undefined),
        },
      },
    });
    expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
      status: "interrupted",
      abortedLastRun: true,
    });
    expect(
      (await loadTranscriptEvents({ storePath, sessionKey, sessionId: "main-session" })).some(
        (event) =>
          isRecord(event) &&
          event.type === "custom_message" &&
          event.customType === "run-failed-before-reply",
      ),
    ).toBe(false);
    resetGatewayWorkAdmission();
    resetAgentEventsForTest();
    await markOrphans({ cfg });
    const recovery = await recover({ cfg });
    expect(recovery).toMatchObject({ started: 1, failed: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agent",
        params: expect.objectContaining({
          sessionKey,
          inputProvenance: {
            kind: "internal_system",
            sourceSessionKey: sessionKey,
            sourceTool: "main_session_restart_recovery",
          },
        }),
      }),
    );
    await recover({ cfg });
    expect(callGateway).toHaveBeenCalledOnce();
    dispatchSettlement.resolve();
  });
  it("preserves a claimless delivered continuation but marks one with only older receipts", async () => {
    const delivered = mainSessionEntry({
      mainRestartRecovery: undefined,
      lifecycleRunId: "interrupted-continuation",
      activeWriterRunId: "interrupted-continuation",
      restartRecoveryDeliverySourceRunId: "completed-source",
      restartRecoveryTerminalRunIds: ["completed-source", "interrupted-continuation"],
      restartRecoveryTerminalDeliveryEvidence: [
        {
          runId: "completed-source",
          transcriptRunId: "interrupted-continuation",
          captured: true,
          payloads: [{ visible: true }],
        },
      ],
    });
    const { storePath } = await makeStoreFixture({
      "agent:main:delivered": delivered,
      "agent:main:undelivered": {
        ...delivered,
        sessionId: "undelivered-session",
        lifecycleRunId: "undelivered-continuation",
        activeWriterRunId: "undelivered-continuation",
        restartRecoveryDeliverySourceRunId: "undelivered-source",
      },
    });
    const before = readStore(storePath);

    expect(await markOrphans({})).toEqual({ marked: 1, skipped: 0 });

    const after = readStore(storePath);
    expect(after["agent:main:delivered"]).toEqual(before["agent:main:delivered"]);
    expect(after["agent:main:undelivered"]).toMatchObject({
      status: "interrupted",
      abortedLastRun: true,
      mainRestartRecovery: { chargedAttempts: 0 },
      restartRecoveryTerminalRunIds: ["completed-source", "interrupted-continuation"],
    });
  });

  it("recovers unclaimed interruptions without taking archived, live, or newer turns", async () => {
    const cutoff = Date.now();
    const interrupted = mainSessionEntry({
      updatedAt: cutoff - 10_000,
      mainRestartRecovery: undefined,
      restartRecoveryRuns: undefined,
      activeWriterRunId: "prior-process-run",
    });
    const entries: Record<string, SessionEntry> = {
      "agent:main:interrupted": interrupted,
      "agent:main:flag-only": { ...interrupted, sessionId: "flag-only", status: undefined },
      "agent:main:status-only": { ...interrupted, sessionId: "status-only", abortedLastRun: false },
      "agent:main:archived": { ...interrupted, sessionId: "archived", archivedAt: cutoff - 5_000 },
      "agent:main:archived-claim": mainSessionEntry({
        sessionId: "archived-claim",
        archivedAt: cutoff - 5_000,
        pendingWorktree: { titleSource: "old-work" },
      }),
      "agent:main:live": { ...interrupted, sessionId: "live", activeWriterRunId: "live-run" },
      "agent:main:cancelled": { ...interrupted, sessionId: "cancelled", status: "killed" },
      "agent:main:newer": {
        ...interrupted,
        sessionId: "newer",
        status: undefined,
        abortedLastRun: false,
      },
      "agent:main:fresh": { ...interrupted, sessionId: "fresh", updatedAt: cutoff + 1 },
    };
    const { sessionsDir, storePath } = await makeStoreFixture(entries);
    for (const sessionId of ["main-session", "flag-only", "status-only"]) {
      await writeUserTurn(sessionsDir, "finish this turn", sessionId);
    }
    const before = readStore(storePath);
    const claim = claimAgentRunContext(
      "live-run",
      {
        sessionId: "live",
        sessionKey: "agent:main:live",
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
      },
      { trackOwner: true },
    );
    const info = vi.spyOn(mainSessionRecoveryLog, "info");
    try {
      expect(await markOrphans({ updatedBeforeMs: cutoff })).toMatchObject({ marked: 3 });
      const marked = readStore(storePath);
      for (const key of [
        "agent:main:interrupted",
        "agent:main:flag-only",
        "agent:main:status-only",
      ]) {
        expect(marked[key]).toMatchObject({
          status: "interrupted",
          abortedLastRun: true,
          mainRestartRecovery: { chargedAttempts: 0 },
        });
      }
      for (const key of [
        "agent:main:archived",
        "agent:main:archived-claim",
        "agent:main:live",
        "agent:main:cancelled",
        "agent:main:newer",
        "agent:main:fresh",
      ]) {
        expect(marked[key]).toEqual(before[key]);
      }
      expect(await recover({})).toEqual(recoveryCounts({ started: 3 }));
      expect(callGateway).toHaveBeenCalledTimes(3);
      expect(info.mock.calls.map(([line]) => line)).not.toContainEqual(
        expect.stringContaining('"reason":"archived"'),
      );
    } finally {
      info.mockRestore();
      releaseAgentRunContext("live-run", claim);
    }
  });

  it.each([
    ["all", undefined],
    ["unrelated logical owner", new Set(["main"])],
    ["physical owner", new Set(["old"])],
  ] as const)(
    "selects a configured fixed store by its physical owner (%s)",
    async (selection, agentIds) => {
      const { storePath } = await makeStoreFixture({ "agent:old:main": mainSessionEntry() }, "old");

      const cfg = {
        agents: { entries: { main: {} } },
        session: { store: storePath },
      } as OpenClawConfig;

      const targets = await discoverRestartRecoveryStoreTargets({
        cfg,
        agentIds,
        stateDir: tmpDir,
      });
      expect(targets).toEqual(
        selection === "unrelated logical owner" ? [] : [{ agentId: "old", storePath }],
      );
    },
  );

  it("marks startup-orphaned admission claims before recovery", async () => {
    const cutoff = Date.now();
    const archivedKey = "agent:main:archived";
    const priorEntry = (name: string, fields: Partial<SessionEntry>): SessionEntry => ({
      sessionId: `${name}-session`,
      updatedAt: cutoff - 10_000,
      ...fields,
    });
    const archived = priorEntry("archived", {
      archivedAt: cutoff - 5_000,
      status: "interrupted",
      abortedLastRun: true,
      restartRecoveryDeliveryRunId: "archived-recovery",
      restartRecoveryDeliverySourceRunId: "archived-source",
      pendingFinalDelivery: makePendingFinalDelivery(),
    });
    const { sessionsDir } = await makeStoreFixture({
      [archivedKey]: archived,
      "agent:main:main": priorEntry("main", {
        restartRecoveryRuns: [{ runId: "main-run", lifecycleGeneration: "prior-process" }],
      }),
      "agent:main:active-key": priorEntry("active-key", {
        restartRecoveryDeliveryRunId: "active-key-run",
      }),
      "agent:main:active-id": priorEntry("active-id", {
        restartRecoveryDeliveryRunId: "active-id-run",
      }),
      "agent:main:fresh": priorEntry("fresh", {
        updatedAt: cutoff + 1,
        restartRecoveryDeliveryRunId: "fresh-run",
      }),
      "agent:main:subagent:child": priorEntry("child", {
        restartRecoveryDeliveryRunId: "child-run",
        spawnDepth: 1,
      }),
      "agent:main:cron:nightly": priorEntry("cron", {
        restartRecoveryDeliveryRunId: "cron-run",
      }),
      "agent:main:completed": priorEntry("completed", {
        status: "done",
        mainRestartRecovery: { cycleId: "completed-cycle", revision: 1, chargedAttempts: 0 },
        restartRecoveryTerminalRunIds: ["completed-prior-process-run"],
        restartRecoveryRuns: [
          { runId: "completed-prior-process-run", lifecycleGeneration: "prior-process" },
        ],
      }),
      "agent:main:already-marked": priorEntry("already-marked", {
        status: "interrupted",
        abortedLastRun: true,
        restartRecoveryRuns: [
          { runId: "marked-prior-process-run", lifecycleGeneration: "prior-process" },
        ],
      }),
    });
    await writeToolTurn(sessionsDir, "run the tool", "done");
    await writeToolTurn(sessionsDir, "already interrupted", "done", "already-marked-session");
    await writeUserTurn(sessionsDir, "do not recover while archived", archived.sessionId);
    const storePath = path.join(sessionsDir, "sessions.json");
    const before = readStore(storePath);
    const archivedScope = {
      agentId: "main",
      sessionKey: archivedKey,
      sessionId: archived.sessionId,
      storePath,
    };
    const archivedHistory = await loadTranscriptEvents(archivedScope);

    const liveWork = await Promise.all([
      beginSessionEffect({
        scope: storePath,
        identities: ["agent:main:active-key", "active-key-session"],
        assertAllowed: () => {},
      }),
      beginSessionEffect({
        scope: storePath,
        identities: ["agent:main:active-id", "active-id-session"],
        assertAllowed: () => {},
      }),
    ]);
    try {
      const marked = await markOrphans({ stateDir: tmpDir, updatedBeforeMs: cutoff });

      expect(marked).toEqual({ marked: 1, skipped: 1 });
      let store = readStore(path.join(sessionsDir, "sessions.json"));
      expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
      expect(store["agent:main:active-key"]?.abortedLastRun).toBeUndefined();
      expect(store["agent:main:active-id"]?.abortedLastRun).toBeUndefined();
      expect(store["agent:main:fresh"]?.abortedLastRun).toBeUndefined();
      expect(store["agent:main:subagent:child"]).toEqual(before["agent:main:subagent:child"]);
      expect(store["agent:main:cron:nightly"]).toEqual(before["agent:main:cron:nightly"]);
      expect(store["agent:main:completed"]?.abortedLastRun).toBe(false);
      expect(store["agent:main:already-marked"]?.abortedLastRun).toBe(true);
      expect(store["agent:main:completed"]?.restartRecoveryRuns).toBeUndefined();
      expect(store["agent:main:already-marked"]?.restartRecoveryRuns).toHaveLength(1);

      const recovered = await recover({});

      expect(recovered).toEqual(recoveryCounts({ started: 2 }));
      expect(callGateway).toHaveBeenCalledTimes(2);
      store = readStore(path.join(sessionsDir, "sessions.json"));
      expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
      expect(store["agent:main:already-marked"]?.abortedLastRun).toBe(false);
      for (const key of [
        archivedKey,
        "agent:main:active-key",
        "agent:main:active-id",
        "agent:main:subagent:child",
        "agent:main:cron:nightly",
      ]) {
        expect(store[key]).toEqual(before[key]);
      }
      expect(await loadTranscriptEvents(archivedScope)).toEqual(archivedHistory);
    } finally {
      liveWork.forEach((work) => work.release());
    }
  });

  it.each<[name: string, residue: Partial<SessionEntry>]>([
    ["a stale before-reply phase", { restartRecoveryBeforeAgentReplyState: "pending" }],
    [
      "an incomplete terminal-delivery receipt",
      { restartRecoveryDeliveryReceiptState: "delivered-terminal" },
    ],
    [
      "a completed delivery claim with a stale handled phase",
      {
        restartRecoveryDeliveryRunId: "finished-run",
        restartRecoveryBeforeAgentReplyState: "handled-reply",
      },
    ],
  ])("does not resume completed work from %s", async (_name, residue) => {
    const sessionKey = "agent:main:main";
    const { sessionsDir, storePath } = await makeStoreFixture({
      [sessionKey]: {
        sessionId: "main-session",
        updatedAt: 200,
        startedAt: 100,
        endedAt: 200,
        runtimeMs: 100,
        status: "done",
        abortedLastRun: false,
        ...residue,
      },
    });
    await writeCompletedToolTranscript(sessionsDir);

    await markOrphans({});
    await expect(recover({})).resolves.toMatchObject({ started: 0, failed: 0 });

    expect(callGateway).not.toHaveBeenCalled();
    expect(sendRecoveryNotice).not.toHaveBeenCalled();
    const entry = loadSessionEntry({ sessionKey, storePath });
    expect(entry).toMatchObject({
      status: "done",
      abortedLastRun: false,
      startedAt: 100,
      endedAt: 200,
      runtimeMs: 100,
    });
    expectCleared(
      entry,
      "restartRecoveryDeliveryRunId",
      "mainRestartRecovery",
      "restartRecoveryRuns",
    );
  });

  it.for([
    ["during the initial scan", "main", false],
    ["after the initial scan", "main", false],
    ["after stop", "main", false],
    ["after the initial scan", "old", false],
    ["after the initial scan", "old", true],
  ] as const)(
    "observes deferred database admission %s (owner=%s, shared=%s)",
    async ([publication, owner, shared], { signal }) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
        const sessionsDir =
          owner === "old" ? path.join(tmpDir, "custom-store") : await makeSessionsDir();
        await fs.mkdir(sessionsDir, { recursive: true });
        const logicalOwner = shared ? "main" : owner;
        const sessionKey = `agent:${logicalOwner}:main`;
        const freshSessionKey = `agent:${logicalOwner}:fresh`;
        const storePath = path.join(sessionsDir, shared ? "shared.sqlite" : "sessions.json");
        const cfg: OpenClawConfig =
          owner === "old"
            ? { agents: { entries: { main: {} } }, session: { store: storePath } }
            : {};
        setRuntimeConfigSnapshot(cfg);
        if (shared) {
          openOpenClawAgentDatabase({ agentId: owner, path: storePath });
        }
        await replaceSessionEntry(
          { agentId: logicalOwner, sessionKey, storePath },
          mainSessionEntry({
            status: undefined,
            abortedLastRun: undefined,
            mainRestartRecovery: undefined,
            restartRecoveryRuns: [
              { runId: "prior-process-run", lifecycleGeneration: "prior-process" },
            ],
          }),
        );
        for (const message of [
          makeUserMessage("resume after database admission"),
          makeToolResultMessage("main result"),
        ]) {
          await appendTranscriptMessage(
            { agentId: logicalOwner, sessionKey, sessionId: "main-session", storePath },
            { cwd: sessionsDir, message },
          );
        }
        const env = { ...process.env, OPENCLAW_STATE_DIR: tmpDir };
        const refusal = createAgentDatabaseInspectionRefusal({
          agentId: owner,
          paths: [],
          reason: "Startup inspection is pending",
          pending: true,
        });
        recordAgentDatabaseAdmissions([refusal], { env });
        const info = vi.spyOn(mainSessionRecoveryLog, "info");
        const resumed = createDeferred<unknown>();
        const scanned = createDeferred();
        const releaseScan = createDeferred();
        const admit = gatewayWorkAdmission.runWithGatewayIndependentRootWorkAdmission;
        let initialPass: Promise<unknown> | undefined;
        const admissionSpy = vi
          .spyOn(gatewayWorkAdmission, "runWithGatewayIndependentRootWorkAdmission")
          .mockImplementation(
            <T>(
              run: () => Promise<T>,
              origin?: string,
              admissionSignal?: AbortSignal,
            ): Promise<T> => {
              const pass = admit(run, origin, admissionSignal);
              if (origin !== "main-session:startup-recovery") {
                return pass;
              }
              if (initialPass) {
                return pass.then((result) => {
                  resumed.resolve(result);
                  return result;
                });
              }
              const held = pass.then(async (result) => {
                scanned.resolve();
                await releaseScan.promise;
                return result;
              });
              initialPass = held;
              return held;
            },
          );
        const recovery = scheduleRecovery({
          getConfig: () => cfg,
          maxRetries: 1,
        });
        try {
          await withinTest(scanned.promise, signal);
          expect(callGateway).not.toHaveBeenCalled();
          if (publication !== "during the initial scan") {
            releaseScan.resolve();
            await initialPass;
          }
          if (publication === "after stop") {
            await recovery.stop();
          }
          await preparePendingAgentDatabase(refusal, { env, assertCurrent() {} }, async () => {
            await replaceSessionEntry(
              { agentId: logicalOwner, sessionKey: freshSessionKey, storePath },
              mainSessionEntry({
                sessionId: "fresh-session",
                updatedAt: Date.now() + 1_000,
                status: undefined,
                abortedLastRun: undefined,
                mainRestartRecovery: undefined,
                restartRecoveryRuns: [
                  {
                    runId: "fresh-process-run",
                    lifecycleGeneration: getAgentEventLifecycleGeneration(),
                  },
                ],
              }),
            );
          });
          sessionChanges.emit({ all: true, scope: { agentId: owner, topology: true } });
          releaseScan.resolve();
          if (publication === "after stop") {
            await recovery.stop();
            expect(callGateway).not.toHaveBeenCalled();
          } else {
            expect(
              await withinTest(resumed.promise, signal),
              info.mock.calls.map(([line]) => line).join("\n"),
            ).toMatchObject({ started: 1, failed: 0 });
            await mockRecoveryRuntime.expectAdmission(1, recovery, { sessionKey, storePath });
            const fresh = loadSessionEntry({
              agentId: logicalOwner,
              sessionKey: freshSessionKey,
              storePath,
            });
            expect(fresh).toMatchObject({ sessionId: "fresh-session" });
            expect(fresh?.status).toBeUndefined();
            expect(fresh?.abortedLastRun).not.toBe(true);
          }
        } finally {
          releaseScan.resolve();
          await recovery.stop();
          admissionSpy.mockRestore();
          info.mockRestore();
          recordAgentDatabaseAdmissions([], { env });
        }
      });
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
