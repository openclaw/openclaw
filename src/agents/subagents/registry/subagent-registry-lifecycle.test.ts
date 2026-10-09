import { AsyncLocalStorage } from "node:async_hooks";
import { beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { withinTest } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import * as sessionAccessor from "../../../config/sessions/session-accessor.js";
import { resolveSessionStorePathForScope } from "../../../config/sessions/session-store-path.js";
import {
  runWithOwnedSessionTranscriptWrite,
  withOwnedSessionTranscriptWrites,
} from "../../../config/sessions/transcript-write-context.js";
import { LegacyContextEngine } from "../../../context-engine/legacy.js";
import {
  listContextEngineQuarantines,
  registerContextEngineInRegistry,
} from "../../../context-engine/registry.js";
import { resetContextEngineRuntimeQuarantineForTests } from "../../../context-engine/registry.test-support.js";
import type { CallGatewayOptions } from "../../../gateway/call.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import {
  claimAgentRunDelegatedAuthority,
  clearAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunDelegatedAuthority,
} from "../../../infra/agent-run-registry.js";
import type { GatewayBootLifecycleSegment } from "../../../infra/gateway-boot-lifecycle.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../../../plugins/registry-inspection-resources.js";
import { retireInspectionInstances } from "../../../plugins/registry-inspection.test-support.js";
// Subagent registry lifecycle tests cover completion, cleanup, announce retry,
// detached task status, and resource retirement around child-run endings.
import { bindGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  getActiveGatewayRootWorkCount,
  getActiveGatewayRootWorkHolders,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../../process/gateway-work-admission.js";
import {
  AsyncWorkScope,
  getAsyncWorkSignal,
  trackAsyncWork,
} from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "../../announce-idempotency.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../../cron-creator-authority-context.js";
import { loadAgentRuntimePluginRegistryHandle } from "../../runtime-plugins.js";
import { withGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import { createStructuredOutputTool } from "../../tools/structured-output-tool.js";
import * as sessionEntryRuntime from "../announce/subagent-announce-delivery.runtime.js";
import { readSubagentRunAnnounceResultUsing } from "../announce/subagent-announce-result.js";
import {
  consumeRequesterCronAuthorityAdmission,
  revokeRequesterCronAuthority,
  withRequesterCronAuthority,
} from "../requester-cron-authority.js";
import { SUBAGENT_KILL_TASK_ERROR } from "./subagent-control.types.js";
import { loadPendingFinalDeliveryPayload } from "./subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import { createSubagentRegistryCompletionRuntime } from "./subagent-registry-completion-runtime.js";
import { resolveSubagentKillTargetState } from "./subagent-registry-completion.js";
import { createSubagentRegistryContextCleanup } from "./subagent-registry-context-cleanup.js";
import { resetSubagentRegistryRuntimeLoadersForTests } from "./subagent-registry-deps.js";
import { registerRequesterDatabaseAdmissionTests } from "./subagent-registry-lifecycle-admission.test-support.js";
import {
  registerDetachedCleanupAuthorityTest,
  registerDeliveryRetryOwnerTests,
  registerDirectSessionCleanupAuthorityTests,
} from "./subagent-registry-lifecycle-cleanup.test-support.js";
import {
  mockBlockedCompletionDeliveryOwner,
  registerPrivateCompletionSettlementTests,
  registerRequesterSettleRetirementTests,
  registerNativeCompletionAuthorityTest,
} from "./subagent-registry-lifecycle-completion.test-support.js";
import {
  createLifecycleControllerFixture,
  createRunEntry,
  readLifecycleRun,
  mutateLifecycleRun,
  type LifecycleFixtureWrite,
  type RunEntryOverrides,
} from "./subagent-registry-lifecycle-controller.test-support.js";
import { registerLifecycleDeliveryReceiptCases } from "./subagent-registry-lifecycle-delivery.test-support.js";
import type {
  SubagentLifecycleController,
  SubagentLifecycleOptions,
} from "./subagent-registry-lifecycle.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { getLatestLiveSubagentRunByChildSessionKey } from "./subagent-registry-read.js";
import { settleRequesterTurnAfterSessionSpawns } from "./subagent-registry-requester-yield.js";
import {
  createRequesterInitialTransferFixture,
  markRequesterTurnYieldedWithAuthority,
} from "./subagent-registry-requester-yield.test-support.js";
import { markSubagentRunPausedAfterYield } from "./subagent-registry-run-pause.js";
import { reconcileStaleActiveSubagentRun } from "./subagent-registry-sweeper-orphan.js";
import { registerTerminalStateSignalAuthorityTests } from "./subagent-registry-terminal-state.test-support.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type LifecycleControllerParams = SubagentLifecycleOptions;
type LifecycleController = SubagentLifecycleController;
type RequesterSettleWakeParams = Parameters<
  LifecycleControllerParams["maybeWakeRequesterAfterAllChildrenSettled"]
>[0];
type SubagentCompletionParams = Parameters<LifecycleController["completeSubagentRun"]>[0];
type AnnounceFlowOutcome = Awaited<
  ReturnType<LifecycleControllerParams["runSubagentAnnounceFlow"]>
>;
type RestartRecoveryReceipt = NonNullable<SubagentRunRecord["execution"]["restartRecovery"]>;

vi.mock("../../../config/config.js", { spy: true });
vi.mock("../../../context-engine/init.js", () => ({ ensureContextEnginesInitialized: vi.fn() }));
vi.mock("../../runtime-plugins.js", () => ({
  loadAgentRuntimePluginRegistryHandle: vi.fn<typeof loadAgentRuntimePluginRegistryHandle>(),
}));

describe("subagent recovery session-effect ownership", () => {
  it("does not treat an ordinary run generation as a recovery suppression receipt", () => {
    const entry = createRunEntry({
      execution: {
        status: "terminal",
        endedAt: 4_000,
        lifecycleGeneration: "retired-generation",
      },
    });

    expect(shouldSuppressSubagentRecoverySessionEffects(entry)).toBe(false);
  });
});

function waitForLifecycleState<T>(assertion: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(assertion, { interval: 1 });
}

const completionDeliveryMocks = vi.hoisted(() => ({
  blockSubagentCompletionDelivery: vi.fn(),
  mutateRequesterCompletionBatch: vi.fn(),
  ownersByEntry: new Map<object, Pick<SubagentLifecycleOptions, "runs">>(),
}));

const gatewayMocks = vi.hoisted(() => ({
  callGateway: vi.fn(async (_opts: CallGatewayOptions) => ({})),
}));

const helperMocks = vi.hoisted(() => ({
  persistSubagentSessionTiming: vi.fn(async () => {}),
  safeRemoveAttachmentsDir: vi.fn(async () => {}),
  logAnnounceGiveUp: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => ({
  log: vi.fn(),
}));

const lifecycleEventMocks = vi.hoisted(() => ({
  emitSessionLifecycleEvent: vi.fn(),
}));

const browserLifecycleCleanupMocks = vi.hoisted(() => ({
  cleanupBrowserSessionsForLifecycleEnd: vi.fn<
    typeof import("../../../browser-lifecycle-cleanup.js").cleanupBrowserSessionsForLifecycleEnd
  >(async () => {}),
}));

const bundleMcpRuntimeMocks = vi.hoisted(() => ({
  retireSessionMcpRuntimeForSessionKey: vi.fn(async () => true),
}));

const internalSessionEffectsMocks = vi.hoisted(() => ({
  removeInternalSessionEffectsSession: vi.fn(async () => {}),
}));

const sessionReconciliationMocks = vi.hoisted(() => ({
  loadSubagentSessionEntry: vi.fn(),
  resolveSubagentRunOrphanReason: vi.fn(() => null as string | null),
}));

vi.mock("../announce/subagent-announce-delivery.runtime.js", { spy: true });
const nativeSessionEntryRuntime = await vi.importActual<typeof sessionEntryRuntime>(
  "../announce/subagent-announce-delivery.runtime.js",
);
const sessionEntryReadMocks = {
  loadSessionEntryByKey: vi.mocked(sessionEntryRuntime.loadSessionEntryByKey),
};

vi.mock("../completion/subagent-completion-admission.store.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../completion/subagent-completion-admission.store.js")
  >()),
  blockSubagentCompletionDelivery: completionDeliveryMocks.blockSubagentCompletionDelivery,
  mutateRequesterCompletionBatch: completionDeliveryMocks.mutateRequesterCompletionBatch,
}));

vi.mock("../../../sessions/session-lifecycle-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../sessions/session-lifecycle-events.js")>()),
  emitSessionLifecycleEvent: lifecycleEventMocks.emitSessionLifecycleEvent,
}));

vi.mock("../../../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd:
    browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
}));

vi.mock("../../agent-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntimeForSessionKey: bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey,
}));

vi.mock("../../internal-session-effects.js", () => ({
  removeInternalSessionEffectsSession:
    internalSessionEffectsMocks.removeInternalSessionEffectsSession,
}));

vi.mock("./subagent-session-reconciliation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./subagent-session-reconciliation.js")>()),
  loadSubagentSessionEntry: sessionReconciliationMocks.loadSubagentSessionEntry,
  resolveSubagentRunOrphanReason: sessionReconciliationMocks.resolveSubagentRunOrphanReason,
}));

const orphanBootSegments = vi.hoisted(() => ({ current: [] as GatewayBootLifecycleSegment[] }));
vi.mock("./subagent-orphan-attribution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./subagent-orphan-attribution.js")>()),
  loadGatewayBootSegmentsForAttribution: async () => orphanBootSegments.current,
}));

vi.mock("../../../runtime.js", () => ({
  defaultRuntime: {
    log: runtimeMocks.log,
  },
}));

vi.mock("../announce/subagent-announce.js", () => ({
  captureSubagentCompletionReply: vi.fn(async () => undefined),
  runSubagentAnnounceFlow: vi.fn(async () => "retryable" as const),
}));

vi.mock("./subagent-registry-cleanup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./subagent-registry-cleanup.js")>()),
  resolveDeferredCleanupDecision: () => ({ kind: "give-up", reason: "expiry" }),
}));

vi.mock("./subagent-registry-helpers.js", () => ({
  ANNOUNCE_COMPLETION_HARD_EXPIRY_MS: 30 * 60_000,
  ANNOUNCE_EXPIRY_MS: 5 * 60_000,
  MIN_ANNOUNCE_RETRY_DELAY_MS: 1_000,
  PROVISIONAL_KILL_RECONCILIATION_MS: 5 * 60_000,
  capFrozenResultText: (text: string) => text.trim(),
  logAnnounceGiveUp: helperMocks.logAnnounceGiveUp,
  persistSubagentSessionTiming: helperMocks.persistSubagentSessionTiming,
  resolveAnnounceRetryDelayMs: (retryCount: number) =>
    Math.min(1_000 * 2 ** Math.max(0, retryCount - 1), 8_000),
  safeRemoveAttachmentsDir: helperMocks.safeRemoveAttachmentsDir,
  shouldRemoveSubagentAttachments: (entry: SubagentRunRecord, cleanup = entry.cleanup) =>
    cleanup === "delete" || !entry.retainAttachmentsOnKeep,
  updateSubagentArchiveAtMs: () => false,
}));

type RunModeCleanupEntryOverrides = Omit<RunEntryOverrides, "execution"> & {
  execution?: Partial<SubagentRunRecord["execution"]>;
};

describe("pending final delivery payload", () => {
  it("uses the authoritative completion reply after a retry payload was captured", () => {
    const staleTerminalReply = { disposition: "visible", text: "child result" } as const;
    const completionTerminalReply = {
      disposition: "visible",
      text: "child result",
      modelRouteChange: "Model route changed: requested/model → actual/model.",
    } as const;
    const entry = createRunEntry({
      delivery: {
        status: "pending",
        payload: {
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          childSessionKey: "agent:main:subagent:child",
          childRunId: "run-1",
          task: "finish the task",
          terminalReply: staleTerminalReply,
        },
      },
      completion: { required: true, terminalReply: completionTerminalReply },
    });

    expect(loadPendingFinalDeliveryPayload(entry).terminalReply).toEqual(completionTerminalReply);
  });
});

function makeProvisionalKilledRunEntry(overrides: RunEntryOverrides = {}): SubagentRunRecord {
  return createRunEntry({
    endedAt: 4_000,
    endedReason: SUBAGENT_ENDED_REASON_KILLED,
    outcome: { status: "error", error: "agent run aborted" },
    suppressAnnounceReason: "killed",
    killReconciliation: { killedAt: 4_000 },
    cleanupHandled: true,
    cleanupCompletedAt: 4_000,
    ...overrides,
  });
}

function makeRestartRecoveryReceipt(
  overrides: Partial<RestartRecoveryReceipt> = {},
): RestartRecoveryReceipt {
  return {
    sessionId: "session-id",
    sessionMarker: "session-id:1",
    idempotencyKey: "recovery-run",
    phase: "accepted",
    ...overrides,
  };
}

function makeRunModeCleanupEntry(
  transcriptSessionId: string,
  overrides: RunModeCleanupEntryOverrides = {},
): SubagentRunRecord {
  const { execution, ...recordOverrides } = overrides;
  const sessionKeySuffix = transcriptSessionId.replace(/^internal-/u, "");
  return createRunEntry({
    cleanup: "delete",
    spawnMode: "run",
    ...recordOverrides,
    execution: {
      status: "terminal",
      endedAt: 4_000,
      transcriptTarget: {
        agentId: "main",
        sessionId: transcriptSessionId,
        sessionKey: `agent:main:internal:${sessionKeySuffix}`,
        storePath: "/tmp/openclaw-agent.sqlite",
      },
      ...execution,
    },
  });
}

function makeSubagentCompletion(
  entry: SubagentRunRecord,
  overrides: Omit<Partial<SubagentCompletionParams>, "runId"> = {},
): SubagentCompletionParams {
  return {
    runId: entry.runId,
    endedAt: 4_000,
    outcome: { status: "ok" },
    reason: SUBAGENT_ENDED_REASON_COMPLETE,
    triggerCleanup: false,
    ...overrides,
  };
}

function makeKilledSubagentCompletion(
  entry: SubagentRunRecord,
  overrides: Omit<Partial<SubagentCompletionParams>, "runId"> = {},
): SubagentCompletionParams {
  return makeSubagentCompletion(entry, {
    outcome: { status: "error", error: "agent run aborted" },
    reason: SUBAGENT_ENDED_REASON_KILLED,
    ...overrides,
  });
}

function makeInterruptedSubagentCompletion(
  entry: SubagentRunRecord,
  overrides: Omit<Partial<SubagentCompletionParams>, "runId"> = {},
): SubagentCompletionParams {
  return makeSubagentCompletion(entry, {
    outcome: { status: "error", error: "restart interrupted run" },
    reason: SUBAGENT_ENDED_REASON_ERROR,
    recoverInterrupted: true,
    ...overrides,
  });
}

function buildExpectedAnnounceIdempotencyKey(entry: SubagentRunRecord): string {
  return buildAnnounceIdempotencyKey(
    buildAnnounceIdFromChildRun({
      childSessionKey: entry.childSessionKey,
      childRunId: entry.runId,
    }),
  );
}

function createLifecycleController(params: Parameters<typeof createLifecycleControllerFixture>[0]) {
  return createLifecycleControllerFixture(params, {
    callGateway: async <T = Record<string, unknown>>(opts: CallGatewayOptions): Promise<T> =>
      (await gatewayMocks.callGateway(opts)) as T,
    cleanupBrowserSessionsForLifecycleEnd:
      browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
    ownersByEntry: completionDeliveryMocks.ownersByEntry,
  });
}

function completeRun(
  controller: LifecycleController,
  entry: SubagentRunRecord,
  overrides: Omit<Partial<SubagentCompletionParams>, "runId"> = {},
) {
  return controller.completeSubagentRun(makeSubagentCompletion(entry, overrides));
}

async function completeAndJoinCleanup(
  controller: LifecycleController,
  entry: SubagentRunRecord,
  overrides: Omit<Partial<SubagentCompletionParams>, "runId"> = {},
) {
  const join = observeRootWork();
  try {
    await completeRun(controller, entry, overrides);
  } finally {
    await join();
  }
}

function finishCleanup(
  controller: LifecycleController,
  entry: SubagentRunRecord,
  overrides: Partial<Parameters<LifecycleController["completeCleanupBookkeeping"]>[0]> = {},
) {
  return controller.completeCleanupBookkeeping({
    runId: entry.runId,
    entry,
    cleanup: "keep",
    completedAt: 5_000,
    ...overrides,
  });
}

function settleRequesterTurn(
  controller: LifecycleController,
  entry: SubagentRunRecord,
  requesterYielded = true,
) {
  return controller.settleRequesterTurnAfterSessionSpawns({
    requesterSessionKey: entry.requesterSessionKey,
    requesterTurnRunId: "run-requester",
    requesterYielded,
    acceptedSessionSpawns: [{ runId: entry.runId, childSessionKey: entry.childSessionKey }],
  });
}

function createCaptureFixture(entry = createRunEntry()) {
  const captured = createDeferredCore<string>();
  const captureSubagentCompletionReply = vi.fn(() => captured.promise);
  const runs = new Map([[entry.runId, entry]]);
  const controller = createLifecycleController({ entry, runs, captureSubagentCompletionReply });
  return { entry, runs, captured, captureSubagentCompletionReply, controller };
}

async function runNoReplyMirrorScenario(params: {
  timestamp: number;
  text?: string;
  idempotencyKey?: string;
  idempotencyKeyForEntry?: (entry: SubagentRunRecord) => string;
}): Promise<SubagentRunRecord> {
  // A failed direct announce can still be mirrored from the requester history;
  // the idempotency key prevents stale or unrelated assistant text from winning.
  const entry = createRunEntry({
    endedAt: 4_000,
    expectsCompletionMessage: true,
    retainAttachmentsOnKeep: true,
  });
  const text = params.text ?? "final completion reply";
  const idempotencyKey =
    params.idempotencyKeyForEntry?.(entry) ??
    params.idempotencyKey ??
    `${buildExpectedAnnounceIdempotencyKey(entry)}:internal-source-reply:0`;
  const runSubagentAnnounceFlow = vi.fn<LifecycleControllerParams["runSubagentAnnounceFlow"]>(
    async (announceParams) => {
      await announceParams.onDeliveryResult?.({
        delivered: false,
        path: "direct",
        error: "completion agent did not produce a visible reply",
      });
      return "retryable" as const;
    },
  );
  gatewayMocks.callGateway.mockResolvedValueOnce({
    messages: [
      {
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
        content: text,
        timestamp: params.timestamp,
        idempotencyKey,
      },
    ],
  });

  await createLifecycleController({
    entry,
    captureSubagentCompletionReply: vi.fn(async () => text),
    beforeWrite: vi.fn(),
    runSubagentAnnounceFlow,
  }).completeSubagentRun(
    makeSubagentCompletion(entry, {
      triggerCleanup: true,
      terminalReply: { disposition: "visible", text },
    }),
  );
  return entry;
}

describe("subagent registry lifecycle hardening", () => {
  beforeAll(() => {
    // Session reads and retained generation checks must observe the same canonical row.
    sessionAccessor.replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:subagent:child" },
      {
        sessionId: "child-session-id",
        lifecycleRevision: "child-lifecycle-revision",
        updatedAt: 1,
      },
    );
  });

  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.clearAllMocks();
    mockBlockedCompletionDeliveryOwner(completionDeliveryMocks);
    gatewayMocks.callGateway.mockReset();
    gatewayMocks.callGateway.mockResolvedValue({});
    browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd.mockClear();
    bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey.mockClear();
    bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey.mockResolvedValue(true);
    internalSessionEffectsMocks.removeInternalSessionEffectsSession.mockClear();
    sessionEntryReadMocks.loadSessionEntryByKey
      .mockReset()
      .mockImplementation(nativeSessionEntryRuntime.loadSessionEntryByKey);
  });

  it.each([
    { change: "identical", current: true },
    { change: "older equivalent", current: true },
    { change: "error", current: false },
    { change: "timing", current: false },
    { change: "reply", current: false },
  ] as const)(
    "keeps queued result authority correct after $change completion",
    async ({ change, current }) => {
      const entry = createRunEntry({ expectsCompletionMessage: true });
      const controller = createLifecycleController({ entry });
      const terminalReply = { disposition: "visible", text: "final completion reply" } as const;
      await completeRun(controller, entry, { terminalReply });
      const prepared = await readSubagentRunAnnounceResultUsing(readLifecycleRun(entry), {
        getRuntimeConfig: () => ({}),
        readSubagentRun: (id) => controller.options.runs.get(id),
        resolveAgentIdFromSessionKey: () => "main",
        resolveSessionStorePathCore: () => "/unused",
        readSubagentSessionEntry: () => undefined,
        findTranscriptEvent: async () => undefined,
        findSessionTranscriptArchiveEventReadOnly: async () => undefined,
      });
      expect(prepared.isCurrent()).toBe(true);

      await completeRun(controller, entry, {
        terminalReply:
          change === "reply"
            ? { ...terminalReply, text: "corrected result" }
            : { ...terminalReply },
        endedAt:
          change === "older equivalent"
            ? 3_999
            : change === "timing" || change === "reply"
              ? 4_001
              : 4_000,
        ...(change === "error"
          ? {
              outcome: { status: "error", error: "provider failed" },
              reason: SUBAGENT_ENDED_REASON_ERROR,
            }
          : {}),
      });
      expect(prepared.isCurrent()).toBe(current);
    },
  );

  describe.each([
    {
      name: "visible answer",
      first: { disposition: "visible" as const, text: "first final" },
      resultText: "first final",
    },
    {
      name: "intentional silence",
      first: { disposition: "silent" as const },
      resultText: "NO_REPLY",
    },
    {
      name: "empty reply",
      first: { disposition: "empty" as const },
      resultText: null,
    },
  ])("completion receipt ordering after $name", ({ first, resultText }) => {
    it.each([
      { order: "older", endedAt: 3_999, accepted: false },
      { order: "equal-time", endedAt: 4_000, accepted: false },
      { order: "newer", endedAt: 4_001, accepted: true },
    ])("accepts only a newer correction ($order receipt)", async ({ endedAt, accepted }) => {
      const entry = createRunEntry({ expectsCompletionMessage: true });
      const controller = createLifecycleController({ entry });
      const correction = { disposition: "visible", text: "corrected final" } as const;
      await completeRun(controller, entry, { terminalReply: first, endedAt: 4_000 });
      await completeRun(controller, entry, { terminalReply: correction, endedAt });

      const stored = readLifecycleRun(entry);
      expect(stored.execution.endedAt).toBe(accepted ? 4_001 : 4_000);
      expect(stored.completion).toMatchObject({
        terminalReply: accepted ? correction : first,
        resultText: accepted ? "corrected final" : resultText,
      });
    });
  });

  it.each([3_999, 4_000])(
    "accepts the first producer reply after terminal timing (%s)",
    async (endedAt) => {
      const entry = createRunEntry({ expectsCompletionMessage: true });
      const controller = createLifecycleController({ entry });
      const outcome = { status: "error", error: "provider failed" } as const;
      const reason = SUBAGENT_ENDED_REASON_ERROR;
      await completeRun(controller, entry, { outcome, reason, terminalReply: undefined });
      const terminalReply = { disposition: "visible", text: "first producer reply" } as const;
      await completeRun(controller, entry, { outcome, reason, endedAt, terminalReply });

      expect(readLifecycleRun(entry).completion).toMatchObject({
        terminalReply,
        resultText: "first producer reply",
      });
    },
  );

  it("fails a required successful completion without producer reply evidence", async () => {
    const entry = createRunEntry({ expectsCompletionMessage: true });
    const captureSubagentCompletionReply = vi.fn(async () => "stale transcript reply");
    const controller = createLifecycleController({ entry, captureSubagentCompletionReply });

    await completeRun(controller, entry, { terminalReply: undefined });

    expect(readLifecycleRun(entry).endedReason).toBe(SUBAGENT_ENDED_REASON_ERROR);
    expect(readLifecycleRun(entry).execution.outcome).toMatchObject({
      status: "error",
      error: "subagent run ended before producing a final reply",
    });
    expect(readLifecycleRun(entry).completion?.resultText).toBeNull();
    expect(captureSubagentCompletionReply).not.toHaveBeenCalled();
  });

  it("keeps reply-optional successful completion compatible without evidence", async () => {
    const entry = createRunEntry({ expectsCompletionMessage: false });
    const captureSubagentCompletionReply = vi.fn(async () => "legacy transcript reply");
    const controller = createLifecycleController({ entry, captureSubagentCompletionReply });

    await completeRun(controller, entry, { terminalReply: undefined });

    expect(readLifecycleRun(entry).endedReason).toBe(SUBAGENT_ENDED_REASON_COMPLETE);
    expect(readLifecycleRun(entry).execution.outcome).toMatchObject({ status: "ok" });
    expect(readLifecycleRun(entry).completion?.resultText).toBe("legacy transcript reply");
  });

  it.each([
    {
      terminalReply: { disposition: "visible", text: "authoritative final" } as const,
      resultText: "authoritative final",
    },
    {
      terminalReply: { disposition: "silent" } as const,
      resultText: "NO_REPLY",
    },
  ])(
    "persists $terminalReply.disposition producer evidence without transcript inference",
    async ({ terminalReply, resultText }) => {
      const entry = createRunEntry({ expectsCompletionMessage: true });
      const captureSubagentCompletionReply = vi.fn(async () => "stale transcript reply");
      const runSubagentAnnounceFlow = vi.fn(async () => "delivered" as const);
      const controller = createLifecycleController({
        entry,
        captureSubagentCompletionReply,
        runSubagentAnnounceFlow,
      });

      await completeAndJoinCleanup(controller, entry, {
        triggerCleanup: true,
        terminalReply,
      });

      expect(captureSubagentCompletionReply).not.toHaveBeenCalled();
      expect(readLifecycleRun(entry).completion).toMatchObject({ terminalReply, resultText });
      expect(runSubagentAnnounceFlow).toHaveBeenCalledWith(
        expect.objectContaining({ terminalReply }),
      );
    },
  );

  it("records explicit empty success as intentional non-delivery at the lifecycle owner", async () => {
    const entry = createRunEntry({ expectsCompletionMessage: true });
    const captureSubagentCompletionReply = vi.fn(async () => "stale transcript reply");
    const runSubagentAnnounceFlow = vi.fn(async () => "delivered" as const);
    const maybeWakeRequesterAfterAllChildrenSettled = vi.fn(async () => false);
    const controller = createLifecycleController({
      entry,
      captureSubagentCompletionReply,
      runSubagentAnnounceFlow,
      maybeWakeRequesterAfterAllChildrenSettled,
    });

    await completeRun(controller, entry, {
      triggerCleanup: true,
      terminalReply: { disposition: "empty" },
    });
    await waitForLifecycleState(() =>
      expect(readLifecycleRun(entry).cleanupCompletedAt).toBeTypeOf("number"),
    );

    expect(captureSubagentCompletionReply).not.toHaveBeenCalled();
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(maybeWakeRequesterAfterAllChildrenSettled).not.toHaveBeenCalled();
    expect(readLifecycleRun(entry).execution.outcome).toMatchObject({ status: "ok" });
    expect(readLifecycleRun(entry).completion).toMatchObject({
      terminalReply: { disposition: "empty" },
      resultText: null,
    });
    expect(readLifecycleRun(entry).requesterSettleWake).toBeUndefined();
    expect(readLifecycleRun(entry).delivery).toMatchObject({
      status: "not_required",
      disposition: "intentional_non_delivery",
    });
    expect(readLifecycleRun(entry).suppressCompletionDelivery).toBeUndefined();
    expect(resolveSubagentKillTargetState(readLifecycleRun(entry))).toMatchObject({
      state: "terminal",
      task: { status: "succeeded" },
    });
  });

  it("keeps message-tool-required missing output on the requester delivery path", async () => {
    const entry = createRunEntry({ expectsCompletionMessage: true });
    const receiptCommitted = createDeferredCore();
    const runSubagentAnnounceFlow: LifecycleControllerParams["runSubagentAnnounceFlow"] = vi.fn(
      async (announceParams) => {
        try {
          await announceParams.onDeliveryResult?.({
            delivered: false,
            path: "direct",
            reason: "message_tool_delivery_missing",
            error: "completion agent did not use the message tool",
          });
          receiptCommitted.resolve();
        } catch (error) {
          receiptCommitted.reject(error);
          throw error;
        }
        return "retryable" as const;
      },
    );
    const controller = createLifecycleController({ entry, runSubagentAnnounceFlow });

    await completeRun(controller, entry, {
      endedAt: Date.now(),
      triggerCleanup: true,
      terminalReply: { disposition: "empty", code: "message-tool-not-called" },
    });
    await receiptCommitted.promise;

    expect(runSubagentAnnounceFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalReply: { disposition: "empty", code: "message-tool-not-called" },
      }),
    );
    expect(readLifecycleRun(entry).suppressCompletionDelivery).toBeUndefined();
    expect(readLifecycleRun(entry).delivery).toMatchObject({
      disposition: "retryable",
      lastError: expect.stringContaining("message tool"),
    });
    expect(readLifecycleRun(entry).delivery?.status).not.toBe("not_required");
    expect(readLifecycleRun(entry).cleanupCompletedAt).toBeUndefined();
  });

  it.each([
    { label: "bound", hasOwner: true },
    { label: "unbound", hasOwner: false },
  ])("uses only the $label run owner for announce dispatch", async ({ hasOwner }) => {
    const entry = createRunEntry({ expectsCompletionMessage: true, runTimeoutSeconds: 600 });
    const liveContext = { marker: "live-context" };
    const resolveGatewayContext = () => liveContext;
    if (hasOwner) {
      bindGatewayContextResolver(entry, resolveGatewayContext as never);
    }
    const runSubagentAnnounceFlow = vi.fn(
      async (_announceParams: {
        resolveGatewayContext?: () => unknown;
        runTimeoutSeconds?: number;
      }) => "delivered" as AnnounceFlowOutcome,
    );
    const previous = subagentRuns.get(entry.runId);
    subagentRuns.set(entry.runId, entry);
    onTestFinished(() => {
      if (previous) {
        subagentRuns.set(entry.runId, previous);
      } else {
        subagentRuns.delete(entry.runId);
      }
    });
    const controller = createLifecycleController({
      entry,
      runs: subagentRuns,
      runSubagentAnnounceFlow,
    });

    await completeAndJoinCleanup(controller, entry, { triggerCleanup: true });

    const announceParams = runSubagentAnnounceFlow.mock.calls[0]?.[0];
    expect(announceParams?.resolveGatewayContext).toBe(
      hasOwner ? resolveGatewayContext : undefined,
    );
    expect(announceParams?.runTimeoutSeconds).toBe(600);
  });

  it("hands announce dispatch the durable requester agent id on a multi-agent roster", async () => {
    const cfg = { agents: { ownership: "explicit" as const, entries: { alpha: {}, beta: {} } } };
    const entry = createRunEntry({
      expectsCompletionMessage: true,
      requesterSessionKey: "main",
      requesterAgentId: "beta",
    });
    const runSubagentAnnounceFlow = vi.fn(
      async (_announceParams: { requesterAgentId?: string }) => "delivered" as AnnounceFlowOutcome,
    );
    const controller = createLifecycleController({
      entry,
      getRuntimeConfig: () => cfg,
      runSubagentAnnounceFlow,
    });

    await completeRun(controller, entry, { triggerCleanup: true });
    await waitForLifecycleState(() => expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce());

    expect(runSubagentAnnounceFlow.mock.calls[0]?.[0]?.requesterAgentId).toBe("beta");
  });

  it("merges late visible reply evidence into an already-terminal completion", async () => {
    const entry = createRunEntry({ expectsCompletionMessage: true });
    const captureSubagentCompletionReply = vi.fn(async () => "legacy fallback");
    const controller = createLifecycleController({ entry, captureSubagentCompletionReply });

    await completeRun(controller, entry, {
      terminalReply: { disposition: "empty" },
    });
    await completeRun(controller, entry, {
      endedAt: 4_001,
      terminalReply: { disposition: "visible", text: "late authoritative reply" },
    });

    expect(readLifecycleRun(entry).completion).toMatchObject({
      resultText: "late authoritative reply",
      terminalReply: { disposition: "visible", text: "late authoritative reply" },
    });
    expect(captureSubagentCompletionReply).not.toHaveBeenCalled();
  });

  registerDetachedCleanupAuthorityTest({ createRunEntry, createLifecycleController });

  it("publishes a recovered terminal session status exactly once", async () => {
    const entry = createRunEntry();
    const emitSubagentProgressEndedForRun = vi.fn(async () => {});
    const controller = createLifecycleController({ entry, emitSubagentProgressEndedForRun });
    const completion = makeInterruptedSubagentCompletion(entry);

    await controller.completeSubagentRun(completion);
    await controller.completeSubagentRun(completion);

    expect(lifecycleEventMocks.emitSessionLifecycleEvent).toHaveBeenCalledExactlyOnceWith({
      sessionKey: entry.childSessionKey,
      reason: "subagent-status",
      parentSessionKey: entry.requesterSessionKey,
      label: entry.label,
    });
    expect(emitSubagentProgressEndedForRun).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ runId: entry.runId, childSessionKey: entry.childSessionKey }),
    );
  });

  it("preserves an attributed restart error after the explicit run deadline", async () => {
    const entry = createRunEntry({ runTimeoutSeconds: 3 });
    const controller = createLifecycleController({ entry });

    await controller.completeSubagentRun(
      makeInterruptedSubagentCompletion(entry, {
        startedAt: 2_000,
        endedAt: 6_000,
        outcome: { status: "error", error: "gateway process exited without a clean stop" },
      }),
    );

    expect(entry).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_ERROR,
      terminalOwner: "interrupted-recovery",
      execution: {
        endedAt: 6_000,
        outcome: {
          status: "error",
          error: "gateway process exited without a clean stop",
          startedAt: 2_000,
          endedAt: 6_000,
        },
      },
    });
  });

  it("does not publish recovered terminal events for an ordinary completion", async () => {
    const outcome = {
      status: "error" as const,
      error: "restart interrupted run",
      startedAt: 2_000,
      endedAt: 4_000,
      elapsedMs: 2_000,
    };
    const entry = createRunEntry({
      endedReason: SUBAGENT_ENDED_REASON_ERROR,
      terminalOwner: "interrupted-recovery",
      execution: {
        status: "terminal",
        startedAt: 2_000,
        endedAt: 4_000,
        outcome,
      },
      completion: { required: false, resultText: null, capturedAt: 4_000 },
    });
    const emitSubagentProgressEndedForRun = vi.fn(async () => {});
    const controller = createLifecycleController({ entry, emitSubagentProgressEndedForRun });

    await completeRun(controller, entry, {
      outcome: { status: "error", error: "restart interrupted run" },
      reason: SUBAGENT_ENDED_REASON_ERROR,
    });

    expect(lifecycleEventMocks.emitSessionLifecycleEvent).not.toHaveBeenCalled();
    expect(emitSubagentProgressEndedForRun).not.toHaveBeenCalled();
  });

  it("retains a retired accepted receipt until terminal cleanup completes", async () => {
    const entry = createRunEntry({
      execution: {
        status: "running",
        startedAt: 2_000,
        restartRecovery: makeRestartRecoveryReceipt({
          lifecycleGeneration: "retired-generation",
        }),
      },
    });
    const beforeWrite = vi.fn();
    const controller = createLifecycleController({ entry, beforeWrite });

    await controller.completeSubagentRun(
      makeInterruptedSubagentCompletion(entry, {
        outcome: { status: "error", error: "exact recovery session was lost" },
        suppressSessionEffects: true,
      }),
    );

    expect(readLifecycleRun(entry)).toMatchObject({
      terminalOwner: "interrupted-recovery",
      execution: {
        status: "terminal",
        endedAt: 4_000,
        restartRecovery: expect.objectContaining({
          phase: "accepted",
          lifecycleGeneration: "retired-generation",
        }),
        suppressSessionEffects: true,
      },
    });
  });

  it("keeps retired recovery cleanup away from the newer child lifecycle", async () => {
    const entry = createRunEntry({
      cleanup: "delete",
      expectsCompletionMessage: false,
      execution: {
        status: "interrupted",
        startedAt: 2_000,
        restartRecovery: makeRestartRecoveryReceipt({
          lifecycleGeneration: "retired-generation",
        }),
      },
    });
    const runs = new Map([[entry.runId, entry]]);
    const emitSubagentEndedHookForRun = vi.fn(async () => {});
    const notifyContextEngineSubagentEnded = vi.fn(async () => {});
    let recovered: SubagentRunRecord | undefined;
    const controller = createLifecycleController({
      entry,
      runs,
      beforeWrite: ({ postimages }) => {
        const value = postimages.get(entry.runId);
        if (value) {
          recovered = value;
        }
      },
      emitSubagentEndedHookForRun,
      notifyContextEngineSubagentEnded,
      shouldEmitEndedHookForRun: () => true,
    });

    await controller.completeSubagentRun(
      makeInterruptedSubagentCompletion(entry, {
        outcome: { status: "error", error: "retired Gateway lifecycle" },
        triggerCleanup: true,
      }),
    );
    await waitForLifecycleState(() => expect(runs.has(entry.runId)).toBe(false));

    expect(
      browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
    ).not.toHaveBeenCalled();
    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).not.toHaveBeenCalled();
    expect(gatewayMocks.callGateway).not.toHaveBeenCalled();
    expect(lifecycleEventMocks.emitSessionLifecycleEvent).not.toHaveBeenCalled();
    expect(emitSubagentEndedHookForRun).not.toHaveBeenCalled();
    expect(notifyContextEngineSubagentEnded).not.toHaveBeenCalled();
    expect(recovered?.execution.suppressSessionEffects).toBe(true);
    if (!recovered) {
      throw new Error("expected committed recovery before retirement");
    }
    await completeRun(controller, entry, { endedAt: 4_001, triggerCleanup: true });
    expect(
      markSubagentRunPausedAfterYield({
        entry: structuredClone(recovered),
        endedAt: 4_002,
      }),
    ).toBe(false);
    expect(runs.has(entry.runId)).toBe(false);
    expect(
      browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
    ).not.toHaveBeenCalled();
    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).not.toHaveBeenCalled();
    expect(gatewayMocks.callGateway).not.toHaveBeenCalled();
    expect(lifecycleEventMocks.emitSessionLifecycleEvent).not.toHaveBeenCalled();
    expect(emitSubagentEndedHookForRun).not.toHaveBeenCalled();
    expect(notifyContextEngineSubagentEnded).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "reconciles a restored kill with current lifecycle authority=%s",
    async (owned) => {
      const error = owned ? "killed" : "legacy killed";
      const entry = createRunEntry({
        endedAt: 4_000,
        endedReason: SUBAGENT_ENDED_REASON_ERROR,
        outcome: { status: "error", error: "restart interrupted run" },
        terminalOwner: "interrupted-recovery",
        killIntent: {
          requestedAt: 4_001,
          reason: error,
          sessionId: "session-id",
          ...(owned ? { lifecycleGeneration: getAgentEventLifecycleGeneration() } : {}),
        },
        execution: {
          status: "terminal",
          startedAt: 2_000,
          endedAt: 4_000,
          outcome: { status: "error", error: "restart interrupted run" },
          restartRecovery: makeRestartRecoveryReceipt(),
        },
      });
      const controller = createLifecycleController({ entry });
      await controller.completeSubagentRun(
        makeKilledSubagentCompletion(entry, {
          endedAt: 4_001,
          outcome: { status: "error", error },
        }),
      );

      expect(readLifecycleRun(entry)).toMatchObject({
        endedReason: SUBAGENT_ENDED_REASON_KILLED,
        killIntent: undefined,
        killReconciliation: { killedAt: 4_001, taskCancellationAccepted: owned ? true : undefined },
        execution: {
          status: "terminal",
          endedAt: 4_001,
          restartRecovery: owned ? undefined : expect.objectContaining({ phase: "accepted" }),
          suppressSessionEffects: owned ? undefined : true,
        },
      });
    },
  );

  it("keeps a natural completion that predates the durable kill intent", async () => {
    const entry = createRunEntry({
      killIntent: {
        requestedAt: 5_000,
        reason: "killed",
        sessionId: "session-id",
      },
      execution: {
        status: "running",
        startedAt: 2_000,
      },
    });
    const controller = createLifecycleController({ entry });

    await completeRun(controller, entry);

    expect(readLifecycleRun(entry)).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      execution: {
        status: "terminal",
        endedAt: 4_000,
        outcome: { status: "ok" },
      },
    });
    expect(readLifecycleRun(entry).killIntent).toBeUndefined();
    expect(readLifecycleRun(entry).killReconciliation).toBeUndefined();
  });

  it("keeps task finalization, resource retirement, and announce cleanup root-admitted", async () => {
    const entry = createRunEntry({ expectsCompletionMessage: true });
    const browserCleanup = createDeferredCore();
    const announce = createDeferredCore<AnnounceFlowOutcome>();
    browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd.mockImplementationOnce(
      () => browserCleanup.promise,
    );
    const runSubagentAnnounceFlow = vi.fn(() => announce.promise);
    const controller = createLifecycleController({ entry, runSubagentAnnounceFlow });

    const completion = completeRun(controller, entry, {
      triggerCleanup: true,
      terminalReply: { disposition: "visible", text: "final completion reply" },
    });

    await waitForLifecycleState(() =>
      expect(
        browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
      ).toHaveBeenCalledOnce(),
    );
    expect(getActiveGatewayRootWorkCount()).toBe(1);

    browserCleanup.resolve();
    await waitForLifecycleState(() => expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce());
    await completion;
    expect(getActiveGatewayRootWorkCount()).toBe(1);

    announce.resolve("delivered");
    await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    expect(readLifecycleRun(entry).cleanupCompletedAt).toBeTypeOf("number");
  });

  it("settles an admitted subagent and its delivery behind a closed drain fence", async () => {
    const entry = createRunEntry({ expectsCompletionMessage: true });
    const announce = createDeferredCore<AnnounceFlowOutcome>();
    const runSubagentAnnounceFlow = vi.fn(() => announce.promise);
    const controller = createLifecycleController({ entry, runSubagentAnnounceFlow });
    const finishRun = createDeferredCore();
    const admittedRun = runWithGatewayIndependentRootWorkAdmission(async () => {
      await finishRun.promise;
      await completeRun(controller, entry, {
        triggerCleanup: true,
        terminalReply: { disposition: "visible", text: "final completion reply" },
      });
    });
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.drain()).toBe(true);

    try {
      expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
      finishRun.resolve();
      await waitForLifecycleState(() => expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce());
      await admittedRun;
      expect(readLifecycleRun(entry).execution.status).toBe("terminal");
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      expect(tryBeginGatewayRootWorkAdmission()).toBeNull();

      announce.resolve("delivered");
      await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      expect(readLifecycleRun(entry).cleanupCompletedAt).toBeTypeOf("number");
    } finally {
      announce.resolve("delivered");
      finishRun.resolve();
      suspension?.release();
      await admittedRun;
    }
  });

  registerDirectSessionCleanupAuthorityTests({
    createRunEntry,
    createLifecycleController,
    completeRun,
    gatewayMocks,
    helperMocks,
    completeAndJoinCleanup,
    sessionEntryReadMocks,
  });

  it("settles admitted cleanup and resource retirement during restart drain", async () => {
    const entry = createRunEntry({ expectsCompletionMessage: true });
    const browserStarted = createDeferredCore();
    const releaseBrowserCleanup = createDeferredCore();
    browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd.mockImplementationOnce(
      async () => {
        browserStarted.resolve();
        await releaseBrowserCleanup.promise;
      },
    );
    const runSubagentAnnounceFlow = vi.fn(async () => "delivered" as const);
    const controller = createLifecycleController({ entry, runSubagentAnnounceFlow });
    const completion = completeAndJoinCleanup(controller, entry, { triggerCleanup: true });
    try {
      await browserStarted.promise;
      markGatewayRestartDraining();
      expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
      releaseBrowserCleanup.resolve();
      await completion;
      expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce();
      expect(readLifecycleRun(entry).cleanupCompletedAt).toBeTypeOf("number");
      expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).toHaveBeenCalled();
      expect(controller.scheduledResumeTimers.size).toBe(0);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
    } finally {
      releaseBrowserCleanup.resolve();
      await completion;
      resetGatewayWorkAdmission();
    }
  });

  it.each([
    { phase: "backoff", related: false },
    { phase: "backoff", related: true },
    { phase: "exhaustion", related: false },
    { phase: "exhaustion", related: true },
  ])(
    "preserves cleanup $phase when another run settles (related=$related)",
    async ({ phase, related }) => {
      vi.useFakeTimers();
      const entry = createRunEntry({
        endedAt: Date.now() - 1_000,
        expectsCompletionMessage: false,
        retainAttachmentsOnKeep: false,
      });
      const runs = new Map([[entry.runId, entry]]);
      helperMocks.safeRemoveAttachmentsDir.mockRejectedValue(new Error("cleanup failed"));
      const controller = createLifecycleController({
        entry,
        runs,
        resumeSubagentRun: (runId) => {
          const current = runs.get(runId);
          if (current) {
            controller.startSubagentAnnounceCleanupFlow(current);
          }
        },
      });

      try {
        controller.startSubagentAnnounceCleanupFlow(entry);
        await waitForLifecycleState(() =>
          expect(readLifecycleRun(entry).cleanupHandled).toBe(false),
        );
        if (phase === "exhaustion") {
          for (let retry = 0; retry < 3; retry += 1) {
            await vi.runOnlyPendingTimersAsync();
          }
        }
        const attempts = phase === "exhaustion" ? 4 : 1;
        expect(helperMocks.safeRemoveAttachmentsDir).toHaveBeenCalledTimes(attempts);

        for (let index = 0; index < 3; index += 1) {
          const settled = createRunEntry({
            runId: `settled-${index}`,
            childSessionKey: `agent:main:subagent:settled-${index}`,
            requesterSessionKey: related ? entry.childSessionKey : "agent:other:main",
            endedAt: Date.now(),
            expectsCompletionMessage: false,
            retainAttachmentsOnKeep: true,
          });
          runs.set(settled.runId, settled);
          controller.startSubagentAnnounceCleanupFlow(settled);
          await waitForLifecycleState(() =>
            expect(readLifecycleRun(settled).cleanupCompletedAt).toBeTypeOf("number"),
          );
          await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
        }

        expect(helperMocks.safeRemoveAttachmentsDir).toHaveBeenCalledTimes(attempts);
        expect(readLifecycleRun(entry).cleanupHandled).toBe(false);
        expect(readLifecycleRun(entry).cleanupCompletedAt).toBeUndefined();
        if (phase === "backoff") {
          await vi.advanceTimersByTimeAsync(1_000);
          expect(helperMocks.safeRemoveAttachmentsDir).toHaveBeenCalledTimes(2);
        } else {
          expect(vi.getTimerCount()).toBe(0);
        }
      } finally {
        helperMocks.safeRemoveAttachmentsDir.mockReset().mockResolvedValue(undefined);
        controller.clearScheduledResumeTimers();
        vi.useRealTimers();
      }
    },
  );

  it("hands a failed cleanup retry to descendant settlement after a late empty final", async () => {
    vi.useFakeTimers();
    const entry = createRunEntry({
      endedAt: Date.now() - 1_000,
      expectsCompletionMessage: true,
      wakeOnDescendantSettle: true,
      outcome: { status: "ok" },
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      delivery: { status: "pending", deadlineAt: Date.now() - 1 },
      retainAttachmentsOnKeep: true,
    });
    const child = createRunEntry({
      runId: "pending-descendant",
      childSessionKey: "agent:main:subagent:pending-descendant",
      requesterSessionKey: entry.childSessionKey,
      endedAt: Date.now(),
      expectsCompletionMessage: false,
    });
    const runs = new Map([
      [entry.runId, entry],
      [child.runId, child],
    ]);
    let pendingDescendants = 1;
    completionDeliveryMocks.blockSubagentCompletionDelivery.mockRejectedValueOnce(
      new Error("completion suspension transaction failed"),
    );
    const controller = createLifecycleController({
      entry,
      runs,
      countPendingDescendantRuns: async () => pendingDescendants,
      runSubagentAnnounceFlow: vi.fn(async () => "retryable" as const),
      resumeSubagentRun: (runId) => {
        const current = runs.get(runId);
        if (current) {
          controller.startSubagentAnnounceCleanupFlow(current);
        }
      },
    });

    try {
      controller.startSubagentAnnounceCleanupFlow(entry);
      await waitForLifecycleState(() => expect(readLifecycleRun(entry).cleanupHandled).toBe(false));
      expect(completionDeliveryMocks.blockSubagentCompletionDelivery).toHaveBeenCalledOnce();
      await completeRun(controller, entry, {
        endedAt: Date.now(),
        outcome: { status: "ok" },
        terminalReply: { disposition: "empty" },
        triggerCleanup: false,
      });
      expect(readLifecycleRun(entry).suppressCompletionDelivery).toBe(true);
      expect(readLifecycleRun(entry).wakeOnDescendantSettle).toBe(true);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(readLifecycleRun(entry).cleanupCompletedAt).toBeUndefined();
      pendingDescendants = 0;
      await controller.completeCleanupBookkeeping({
        runId: child.runId,
        entry: child,
        cleanup: "keep",
        completedAt: Date.now(),
        preserveTranscript: true,
        skipRequesterSettleWake: true,
      });
      await waitForLifecycleState(() =>
        expect(readLifecycleRun(entry).cleanupCompletedAt).toBeTypeOf("number"),
      );
    } finally {
      controller.clearScheduledResumeTimers();
      vi.useRealTimers();
    }
  });

  registerRequesterSettleRetirementTests({
    createRunEntry,
    createLifecycleController,
    waitForLifecycleState,
    completeRun,
  });

  it("keeps a same-run replacement from hiding another session successor", () => {
    const entry = createRunEntry({
      runId: "fence-original",
      childSessionKey: "agent:main:subagent:fence-index",
      generation: 1,
    });
    const replacement = createRunEntry({ ...entry, generation: 3 });
    const successor = createRunEntry({ ...entry, runId: "fence-successor", generation: 2 });
    subagentRuns.set(replacement.runId, replacement);
    subagentRuns.set(successor.runId, successor);
    const controller = createLifecycleController({
      entry,
      runs: subagentRuns,
      getLatestRunForChildSession: getLatestLiveSubagentRunByChildSessionKey,
    });

    try {
      expect(controller.newerGenerationOwnsSession(entry)).toBe(true);
      subagentRuns.delete(successor.runId);
      expect(controller.newerGenerationOwnsSession(entry)).toBe(false);
      subagentRuns.set(successor.runId, { ...successor, generation: 0, createdAt: 0 });
      expect(controller.newerGenerationOwnsSession(entry)).toBe(false);
      entry.killReconciliation = { killedAt: 1, supersededAt: 2 };
      expect(controller.newerGenerationOwnsSession(entry)).toBe(true);
    } finally {
      subagentRuns.delete(replacement.runId);
      subagentRuns.delete(successor.runId);
    }
  });

  it.each([false, true])(
    "resumes only current ancestors after retirement (cycle=%s)",
    async (cycle) => {
      const ancestor = createRunEntry({
        runId: "ancestor-current",
        childSessionKey: "agent:main:subagent:ancestor",
        requesterSessionKey: cycle ? "agent:main:subagent:parent" : "agent:main:main",
        generation: 2,
        endedAt: Date.now(),
        expectsCompletionMessage: true,
        pauseReason: "sessions_yield",
        wakeOnDescendantSettle: true,
      });
      const previous = createRunEntry({ ...ancestor, runId: "ancestor-previous", generation: 1 });
      const parent = createRunEntry({
        runId: "parent",
        childSessionKey: "agent:main:subagent:parent",
        requesterSessionKey: ancestor.childSessionKey,
        endedAt: Date.now(),
        cleanupCompletedAt: Date.now(),
      });
      const settled = createRunEntry({
        runId: "settled",
        requesterSessionKey: parent.childSessionKey,
        endedAt: Date.now(),
      });
      const unrelated = createRunEntry({
        runId: "unrelated",
        childSessionKey: "agent:main:subagent:unrelated",
        endedAt: Date.now(),
      });
      const runs = new Map(
        [ancestor, previous, parent, settled, unrelated].map((entry) => [entry.runId, entry]),
      );
      const resumeSubagentRun = vi.fn();
      const controller = createLifecycleController({ entry: settled, runs, resumeSubagentRun });

      await controller.completeCleanupBookkeeping({
        runId: settled.runId,
        entry: settled,
        cleanup: "delete",
        completedAt: Date.now(),
        preserveTranscript: true,
        skipRequesterSettleWake: true,
      });

      expect(runs.has(settled.runId)).toBe(false);
      expect(resumeSubagentRun).toHaveBeenCalledExactlyOnceWith(ancestor.runId);
    },
  );

  it("drops a failed-cleanup retry after a newer cleanup generation starts", async () => {
    vi.useFakeTimers();
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: false,
      retainAttachmentsOnKeep: false,
    });
    let releaseNewCleanup: (() => void) | undefined;
    helperMocks.safeRemoveAttachmentsDir
      .mockRejectedValueOnce(new Error("cleanup failed"))
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseNewCleanup = resolve;
          }),
      );
    const resumeSubagentRun = vi.fn();
    const controller = createLifecycleController({ entry, resumeSubagentRun });

    try {
      expect(controller.startSubagentAnnounceCleanupFlow(entry)).toBe(true);
      await waitForLifecycleState(() => expect(readLifecycleRun(entry).cleanupHandled).toBe(false));
      expect(vi.getTimerCount()).toBe(1);

      expect(controller.startSubagentAnnounceCleanupFlow(entry)).toBe(true);
      await waitForLifecycleState(() => expect(releaseNewCleanup).toBeTypeOf("function"));
      await vi.advanceTimersByTimeAsync(1_000);

      expect(resumeSubagentRun).not.toHaveBeenCalled();
      releaseNewCleanup?.();
      await waitForLifecycleState(() =>
        expect(readLifecycleRun(entry).cleanupCompletedAt).toBeTypeOf("number"),
      );
    } finally {
      releaseNewCleanup?.();
      controller.clearScheduledResumeTimers();
      vi.useRealTimers();
    }
  });

  registerDeliveryRetryOwnerTests({
    createRunEntry,
    createLifecycleController,
    helperMocks,
    waitForLifecycleState,
  });

  registerTerminalStateSignalAuthorityTests({
    createRunEntry,
    createLifecycleController,
    completeRun,
    helperMocks,
    lifecycleEventMocks,
  });

  it.each(["ordinary", "interrupted"] as const)(
    "restores the registry state when %s completion persistence fails",
    async (source) => {
      const entry = createRunEntry();
      const original = structuredClone(entry);
      const controller = createLifecycleController({
        entry,
        beforeWrite: () => {
          throw new Error("registry store boom");
        },
      });

      await expect(
        controller.completeSubagentRun(
          source === "interrupted"
            ? makeInterruptedSubagentCompletion(entry)
            : makeSubagentCompletion(entry),
        ),
      ).rejects.toThrow("registry store boom");
      expect(readLifecycleRun(entry)).toEqual(original);
    },
  );

  it.each(["interrupted", "killed"] as const)(
    "keeps provider success canonical while a %s callback waits behind capture",
    async (source) => {
      const { entry, controller, captured, captureSubagentCompletionReply } = createCaptureFixture(
        createRunEntry({ expectsCompletionMessage: source === "killed" ? false : undefined }),
      );
      const success = completeRun(controller, entry);
      await waitForLifecycleState(() =>
        expect(captureSubagentCompletionReply).toHaveBeenCalledOnce(),
      );
      const competing = controller.completeSubagentRun(
        source === "interrupted"
          ? makeInterruptedSubagentCompletion(entry, { endedAt: 4_001 })
          : makeKilledSubagentCompletion(entry, { endedAt: 4_001 }),
      );
      const reply = source === "interrupted" ? "provider result" : "Canonical final reply.";
      captured.resolve(reply);
      await Promise.all([success, competing]);

      expect(readLifecycleRun(entry)).toMatchObject({
        endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
        execution: { endedAt: 4_000, outcome: { status: "ok" } },
        completion: { resultText: reply },
      });
      expect(readLifecycleRun(entry).terminalOwner).toBeUndefined();
    },
  );

  it("persists interrupted recovery before task projection and rejects late provider or yield", async () => {
    const entry = createRunEntry();
    const beforeWrite = vi.fn();
    const controller = createLifecycleController({ entry, beforeWrite });
    await controller.completeSubagentRun(makeInterruptedSubagentCompletion(entry));
    const recovered = structuredClone(readLifecycleRun(entry));

    await completeRun(controller, entry, { endedAt: 4_001 });

    expect(
      markSubagentRunPausedAfterYield({
        entry: structuredClone(readLifecycleRun(entry)),
        endedAt: 4_002,
      }),
    ).toBe(false);
    expect(readLifecycleRun(entry)).toEqual(recovered);
    expect(readLifecycleRun(entry)).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_ERROR,
      terminalOwner: "interrupted-recovery",
      execution: {
        endedAt: 4_000,
        outcome: { status: "error", error: "restart interrupted run" },
      },
      completion: { resultText: null, capturedAt: 4_000 },
    });
    expect(beforeWrite).toHaveBeenCalledOnce();
  });

  it.each([
    ["provisional", { killReconciliation: { killedAt: 4_000 } }],
    ["stable", {}],
  ])("keeps %s killed state unchanged during interrupted recovery", async (_name, extra) => {
    const entry = createRunEntry({
      endedAt: 4_000,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: { status: "error", error: "agent run aborted" },
      suppressAnnounceReason: "killed",
      ...extra,
    });
    const original = structuredClone(entry);
    const beforeWrite = vi.fn();
    await createLifecycleController({ entry, beforeWrite }).completeSubagentRun(
      makeInterruptedSubagentCompletion(entry, {
        endedAt: 4_001,
      }),
    );

    expect(readLifecycleRun(entry)).toEqual(original);
    expect(beforeWrite).not.toHaveBeenCalled();
  });

  it("does not overwrite partial terminal evidence during interrupted recovery", async () => {
    const terminalEvidence: RunEntryOverrides[] = [
      { execution: { status: "terminal", endedAt: 4_000 } },
      {
        execution: {
          status: "terminal",
          outcome: { status: "error", error: "existing failure" },
        },
      },
      { endedReason: SUBAGENT_ENDED_REASON_ERROR },
      {
        execution: {
          status: "terminal",
          endedAt: 4_000,
          outcome: { status: "error", error: "existing failure" },
        },
        endedReason: SUBAGENT_ENDED_REASON_ERROR,
      },
    ];
    for (const evidence of terminalEvidence) {
      const entry = createRunEntry(evidence);
      const original = structuredClone(entry);
      const beforeWrite = vi.fn();
      await createLifecycleController({ entry, beforeWrite }).completeSubagentRun(
        makeInterruptedSubagentCompletion(entry, {
          endedAt: 4_001,
        }),
      );

      expect(readLifecycleRun(entry)).toEqual(original);
      expect(beforeWrite).not.toHaveBeenCalled();
    }
  });

  it("drains exact interrupted terminal evidence after restart admission reopens", async () => {
    const interruptedOutcome = {
      status: "error" as const,
      error: "restart interrupted run",
      startedAt: 2_000,
      endedAt: 4_000,
      elapsedMs: 2_000,
    };
    const entry = createRunEntry({
      endedReason: SUBAGENT_ENDED_REASON_ERROR,
      execution: {
        status: "terminal",
        startedAt: 2_000,
        endedAt: 4_000,
        outcome: interruptedOutcome,
      },
    });
    const beforeWrite = vi.fn();
    await createLifecycleController({ entry, beforeWrite }).completeSubagentRun(
      makeInterruptedSubagentCompletion(entry),
    );

    expect(readLifecycleRun(entry)).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_ERROR,
      terminalOwner: "interrupted-recovery",
      execution: {
        status: "terminal",
        endedAt: 4_000,
        outcome: { status: "error", error: "restart interrupted run" },
      },
    });
  });

  it.each([undefined, "steer-restart"] as const)(
    "records a killed lifecycle (suppression=%s)",
    async (suppressAnnounceReason) => {
      const entry = createRunEntry({ suppressAnnounceReason });
      const controller = createLifecycleController({ entry });
      await controller.completeSubagentRun(makeKilledSubagentCompletion(entry));
      expect(readLifecycleRun(entry)).toMatchObject({
        endedReason: SUBAGENT_ENDED_REASON_KILLED,
        execution: { endedAt: 4_000 },
      });
      if (!suppressAnnounceReason) {
        expect(resolveSubagentKillTargetState(readLifecycleRun(entry))).toMatchObject({
          state: "terminal",
          task: { status: "cancelled", error: SUBAGENT_KILL_TASK_ERROR },
        });
      }
    },
  );

  it.each([undefined, "steer-restart"] as const)(
    "normalizes an overdue abort without a kill tombstone (suppression=%s)",
    async (suppressAnnounceReason) => {
      const entry = createRunEntry({ runTimeoutSeconds: 3, suppressAnnounceReason });
      const text = suppressAnnounceReason
        ? "final completion reply"
        : "Partial result before timeout.";
      const captureSubagentCompletionReply = vi.fn(async () => text);
      const controller = createLifecycleController({ entry, captureSubagentCompletionReply });
      await controller.completeSubagentRun(
        makeKilledSubagentCompletion(entry, {
          startedAt: 2_000,
          endedAt: 6_000,
        }),
      );

      const outcome = { status: "timeout", startedAt: 2_000, endedAt: 5_000, elapsedMs: 3_000 };
      expect(readLifecycleRun(entry)).toMatchObject({
        endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
        execution: { endedAt: 5_000, outcome },
        completion: { resultText: text },
        suppressAnnounceReason,
      });
      expect(readLifecycleRun(entry).killReconciliation).toBeUndefined();
      expect(captureSubagentCompletionReply).toHaveBeenCalledWith(
        entry.childSessionKey,
        expect.objectContaining({ outcome }),
      );
    },
  );

  it("reprepares a captured result when admission changes its effective terminal outcome", async () => {
    const entry = createRunEntry({ expectsCompletionMessage: false });
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const captureSubagentCompletionReply = vi
      .fn(async () => "Partial result at deadline.")
      .mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return "Earlier unbounded result.";
      });
    const controller = createLifecycleController({ entry, captureSubagentCompletionReply });
    const warn = vi.fn();
    const runtime = createSubagentRegistryCompletionRuntime({
      runs: controller.options.runs,
      resumed: new Set(),
      retryTimers: new Set(),
      completeSubagentRun: controller.completeSubagentRun,
      scheduleSweep: vi.fn(),
      resumeRun: vi.fn(),
      warn,
    });
    const completion = runtime.completeSubagentRunWithRecovery(
      makeSubagentCompletion(entry, { endedAt: 6_000 }),
      "capture-fixture",
    );
    const settled = Promise.allSettled([completion]);
    try {
      await entered.promise;
      await mutateLifecycleRun(entry, (draft) => {
        draft.runTimeoutSeconds = 3;
      });
      release.resolve();
      await completion;
      expect(captureSubagentCompletionReply).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledOnce();
      expect(readLifecycleRun(entry)).toMatchObject({
        execution: { status: "terminal", endedAt: 5_000, outcome: { status: "timeout" } },
        completion: { resultText: "Partial result at deadline." },
      });
    } finally {
      release.resolve();
      await settled;
    }
  });

  it("defers provisional killed publication when completion delivery is required", async () => {
    const entry = createRunEntry({ expectsCompletionMessage: true });
    const emitSubagentEndedHookForRun = vi.fn(async () => {});
    const runSubagentAnnounceFlow = vi.fn(async () => "delivered" as const);
    const controller = createLifecycleController({
      entry,
      shouldEmitEndedHookForRun: () => true,
      emitSubagentEndedHookForRun,
      runSubagentAnnounceFlow,
    });

    await controller.completeSubagentRun(
      makeKilledSubagentCompletion(entry, {
        triggerCleanup: true,
      }),
    );

    expect(readLifecycleRun(entry)).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      suppressAnnounceReason: "killed",
    });
    expect(emitSubagentEndedHookForRun).not.toHaveBeenCalled();
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(resolveSubagentKillTargetState(readLifecycleRun(entry))).toMatchObject({
      state: "terminal",
      task: { error: SUBAGENT_KILL_TASK_ERROR },
    });
  });

  it.each([
    { status: "ok", text: "Fixed the crash and verified the regression tests pass." },
    { status: "timeout", text: "Partial result before timeout." },
  ] as const)(
    "captures the canonical $status reply after a provisional kill",
    async ({ status, text }) => {
      const entry = createRunEntry({
        expectsCompletionMessage: true,
        suppressAnnounceReason: "killed",
      });
      const captureSubagentCompletionReply = vi.fn(async () => text);
      const controller = createLifecycleController({ entry, captureSubagentCompletionReply });
      await controller.completeSubagentRun(makeKilledSubagentCompletion(entry));
      expect(readLifecycleRun(entry).completion).toMatchObject({ resultText: null });

      await completeRun(controller, entry, {
        endedAt: 4_001,
        outcome: { status },
        terminalReply: status === "ok" ? { disposition: "visible", text } : undefined,
      });

      expect(captureSubagentCompletionReply).toHaveBeenCalledTimes(status === "ok" ? 0 : 1);
      expect(readLifecycleRun(entry).completion?.resultText).toBe(text);
    },
  );

  it("preserves a captured reply when success supersedes a delayed killed lifecycle", async () => {
    const entry = makeProvisionalKilledRunEntry({
      archiveAtMs: 5_000,
      expectsCompletionMessage: true,
      completion: {
        required: true,
        resultText: "Already captured final reply.",
        capturedAt: 4_000,
        terminalReply: { disposition: "visible", text: "Already captured final reply." },
      },
    });
    const captureSubagentCompletionReply = vi.fn(async () => undefined);
    const controller = createLifecycleController({
      entry,
      captureSubagentCompletionReply,
    });

    await completeRun(controller, entry, { endedAt: 4_001 });

    expect(captureSubagentCompletionReply).not.toHaveBeenCalled();
    expect(readLifecycleRun(entry).completion).toMatchObject({
      resultText: "Already captured final reply.",
      capturedAt: 4_000,
    });
    expect(readLifecycleRun(entry).archiveAtMs).toBe(5_000);
  });

  it("skips frozen-result refill for a sessions_yield-paused run", async () => {
    const entry = createRunEntry({
      expectsCompletionMessage: true,
      endedAt: 4_000,
      pauseReason: "sessions_yield",
    });
    const captureSubagentCompletionReply = vi.fn(async () => "text from the next turn");
    const controller = createLifecycleController({ entry, captureSubagentCompletionReply });

    expect(await controller.refreshFrozenResultFromSession(entry.childSessionKey)).toBe(false);

    // The yield cleared this row's result on purpose. Whatever the session holds
    // now belongs to the turn that runs next, so refreezing it would announce a
    // stranger's output as the paused run's completion.
    expect(captureSubagentCompletionReply).not.toHaveBeenCalled();
    expect(readLifecycleRun(entry).completion?.resultText).toBeUndefined();
  });

  it("refreshes only the newest pending completion generation for a shared session", async () => {
    const childSessionKey = "agent:main:subagent:shared-refresh";
    const older = createRunEntry({
      runId: "run-shared-refresh-old",
      childSessionKey,
      generation: 1,
      createdAt: 1_000,
      expectsCompletionMessage: true,
      endedAt: 4_000,
      outcome: { status: "ok" },
      completion: {
        required: true,
        resultText: "older generation result",
        capturedAt: 4_000,
      },
    });
    const newer = createRunEntry({
      runId: "run-shared-refresh-new",
      childSessionKey,
      generation: 2,
      createdAt: 2_000,
      expectsCompletionMessage: true,
      endedAt: 5_000,
      outcome: { status: "ok" },
      completion: {
        required: true,
        resultText: "newer generation placeholder",
        capturedAt: 5_000,
      },
    });
    const olderBefore = structuredClone(older);
    const persist = vi.fn();
    const controller = createLifecycleController({
      entry: newer,
      runs: new Map([
        [older.runId, older],
        [newer.runId, newer],
      ]),
      beforeWrite: persist,
      captureSubagentCompletionReply: vi.fn(async () => "latest session reply"),
    });

    expect(await controller.refreshFrozenResultFromSession(childSessionKey)).toBe(true);

    expect(readLifecycleRun(older)).toEqual(olderBefore);
    expect(readLifecycleRun(newer).completion).toMatchObject({
      resultText: "latest session reply",
      capturedAt: expect.any(Number),
    });
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ runIds: [newer.runId] }));
  });

  it("rejects a frozen-result refresh when a newer generation registers during capture", async () => {
    const childSessionKey = "agent:main:subagent:refresh-race";
    const entry = createRunEntry({
      runId: "run-refresh-race-old",
      childSessionKey,
      generation: 1,
      expectsCompletionMessage: true,
      endedAt: 4_000,
      outcome: { status: "ok" },
    });
    const runs = new Map([[entry.runId, entry]]);
    const captured = createDeferredCore<string>();
    const captureSubagentCompletionReply = vi.fn(() => captured.promise);
    const persist = vi.fn();
    const controller = createLifecycleController({
      entry,
      runs,
      beforeWrite: persist,
      captureSubagentCompletionReply,
    });

    const refresh = controller.refreshFrozenResultFromSession(childSessionKey);
    await waitForLifecycleState(() =>
      expect(captureSubagentCompletionReply).toHaveBeenCalledOnce(),
    );
    const successor = createRunEntry({
      runId: "run-refresh-race-new",
      childSessionKey,
      generation: 2,
      createdAt: 2_000,
    });
    runs.set(successor.runId, successor);
    captured.resolve("reply owned by the successor");

    expect(await refresh).toBe(false);
    expect(readLifecycleRun(entry).completion?.resultText).toBeUndefined();
    expect(successor.completion?.resultText).toBeUndefined();
    expect(persist).not.toHaveBeenCalled();
  });

  it.each(["error", "reply", "snapshot"] as const)(
    "preserves an admitted yield before a late %s completion is planned",
    async (source) => {
      const entry = createRunEntry({ expectsCompletionMessage: false });
      const beforeWrite = vi.fn();
      const controller = createLifecycleController({ entry, beforeWrite });
      const release = await controller.acquireTerminalCompletionLock(entry.runId);
      const entered = createDeferredCore();
      const acquire = controller.acquireTerminalCompletionLock.bind(controller);
      const held = vi
        .spyOn(controller, "acquireTerminalCompletionLock")
        .mockImplementation((runId) => {
          entered.resolve();
          return acquire(runId);
        });
      const completion = completeRun(controller, entry, {
        triggerCleanup: true,
        ...(source === "error"
          ? {
              outcome: { status: "error", error: "late provider error" },
              reason: SUBAGENT_ENDED_REASON_ERROR,
            }
          : source === "reply"
            ? { terminalReply: { disposition: "visible", text: "late reply" } }
            : { completionSnapshot: { resultText: "late snapshot", capturedAt: 4_000 } }),
      });
      const settled = Promise.allSettled([completion]);
      try {
        await entered.promise;
        await mutateLifecycleRun(entry, (draft) => {
          expect(markSubagentRunPausedAfterYield({ entry: draft, endedAt: 4_001 })).toBe(true);
        });
        const yielded = structuredClone(readLifecycleRun(entry));
        beforeWrite.mockClear();
        release();
        await completion;
        expect(readLifecycleRun(entry)).toEqual(yielded);
        expect(beforeWrite).not.toHaveBeenCalled();
        expect(helperMocks.persistSubagentSessionTiming).not.toHaveBeenCalled();
        expect(
          browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
        ).not.toHaveBeenCalled();
      } finally {
        release();
        held.mockRestore();
        await settled;
      }
    },
  );

  it.for(["keep", "delete"] as const)(
    "invalidates in-flight %s cleanup when an authoritative yield revives the run",
    async (cleanup, { signal }) => {
      const entry = createRunEntry({
        cleanup,
        expectsCompletionMessage: true,
      });
      const runs = new Map([[entry.runId, entry]]);
      const announceEntered = createDeferredCore();
      const finishAnnounce = createDeferredCore<AnnounceFlowOutcome>();
      const runSubagentAnnounceFlow = vi.fn(() => {
        announceEntered.resolve();
        return finishAnnounce.promise;
      });
      const controller = createLifecycleController({
        entry,
        runs,
        runSubagentAnnounceFlow,
        captureSubagentCompletionReply: vi.fn(async () => "premature terminal reply"),
      });

      const joinCleanup = observeRootWork();
      try {
        await completeRun(controller, entry, { triggerCleanup: true });
        await withinTest(announceEntered.promise, signal);
        expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce();
        expect(readLifecycleRun(entry).cleanupHandled).toBe(true);

        await mutateLifecycleRun(entry, (draft) => {
          expect(
            markSubagentRunPausedAfterYield({ entry: draft, startedAt: 2_000, endedAt: 4_001 }),
          ).toBe(true);
        });
      } finally {
        finishAnnounce.resolve("delivered");
        await joinCleanup();
      }

      expect(readLifecycleRun(entry).pauseReason).toBe("sessions_yield");
      expect(runs.has(entry.runId)).toBe(true);
      expect(readLifecycleRun(entry).cleanupHandled).toBe(false);
      expect(readLifecycleRun(entry).cleanupCompletedAt).toBeUndefined();
      expect(helperMocks.safeRemoveAttachmentsDir).not.toHaveBeenCalled();
      expect(gatewayMocks.callGateway).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: "sessions.delete" }),
      );
    },
  );

  it("rejects a yield after direct delete cleanup has been dispatched", async () => {
    const entry = createRunEntry({ cleanup: "delete", expectsCompletionMessage: false });
    const runs = new Map([[entry.runId, entry]]);
    let releaseDelete: (() => void) | undefined;
    gatewayMocks.callGateway.mockImplementation((opts) => {
      if (opts.method !== "sessions.delete") {
        return Promise.resolve({});
      }
      return new Promise<Record<string, unknown>>((resolve) => {
        releaseDelete = () => resolve({});
      });
    });
    const controller = createLifecycleController({ entry, runs });

    await completeRun(controller, entry, { triggerCleanup: true });
    await waitForLifecycleState(() =>
      expect(readLifecycleRun(entry).deleteCleanupDispatchedAt).toBeTypeOf("number"),
    );

    expect(
      markSubagentRunPausedAfterYield({
        entry: structuredClone(readLifecycleRun(entry)),
        endedAt: 4_001,
      }),
    ).toBe(false);
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    expect(readLifecycleRun(entry).pauseReason).toBeUndefined();
    expect(readLifecycleRun(entry).endedReason).toBe(SUBAGENT_ENDED_REASON_COMPLETE);

    releaseDelete?.();
    await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    expect(runs.has(entry.runId)).toBe(false);
  });

  it("rejects a yield after announce cleanup hands off delete dispatch", async () => {
    const entry = createRunEntry({ cleanup: "delete", expectsCompletionMessage: true });
    const runs = new Map([[entry.runId, entry]]);
    const announceRelease = createDeferredCore<AnnounceFlowOutcome>();
    const deleteHandoff = createDeferredCore<boolean | undefined>();
    const runSubagentAnnounceFlow: LifecycleControllerParams["runSubagentAnnounceFlow"] = vi.fn(
      async (announceParams) => {
        try {
          deleteHandoff.resolve(await announceParams.onBeforeDeleteChildSession?.());
        } catch (error) {
          deleteHandoff.reject(error);
          throw error;
        }
        return await announceRelease.promise;
      },
    );
    const controller = createLifecycleController({ entry, runs, runSubagentAnnounceFlow });

    const join = observeRootWork();
    try {
      await completeRun(controller, entry, {
        triggerCleanup: true,
        terminalReply: { disposition: "visible", text: "final completion reply" },
      });
      expect(await deleteHandoff.promise).toBe(true);
      expect(readLifecycleRun(entry).deleteCleanupDispatchedAt).toBeTypeOf("number");

      expect(
        markSubagentRunPausedAfterYield({
          entry: structuredClone(readLifecycleRun(entry)),
          endedAt: 4_001,
        }),
      ).toBe(false);
      expect(readLifecycleRun(entry).pauseReason).toBeUndefined();
      expect(readLifecycleRun(entry).endedReason).toBe(SUBAGENT_ENDED_REASON_COMPLETE);
    } finally {
      announceRelease.resolve("delivered");
      await join();
    }
    expect(runs.has(entry.runId)).toBe(false);
  });

  it.each([
    { name: "pending", beforeDelete: undefined, persisted: { status: "pending" as const } },
    {
      name: "queued",
      beforeDelete: {
        status: "in_progress" as const,
        disposition: "session_queued" as const,
        queueId: "queue-1",
      },
      persisted: {
        status: "in_progress" as const,
        disposition: "session_queued" as const,
        queueId: "queue-1",
      },
    },
  ])(
    "persists a required completion before delete cleanup for $name delivery",
    async ({ beforeDelete, persisted }) => {
      const entry = createRunEntry({ cleanup: "delete", expectsCompletionMessage: true });
      const runs = new Map([[entry.runId, entry]]);
      const persistedSnapshots: SubagentRunRecord[] = [];
      const announceRelease = createDeferredCore<AnnounceFlowOutcome>();
      const deleteHandoff = createDeferredCore<boolean | undefined>();
      const runSubagentAnnounceFlow: LifecycleControllerParams["runSubagentAnnounceFlow"] = vi.fn(
        async (announceParams) => {
          if (beforeDelete) {
            await mutateLifecycleRun(entry, (draft) => {
              draft.delivery = { ...draft.delivery, ...beforeDelete };
            });
          }
          try {
            deleteHandoff.resolve(await announceParams.onBeforeDeleteChildSession?.());
          } catch (error) {
            deleteHandoff.reject(error);
            throw error;
          }
          return await announceRelease.promise;
        },
      );
      const controller = createLifecycleController({
        entry,
        runs,
        beforeWrite: vi.fn(({ postimages }) => {
          const postimage = postimages.get(entry.runId);
          if (postimage) {
            persistedSnapshots.push(structuredClone(postimage));
          }
        }),
        runSubagentAnnounceFlow,
      });

      const join = observeRootWork();
      try {
        await completeRun(controller, entry, {
          triggerCleanup: true,
          terminalReply: { disposition: "visible", text: "final completion reply" },
        });
        expect(await deleteHandoff.promise).toBe(true);
        expect(readLifecycleRun(entry).deleteCleanupDispatchedAt).toBeTypeOf("number");

        const deleteSnapshot = persistedSnapshots.find(
          (snapshot) => snapshot.deleteCleanupDispatchedAt !== undefined,
        );
        expect(deleteSnapshot).toMatchObject({
          completion: {
            required: true,
            resultText: "final completion reply",
          },
          delivery: {
            ...persisted,
            payload: {
              requesterSessionKey: "agent:main:main",
              childSessionKey: "agent:main:subagent:child",
              task: "finish the task",
              outcome: { status: "ok" },
              terminalReply: { disposition: "visible", text: "final completion reply" },
            },
          },
        });
        expect(deleteSnapshot?.delivery?.attemptCount).toBeUndefined();
        expect(deleteSnapshot?.delivery?.lastAttemptAt).toBeUndefined();
      } finally {
        announceRelease.resolve("delivered");
        await join();
      }
      expect(runs.has(entry.runId)).toBe(false);
    },
  );

  it("does not hand off delete cleanup when the replay payload cannot be persisted", async () => {
    const entry = createRunEntry({ cleanup: "delete", expectsCompletionMessage: true });
    const runs = new Map([[entry.runId, entry]]);
    const beforeWrite = vi.fn();
    const attemptDelete = createDeferredCore();
    const deleteResult = createDeferredCore<boolean | undefined>();
    let releaseAnnounce: ((outcome: AnnounceFlowOutcome) => void) | undefined;
    const runSubagentAnnounceFlow: LifecycleControllerParams["runSubagentAnnounceFlow"] = vi.fn(
      async (announceParams) => {
        const outcome = new Promise<AnnounceFlowOutcome>((resolve) => {
          releaseAnnounce = resolve;
        });
        await attemptDelete.promise;
        try {
          deleteResult.resolve(await announceParams.onBeforeDeleteChildSession?.());
        } catch (error) {
          deleteResult.reject(error);
        }
        return outcome;
      },
    );
    const controller = createLifecycleController({
      entry,
      runs,
      beforeWrite,
      runSubagentAnnounceFlow,
    });

    await completeRun(controller, entry, {
      triggerCleanup: true,
      terminalReply: { disposition: "visible", text: "final completion reply" },
    });
    await waitForLifecycleState(() => expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce());
    beforeWrite.mockImplementationOnce(() => {
      throw new Error("registry store boom");
    });

    const rejectedWrite = expect(deleteResult.promise).rejects.toMatchObject({
      outcome: "not-committed",
      cause: { message: "registry store boom" },
    });
    attemptDelete.resolve();
    await rejectedWrite;
    expect(readLifecycleRun(entry).deleteCleanupDispatchedAt).toBeUndefined();
    expect(readLifecycleRun(entry).delivery?.payload).toBeUndefined();

    releaseAnnounce?.("delivered");
    await waitForLifecycleState(() => expect(runs.has(entry.runId)).toBe(false));
  });

  it("discards completion capture when an authoritative yield arrives during the await", async () => {
    const { entry, controller, captured, captureSubagentCompletionReply } = createCaptureFixture(
      createRunEntry({ expectsCompletionMessage: false }),
    );

    const completion = completeRun(controller, entry, { triggerCleanup: true });
    await waitForLifecycleState(() =>
      expect(captureSubagentCompletionReply).toHaveBeenCalledOnce(),
    );
    await mutateLifecycleRun(entry, (draft) => {
      expect(markSubagentRunPausedAfterYield({ entry: draft, endedAt: 4_001 })).toBe(true);
    });
    captured.resolve("stale pre-yield reply");
    await completion;

    expect(readLifecycleRun(entry)).toMatchObject({
      pauseReason: "sessions_yield",
      completion: { required: false },
    });
    expect(readLifecycleRun(entry).completion?.resultText).toBeUndefined();
    expect(readLifecycleRun(entry).completion?.capturedAt).toBeUndefined();
  });

  it("abandons a killed callback tail after success becomes canonical", async () => {
    const entry = createRunEntry({ expectsCompletionMessage: true });
    let releaseKilledTiming: (() => void) | undefined;
    helperMocks.persistSubagentSessionTiming
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseKilledTiming = resolve;
          }),
      )
      .mockResolvedValueOnce(undefined);
    const runSubagentAnnounceFlow = vi.fn<LifecycleControllerParams["runSubagentAnnounceFlow"]>(
      async () => "delivered",
    );
    const controller = createLifecycleController({
      entry,
      runSubagentAnnounceFlow,
      captureSubagentCompletionReply: vi.fn(async () => "Canonical success."),
    });

    const killed = controller.completeSubagentRun(
      makeKilledSubagentCompletion(entry, {
        triggerCleanup: true,
      }),
    );
    await waitForLifecycleState(() =>
      expect(helperMocks.persistSubagentSessionTiming).toHaveBeenCalledOnce(),
    );
    const success = completeRun(controller, entry, {
      endedAt: 4_001,
      triggerCleanup: true,
      terminalReply: { disposition: "visible", text: "Canonical success." },
    });
    await waitForLifecycleState(() =>
      expect(helperMocks.persistSubagentSessionTiming).toHaveBeenCalledTimes(2),
    );
    releaseKilledTiming?.();
    await Promise.all([killed, success]);

    expect(readLifecycleRun(entry)).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      execution: { outcome: { status: "ok" } },
      completion: { resultText: "Canonical success." },
    });
    expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce();
    expect(runSubagentAnnounceFlow.mock.calls[0]?.[0]).toMatchObject({
      outcome: { status: "ok" },
      roundOneReply: "Canonical success.",
    });
  });

  it("keeps requester stop delivery suppressed when provider completion wins", async () => {
    const entry = makeProvisionalKilledRunEntry({
      expectsCompletionMessage: true,
      killReconciliation: {
        killedAt: 4_000,
        suppressTaskDelivery: true,
      },
    });
    const runSubagentAnnounceFlow = vi.fn<LifecycleControllerParams["runSubagentAnnounceFlow"]>(
      async () => "delivered",
    );
    const emitSubagentEndedHookForRun = vi.fn(async () => {});
    const controller = createLifecycleController({
      entry,
      runSubagentAnnounceFlow,
      shouldEmitEndedHookForRun: () => true,
      emitSubagentEndedHookForRun,
    });

    await completeRun(controller, entry, {
      endedAt: 4_001,
      triggerCleanup: true,
      terminalReply: { disposition: "visible", text: "final completion reply" },
    });

    await waitForLifecycleState(() =>
      expect(readLifecycleRun(entry).cleanupCompletedAt).toBeTypeOf("number"),
    );
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(readLifecycleRun(entry).delivery?.status).toBe("not_required");
    expect(readLifecycleRun(entry).suppressCompletionDelivery).toBeUndefined();
    expect(emitSubagentEndedHookForRun).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({
          runId: entry.runId,
          execution: expect.objectContaining({
            outcome: expect.objectContaining({ status: "ok" }),
          }),
          delivery: expect.objectContaining({ status: "not_required" }),
        }),
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
      }),
    );
  });

  it.each([
    {
      name: "failure",
      reason: SUBAGENT_ENDED_REASON_ERROR,
      outcome: { status: "error" as const, error: "provider failed" },
    },
    {
      name: "timeout",
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      outcome: { status: "timeout" as const },
    },
  ])(
    "keeps canonical $name when a delayed killed callback arrives",
    async ({ reason, outcome }) => {
      const entry = createRunEntry();
      const controller = createLifecycleController({ entry });

      await completeRun(controller, entry, {
        outcome,
        reason,
      });
      await controller.completeSubagentRun(
        makeKilledSubagentCompletion(entry, {
          endedAt: 4_001,
        }),
      );

      expect(readLifecycleRun(entry).execution.outcome?.status).toBe(outcome.status);
      expect(readLifecycleRun(entry).endedReason).toBe(reason);
    },
  );

  it.each([
    {
      name: "failure",
      reason: SUBAGENT_ENDED_REASON_ERROR,
      outcome: { status: "error" as const, error: "provider failed" },
    },
    {
      name: "timeout",
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      outcome: { status: "timeout" as const },
    },
  ])(
    "restarts cleanup when canonical $name supersedes a killed run",
    async ({ reason, outcome }) => {
      const entry = makeProvisionalKilledRunEntry({
        expectsCompletionMessage: true,
        delivery: {
          status: "delivered",
          announcedAt: 4_000,
          deliveredAt: 4_000,
        },
      });
      const controller = createLifecycleController({ entry });

      await completeRun(controller, entry, {
        endedAt: 4_001,
        outcome,
        reason,
      });

      expect(readLifecycleRun(entry)).toMatchObject({
        endedReason: reason,
        execution: { endedAt: 4_001, outcome: { status: outcome.status } },
        cleanupHandled: false,
        delivery: { status: "pending" },
      });
      expect(readLifecycleRun(entry).cleanupCompletedAt).toBeUndefined();
      expect(readLifecycleRun(entry).suppressAnnounceReason).toBeUndefined();
      expect(readLifecycleRun(entry).delivery?.announcedAt).toBeUndefined();
      expect(readLifecycleRun(entry).delivery?.deliveredAt).toBeUndefined();
    },
  );

  it.each([3_999, 4_001])(
    "orders provider completion at %s against accepted cancellation",
    async (endedAt) => {
      const predatesCancellation = endedAt < 4_000;
      const entry = makeProvisionalKilledRunEntry({
        killReconciliation: { killedAt: 4_000, taskCancellationAccepted: true },
      });
      const controller = createLifecycleController({ entry });
      await completeRun(controller, entry, { endedAt, triggerCleanup: !predatesCancellation });
      expect(readLifecycleRun(entry)).toMatchObject(
        predatesCancellation
          ? {
              endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
              execution: { endedAt, outcome: { status: "ok" } },
              cleanupHandled: false,
              suppressAnnounceReason: undefined,
            }
          : {
              endedReason: SUBAGENT_ENDED_REASON_KILLED,
              execution: {
                endedAt: 4_000,
                outcome: { status: "error", error: "agent run aborted" },
              },
              suppressAnnounceReason: "killed",
            },
      );
    },
  );

  it("does not reinterpret a legacy killed row as a provisional cancellation", async () => {
    const entry = createRunEntry({
      endedAt: 4_000,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: { status: "error", error: "legacy cancellation" },
      suppressAnnounceReason: "killed",
      cleanupHandled: true,
      cleanupCompletedAt: 4_000,
    });
    const original = structuredClone(entry);
    const controller = createLifecycleController({ entry });

    await completeRun(controller, entry, { endedAt: 4_001, triggerCleanup: true });

    expect(readLifecycleRun(entry)).toEqual(original);
  });

  it("keeps cancellation that becomes durable during completion capture", async () => {
    const { entry, controller, captured, captureSubagentCompletionReply } = createCaptureFixture(
      makeProvisionalKilledRunEntry(),
    );

    const completion = completeRun(controller, entry, { endedAt: 4_001, triggerCleanup: true });
    await waitForLifecycleState(() => expect(captureSubagentCompletionReply).toHaveBeenCalled());
    expect(readLifecycleRun(entry)).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      execution: { endedAt: 4_000 },
      killReconciliation: { killedAt: 4_000 },
    });
    expect(readLifecycleRun(entry).completion?.resultText).toBeUndefined();
    expect(readLifecycleRun(entry).completion?.capturedAt).toBeUndefined();
    expect(readLifecycleRun(entry).completion?.terminalReply).toBeUndefined();
    await mutateLifecycleRun(entry, (draft) => {
      draft.killReconciliation!.taskCancellationAccepted = true;
    });
    captured.resolve("late success");
    await completion;

    expect(readLifecycleRun(entry)).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      execution: {
        endedAt: 4_000,
        outcome: { status: "error", error: "agent run aborted" },
      },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: 4_000 },
      cleanupHandled: true,
      cleanupCompletedAt: 4_000,
    });
    expect(readLifecycleRun(entry).completion?.resultText).toBeUndefined();
    expect(readLifecycleRun(entry).completion?.capturedAt).toBeUndefined();
    expect(readLifecycleRun(entry).completion?.terminalReply).toBeUndefined();
    expect(helperMocks.persistSubagentSessionTiming).not.toHaveBeenCalled();
  });

  it("keeps accepted kill cleanup live when a later completion is rejected", async () => {
    let finishSessionTiming: (() => void) | undefined;
    helperMocks.persistSubagentSessionTiming.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          finishSessionTiming = resolve;
        }),
    );
    const entry = createRunEntry();
    const controller = createLifecycleController({
      entry,
    });

    const killed = controller.completeSubagentRun(
      makeKilledSubagentCompletion(entry, {
        triggerCleanup: true,
      }),
    );
    await waitForLifecycleState(() =>
      expect(helperMocks.persistSubagentSessionTiming).toHaveBeenCalled(),
    );

    await mutateLifecycleRun(entry, (draft) => {
      draft.killReconciliation!.taskCancellationAccepted = true;
    });
    await completeRun(controller, entry, { endedAt: 4_001, triggerCleanup: true });
    finishSessionTiming?.();
    await killed;

    expect(
      browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
    ).toHaveBeenCalledTimes(1);
    expect(readLifecycleRun(entry).killReconciliation).toEqual({
      killedAt: 4_000,
      taskCancellationAccepted: true,
    });
  });

  it.each([SUBAGENT_ENDED_REASON_COMPLETE, SUBAGENT_ENDED_REASON_KILLED])(
    "lets an explicit timeout deadline predate accepted cancellation from %s",
    async (reason) => {
      const entry = makeProvisionalKilledRunEntry({
        runTimeoutSeconds: 3,
        endedAt: 5_500,
        killReconciliation: { killedAt: 5_500, taskCancellationAccepted: true },
        cleanupCompletedAt: 5_500,
      });
      const controller = createLifecycleController({
        entry,
      });

      await completeRun(controller, entry, {
        reason,
        startedAt: 2_000,
        endedAt: 6_000,
      });

      expect(readLifecycleRun(entry)).toMatchObject({
        endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
        execution: {
          endedAt: 5_000,
          outcome: { status: "timeout", startedAt: 2_000, endedAt: 5_000 },
        },
      });
    },
  );

  it("retires an old live completion without touching a newer session generation", async () => {
    const entry = makeProvisionalKilledRunEntry({
      cleanup: "delete",
    });
    const newer = createRunEntry({
      runId: "run-2",
      createdAt: 5_000,
      startedAt: 5_000,
    });
    const runs = new Map([
      [entry.runId, entry],
      [newer.runId, newer],
    ]);
    const retireSupersededRun = vi.fn(async (runId: string) => {
      runs.delete(runId);
    });
    const emitSubagentEndedHookForRun = vi.fn(async () => {});
    const runSubagentAnnounceFlow = vi.fn<LifecycleControllerParams["runSubagentAnnounceFlow"]>(
      async () => "delivered",
    );
    const controller = createLifecycleController({
      entry,
      runs,
      retireSupersededRun,
      shouldEmitEndedHookForRun: () => true,
      emitSubagentEndedHookForRun,
      runSubagentAnnounceFlow,
    });

    await completeRun(controller, entry, { endedAt: 3_999, triggerCleanup: true });

    expect(retireSupersededRun).toHaveBeenCalledWith(
      entry.runId,
      expect.objectContaining({ runId: entry.runId, childSessionKey: entry.childSessionKey }),
    );
    expect(runs.has(entry.runId)).toBe(false);
    expect(runs.get(newer.runId)).toBe(newer);
    expect(helperMocks.persistSubagentSessionTiming).not.toHaveBeenCalled();
    expect(lifecycleEventMocks.emitSessionLifecycleEvent).not.toHaveBeenCalled();
    expect(emitSubagentEndedHookForRun).not.toHaveBeenCalled();
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(
      browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
    ).not.toHaveBeenCalled();
    expect(gatewayMocks.callGateway).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "sessions.delete" }),
    );
  });

  it("discards completion capture when a newer session generation takes ownership", async () => {
    const entry = createRunEntry();
    const runs = new Map([[entry.runId, entry]]);
    const captured = createDeferredCore<string>();
    const captureSubagentCompletionReply = vi.fn(() => captured.promise);
    const retireSupersededRun = vi.fn(async (runId: string) => {
      runs.delete(runId);
    });
    const controller = createLifecycleController({
      entry,
      runs,
      captureSubagentCompletionReply,
      retireSupersededRun,
    });

    const completion = completeRun(controller, entry, { triggerCleanup: true });
    await waitForLifecycleState(() => expect(captureSubagentCompletionReply).toHaveBeenCalled());
    const newer = createRunEntry({ runId: "run-2", createdAt: 5_000, startedAt: 5_000 });
    runs.set(newer.runId, newer);
    captured.resolve("new generation result");
    await completion;

    expect(runs.has(entry.runId)).toBe(false);
    expect(retireSupersededRun).toHaveBeenCalledWith(
      entry.runId,
      expect.objectContaining({
        runId: entry.runId,
        childSessionKey: entry.childSessionKey,
        completion: expect.objectContaining({ resultText: null }),
      }),
    );
    expect(helperMocks.persistSubagentSessionTiming).not.toHaveBeenCalled();
    expect(lifecycleEventMocks.emitSessionLifecycleEvent).not.toHaveBeenCalled();
  });

  it("rechecks session ownership inside a delayed timing write", async () => {
    const entry = createRunEntry({ generation: 1, createdAt: 1_000, startedAt: 1_000 });
    const runs = new Map([[entry.runId, entry]]);
    const timingEntered = createDeferredCore();
    const timingRelease = createDeferredCore();
    const originalTiming = helperMocks.persistSubagentSessionTiming.getMockImplementation();
    let timingWriteStillOwned: boolean | undefined;
    helperMocks.persistSubagentSessionTiming.mockImplementationOnce(async (...args: unknown[]) => {
      timingEntered.resolve();
      await timingRelease.promise;
      const options = args[1] as { isCurrentGeneration?: () => boolean } | undefined;
      timingWriteStillOwned = options?.isCurrentGeneration?.();
    });
    const retireSupersededRun = vi.fn(async (runId: string) => {
      runs.delete(runId);
    });
    const controller = createLifecycleController({ entry, runs, retireSupersededRun });

    const completion = completeRun(controller, entry, { triggerCleanup: true });
    try {
      await Promise.race([
        timingEntered.promise,
        completion.then(() => {
          throw new Error("Completion settled before entering timing persistence");
        }),
      ]);
      expect(helperMocks.persistSubagentSessionTiming).toHaveBeenCalledOnce();
      const newer = createRunEntry({
        runId: "run-same-millisecond-newer",
        generation: 2,
        createdAt: entry.createdAt,
        startedAt: entry.execution.startedAt,
      });
      runs.set(newer.runId, newer);
      timingRelease.resolve();
      await completion;

      expect(timingWriteStillOwned).toBe(false);
      expect(retireSupersededRun).toHaveBeenCalledWith(
        entry.runId,
        expect.objectContaining({ runId: entry.runId, childSessionKey: entry.childSessionKey }),
      );
      expect(runs.get(newer.runId)).toBe(newer);
      expect(lifecycleEventMocks.emitSessionLifecycleEvent).not.toHaveBeenCalled();
    } finally {
      timingRelease.resolve();
      try {
        await completion;
      } finally {
        helperMocks.persistSubagentSessionTiming.mockReset();
        if (originalTiming) {
          helperMocks.persistSubagentSessionTiming.mockImplementation(originalTiming);
        }
      }
    }
  });

  it("finalizes restored completion text that predates capturedAt", async () => {
    const entry = createRunEntry({
      completion: { required: false, resultText: "restored final result" },
    });
    const controller = createLifecycleController({ entry });

    await completeRun(controller, entry);

    expect(readLifecycleRun(entry).completion?.resultText).toBe("restored final result");
  });

  it.each(["replacement row", "newer child generation"])(
    "does not dispatch browser cleanup after a %s takes ownership",
    async (scenario) => {
      const entry = createRunEntry({
        generation: 1,
        createdAt: 1_000,
        execution: { status: "running", startedAt: 2_000 },
      });
      const runs = new Map([[entry.runId, entry]]);
      const browserLoaderEntered = createDeferredCore();
      const browserLoaderRelease = createDeferredCore();
      const loadCleanupBrowserSessionsForLifecycleEnd = vi.fn(async () => {
        browserLoaderEntered.resolve();
        await browserLoaderRelease.promise;
        return browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd;
      });
      const controller = createLifecycleController({
        entry,
        runs,
        cleanupBrowserSessionsForLifecycleEnd: undefined,
        loadCleanupBrowserSessionsForLifecycleEnd,
      });

      const completion = completeRun(controller, entry, { triggerCleanup: true });
      await browserLoaderEntered.promise;
      const successor = createRunEntry({
        runId: scenario === "replacement row" ? entry.runId : "run-2",
        childSessionKey: entry.childSessionKey,
        generation: 2,
        createdAt: 5_000,
        execution: { status: "running", startedAt: 5_000 },
      });
      runs.set(successor.runId, successor);
      browserLoaderRelease.resolve();
      await completion;

      expect(
        browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
      ).not.toHaveBeenCalled();
      expect(readLifecycleRun(entry).browserCleanupDispatchedAt).toBeUndefined();
      expect(successor.execution).toEqual({ status: "running", startedAt: 5_000 });
    },
  );

  it("rolls back dynamic session-effect suppression when persistence fails", async () => {
    const entry = createRunEntry({
      generation: 1,
      execution: { status: "running", startedAt: 2_000 },
    });
    const browserLoaderEntered = createDeferredCore();
    const browserLoaderRelease = createDeferredCore();
    const loadCleanupBrowserSessionsForLifecycleEnd = vi.fn(async () => {
      browserLoaderEntered.resolve();
      await browserLoaderRelease.promise;
      return browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd;
    });
    const beforeWrite = vi.fn<
      NonNullable<Parameters<typeof createLifecycleControllerFixture>[0]["beforeWrite"]>
    >(({ postimages }) => {
      if (postimages.get(entry.runId)?.execution.suppressSessionEffects === true) {
        throw new Error("suppression persistence failed");
      }
    });
    const controller = createLifecycleController({
      entry,
      beforeWrite,
      cleanupBrowserSessionsForLifecycleEnd: undefined,
      loadCleanupBrowserSessionsForLifecycleEnd,
    });

    const completion = completeRun(controller, entry, { triggerCleanup: true });
    await browserLoaderEntered.promise;
    const recoveryReceipt = {
      sessionId: "session-id",
      sessionMarker: "session-id:1",
      idempotencyKey: "recovery-run",
      phase: "accepted" as const,
      lifecycleGeneration: "retired-generation",
    };
    await mutateLifecycleRun(entry, (draft) => {
      draft.execution.restartRecovery = recoveryReceipt;
    });
    browserLoaderRelease.resolve();

    await expect(completion).rejects.toThrow("suppression persistence failed");
    expect(readLifecycleRun(entry).execution.restartRecovery).toEqual(recoveryReceipt);
    expect(readLifecycleRun(entry).execution.suppressSessionEffects).toBeUndefined();
    expect(readLifecycleRun(entry).browserCleanupDispatchedAt).toBeUndefined();
    expect(
      browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
    ).not.toHaveBeenCalled();
  });

  registerLifecycleDeliveryReceiptCases({
    createRunEntry,
    createLifecycleController,
    completeRun,
    completeAndJoinCleanup,
    waitForLifecycleState,
  });

  it("persists collector completion and skips announce delivery", async () => {
    const entry = createRunEntry({
      expectsCompletionMessage: false,
      retainAttachmentsOnKeep: true,
      collect: true,
      groupId: "swarm:test",
    });
    const runSubagentAnnounceFlow = vi.fn(async () => "delivered" as const);

    const controller = createLifecycleController({
      entry,
      runSubagentAnnounceFlow,
      captureSubagentCompletionReply: vi.fn(async () => "raw collector result"),
    });

    await expect(completeRun(controller, entry, { triggerCleanup: true })).resolves.toBeUndefined();

    expect(browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKeys: [entry.childSessionKey],
        onWarn: expect.any(Function),
      }),
    );
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(readLifecycleRun(entry).delivery?.status === "delivered").toBe(false);
    await waitForLifecycleState(() =>
      expect(readLifecycleRun(entry).cleanupCompletedAt).toBeTypeOf("number"),
    );
    expect(readLifecycleRun(entry).completion?.resultText).toBe("raw collector result");
    expect(readLifecycleRun(entry).collectorCompletion).toEqual({ status: "done" });
    expect(readLifecycleRun(entry).delivery?.status).toBe("not_required");
    expect(readLifecycleRun(entry).delivery?.announcedAt).toBeUndefined();
  });

  it("deletes collector session resources while retaining the waitable record", async () => {
    const entry = createRunEntry({
      requesterTurnRunId: "run-requester",
      cleanup: "delete",
      expectsCompletionMessage: false,
      collect: true,
      groupId: "swarm:test",
    });
    const runs = new Map([[entry.runId, entry]]);
    const notifyContextEngineSubagentEnded = vi.fn(async () => {});
    const controller = createLifecycleController({
      entry,
      runs,
      notifyContextEngineSubagentEnded,
      captureSubagentCompletionReply: vi.fn(async () => "raw collector result"),
    });

    await completeRun(controller, entry, { triggerCleanup: true });

    await waitForLifecycleState(() =>
      expect(readLifecycleRun(entry).cleanupCompletedAt).toBeTypeOf("number"),
    );
    await waitForLifecycleState(() =>
      expect(gatewayMocks.callGateway).toHaveBeenCalledWith({
        method: "sessions.delete",
        params: {
          key: entry.childSessionKey,
          deleteTranscript: true,
          emitLifecycleHooks: false,
          expectedSessionId: "child-session-id",
          expectedLifecycleRevision: "child-lifecycle-revision",
        },
        timeoutMs: 10_000,
        prepareDispatchCurrent: expect.any(Function),
        assertDispatchCurrent: expect.any(Function),
      }),
    );
    await waitForLifecycleState(() =>
      expect(notifyContextEngineSubagentEnded).toHaveBeenCalledWith(
        {
          childSessionKey: entry.childSessionKey,
          reason: "deleted",
          agentDir: entry.agentDir,
          workspaceDir: entry.workspaceDir,
        },
        { isCurrent: expect.any(Function), prepareCurrent: expect.any(Function) },
      ),
    );
    expect(helperMocks.safeRemoveAttachmentsDir).toHaveBeenCalledWith(
      expect.objectContaining({ runId: entry.runId, childSessionKey: entry.childSessionKey }),
      expect.any(Function),
    );
    expect(runs.has(entry.runId)).toBe(true);
    expect(readLifecycleRun(entry).collectorCompletion).toEqual({ status: "done" });
    expect(readLifecycleRun(entry).completion?.required).toBe(false);
    expect(readLifecycleRun(entry).requesterSettleWake).toBeUndefined();
    expect(readLifecycleRun(entry).retireAfterRequesterTurn).toBeUndefined();
  });

  it.each(["tool-only success", "provider failure", "missing output"] as const)(
    "records collector outcome for %s",
    async (scenario) => {
      const structured = { answer: "yes" };
      const entry = createRunEntry({
        expectsCompletionMessage: false,
        collect: true,
        outputSchema: { type: "object" },
        ...(scenario === "provider failure"
          ? { structuredOutput: { structured, invalidAttempts: 0 } }
          : {}),
      });
      if (scenario === "tool-only success") {
        const tool = createStructuredOutputTool({ runId: entry.runId, schema: { type: "object" } });
        await tool.execute("tool-call", { result: structured });
      }
      const controller = createLifecycleController({
        entry,
        captureSubagentCompletionReply: vi.fn(async () =>
          scenario === "tool-only success"
            ? ""
            : scenario === "missing output"
              ? "raw collector result"
              : "final completion reply",
        ),
      });
      await completeRun(controller, entry, {
        triggerCleanup: true,
        ...(scenario === "missing output"
          ? {}
          : {
              outcome: {
                status: "error",
                error:
                  scenario === "tool-only success"
                    ? "completed"
                    : "provider failed after tool output",
              },
              reason: SUBAGENT_ENDED_REASON_ERROR,
            }),
      });
      await waitForLifecycleState(() =>
        expect(readLifecycleRun(entry).cleanupCompletedAt).toBeTypeOf("number"),
      );
      expect(readLifecycleRun(entry).collectorCompletion).toEqual(
        scenario === "missing output"
          ? { status: "failed", schemaError: "structured_output was not called" }
          : { status: scenario === "tool-only success" ? "done" : "failed", structured },
      );
      if (scenario === "tool-only success") {
        expect(readLifecycleRun(entry).execution).toMatchObject({
          status: "terminal",
          outcome: { status: "ok" },
        });
        expect(readLifecycleRun(entry).endedReason).toBe(SUBAGENT_ENDED_REASON_COMPLETE);
      } else if (scenario === "provider failure") {
        expect(readLifecycleRun(entry).execution.outcome).toMatchObject({
          status: "error",
          error: "provider failed after tool output",
        });
      }
    },
  );

  it("archives delete-mode sessions when completion messages are disabled", async () => {
    let finalPostimage: SubagentRunRecord | undefined;
    const persist = vi.fn(({ postimages }: LifecycleFixtureWrite) => {
      for (const row of postimages.values()) {
        if (row) {
          finalPostimage = row;
        }
      }
    });
    const entry = createRunEntry({
      cleanup: "delete",
      expectsCompletionMessage: false,
      spawnMode: "session",
    });
    const runs = new Map([[entry.runId, entry]]);
    const runSubagentAnnounceFlow = vi.fn(async () => "delivered" as const);

    const controller = createLifecycleController({
      entry,
      runs,
      beforeWrite: persist,
      runSubagentAnnounceFlow,
    });

    await expect(completeRun(controller, entry, { triggerCleanup: true })).resolves.toBeUndefined();

    await waitForLifecycleState(() =>
      expect(gatewayMocks.callGateway).toHaveBeenCalledWith({
        method: "sessions.delete",
        params: {
          key: entry.childSessionKey,
          deleteTranscript: true,
          emitLifecycleHooks: true,
          expectedSessionId: "child-session-id",
          expectedLifecycleRevision: "child-lifecycle-revision",
        },
        timeoutMs: 10_000,
        prepareDispatchCurrent: expect.any(Function),
        assertDispatchCurrent: expect.any(Function),
      }),
    );
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(finalPostimage?.delivery?.status === "delivered").toBe(false);
    await waitForLifecycleState(() => expect(runs.has(entry.runId)).toBe(false));
    expect(finalPostimage?.delivery?.announcedAt).toBeUndefined();
  });

  it("finishes old cleanup without deleting a newer session generation", async () => {
    const entry = createRunEntry({
      cleanup: "delete",
      expectsCompletionMessage: false,
      spawnMode: "session",
      generation: 1,
    });
    const runs = new Map([[entry.runId, entry]]);
    const retireSupersededRun = vi.fn(async () => {});
    const controller = createLifecycleController({ entry, runs, retireSupersededRun });

    const join = observeRootWork();
    expect(controller.startSubagentAnnounceCleanupFlow(entry)).toBe(true);
    const newer = createRunEntry({
      runId: "run-2",
      generation: 2,
      createdAt: entry.createdAt,
      startedAt: entry.execution.startedAt,
    });
    runs.set(newer.runId, newer);

    await join();
    expect(retireSupersededRun).not.toHaveBeenCalled();
    expect(readLifecycleRun(entry)).toMatchObject({
      cleanupCompletedAt: expect.any(Number),
      execution: { suppressSessionEffects: true },
    });
    expect(runs.get(newer.runId)).toBe(newer);
    expect(gatewayMocks.callGateway).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "sessions.delete" }),
    );
  });

  it("keeps provisional killed sessions across resumed cleanup", async () => {
    const entry = createRunEntry({
      cleanup: "delete",
      endedAt: 4_000,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: { status: "error", error: "agent run aborted" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: 4_000 },
      archiveAtMs: 304_000,
      expectsCompletionMessage: false,
    });
    const runs = new Map([[entry.runId, entry]]);
    const controller = createLifecycleController({ entry, runs });

    expect(controller.startSubagentAnnounceCleanupFlow(entry)).toBe(false);

    expect(readLifecycleRun(entry).cleanupCompletedAt).toBeUndefined();
    expect(runs.has(entry.runId)).toBe(true);
    expect(controller.startSubagentAnnounceCleanupFlow(entry)).toBe(false);
    expect(gatewayMocks.callGateway).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "sessions.delete" }),
    );
  });

  it.each(["run", "session"] as const)(
    "retires bundle MCP runtimes only for run-mode cleanup (%s)",
    async (spawnMode) => {
      const entry = createRunEntry({ endedAt: 4_000, expectsCompletionMessage: false, spawnMode });
      const controller = createLifecycleController({ entry });

      await completeAndJoinCleanup(controller, entry, { triggerCleanup: true });

      const retire = bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey;
      if (spawnMode === "session") {
        expect(retire).not.toHaveBeenCalled();
      } else {
        expect(retire).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionKey: entry.childSessionKey,
            reason: "subagent-run-cleanup",
            preserveActiveLeases: true,
            onError: expect.any(Function),
          }),
        );
      }
    },
  );

  it("enriches registered-run outcomes with persisted timing before cleanup", async () => {
    const runSubagentAnnounceFlow = vi.fn(async () => "delivered" as const);
    const entry = createRunEntry({
      startedAt: 2_000,
      expectsCompletionMessage: true,
    });

    const controller = createLifecycleController({
      entry,
      runSubagentAnnounceFlow,
    });

    await expect(
      completeRun(controller, entry, {
        endedAt: 4_250,
        outcome: { status: "timeout" },
        triggerCleanup: true,
      }),
    ).resolves.toBeUndefined();

    const enrichedOutcome = {
      status: "timeout" as const,
      startedAt: 2_000,
      endedAt: 4_250,
      elapsedMs: 2_250,
    };
    expect(readLifecycleRun(entry).execution.outcome).toEqual(enrichedOutcome);
    expect(resolveSubagentKillTargetState(readLifecycleRun(entry))).toMatchObject({
      state: "terminal",
      task: { status: "timed_out" },
    });
    expect(runSubagentAnnounceFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        startedAt: 2_000,
        endedAt: 4_250,
        outcome: enrichedOutcome,
      }),
    );
  });

  it("does not wait for a completion reply when the run does not expect one", async () => {
    const entry = createRunEntry({
      expectsCompletionMessage: false,
      execution: {
        status: "running",
        transcriptTarget: {
          agentId: "main",
          sessionId: "child-session",
          sessionKey: "agent:main:subagent:child",
          storePath: "/tmp/openclaw/agents/main/sessions/sessions.json",
        },
      },
    });
    const captureSubagentCompletionReply = vi.fn(async () => undefined);

    const controller = createLifecycleController({
      entry,
      captureSubagentCompletionReply,
      runSubagentAnnounceFlow: vi.fn(async () => "retryable" as const),
    });

    await expect(completeRun(controller, entry)).resolves.toBeUndefined();

    expect(captureSubagentCompletionReply).toHaveBeenCalledWith(entry.childSessionKey, {
      waitForReply: false,
      sessionTarget: entry.execution?.transcriptTarget,
      outcome: {
        status: "ok",
        startedAt: 2_000,
        endedAt: 4_000,
        elapsedMs: 2_000,
      },
    });
  });

  it("scopes fallback completion capture to the incognito child store", async () => {
    const childSessionKey = "agent:main:subagent:incognito-child";
    const durableStorePath = "/tmp/durable-sessions.json";
    const entry = createRunEntry({
      childSessionKey,
      expectsCompletionMessage: false,
      execution: {
        status: "running",
        transcriptTarget: {
          agentId: "main",
          sessionId: "incognito-child-session",
          sessionKey: childSessionKey,
        },
      },
    });
    const captureSubagentCompletionReply = vi.fn(async () => undefined);
    const controller = createLifecycleController({
      entry,
      captureSubagentCompletionReply,
      getRuntimeConfig: () => ({ session: { store: durableStorePath } }),
      runSubagentAnnounceFlow: vi.fn(async () => "retryable" as const),
    });

    await completeRun(controller, entry);

    expect(captureSubagentCompletionReply).toHaveBeenCalledWith(
      childSessionKey,
      expect.objectContaining({
        sessionTarget: {
          agentId: "main",
          sessionId: "incognito-child-session",
          sessionKey: childSessionKey,
          storePath: resolveSessionStorePathForScope({
            agentId: "main",
            sessionKey: childSessionKey,
            storePath: durableStorePath,
          }),
        },
      }),
    );
  });

  it("does not freeze stale reply text for terminal error outcomes", async () => {
    const captureSubagentCompletionReply = vi.fn(async () => "stale assistant text");
    const entry = createRunEntry({
      expectsCompletionMessage: true,
    });

    const controller = createLifecycleController({
      entry,
      captureSubagentCompletionReply,
    });

    await expect(
      completeRun(controller, entry, {
        outcome: { status: "error", error: "All models failed (2): timeout" },
      }),
    ).resolves.toBeUndefined();

    expect(captureSubagentCompletionReply).not.toHaveBeenCalled();
    expect(readLifecycleRun(entry).completion?.resultText).toBeNull();
    expect(resolveSubagentKillTargetState(readLifecycleRun(entry))).toMatchObject({
      state: "terminal",
      task: { status: "failed", error: "All models failed (2): timeout" },
    });
  });

  it.each([
    { mode: "optional", waitsForDescendants: false, expectsCompletionMessage: undefined },
    { mode: "required", waitsForDescendants: false, expectsCompletionMessage: true },
    { mode: "descendants", waitsForDescendants: true, expectsCompletionMessage: undefined },
  ])(
    "does not re-run delivered announce during $mode cleanup",
    async ({ waitsForDescendants, expectsCompletionMessage }) => {
      let pendingDescendants = waitsForDescendants ? 1 : 0;
      const entry = createRunEntry({
        delivery: { status: "delivered", announcedAt: 3_500, deliveredAt: 3_500 },
        endedAt: 4_000,
        expectsCompletionMessage,
        ...(waitsForDescendants
          ? { suppressCompletionDelivery: true, wakeOnDescendantSettle: true }
          : {}),
      });
      const persist = vi.fn();
      const runSubagentAnnounceFlow = vi.fn(async () => "delivered" as const);
      const notifyContextEngineSubagentEnded = vi.fn(async () => {});
      const emitSubagentEndedHookForRun = vi.fn(async () => {});

      const controller = createLifecycleController({
        entry,
        beforeWrite: persist,
        countPendingDescendantRuns: async () => pendingDescendants,
        notifyContextEngineSubagentEnded,
        runSubagentAnnounceFlow,
        shouldEmitEndedHookForRun: () => expectsCompletionMessage === true,
        emitSubagentEndedHookForRun,
      });

      await expect(
        completeAndJoinCleanup(controller, entry, {
          triggerCleanup: true,
          terminalReply: expectsCompletionMessage
            ? { disposition: "visible", text: "final completion reply" }
            : undefined,
        }),
      ).resolves.toBeUndefined();

      if (waitsForDescendants) {
        expect(readLifecycleRun(entry).cleanupCompletedAt).toBeUndefined();
        expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
        expect(notifyContextEngineSubagentEnded).not.toHaveBeenCalled();
        pendingDescendants = 0;
        await completeAndJoinCleanup(controller, entry, { triggerCleanup: true });
      }
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
      expect(typeof readLifecycleRun(entry).cleanupCompletedAt).toBe("number");
      expect(readLifecycleRun(entry).cleanupCompletedAt).toBeGreaterThanOrEqual(4_000);
      expect(notifyContextEngineSubagentEnded).toHaveBeenCalledWith(
        {
          childSessionKey: entry.childSessionKey,
          reason: "completed",
          agentDir: entry.agentDir,
          workspaceDir: entry.workspaceDir,
        },
        { isCurrent: expect.any(Function), prepareCurrent: expect.any(Function) },
      );
      if (expectsCompletionMessage) {
        expect(emitSubagentEndedHookForRun).toHaveBeenCalledExactlyOnceWith({
          entry: expect.objectContaining({
            runId: entry.runId,
            childSessionKey: entry.childSessionKey,
            delivery: expect.objectContaining({ status: "delivered", deliveredAt: 3_500 }),
          }),
          reason: SUBAGENT_ENDED_REASON_COMPLETE,
          sendFarewell: true,
          isCurrent: expect.any(Function),
          prepareCurrent: expect.any(Function),
        });
      }

      expect(persist).toHaveBeenCalled();
    },
  );

  it("suppresses a deferred ended hook after a newer session generation registers", async () => {
    const entry = createRunEntry({
      delivery: { status: "delivered", announcedAt: 3_500, deliveredAt: 3_500 },
      endedAt: 4_000,
      expectsCompletionMessage: true,
      generation: 1,
    });
    const runs = new Map([[entry.runId, entry]]);
    let finishPluginLoad: (() => void) | undefined;
    const emitted = vi.fn();
    const emitSubagentEndedHookForRun = vi.fn(async (params: { isCurrent?: () => boolean }) => {
      await new Promise<void>((resolve) => {
        finishPluginLoad = resolve;
      });
      if (params.isCurrent?.() !== false) {
        emitted();
      }
    });
    const controller = createLifecycleController({
      entry,
      runs,
      shouldEmitEndedHookForRun: () => true,
      emitSubagentEndedHookForRun,
    });

    const completion = completeRun(controller, entry, { triggerCleanup: true });
    await waitForLifecycleState(() => expect(emitSubagentEndedHookForRun).toHaveBeenCalled());
    runs.set(
      "run-2",
      createRunEntry({
        runId: "run-2",
        createdAt: 5_000,
        startedAt: 5_000,
        generation: 2,
      }),
    );
    finishPluginLoad?.();
    await completion;

    expect(emitted).not.toHaveBeenCalled();
  });

  it("produces valid cleanupCompletedAt on give-up path when completionAnnouncedAt is undefined", async () => {
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: false,
      retainAttachmentsOnKeep: true,
    });

    const controller = createLifecycleController({
      entry,
      captureSubagentCompletionReply: vi.fn(async () => undefined),
    });

    expect(readLifecycleRun(entry).delivery?.announcedAt).toBeUndefined();

    await controller.finalizeResumedAnnounceGiveUp({
      entry,
      reason: "expiry",
    });

    expect(readLifecycleRun(entry).cleanupCompletedAt).toBeTypeOf("number");
    expect(Number.isNaN(readLifecycleRun(entry).cleanupCompletedAt)).toBe(false);
  });

  it.each([
    { name: "original window", required: true, redriven: false, replaced: false },
    { name: "explicit retry window", required: true, redriven: true, replaced: false },
    { name: "retired owner", required: true, redriven: false, replaced: true },
    { name: "optional completion window", required: false, redriven: false, replaced: false },
  ])(
    "bounds a pending completion handoff by its $name",
    async ({ required, redriven, replaced }) => {
      vi.useFakeTimers();
      vi.setSystemTime(2_000_000);
      const deadlineAt = Date.now() + (redriven ? 3_000 : 1_000);
      const entry = createRunEntry({
        endedAt: Date.now() - (required ? 30 : 5) * 60_000 + 1_000,
        endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
        expectsCompletionMessage: required ? true : undefined,
        completion: { required, resultText: "final answer" },
        delivery: {
          status: "pending",
          ...(redriven ? { windowStartedAt: Date.now(), deadlineAt } : {}),
        },
        outcome: { status: "ok" },
        retainAttachmentsOnKeep: true,
      });
      const pendingHandoff = createDeferredCore<AnnounceFlowOutcome>();
      let deliverySignal: AbortSignal | undefined;
      const runSubagentAnnounceFlow = vi.fn<LifecycleControllerParams["runSubagentAnnounceFlow"]>(
        (params) => {
          deliverySignal = params.signal;
          params.signal?.addEventListener(
            "abort",
            () => pendingHandoff.reject(params.signal?.reason),
            {
              once: true,
            },
          );
          return pendingHandoff.promise;
        },
      );
      const runs = new Map([[entry.runId, entry]]);
      const controller = createLifecycleController({ entry, runs, runSubagentAnnounceFlow });
      try {
        expect(controller.startSubagentAnnounceCleanupFlow(entry)).toBe(true);
        await waitForLifecycleState(() => expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce());
        const successor = replaced ? createRunEntry({ runId: entry.runId }) : undefined;
        if (successor) {
          runs.set(entry.runId, successor);
        }

        await vi.advanceTimersByTimeAsync(deadlineAt - Date.now() - 1);
        expect(readLifecycleRun(entry).delivery?.status).toBe("pending");
        expect(completionDeliveryMocks.blockSubagentCompletionDelivery).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        expect(deliverySignal?.aborted).toBe(true);
        await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
        if (successor) {
          expect(runs.get(entry.runId)).toBe(successor);
          expect(completionDeliveryMocks.blockSubagentCompletionDelivery).not.toHaveBeenCalled();
        } else if (!required) {
          expect(readLifecycleRun(entry).delivery?.status).toBe("failed");
          expect(readLifecycleRun(entry).cleanupCompletedAt).toBeTypeOf("number");
          expect(completionDeliveryMocks.blockSubagentCompletionDelivery).not.toHaveBeenCalled();
        } else {
          expect(readLifecycleRun(entry).delivery?.status).toBe("suspended");
          expect(readLifecycleRun(entry).delivery?.suspendedReason).toBe("expiry");
          expect(readLifecycleRun(entry).completion?.resultText).toBe("final answer");
          expect(readLifecycleRun(entry).cleanupHandled).toBe(false);
          expect(readLifecycleRun(entry).cleanupCompletedAt).toBeUndefined();
        }
      } finally {
        pendingHandoff.resolve("retryable");
        await vi.advanceTimersByTimeAsync(0);
        controller.clearScheduledResumeTimers();
        vi.useRealTimers();
      }
    },
  );

  it("retires delivery expiry when requester execution starts and records its eventual success", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    const entry = createRunEntry({
      endedAt: Date.now() - 30 * 60_000 + 1_000,
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      expectsCompletionMessage: true,
      completion: { required: true, resultText: "final answer" },
      delivery: { status: "pending" },
      outcome: { status: "ok" },
      retainAttachmentsOnKeep: true,
    });
    const requesterFinished = createDeferredCore<AnnounceFlowOutcome>();
    let deliverySignal: AbortSignal | undefined;
    const runSubagentAnnounceFlow = vi.fn<LifecycleControllerParams["runSubagentAnnounceFlow"]>(
      (params) => {
        deliverySignal = params.signal;
        params.onExecutionStarted?.();
        return requesterFinished.promise;
      },
    );
    const controller = createLifecycleController({ entry, runSubagentAnnounceFlow });
    try {
      expect(controller.startSubagentAnnounceCleanupFlow(entry)).toBe(true);
      await waitForLifecycleState(() => expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(1_001);
      expect(deliverySignal?.aborted).toBe(false);
      expect(readLifecycleRun(entry).delivery?.status).toBe("pending");
      requesterFinished.resolve("delivered");
      await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      expect(readLifecycleRun(entry).delivery?.status).toBe("delivered");
      expect(readLifecycleRun(entry).delivery?.nextAttemptAt).toBeUndefined();
      expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce();
      expect(completionDeliveryMocks.blockSubagentCompletionDelivery).not.toHaveBeenCalled();
    } finally {
      requesterFinished.resolve("delivered");
      await vi.advanceTimersByTimeAsync(0);
      controller.clearScheduledResumeTimers();
      vi.useRealTimers();
    }
  });

  it("suspends successful keep-mode final delivery after its deadline", async () => {
    const entry = createRunEntry({
      endedAt: 4_000,
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      expectsCompletionMessage: true,
      completion: { required: true, resultText: "final answer" },
      delivery: { status: "pending", lastError: "gateway request timeout for agent" },
      outcome: { status: "ok" },
      retainAttachmentsOnKeep: true,
    });

    const controller = createLifecycleController({
      entry,
      captureSubagentCompletionReply: vi.fn(async () => undefined),
    });

    await controller.finalizeResumedAnnounceGiveUp({
      entry,
      reason: "expiry",
    });

    expect(readLifecycleRun(entry).delivery?.status).toBe("suspended");
    expect(readLifecycleRun(entry).completion?.resultText).toBe("final answer");
    expect(readLifecycleRun(entry).delivery?.suspendedAt).toBeTypeOf("number");
    expect(readLifecycleRun(entry).delivery?.suspendedReason).toBe("expiry");
    expect(readLifecycleRun(entry).cleanupHandled).toBe(false);
    expect(readLifecycleRun(entry).cleanupCompletedAt).toBeUndefined();
    expect(helperMocks.safeRemoveAttachmentsDir).not.toHaveBeenCalled();
    expect(completionDeliveryMocks.blockSubagentCompletionDelivery).toHaveBeenCalledWith({
      subagent: expect.objectContaining({
        runId: entry.runId,
        childSessionKey: entry.childSessionKey,
      }),
      reason: "gateway request timeout for agent",
      suspendedReason: "expiry",
    });
  });

  it.each([
    {
      name: "timeout",
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      outcome: { status: "timeout" as const },
    },
    {
      name: "error",
      endedReason: SUBAGENT_ENDED_REASON_ERROR,
      outcome: { status: "error" as const, error: "child failed" },
    },
    {
      name: "killed",
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: undefined,
    },
  ])(
    "keeps $name completion cleanup terminal on retry exhaustion",
    async ({ endedReason, outcome }) => {
      let finalPostimage: SubagentRunRecord | undefined;
      const beforeWrite = vi.fn(({ postimages }: LifecycleFixtureWrite) => {
        for (const row of postimages.values()) {
          if (row) {
            finalPostimage = row;
          }
        }
      });
      const entry = createRunEntry({
        endedAt: 4_000,
        endedReason,
        expectsCompletionMessage: true,
        delivery: { status: "pending", lastError: "gateway request timeout for agent" },
        outcome,
        retainAttachmentsOnKeep: true,
      });
      const runs = new Map([[entry.runId, entry]]);

      const controller = createLifecycleController({
        entry,
        runs,
        beforeWrite,
        captureSubagentCompletionReply: vi.fn(async () => undefined),
      });

      const join = observeRootWork();
      await controller.finalizeResumedAnnounceGiveUp({
        entry,
        reason: "expiry",
      });
      await join();

      expect(finalPostimage?.delivery?.payload).toBeUndefined();
      expect(finalPostimage?.delivery?.suspendedAt).toBeUndefined();
      expect(finalPostimage?.delivery?.suspendedReason).toBeUndefined();
      if (endedReason === SUBAGENT_ENDED_REASON_KILLED) {
        expect(runs.has(entry.runId)).toBe(false);
      } else {
        expect(readLifecycleRun(entry).cleanupCompletedAt).toBeTypeOf("number");
      }
      expect(beforeWrite).toHaveBeenCalled();
    },
  );

  it("persists the concrete announce delivery error when cleanup gives up", async () => {
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: true,
      retainAttachmentsOnKeep: true,
    });
    const runSubagentAnnounceFlow = vi.fn<LifecycleControllerParams["runSubagentAnnounceFlow"]>(
      async (announceParams) => {
        await announceParams.onDeliveryResult?.({
          delivered: false,
          path: "direct",
          error: "UNAVAILABLE: requester wake failed",
          phases: [
            {
              phase: "direct-primary",
              delivered: false,
              path: "direct",
              error: "UNAVAILABLE: requester wake failed",
            },
            {
              phase: "steer-fallback",
              delivered: false,
              path: "none",
            },
          ],
        });
        return "retryable" as const;
      },
    );

    const controller = createLifecycleController({
      entry,
      runSubagentAnnounceFlow,
    });

    await expect(
      completeAndJoinCleanup(controller, entry, {
        triggerCleanup: true,
        terminalReply: { disposition: "visible", text: "final completion reply" },
      }),
    ).resolves.toBeUndefined();

    expect(completionDeliveryMocks.blockSubagentCompletionDelivery).toHaveBeenCalledWith({
      subagent: expect.objectContaining({
        runId: entry.runId,
        childSessionKey: entry.childSessionKey,
      }),
      reason:
        "UNAVAILABLE: requester wake failed; direct-primary: UNAVAILABLE: requester wake failed",
      suspendedReason: "expiry",
    });
    expect(readLifecycleRun(entry).delivery?.lastError).toBe(
      "UNAVAILABLE: requester wake failed; direct-primary: UNAVAILABLE: requester wake failed",
    );
    expect(readLifecycleRun(entry).delivery?.status).toBe("suspended");
    expect(readLifecycleRun(entry).delivery?.suspendedAt).toBeTypeOf("number");
    expect(readLifecycleRun(entry).delivery?.suspendedReason).toBe("expiry");
    expect(readLifecycleRun(entry).cleanupCompletedAt).toBeUndefined();
  });

  registerNativeCompletionAuthorityTest({
    createRunEntry,
    createLifecycleController,
    completeRun,
    helperMocks,
  });

  registerPrivateCompletionSettlementTests({
    createRunEntry,
    createLifecycleController,
    waitForLifecycleState,
    completionDeliveryMocks,
  });

  it("does not let a late announce failure reclaim a pending yielded batch", async () => {
    const entry = createRunEntry({
      endedAt: Date.now(),
      outcome: { status: "ok" },
      requesterTurnRunId: "run-requester",
      expectsCompletionMessage: true,
      retainAttachmentsOnKeep: true,
      completion: { required: true, resultText: "child result" },
      delivery: { status: "pending" },
    });
    const announce = createDeferredCore();
    const runSubagentAnnounceFlow = vi.fn<LifecycleControllerParams["runSubagentAnnounceFlow"]>(
      async (params) => {
        await announce.promise;
        await params.onDeliveryResult?.({
          delivered: false,
          path: "direct",
          error: "obsolete announce failure",
          disposition: "retryable",
        });
        return "retryable";
      },
    );
    const controller = createLifecycleController({
      entry,
      runSubagentAnnounceFlow,
      maybeWakeRequesterAfterAllChildrenSettled: async () => false,
    });
    try {
      controller.startSubagentAnnounceCleanupFlow(entry);
      await waitForLifecycleState(() => expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce());
      await mutateLifecycleRun(entry, (draft) => {
        draft.requesterTurnYielded = true;
      });
      await settleRequesterTurn(controller, entry);
      const batch = structuredClone(readLifecycleRun(entry).requesterSettleWake);
      announce.resolve();
      await waitForLifecycleState(() =>
        expect(readLifecycleRun(entry).cleanupCompletedAt).toBeTypeOf("number"),
      );
      expect(readLifecycleRun(entry).requesterSettleWake).toEqual(batch);
      expect(readLifecycleRun(entry).delivery).toMatchObject({
        status: "pending",
        disposition: "intentional_non_delivery",
      });
      expect(readLifecycleRun(entry).delivery?.lastError).toBeUndefined();
      expect(readLifecycleRun(entry).delivery?.nextAttemptAt).toBeUndefined();
    } finally {
      announce.resolve();
      controller.clearScheduledResumeTimers();
    }
  });

  it.each([
    { waitingOn: "announce", outcome: "intentional_non_delivery" },
    { waitingOn: "announce", outcome: "retryable" },
    { waitingOn: "mirror", outcome: "intentional_non_delivery" },
    { waitingOn: "mirror", outcome: "retryable" },
    { waitingOn: "active-send", outcome: "delivered" },
    { waitingOn: "delivered-mirror", outcome: "retryable" },
  ] as const)(
    "preserves requester-settle delivery while $outcome cleanup awaits $waitingOn",
    async ({ waitingOn, outcome }) => {
      const entry = createRunEntry({
        endedAt: Date.now(),
        outcome: { status: "timeout" },
        requesterTurnRunId: "run-requester",
        expectsCompletionMessage: true,
        retainAttachmentsOnKeep: true,
        completion: { required: true, resultText: "child timed out" },
        delivery: { status: "pending", attemptCount: 1 },
      });
      entry.delivery!.payload = loadPendingFinalDeliveryPayload(entry);
      const announce = createDeferredCore();
      const mirror = createDeferredCore<{ messages: unknown[] }>();
      const runSubagentAnnounceFlow = vi.fn<LifecycleControllerParams["runSubagentAnnounceFlow"]>(
        async (params) => {
          if (waitingOn === "active-send") {
            await params.onDeliveryResult?.({
              delivered: true,
              path: "direct",
              deliveredAt: 12_345,
            });
          }
          await announce.promise;
          if (waitingOn === "active-send") {
            return outcome;
          }
          await params.onDeliveryResult?.({
            delivered: false,
            path: "direct",
            error: "completion agent did not produce a visible reply",
            disposition: outcome,
          });
          return outcome;
        },
      );
      gatewayMocks.callGateway.mockImplementation(() => mirror.promise);
      const controller = createLifecycleController({
        entry,
        runSubagentAnnounceFlow,
        maybeWakeRequesterAfterAllChildrenSettled: async (params) => {
          await params.completeBatch(
            [params.settledEntry],
            params.settledEntry.requesterSettleWake?.rearmGeneration,
            {
              delivered: true,
              path: "direct",
              deliveredAt: 12_345,
              requesterVisibleFinalDelivered: true,
            },
          );
          return true;
        },
      });

      try {
        expect(controller.startSubagentAnnounceCleanupFlow(entry)).toBe(true);
        await waitForLifecycleState(() => expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce());
        if (waitingOn === "mirror" || waitingOn === "delivered-mirror") {
          announce.resolve();
          await waitForLifecycleState(() =>
            expect(gatewayMocks.callGateway).toHaveBeenCalledWith(
              expect.objectContaining({ method: "chat.history" }),
            ),
          );
        }
        const announceParams = runSubagentAnnounceFlow.mock.calls[0]![0];
        expect(announceParams.isCompletionDeliveryAllowed?.()).toBe(true);
        await mutateLifecycleRun(entry, (draft) => {
          draft.requesterTurnYielded = true;
        });
        expect(await settleRequesterTurn(controller, entry)).toBe(true);
        await waitForLifecycleState(() =>
          expect(readLifecycleRun(entry).delivery?.status).toBe("delivered"),
        );
        expect
          .soft(readLifecycleRun(entry).delivery)
          .toMatchObject({ payload: undefined, attemptCount: undefined });
        await waitForLifecycleState(() =>
          expect(readLifecycleRun(entry).requesterSettleWake).toBeUndefined(),
        );
        expect(announceParams.isCompletionOwnedByRequesterYield?.()).toBe(false);
        expect.soft(announceParams.isCompletionDeliveryAllowed?.()).toBe(false);

        announce.resolve();
        mirror.resolve({
          messages:
            waitingOn === "delivered-mirror"
              ? [
                  {
                    role: "assistant",
                    provider: "openclaw",
                    model: "delivery-mirror",
                    timestamp: 12_300,
                    idempotencyKey: buildExpectedAnnounceIdempotencyKey(entry),
                    content: "child timed out",
                  },
                ]
              : [],
        });
        await waitForLifecycleState(() =>
          expect(readLifecycleRun(entry).cleanupCompletedAt).toBeTypeOf("number"),
        );
        expect(readLifecycleRun(entry).delivery).toMatchObject({
          status: "delivered",
          disposition: "delivered",
          deliveredAt: 12_345,
          announcedAt: 12_345,
          payload: undefined,
          lastError: undefined,
          attemptCount: undefined,
        });
      } finally {
        announce.resolve();
        mirror.resolve({ messages: [] });
        await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
        controller.clearScheduledResumeTimers();
      }
    },
  );

  it.each([
    { source: "current" },
    { source: "long reply" },
    { source: "message tool" },
    { source: "child run" },
    { source: "stale" },
    { source: "sibling" },
  ])("credits only current-run requester delivery mirrors ($source)", async ({ source }) => {
    const delivered = source !== "stale" && source !== "sibling";
    const entry = await runNoReplyMirrorScenario({
      timestamp: source === "stale" ? 1_999 : 12_345,
      text: source === "long reply" ? "long completion reply ".repeat(500) : undefined,
      idempotencyKeyForEntry: (candidate) => {
        if (source === "child run") {
          return `${candidate.runId}:message-tool:1`;
        }
        if (source === "sibling") {
          return `${buildAnnounceIdempotencyKey(
            buildAnnounceIdFromChildRun({
              childSessionKey: "agent:main:subagent:sibling",
              childRunId: "run-sibling",
            }),
          )}:internal-source-reply:0`;
        }
        return `${buildExpectedAnnounceIdempotencyKey(candidate)}:${source === "message tool" ? "message-tool:" : ""}internal-source-reply:0`;
      },
    });
    await waitForLifecycleState(() =>
      expect(
        delivered
          ? readLifecycleRun(entry).cleanupCompletedAt
          : readLifecycleRun(entry).delivery?.suspendedAt,
      ).toBeTypeOf("number"),
    );
    expect(gatewayMocks.callGateway).toHaveBeenCalledWith({
      method: "chat.history",
      params: { sessionKey: entry.requesterSessionKey, limit: 25, maxChars: 128 * 1024 },
      timeoutMs: 5_000,
    });
    expect(readLifecycleRun(entry).delivery).toMatchObject({
      status: delivered ? "delivered" : "suspended",
      deliveredAt: delivered ? 12_345 : undefined,
      announcedAt: delivered ? 12_345 : undefined,
      lastError: delivered ? undefined : "completion agent did not produce a visible reply",
    });
    if (delivered) {
      expect(readLifecycleRun(entry).delivery?.payload).toBeUndefined();
      expect(readLifecycleRun(entry).delivery?.attemptCount).toBeUndefined();
      expect(helperMocks.logAnnounceGiveUp).not.toHaveBeenCalled();
    } else {
      expect(completionDeliveryMocks.blockSubagentCompletionDelivery).toHaveBeenCalledWith({
        subagent: expect.objectContaining({
          runId: entry.runId,
          childSessionKey: entry.childSessionKey,
          completion: expect.objectContaining({ resultText: "final completion reply" }),
        }),
        reason: "completion agent did not produce a visible reply",
        suspendedReason: "expiry",
      });
      expect(helperMocks.logAnnounceGiveUp).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: entry.runId,
          requesterSessionKey: entry.requesterSessionKey,
        }),
        "expiry",
      );
    }
  });

  it("skips browser cleanup when steer restart suppresses cleanup flow", async () => {
    const entry = createRunEntry({
      expectsCompletionMessage: false,
    });
    const runSubagentAnnounceFlow = vi.fn(async () => "delivered" as const);

    const controller = createLifecycleController({
      entry,
      suppressAnnounceForSteerRestart: () => true,
      runSubagentAnnounceFlow,
    });

    await expect(completeRun(controller, entry, { triggerCleanup: true })).resolves.toBeUndefined();

    expect(
      browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
    ).not.toHaveBeenCalled();
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
  });

  it("does not apply a queued interrupted completion to a same-id successor", async () => {
    const entry = createRunEntry({
      generation: 1,
      expectsCompletionMessage: false,
    });
    const runs = new Map([[entry.runId, entry]]);
    const successor = createRunEntry({
      generation: 2,
      createdAt: 5_000,
      execution: { status: "running", startedAt: 5_000 },
    });
    const controller = createLifecycleController({ entry, runs });
    const firstCleanupEntered = createDeferredCore();
    const firstCleanupRelease = createDeferredCore();
    browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd.mockImplementationOnce(
      async () => {
        firstCleanupEntered.resolve();
        await firstCleanupRelease.promise;
      },
    );

    const firstCompletion = completeRun(controller, entry, {
      triggerCleanup: true,
    });
    await firstCleanupEntered.promise;
    const staleRecovery = controller.completeSubagentRun(
      makeInterruptedSubagentCompletion(entry, {
        expectedEntry: entry,
        endedAt: 4_001,
        outcome: { status: "error", error: "stale interrupted recovery" },
        triggerCleanup: true,
      }),
    );
    runs.set(entry.runId, successor);

    firstCleanupRelease.resolve();
    const results = await Promise.allSettled([firstCompletion, staleRecovery]);
    expect(results[0]).toMatchObject({ status: "fulfilled" });
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        name: "SubagentRegistryMutationRejectedError",
      }),
    });

    expect(runs.get(entry.runId)).toBe(successor);
    expect(successor.execution).toEqual({ status: "running", startedAt: 5_000 });
    expect(successor.endedReason).toBeUndefined();
    expect(successor.terminalOwner).toBeUndefined();
  });

  it("dedupes browser cleanup when two callers complete the same run in parallel", async () => {
    // registerSubagentRun fires both an in-process listener (phase='end') and a
    // gateway waitForSubagentCompletion RPC; in embedded mode both resolve to
    // the same runId and call completeSubagentRun. Without a per-entry dispatch
    // guard, cleanupBrowserSessionsForLifecycleEnd fires once per caller,
    // duplicating browser driver tab-close IPC.
    const entry = createRunEntry({
      expectsCompletionMessage: false,
    });
    const runSubagentAnnounceFlow = vi.fn(async () => "delivered" as const);

    const controller = createLifecycleController({
      entry,
      runSubagentAnnounceFlow,
    });

    const completeParams = {
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" as const },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
    };

    await Promise.all([
      controller.completeSubagentRun(completeParams),
      controller.completeSubagentRun(completeParams),
    ]);

    expect(
      browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
    ).toHaveBeenCalledTimes(1);
    expect(readLifecycleRun(entry).browserCleanupDispatchedAt).toBeTypeOf("number");
  });

  // The helper, retry wrapper, admission, completion lock and terminal-effect
  // owners are real. Existing suite adapters observe task/session/transport I/O.
  // Unlike the direct-controller regression below, these requests originate at
  // the orphan helper, so dropping any of its three bindings is observable.
  it.each(
    ["persisted terminal", "attributed orphan", "lost context"].flatMap((path) =>
      ["current", "replaced", "released"].map((ownership) => ({ path, ownership })),
    ),
  )(
    "settles $path only for the $ownership entry after the terminal lock",
    async ({ path, ownership }) => {
      const entry = createRunEntry({
        generation: 1,
        cleanup: "delete",
        expectsCompletionMessage: true,
      });
      const runs = new Map([[entry.runId, entry]]);
      const successor = createRunEntry({
        generation: 2,
        createdAt: 5_000,
        execution: { status: "running", startedAt: 5_000 },
      });
      const original = structuredClone(entry);
      const successorBefore = structuredClone(successor);
      orphanBootSegments.current =
        path === "attributed orphan"
          ? [
              {
                bootId: "dead",
                pid: 101,
                startedAtMs: 0,
                completedAtMs: null,
                outcome: null,
                hostBootId: null,
              },
              {
                bootId: "live",
                pid: process.pid,
                startedAtMs: 4_000,
                completedAtMs: null,
                outcome: null,
                hostBootId: null,
              },
            ]
          : [];
      sessionReconciliationMocks.resolveSubagentRunOrphanReason.mockReturnValue(
        path === "attributed orphan" ? "missing-session-entry" : null,
      );
      sessionReconciliationMocks.loadSubagentSessionEntry.mockReturnValue(
        path === "persisted terminal"
          ? {
              sessionId: "child-session-id",
              status: "failed",
              startedAt: 2_000,
              endedAt: 4_000,
              updatedAt: 4_000,
            }
          : undefined,
      );
      const persist = vi.fn();
      const persistOrThrow = vi.fn();
      const notifyContextEngineSubagentEnded = vi.fn(async () => {});
      const resumeSubagentRun = vi.fn();
      const warn = vi.fn();
      const controller = createLifecycleController({
        entry,
        runs,
        persist,
        persistOrThrow,
        notifyContextEngineSubagentEnded,
        resumeSubagentRun,
        warn,
      });
      const retryTimers = new Set<ReturnType<typeof setTimeout>>();
      const runtime = createSubagentRegistryCompletionRuntime({
        runs,
        resumed: controller.options.resumedRuns,
        retryTimers,
        completeSubagentRun: controller.completeSubagentRun,
        scheduleSweep: vi.fn(),
        resumeRun: resumeSubagentRun,
        warn,
      });
      // Hold the actual owner's lock, not browser cleanup (which runs after it
      // is released). Observe acquisition so replacement happens while queued.
      const unlock = await controller.acquireTerminalCompletionLock(entry.runId);
      const queued = createDeferredCore();
      const acquireLock = controller.acquireTerminalCompletionLock.bind(controller);
      vi.spyOn(controller, "acquireTerminalCompletionLock").mockImplementation((runId) => {
        const result = acquireLock(runId);
        queued.resolve();
        return result;
      });
      const completion = reconcileStaleActiveSubagentRun({
        runId: entry.runId,
        entry,
        now: 6_000,
        isCurrent: () => runs.get(entry.runId) === entry,
        completeSubagentRunWithRecovery: runtime.completeSubagentRunWithRecovery,
      });
      try {
        await queued.promise;
        if (ownership === "replaced") {
          runs.set(entry.runId, successor);
        } else if (ownership === "released") {
          runs.delete(entry.runId);
        }
        unlock();
        await completion;
        if (ownership === "current") {
          await waitForLifecycleState(() => {
            expect(entry.cleanupCompletedAt).toBeTypeOf("number");
          });
          expect(entry.execution.status).toBe("terminal");
          expect(entry.execution.outcome?.status).toBe("error");
          expect(terminalState.recordSubagentTerminalState).toHaveBeenCalledOnce();
          expect(helperMocks.persistSubagentSessionTiming).toHaveBeenCalledOnce();
          expect(controller.options.runSubagentAnnounceFlow).toHaveBeenCalledOnce();
          expect(
            browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
          ).toHaveBeenCalledOnce();
          expect(helperMocks.safeRemoveAttachmentsDir).toHaveBeenCalledOnce();
        } else {
          expect(runs.get(entry.runId)).toBe(ownership === "replaced" ? successor : undefined);
          expect(entry).toEqual(original);
          expect(successor).toEqual(successorBefore);
          expect(persistOrThrow).not.toHaveBeenCalled();
          expect(persist).not.toHaveBeenCalled();
          expect(terminalState.recordSubagentTerminalState).not.toHaveBeenCalled();
          expect(helperMocks.persistSubagentSessionTiming).not.toHaveBeenCalled();
          expect(lifecycleEventMocks.emitSessionLifecycleEvent).not.toHaveBeenCalled();
          expect(controller.options.runSubagentAnnounceFlow).not.toHaveBeenCalled();
          expect(
            browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
          ).not.toHaveBeenCalled();
          expect(notifyContextEngineSubagentEnded).not.toHaveBeenCalled();
          expect(helperMocks.safeRemoveAttachmentsDir).not.toHaveBeenCalled();
          expect(gatewayMocks.callGateway).not.toHaveBeenCalled();
        }
        expect(retryTimers.size).toBe(0);
        await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      } finally {
        unlock();
        await completion;
        controller.clearScheduledResumeTimers();
        for (const timer of retryTimers) {
          clearTimeout(timer);
        }
        orphanBootSegments.current = [];
        sessionReconciliationMocks.resolveSubagentRunOrphanReason.mockReturnValue(null);
        vi.restoreAllMocks();
      }
    },
  );

  it("does not reopen successor cleanup after orphan persistence fails twice", async () => {
    const entry = createRunEntry({ generation: 1 });
    const successor = createRunEntry({
      generation: 2,
      endedAt: 5_000,
      outcome: { status: "ok" },
      cleanupHandled: true,
    });
    const successorBefore = structuredClone(successor);
    const runs = new Map([[entry.runId, entry]]);
    const resumedRuns = new Set([entry.runId]);
    let attempts = 0;
    const persistOrThrow = vi.fn(() => {
      attempts += 1;
      if (attempts === 2) {
        runs.set(entry.runId, successor);
      }
      throw new Error("synthetic persistence failure");
    });
    const resumeSubagentRun = vi.fn();
    const warn = vi.fn();
    const controller = createLifecycleController({
      entry,
      runs,
      resumedRuns,
      persistOrThrow,
      resumeSubagentRun,
      warn,
    });
    const retryTimers = new Set<ReturnType<typeof setTimeout>>();
    const runtime = createSubagentRegistryCompletionRuntime({
      runs,
      resumed: resumedRuns,
      retryTimers,
      completeSubagentRun: controller.completeSubagentRun,
      scheduleSweep: vi.fn(),
      resumeRun: resumeSubagentRun,
      warn,
    });
    sessionReconciliationMocks.loadSubagentSessionEntry.mockReturnValue({
      sessionId: "child-session-id",
      status: "failed",
      startedAt: 2_000,
      endedAt: 4_000,
      updatedAt: 4_000,
    });
    try {
      await reconcileStaleActiveSubagentRun({
        runId: entry.runId,
        entry,
        now: 6_000,
        isCurrent: () => runs.get(entry.runId) === entry,
        completeSubagentRunWithRecovery: runtime.completeSubagentRunWithRecovery,
      });
      expect(persistOrThrow).toHaveBeenCalledTimes(2);
      expect(runs.get(entry.runId)).toBe(successor);
      expect(successor).toEqual(successorBefore);
      expect(resumedRuns.has(entry.runId)).toBe(true);
      expect(resumeSubagentRun).not.toHaveBeenCalled();
      expect(terminalState.recordSubagentTerminalState).not.toHaveBeenCalled();
      expect(helperMocks.persistSubagentSessionTiming).not.toHaveBeenCalled();
      expect(controller.options.runSubagentAnnounceFlow).not.toHaveBeenCalled();
      expect(
        browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
      ).not.toHaveBeenCalled();
      expect(gatewayMocks.callGateway).not.toHaveBeenCalled();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      controller.clearScheduledResumeTimers();
      for (const timer of retryTimers) {
        clearTimeout(timer);
      }
    }
  });

  it("does not apply a queued interrupted completion to a same-id successor", async () => {
    const entry = createRunEntry({
      generation: 1,
      expectsCompletionMessage: false,
    });
    const runs = new Map([[entry.runId, entry]]);
    const successor = createRunEntry({
      generation: 2,
      createdAt: 5_000,
      execution: { status: "running", startedAt: 5_000 },
    });
    const controller = createLifecycleController({ entry, runs });
    let releaseFirstCleanup!: () => void;
    let markFirstCleanupEntered!: () => void;
    const firstCleanupEntered = new Promise<void>((resolve) => {
      markFirstCleanupEntered = resolve;
    });
    const firstCleanupRelease = new Promise<void>((resolve) => {
      releaseFirstCleanup = resolve;
    });
    browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd.mockImplementationOnce(
      async () => {
        markFirstCleanupEntered();
        await firstCleanupRelease;
      },
    );

    const firstCompletion = completeRun(controller, entry, {
      triggerCleanup: true,
    });
    await firstCleanupEntered;
    const staleRecovery = controller.completeSubagentRun(
      makeInterruptedSubagentCompletion(entry, {
        expectedEntry: entry,
        endedAt: 4_001,
        outcome: { status: "error", error: "stale interrupted recovery" },
        triggerCleanup: true,
      }),
    );
    runs.set(entry.runId, successor);

    releaseFirstCleanup();
    await Promise.all([firstCompletion, staleRecovery]);

    expect(runs.get(entry.runId)).toBe(successor);
    expect(successor.execution).toEqual({ status: "running", startedAt: 5_000 });
    expect(successor.endedReason).toBeUndefined();
    expect(successor.terminalOwner).toBeUndefined();
  });

  it("drains the retire + announce tail for a duplicate completion held behind a slow first browser cleanup", async ({
    signal,
  }) => {
    // The dispatch flag dedupes only the browser tab-close IPC. A duplicate
    // completion caller must still reach retireRunModeBundleMcpRuntime and
    // startSubagentAnnounceCleanupFlow while the first caller's cleanup
    // promise is still pending, so a slow browser driver cannot strand
    // completion delivery behind it.
    const entry = createRunEntry({
      expectsCompletionMessage: true,
    });
    const announceEntered = createDeferredCore();
    const runSubagentAnnounceFlow = vi.fn(async () => {
      announceEntered.resolve();
      return "delivered" as const;
    });
    const controller = createLifecycleController({ entry, runSubagentAnnounceFlow });

    const releaseFirstCleanup = createDeferredCore();
    let firstCleanupParams:
      | Parameters<
          typeof import("../../../browser-lifecycle-cleanup.js").cleanupBrowserSessionsForLifecycleEnd
        >[0]
      | undefined;
    const firstCleanupEntered = createDeferredCore();
    browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd.mockImplementationOnce(
      (params) => {
        firstCleanupParams = params;
        firstCleanupEntered.resolve();
        return releaseFirstCleanup.promise;
      },
    );

    const completeParams = {
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" as const },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
      terminalReply: { disposition: "visible" as const, text: "final completion reply" },
    };

    // First caller takes the dispatch flag and parks inside the cleanup wrapper.
    const joinCleanup = observeRootWork();
    const firstCompletion = controller.completeSubagentRun(completeParams);
    try {
      await withinTest(firstCleanupEntered.promise, signal);

      // Second caller observes the flag set, skips the cleanup wrapper, and must
      // still drain the retire + announce tail without waiting on the first
      // caller's still-pending cleanup.
      await controller.completeSubagentRun({ ...completeParams, endedAt: 3_999 });
      await withinTest(announceEntered.promise, signal);

      expect(
        browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
      ).toHaveBeenCalledTimes(1);
      expect(readLifecycleRun(entry).execution.endedAt).toBe(4_000);
      expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).toHaveBeenCalled();
      expect(runSubagentAnnounceFlow).toHaveBeenCalled();
      expect(firstCleanupParams?.isCurrent?.()).toBe(true);
      expect(await firstCleanupParams?.prepareCurrent?.()).toBe(true);
    } finally {
      releaseFirstCleanup.resolve();
      await expect(firstCompletion).resolves.toBeUndefined();
      await joinCleanup();
    }
  });

  it("does not invalidate an active timeout tail when a published timeout is observed again", async ({
    signal,
  }) => {
    const entry = createRunEntry({
      expectsCompletionMessage: true,
      runTimeoutSeconds: 2,
    });
    const timingEntered = createDeferredCore();
    const releaseTiming = createDeferredCore();
    helperMocks.persistSubagentSessionTiming.mockImplementationOnce(() => {
      timingEntered.resolve();
      return releaseTiming.promise;
    });
    const runSubagentAnnounceFlow = vi.fn<LifecycleControllerParams["runSubagentAnnounceFlow"]>(
      async () => "delivered",
    );
    const controller = createLifecycleController({ entry, runSubagentAnnounceFlow });
    const completeParams = {
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "timeout" as const },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
    };

    const joinCleanup = observeRootWork();
    const firstCompletion = controller.completeSubagentRun(completeParams);
    try {
      await withinTest(timingEntered.promise, signal);
      expect(helperMocks.persistSubagentSessionTiming).toHaveBeenCalledOnce();
      await mutateLifecycleRun(entry, (draft) => {
        draft.endedHookEmittedAt = 4_000;
      });

      await controller.completeSubagentRun(completeParams);
    } finally {
      releaseTiming.resolve();
      await firstCompletion;
      await joinCleanup();
    }

    expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce();
    expect(runSubagentAnnounceFlow.mock.calls[0]?.[0]).toMatchObject({
      outcome: { status: "timeout" },
    });
  });
});

describe("requester settle wake trigger", () => {
  beforeEach(() => {
    mockBlockedCompletionDeliveryOwner(completionDeliveryMocks);
    helperMocks.safeRemoveAttachmentsDir.mockClear();
    helperMocks.logAnnounceGiveUp.mockClear();
    bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey.mockReset().mockResolvedValue(true);
    internalSessionEffectsMocks.removeInternalSessionEffectsSession
      .mockReset()
      .mockResolvedValue(undefined);
  });

  it.each(["completed", "stale-after-resolution", "restart-before-admission"] as const)(
    "owns context cleanup after its caller scope drains (%s)",
    async (mode) => {
      resetGatewayWorkAdmission();
      await resetContextEngineRuntimeQuarantineForTests();
      runtimeMocks.log.mockClear();
      const registry = createEmptyPluginRegistry();
      const resources = new PluginRegistryInspectionResources(retireInspectionInstances);
      resources.attach(registry);
      const retire = vi.fn();
      resources.register("fixture", { id: "cleanup-resource", dispose: retire });
      const factoryStarted = createDeferredCore();
      const factoryGate = createDeferredCore();
      const disposalStarted = createDeferredCore();
      const disposalGate = createDeferredCore();
      const descendantGate = createDeferredCore();
      const descendantDone = createDeferredCore();
      const onSubagentEnded = vi.fn(async () => {});
      const dispose = vi.fn(async () => {
        expect(retire).not.toHaveBeenCalled();
        disposalStarted.resolve();
        await disposalGate.promise;
      });
      const factory = vi.fn(async () => {
        expect(getAsyncWorkSignal()?.aborted).toBe(false);
        factoryStarted.resolve();
        await factoryGate.promise;
        return Object.assign(new LegacyContextEngine(), { onSubagentEnded, dispose });
      });
      registerContextEngineInRegistry(registry, "cleanup-owned", factory, "plugin:fixture");
      registerContextEngineInRegistry(registry, "legacy", () => new LegacyContextEngine(), "core");
      vi.mocked(getRuntimeConfig).mockReturnValue({
        plugins: { slots: { contextEngine: "cleanup-owned" } },
      });
      vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReturnValue(registry);
      const warn = vi.fn();
      const cleanup = createSubagentRegistryContextCleanup({
        isEndedHookOwnerCurrent: () => false,
        warn,
      });
      const entry = makeRunModeCleanupEntry("closed-cleanup-caller", { generation: 1 });
      const runs = new Map([[entry.runId, entry]]);
      const cleanupDone = createDeferredCore();
      const controller = createLifecycleController({
        entry,
        runs,
        notifyContextEngineSubagentEnded: async (params, options) => {
          try {
            await cleanup.notifyContextEngineSubagentEnded(params, options);
            // A cooperating descendant must keep the root counted even after notification returns.
            void trackAsyncWork(async () => {
              await descendantGate.promise;
              descendantDone.resolve();
            }).catch((error: unknown) => warn("descendant admission failed", { error }));
          } finally {
            cleanupDone.resolve();
          }
        },
      });
      const caller = new AsyncWorkScope();
      const continuation = caller.run(() => AsyncLocalStorage.snapshot());
      const suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension?.commit()).toBe(true);
      try {
        await continuation(() =>
          finishCleanup(controller, entry, {
            skipRequesterSettleWake: true,
          }),
        );
        // Admission is parked while the originating async owner becomes permanently closed.
        await caller.drain();
        expect(factory).not.toHaveBeenCalled();
        if (mode === "restart-before-admission") {
          markGatewayRestartDraining();
          await waitForLifecycleState(() =>
            expect(runtimeMocks.log).toHaveBeenCalledWith(
              expect.stringContaining("subagent context-engine cleanup failed"),
            ),
          );
          expect(factory).not.toHaveBeenCalled();
          expect(getActiveGatewayRootWorkCount()).toBe(0);
          expect(await listContextEngineQuarantines()).toEqual([]);
          return;
        }
        expect(suspension?.release()).toBe(true);
        await factoryStarted.promise;
        expect(factory).toHaveBeenCalledOnce();
        if (mode === "stale-after-resolution") {
          runs.set(entry.runId, createRunEntry({ generation: 2 }));
        }
        factoryGate.resolve();
        await disposalStarted.promise;
        expect(getActiveGatewayRootWorkHolders()).toContain("subagents:lifecycle-cleanup");
        await resources.release();
        expect(retire).not.toHaveBeenCalled();
        disposalGate.resolve();
        await cleanupDone.promise;
        expect(retire).toHaveBeenCalledOnce();
        expect(dispose).toHaveBeenCalledOnce();
        expect(onSubagentEnded).toHaveBeenCalledTimes(mode === "completed" ? 1 : 0);
        expect(warn).not.toHaveBeenCalled();
        expect(await listContextEngineQuarantines()).toEqual([]);
        expect(getActiveGatewayRootWorkHolders()).toContain("subagents:lifecycle-cleanup");
        descendantGate.resolve();
        await descendantDone.promise;
        await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      } finally {
        suspension?.release();
        factoryGate.resolve();
        disposalGate.resolve();
        descendantGate.resolve();
        await resources.release();
        await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
        vi.mocked(getRuntimeConfig).mockReset();
        vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReset();
        resetSubagentRegistryRuntimeLoadersForTests();
        await resetContextEngineRuntimeQuarantineForTests();
        resetGatewayWorkAdmission();
      }
    },
  );

  it("runs a detached settle wake outside a disposed requester transcript owner", async () => {
    const sessionKey = "agent:main:disposed-settle-wake-owner";
    const entry = createRunEntry({ requesterSessionKey: sessionKey, endedAt: 4_000 });
    let disposed = false;
    const wakeReady = createDeferredCore();
    const requesterTranscriptWrite = vi.fn();
    const withRequesterTranscriptWrite = async <T>(operation: () => Promise<T> | T): Promise<T> => {
      requesterTranscriptWrite();
      if (disposed) {
        throw new Error("attempt disposed before transcript write");
      }
      return await operation();
    };
    const freshTranscriptWrite = vi.fn(async () => {});
    const settleWake = vi.fn(async () => {
      await wakeReady.promise;
      await runWithOwnedSessionTranscriptWrite({ sessionKey }, freshTranscriptWrite);
      return false;
    });
    const controller = createLifecycleController({
      entry,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
    });

    await withOwnedSessionTranscriptWrites(
      { sessionKey, withTranscriptWrite: withRequesterTranscriptWrite },
      async () => {
        await finishCleanup(controller, entry);
      },
    );

    disposed = true;
    wakeReady.resolve();

    await waitForLifecycleState(() => expect(freshTranscriptWrite).toHaveBeenCalledOnce());
    expect(requesterTranscriptWrite).not.toHaveBeenCalled();
    expect(settleWake).toHaveBeenCalledOnce();
  });

  it.each(["replacement row", "newer child generation"])(
    "drops detached cleanup tails after a %s takes ownership",
    async (scenario) => {
      const entry = makeRunModeCleanupEntry("internal-run-1", {
        generation: 1,
        createdAt: 1_000,
        cleanup: "keep",
        execution: {
          startedAt: 2_000,
          outcome: { status: "ok" },
        },
      });
      const runs = new Map([[entry.runId, entry]]);
      const notifyContextEngineSubagentEnded = vi.fn(async () => {});
      const controller = createLifecycleController({
        entry,
        runs,
        notifyContextEngineSubagentEnded,
      });
      const suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension).not.toBeNull();
      expect(suspension?.commit()).toBe(true);

      await finishCleanup(controller, entry, {
        skipRequesterSettleWake: true,
      });
      const successor = createRunEntry({
        runId: scenario === "replacement row" ? entry.runId : "run-2",
        childSessionKey: entry.childSessionKey,
        generation: 2,
        createdAt: 6_000,
        execution: { status: "running", startedAt: 6_000 },
      });
      runs.set(successor.runId, successor);
      expect(suspension?.release()).toBe(true);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));

      expect(
        internalSessionEffectsMocks.removeInternalSessionEffectsSession,
      ).not.toHaveBeenCalled();
      expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).not.toHaveBeenCalled();
      expect(notifyContextEngineSubagentEnded).not.toHaveBeenCalled();
      expect(successor.execution).toEqual({ status: "running", startedAt: 6_000 });
    },
  );

  it.each(["wake", "discard", "provisional kill"] as const)(
    "settles keep-cleanup bookkeeping for %s",
    async (mode) => {
      const provisionalKill = mode === "provisional kill";
      const entry = createRunEntry({
        endedAt: 4_000,
        ...(provisionalKill
          ? {
              endedReason: SUBAGENT_ENDED_REASON_KILLED,
              killReconciliation: { killedAt: 4_000 },
            }
          : {}),
      });
      const settleWake = vi.fn(async () => false);
      const controller = createLifecycleController({
        entry,
        maybeWakeRequesterAfterAllChildrenSettled: settleWake,
      });
      await finishCleanup(controller, entry, {
        skipRequesterSettleWake: mode === "discard",
        provisionalKill,
      });
      expect(settleWake).toHaveBeenCalledTimes(mode === "wake" ? 1 : 0);
      if (mode === "wake") {
        expect(settleWake).toHaveBeenCalledWith({
          requesterSessionKey: "agent:main:main",
          requesterOrigin: undefined,
          settledEntry: expect.objectContaining({
            runId: entry.runId,
            childSessionKey: entry.childSessionKey,
          }),
          transitionBatch: expect.any(Function),
          completeBatch: expect.any(Function),
          isSourceCurrent: expect.any(Function),
        });
      }
      expect(readLifecycleRun(entry).requesterSettleWake).toEqual(
        mode === "wake" ? { status: "pending", attemptCount: 0 } : undefined,
      );
      if (provisionalKill) {
        expect(readLifecycleRun(entry).cleanupCompletedAt).toBeUndefined();
      }
    },
  );

  it.each(["delete", "killed"] as const)(
    "retains %s cleanup rows until the settle wake resolves",
    async (retirement) => {
      const cleanup = retirement === "delete" ? "delete" : "keep";
      const entry = createRunEntry({
        endedAt: 4_000,
        cleanup,
        ...(retirement === "killed" ? { endedReason: SUBAGENT_ENDED_REASON_KILLED } : {}),
      });
      const runs = new Map([[entry.runId, entry]]);
      const settleWake = vi.fn<
        LifecycleControllerParams["maybeWakeRequesterAfterAllChildrenSettled"]
      >(async () => false);
      const controller = createLifecycleController({
        entry,
        runs,
        maybeWakeRequesterAfterAllChildrenSettled: settleWake,
      });

      await controller.completeCleanupBookkeeping({
        runId: entry.runId,
        entry,
        cleanup,
        completedAt: 5_000,
      });

      expect(runs.has(entry.runId)).toBe(true);
      expect(readLifecycleRun(entry).requesterSettleWake).toEqual({
        status: "pending",
        attemptCount: 0,
        retireAfterSettle: true,
      });
      expect(settleWake).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          requesterSessionKey: "agent:main:main",
          settledEntry: expect.objectContaining({
            runId: entry.runId,
            childSessionKey: entry.childSessionKey,
          }),
        }),
      );
      const [settleParams] = settleWake.mock.calls[0]!;
      await settleParams.completeBatch(
        [settleParams.settledEntry],
        settleParams.settledEntry.requesterSettleWake?.rearmGeneration,
      );
      expect(runs.has(entry.runId)).toBe(false);
    },
  );

  it.each([
    { retirement: "settle", replaced: false },
    { retirement: "settle", replaced: true },
    { retirement: "immediate", replaced: false },
    { retirement: "immediate", replaced: true },
  ])(
    "fences $retirement retirement effects against a successor (replaced=$replaced)",
    async ({ retirement, replaced }) => {
      const entry = makeRunModeCleanupEntry("internal-retirement", { generation: 1 });
      const runs = new Map([[entry.runId, entry]]);
      const notifyContextEngineSubagentEnded = vi.fn(async () => {});
      const beforeWrite = vi.fn();
      const controller = createLifecycleController({
        entry,
        runs,
        beforeWrite,
        maybeWakeRequesterAfterAllChildrenSettled: vi.fn(async () => false),
        notifyContextEngineSubagentEnded,
      });
      const suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension?.commit()).toBe(true);
      const join = observeRootWork();
      try {
        await finishCleanup(controller, entry, {
          cleanup: "delete",
          skipRequesterSettleWake: retirement === "immediate",
        });
        expect(beforeWrite).toHaveBeenCalledOnce();
        if (retirement === "settle") {
          expect(readLifecycleRun(entry).requesterSettleWake?.retireAfterSettle).toBe(true);
          runs.delete(entry.runId);
        }
        expect(runs.has(entry.runId)).toBe(false);
        if (replaced) {
          const successor = createRunEntry({
            runId: "run-successor",
            childSessionKey: entry.childSessionKey,
            generation: 2,
            createdAt: 6_000,
            execution: { status: "running", startedAt: 6_000 },
          });
          runs.set(successor.runId, successor);
        }
      } finally {
        expect(suspension?.release()).toBe(true);
        await join();
      }
      for (const effect of [
        internalSessionEffectsMocks.removeInternalSessionEffectsSession,
        bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey,
        notifyContextEngineSubagentEnded,
      ]) {
        expect(effect).toHaveBeenCalledTimes(replaced ? 0 : 1);
      }
      if (!replaced) {
        expect(
          internalSessionEffectsMocks.removeInternalSessionEffectsSession,
        ).toHaveBeenCalledWith(entry.execution.transcriptTarget);
      }
    },
  );

  it("schedules every remaining requester wave after one batch resolves", async () => {
    const first = createRunEntry({
      runId: "run-first",
      childSessionKey: "agent:main:subagent:first-wave",
      endedAt: 4_000,
    });
    const later = createRunEntry({
      runId: "run-later",
      childSessionKey: "agent:main:subagent:later-wave",
      endedAt: 8_000,
    });
    later.requesterSettleWake = { status: "pending", attemptCount: 0 };
    const runs = new Map([
      [first.runId, first],
      [later.runId, later],
    ]);
    const settleWake = vi.fn(async (params: RequesterSettleWakeParams) => {
      if (params.settledEntry.runId === first.runId) {
        await params.completeBatch(
          [params.settledEntry],
          params.settledEntry.requesterSettleWake?.rearmGeneration,
        );
      }
      return false;
    });
    const controller = createLifecycleController({
      entry: first,
      runs,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
    });

    await finishCleanup(controller, first);

    await waitForLifecycleState(() => expect(settleWake).toHaveBeenCalledTimes(2));
    expect(settleWake.mock.calls.map(([params]) => params.settledEntry.runId)).toEqual([
      "run-first",
      "run-later",
    ]);
    expect(readLifecycleRun(later).requesterSettleWake).toEqual({
      status: "pending",
      attemptCount: 0,
    });
  });

  it("does not resume a persisted settle wake until its registry row is terminal", async () => {
    const entry = createRunEntry({
      requesterSettleWake: { status: "pending", attemptCount: 0 },
    });
    const settleWake = vi.fn(async () => false);
    const controller = createLifecycleController({
      entry,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
    });

    controller.resumeRequesterSettleWake(entry.runId, entry);
    await Promise.resolve();
    expect(settleWake).not.toHaveBeenCalled();

    await mutateLifecycleRun(entry, (draft) => {
      draft.execution = { ...draft.execution, status: "terminal", endedAt: 4_000 };
    });
    controller.resumeRequesterSettleWake(entry.runId, entry);

    await waitForLifecycleState(() => expect(settleWake).toHaveBeenCalledOnce());
  });

  it("keeps a yielded completion parked until its requester turn settles", async () => {
    const entry = createRunEntry({
      requesterTurnRunId: "run-requester",
      requesterTurnYielded: true,
      endedAt: 4_000,
      expectsCompletionMessage: true,
      delivery: { status: "delivered" },
    });
    const settleWake = vi.fn(async (params: RequesterSettleWakeParams) => {
      await params.completeBatch(
        [params.settledEntry],
        params.settledEntry.requesterSettleWake?.rearmGeneration,
      );
      return true;
    });
    const controller = createLifecycleController({
      entry,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
    });

    await finishCleanup(controller, entry);

    await Promise.resolve();
    expect(settleWake).not.toHaveBeenCalled();

    await settleRequesterTurn(controller, entry);

    await waitForLifecycleState(() => expect(settleWake).toHaveBeenCalledOnce());
    await settleWake.mock.results[0]?.value;
    expect(readLifecycleRun(entry).requesterSettleWake).toBeUndefined();
  });

  it.each([
    "unbound",
    "closed-receipt",
    "closed-in-flight",
    "throwing-in-flight",
    "closed-rearmed",
  ] as const)(
    "credits a yielded handoff only from settled delivery evidence: %s",
    async (ownership) => {
      const entry = createRunEntry({
        endedAt: 4_000,
        expectsCompletionMessage: true,
        requesterSettleWake: {
          status: "pending",
          attemptCount: 0,
          requesterYieldBatch: true,
          rearmGeneration: 1,
        },
      });
      let gatewayOpen = true;
      const gatewayContext = {};
      if (ownership !== "unbound") {
        bindGatewayContextResolver(entry, () => {
          if (!gatewayOpen && ownership === "throwing-in-flight") {
            throw new Error("Gateway owner unavailable");
          }
          return gatewayOpen ? (gatewayContext as never) : undefined;
        });
      }
      let settleParams: RequesterSettleWakeParams | undefined;
      const maybeWakeRequesterAfterAllChildrenSettled = vi.fn(async (params) => {
        settleParams = params;
        return false;
      });
      const runSubagentAnnounceFlow: LifecycleControllerParams["runSubagentAnnounceFlow"] = vi.fn(
        async (announceParams) => {
          await announceParams.onDeliveryResult?.({
            delivered: false,
            path: "none",
            reason: "completion_handoff_pending",
            terminal: true,
            disposition: "intentional_non_delivery",
          });
          return "intentional_non_delivery" as const;
        },
      );
      const previous = subagentRuns.get(entry.runId);
      subagentRuns.set(entry.runId, entry);
      onTestFinished(() => {
        if (previous) {
          subagentRuns.set(entry.runId, previous);
        } else {
          subagentRuns.delete(entry.runId);
        }
      });
      const controller = createLifecycleController({
        entry,
        runs: subagentRuns,
        maybeWakeRequesterAfterAllChildrenSettled,
        runSubagentAnnounceFlow,
      });

      await completeRun(controller, entry, {
        triggerCleanup: true,
        terminalReply: { disposition: "empty" },
      });
      await waitForLifecycleState(() =>
        expect(maybeWakeRequesterAfterAllChildrenSettled).toHaveBeenCalledOnce(),
      );
      expect(readLifecycleRun(entry).delivery).toMatchObject({
        status: "pending",
        disposition: "intentional_non_delivery",
        lastError: "completion_handoff_pending",
      });
      expect(readLifecycleRun(entry).delivery?.deliveredAt).toBeUndefined();

      gatewayOpen = false;
      if (ownership === "closed-rearmed") {
        await mutateLifecycleRun(entry, (draft) => {
          if (!draft.requesterSettleWake) {
            throw new Error("Expected pending requester wake");
          }
          draft.requesterSettleWake.rearmGeneration = 2;
        });
      }
      const pendingWake = structuredClone(readLifecycleRun(entry).requesterSettleWake);
      await settleParams?.completeBatch([entry], 1, {
        delivered: true,
        path: "direct",
        deliveredAt: 8_000,
        ...(ownership === "closed-receipt" || ownership === "closed-rearmed"
          ? { requesterVisibleFinalDelivered: true as const }
          : {}),
      });
      if (ownership.endsWith("in-flight") || ownership === "closed-rearmed") {
        expect(readLifecycleRun(entry).delivery?.status).toBe("pending");
        expect(readLifecycleRun(entry).requesterSettleWake).toEqual(pendingWake);
        return;
      }

      expect(readLifecycleRun(entry).delivery).toMatchObject({
        status: "delivered",
        disposition: "delivered",
        deliveredAt: 8_000,
        announcedAt: 8_000,
      });
    },
  );

  it("records suppressed completion delivery without retrying or waking the requester", async () => {
    const entry = createRunEntry({ endedAt: 4_000, expectsCompletionMessage: true });
    const maybeWakeRequesterAfterAllChildrenSettled = vi.fn(async () => false);
    const runSubagentAnnounceFlow: LifecycleControllerParams["runSubagentAnnounceFlow"] = vi.fn(
      async (announceParams) => {
        await announceParams.onDeliveryResult?.({
          delivered: false,
          path: "direct",
          reason: "delivery_suppressed",
          error: "cancelled_by_message_sending_hook",
          terminal: true,
          disposition: "intentional_non_delivery",
        });
        return "intentional_non_delivery" as const;
      },
    );
    const controller = createLifecycleController({
      entry,
      maybeWakeRequesterAfterAllChildrenSettled,
      runSubagentAnnounceFlow,
    });

    await completeRun(controller, entry, {
      triggerCleanup: true,
      terminalReply: { disposition: "visible", text: "Generated completion" },
    });
    await waitForLifecycleState(() =>
      expect(readLifecycleRun(entry).cleanupCompletedAt).toBeDefined(),
    );

    expect(readLifecycleRun(entry).delivery).toMatchObject({
      status: "failed",
      disposition: "intentional_non_delivery",
      lastError: "cancelled_by_message_sending_hook; delivery_suppressed",
    });
    expect(readLifecycleRun(entry).delivery?.deliveredAt).toBeUndefined();
    expect(readLifecycleRun(entry).delivery?.nextAttemptAt).toBeUndefined();
    expect(maybeWakeRequesterAfterAllChildrenSettled).not.toHaveBeenCalled();
  });

  it("does not transfer a partial batch after a suppressed delete-mode child retires", async () => {
    const entry = createRunEntry({
      runId: "suppressed-child",
      requesterTurnRunId: "requester-turn",
      cleanup: "delete",
      expectsCompletionMessage: true,
    });
    const sibling = createRunEntry({
      runId: "remaining-child",
      childSessionKey: "agent:main:subagent:remaining",
      requesterTurnRunId: "requester-turn",
      requesterTurnYielded: true,
      expectsCompletionMessage: true,
      endedAt: 4_000,
      delivery: { status: "delivered" },
    });
    const runs = new Map([entry, sibling].map((child) => [child.runId, child]));
    const acceptedSessionSpawns = [entry, sibling].map((child) => ({
      runId: child.runId,
      childSessionKey: child.childSessionKey,
      expectsCompletionMessage: true,
    }));
    let finalPostimage: SubagentRunRecord | undefined;
    const beforeWrite = vi.fn(({ postimages }: LifecycleFixtureWrite) => {
      const row = postimages.get(entry.runId);
      if (row) {
        finalPostimage = row;
      }
    });
    const settleWake = vi.fn(async () => false);
    const controller = createLifecycleController({
      entry,
      runs,
      beforeWrite,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
      runSubagentAnnounceFlow: async (params) => {
        await params.onDeliveryResult?.({
          delivered: false,
          path: "direct",
          reason: "delivery_suppressed",
          error: "cancelled_by_message_sending_hook",
          terminal: true,
          disposition: "intentional_non_delivery",
        });
        return "intentional_non_delivery";
      },
    });
    await completeRun(controller, entry, {
      triggerCleanup: true,
      terminalReply: { disposition: "visible", text: "Suppressed child result" },
    });
    await waitForLifecycleState(() => expect(runs.has(entry.runId)).toBe(false));
    expect(finalPostimage?.delivery?.status).toBe("failed");
    const before = structuredClone(runs);
    beforeWrite.mockClear();
    expect(
      await controller.settleRequesterTurnAfterSessionSpawns({
        requesterSessionKey: entry.requesterSessionKey,
        requesterTurnRunId: "requester-turn",
        requesterYielded: true,
        acceptedSessionSpawns,
      }),
    ).toBe(false);
    expect(runs).toEqual(before);
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(settleWake).not.toHaveBeenCalled();
  });

  it("marks yielded intentional non-delivery blocked after requester-settle exhaustion", async () => {
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: true,
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        requesterYieldBatch: true,
        rearmGeneration: 1,
      },
    });
    let settleParams: RequesterSettleWakeParams | undefined;
    const maybeWakeRequesterAfterAllChildrenSettled = vi.fn(async (params) => {
      settleParams = params;
      return false;
    });
    const runSubagentAnnounceFlow: LifecycleControllerParams["runSubagentAnnounceFlow"] = vi.fn(
      async (announceParams) => {
        await announceParams.onDeliveryResult?.({
          delivered: false,
          path: "none",
          reason: "completion_handoff_pending",
          terminal: true,
          disposition: "intentional_non_delivery",
        });
        return "intentional_non_delivery" as const;
      },
    );
    let pendingDescendantRuns = 0;
    const controller = createLifecycleController({
      entry,
      maybeWakeRequesterAfterAllChildrenSettled,
      runSubagentAnnounceFlow,
      countPendingDescendantRuns: async () => pendingDescendantRuns,
    });

    await completeRun(controller, entry, {
      triggerCleanup: true,
      terminalReply: { disposition: "empty" },
    });
    await waitForLifecycleState(() =>
      expect(maybeWakeRequesterAfterAllChildrenSettled).toHaveBeenCalledOnce(),
    );
    await settleParams?.completeBatch([entry], 1, {
      delivered: false,
      path: "none",
      error: "requester settle wake attempts exhausted",
    });

    expect(readLifecycleRun(entry).delivery).toMatchObject({
      status: "failed",
      disposition: "intentional_non_delivery",
      lastError: "requester settle wake attempts exhausted",
    });
    expect(readLifecycleRun(entry).requesterSettleWake).toBeUndefined();
    expect(readLifecycleRun(entry).suppressCompletionDelivery).toBe(true);

    await mutateLifecycleRun(entry, (draft) => {
      draft.cleanupCompletedAt = undefined;
      draft.cleanupHandled = false;
      draft.wakeOnDescendantSettle = true;
    });
    vi.mocked(runSubagentAnnounceFlow).mockClear();

    pendingDescendantRuns = 1;
    const joinDeferred = observeRootWork();
    expect(controller.startSubagentAnnounceCleanupFlow(entry)).toBe(true);
    await joinDeferred();
    expect(readLifecycleRun(entry).cleanupCompletedAt).toBeUndefined();
    expect(readLifecycleRun(entry).suppressCompletionDelivery).toBe(true);
    expect(readLifecycleRun(entry).wakeOnDescendantSettle).toBe(true);
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();

    pendingDescendantRuns = 0;
    expect(controller.startSubagentAnnounceCleanupFlow(entry)).toBe(true);
    await waitForLifecycleState(() =>
      expect(readLifecycleRun(entry).cleanupCompletedAt).toEqual(expect.any(Number)),
    );

    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(readLifecycleRun(entry).suppressCompletionDelivery).toBeUndefined();
    expect(readLifecycleRun(entry).wakeOnDescendantSettle).toBeUndefined();
    expect(readLifecycleRun(entry).requesterSettleWake).toBeUndefined();
    expect(readLifecycleRun(entry).delivery?.status === "delivered").toBe(false);
  });

  it.each(["committed", "failed persistence", "stale generation"] as const)(
    "retires requester cron authority only after its own wake cleanup is %s",
    async (mode) => {
      const requesterTurnRunId = "cron-authority-requester";
      const requesterSessionId = "cron-authority-session";
      const entry = createRunEntry({
        requesterTurnRunId,
        requesterAgentId: "main",
        endedAt: 4_000,
        expectsCompletionMessage: true,
        delivery: { status: "delivered" },
      });
      const requesterSessionKey = entry.requesterSessionKey;
      subagentRuns.set(entry.runId, entry);
      const runs = subagentRuns;
      const sharing = await import("../../../gateway/session-sharing-preparation.js");
      const target = {
        agentId: "main",
        canonicalKey: requesterSessionKey,
        storeKey: requesterSessionKey,
        storeKeys: [requesterSessionKey],
        storePath: "/synthetic/requester.sqlite",
      };
      const sessionFacts = vi.spyOn(sharing, "prepareSessionMutationFacts").mockResolvedValue({
        storageTarget: target,
        bindCreation: vi.fn(),
        readCurrent: () => ({
          target: { ...target, entry: { sessionId: requesterSessionId, updatedAt: 1 } },
          membership: new Set(),
        }),
        release: vi.fn(),
      });
      const { operationalRunInstance } = createTestAdmittedRunContext(requesterTurnRunId);
      const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
      registerAgentRunContext(requesterTurnRunId, {
        sessionKey: requesterSessionKey,
        sessionId: requesterSessionId,
        agentId: "main",
      });
      const capability = createCronCreatorAuthorityCapability(
        requesterTurnRunId,
        { kind: "unknown" },
        { source: "control-ui-admin" },
      )!;
      try {
        await runWithCronCreatorAuthorityCapability(capability, () =>
          withGatewayToolCallerIdentity(
            {
              agentId: "main",
              sessionKey: requesterSessionKey,
              operationalRunInstance,
              approvalAuthority: authority,
            },
            async () => {
              expect(
                await markRequesterTurnYieldedWithAuthority({
                  requesterSessionKey,
                  requesterAgentId: "main",
                  requesterTurnRunId,
                  runs,
                  transfer: createRequesterInitialTransferFixture(runs, () => undefined),
                }),
              ).toBe(1);
            },
          ),
        );
        expect(
          await settleRequesterTurnAfterSessionSpawns({
            requesterSessionKey,
            requesterAgentId: "main",
            requesterTurnRunId,
            requesterYielded: true,
            acceptedSessionSpawns: [
              {
                runId: entry.runId,
                childSessionKey: entry.childSessionKey,
                expectsCompletionMessage: true,
              },
            ],
            runs,
            transfer: createRequesterInitialTransferFixture(runs, () => undefined),
            schedule: () => undefined,
          }),
        ).toBe(true);
        const capturedEntry = runs.get(entry.runId)!;
        const wake = capturedEntry.requesterSettleWake!;
        let settleParams: RequesterSettleWakeParams | undefined;
        const beforeWrite = vi.fn();
        const controller = createLifecycleController({
          entry,
          runs,
          beforeWrite,
          maybeWakeRequesterAfterAllChildrenSettled: vi.fn(async (params) => {
            settleParams = params;
            return false;
          }),
        });
        controller.resumeRequesterSettleWake(entry.runId, entry);
        await waitForLifecycleState(() => expect(settleParams).toBeDefined());
        const admitted = settleParams!;
        const admittedGeneration = admitted.settledEntry.requesterSettleWake?.rearmGeneration;
        if (mode === "failed persistence") {
          beforeWrite.mockImplementationOnce(() => {
            throw new Error("write failed");
          });
          await expect(
            admitted.completeBatch([admitted.settledEntry], admittedGeneration),
          ).rejects.toThrow("write failed");
        } else {
          await admitted.completeBatch(
            [admitted.settledEntry],
            mode === "stale generation" ? 0 : admittedGeneration,
          );
        }
        // The immutable pre-settlement value cannot resurrect committed outbox custody.
        await withRequesterCronAuthority(
          {
            requesterSessionKey,
            requesterSessionId,
            requesterAgentId: "main",
            batch: [capturedEntry],
            rearmGeneration: wake.rearmGeneration,
            runId: "cron-authority-continuation",
            isCurrent: () => true,
          },
          async () => {
            const admission = consumeRequesterCronAuthorityAdmission({
              runId: "cron-authority-continuation",
              sessionKey: requesterSessionKey,
              sessionId: requesterSessionId,
              inputProvenance: {
                kind: "inter_session",
                sourceTool: "subagent_settle",
                sourceSessionKey: entry.childSessionKey,
              },
            });
            expect(Boolean(admission)).toBe(mode !== "committed");
          },
        );
      } finally {
        revokeRequesterCronAuthority(requesterSessionKey);
        subagentRuns.delete(entry.runId);
        releaseAgentRunDelegatedAuthority(authority);
        clearAgentRunContext(requesterTurnRunId);
        sessionFacts.mockRestore();
      }
    },
  );

  it("keeps the complete requester batch unchanged when its atomic settlement fails", async () => {
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: true,
      requesterSettleWake: { status: "pending", attemptCount: 0, rearmGeneration: 1 },
    });
    let settleParams: RequesterSettleWakeParams | undefined;
    const controller = createLifecycleController({
      entry,
      maybeWakeRequesterAfterAllChildrenSettled: vi.fn(async (params) => {
        settleParams = params;
        return false;
      }),
      runSubagentAnnounceFlow: vi.fn(async () => "intentional_non_delivery" as const),
    });
    await completeRun(controller, entry, {
      triggerCleanup: true,
      terminalReply: { disposition: "empty" },
    });
    await waitForLifecycleState(() => expect(settleParams).toBeDefined());
    const before = structuredClone(readLifecycleRun(entry));
    completionDeliveryMocks.mutateRequesterCompletionBatch.mockRejectedValueOnce(
      new Error("bookkeeping write failed"),
    );

    await expect(
      settleParams!.completeBatch([entry], 1, {
        delivered: false,
        path: "none",
        error: "requester settle wake failed",
      }),
    ).rejects.toThrow("bookkeeping write failed");
    expect(readLifecycleRun(entry)).toEqual(before);
  });

  it("retains a delete-mode child after no-wake until its requester turn settles", async () => {
    const entry = createRunEntry({
      requesterTurnRunId: "run-requester",
      cleanup: "delete",
      expectsCompletionMessage: true,
      completion: { required: true, resultText: "delete-mode findings" },
    });
    const runs = new Map([[entry.runId, entry]]);
    const settleWake = vi.fn(async (params: RequesterSettleWakeParams) => {
      await params.completeBatch(
        [params.settledEntry],
        params.settledEntry.requesterSettleWake?.rearmGeneration,
      );
      return false;
    });
    const runSubagentAnnounceFlow = vi.fn(async () => "delivered" as const);
    const controller = createLifecycleController({
      entry,
      runs,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
      runSubagentAnnounceFlow,
    });

    await completeAndJoinCleanup(controller, entry, { triggerCleanup: true });
    await Promise.resolve();

    // The child cannot wake its requester while that exact requester turn owns it.
    expect(readLifecycleRun(entry).completion?.resultText).toBe("delete-mode findings");
    expect(runs.has(entry.runId)).toBe(true);
    expect(readLifecycleRun(entry).requesterSettleWake).toMatchObject({
      status: "pending",
      retireAfterSettle: true,
    });
    expect(readLifecycleRun(entry).retireAfterRequesterTurn).toBeUndefined();
    expect(settleWake).not.toHaveBeenCalled();

    await settleRequesterTurn(controller, entry, false);
    await waitForLifecycleState(() => expect(settleWake).toHaveBeenCalledTimes(1));
    await settleWake.mock.results[0]?.value;

    expect(settleWake).toHaveBeenCalledWith(
      expect.objectContaining({
        settledEntry: expect.objectContaining({
          runId: entry.runId,
          completion: expect.objectContaining({ resultText: "delete-mode findings" }),
        }),
      }),
    );
    expect(runs.has(entry.runId)).toBe(false);
  });

  it("retires delete cleanup immediately without a completion message", async () => {
    const entry = createRunEntry({
      requesterTurnRunId: "run-requester",
      cleanup: "delete",
      completion: { required: false, resultText: "delete-mode findings" },
    });
    const runs = new Map([[entry.runId, entry]]);
    const settleWake = vi.fn(async (params: RequesterSettleWakeParams) => {
      await params.completeBatch(
        [params.settledEntry],
        params.settledEntry.requesterSettleWake?.rearmGeneration,
      );
      return false;
    });
    const runSubagentAnnounceFlow = vi.fn(async () => "delivered" as const);
    const controller = createLifecycleController({
      entry,
      runs,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
      runSubagentAnnounceFlow,
    });

    await completeRun(controller, entry, { triggerCleanup: true });
    await waitForLifecycleState(() => expect(settleWake).toHaveBeenCalledTimes(1));
    await settleWake.mock.results[0]?.value;
    expect(runs.has(entry.runId)).toBe(false);
  });

  it("restores a suspended delete row without cleanup effects when retirement fails", async () => {
    const entry = makeRunModeCleanupEntry("internal-failed-retirement", {
      delivery: {
        status: "discarded",
        discardedAt: 5_000,
        discardReason: "expired",
      },
    });
    const deferredEntry = createRunEntry({
      runId: "run-2",
      childSessionKey: "agent:main:subagent:deferred-child",
      endedAt: 4_000,
      expectsCompletionMessage: true,
    });
    const runs = new Map([
      [entry.runId, entry],
      [deferredEntry.runId, deferredEntry],
    ]);
    const resumeSubagentRun = vi.fn();
    const notifyContextEngineSubagentEnded = vi.fn(async () => {});
    const controller = createLifecycleController({
      entry,
      runs,
      resumeSubagentRun,
      notifyContextEngineSubagentEnded,
      beforeWrite: vi.fn(() => {
        throw new Error("registry deletion failed");
      }),
    });

    await expect(
      finishCleanup(controller, entry, {
        cleanup: "delete",
        skipRequesterSettleWake: true,
      }),
    ).rejects.toMatchObject({
      outcome: "not-committed",
      cause: { message: "registry deletion failed" },
    });

    expect(runs.has(entry.runId)).toBe(true);
    expect(resumeSubagentRun).not.toHaveBeenCalled();
    expect(internalSessionEffectsMocks.removeInternalSessionEffectsSession).not.toHaveBeenCalled();
    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).not.toHaveBeenCalled();
    expect(notifyContextEngineSubagentEnded).not.toHaveBeenCalled();
  });

  it("re-arms a deferred frozen batch at its persisted retry deadline", async () => {
    const entry = createRunEntry({ endedAt: 4_000 });
    let invocation = 0;
    const settleWake = vi.fn(async (params: RequesterSettleWakeParams) => {
      invocation += 1;
      if (invocation === 1) {
        await params.transitionBatch(
          [params.settledEntry],
          {
            status: "pending",
            attemptCount: 0,
            nextAttemptAt: 30_000,
            batchRunIds: [entry.runId],
          },
          () => {},
        );
      } else {
        await params.completeBatch([params.settledEntry]);
      }
      return false;
    });
    const controller = createLifecycleController({
      entry,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
    });

    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      await finishCleanup(controller, entry);
      await vi.advanceTimersByTimeAsync(0);
      expect(settleWake).toHaveBeenCalledTimes(1);
      controller.resumeRequesterSettleWake(entry.runId, entry);
      controller.resumeRequesterSettleWake(entry.runId, entry);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(29_999);
      expect(settleWake).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(settleWake).toHaveBeenCalledTimes(2);
      expect(readLifecycleRun(entry).requesterSettleWake).toBeUndefined();
    } finally {
      controller.clearScheduledResumeTimers();
      vi.useRealTimers();
    }
  });

  it("lets a fresh yield wake preempt a stale retry timer", async () => {
    const entry = createRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: true,
      delivery: { status: "delivered" },
      requesterSettleWake: {
        status: "pending",
        attemptCount: 1,
        nextAttemptAt: 120_000,
        rearmGeneration: 1,
      },
    });
    const settleWake = vi.fn(async (params: RequesterSettleWakeParams) => {
      await params.completeBatch(
        [params.settledEntry],
        params.settledEntry.requesterSettleWake?.rearmGeneration,
      );
      return true;
    });
    const controller = createLifecycleController({
      entry,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
    });

    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      controller.resumeRequesterSettleWake(entry.runId, entry);
      expect(vi.getTimerCount()).toBe(1);

      await mutateLifecycleRun(entry, (draft) => {
        draft.requesterTurnRunId = "run-requester";
        draft.requesterTurnYielded = true;
      });
      expect(await settleRequesterTurn(controller, entry)).toBe(true);
      await vi.advanceTimersByTimeAsync(0);

      expect(settleWake).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(settleWake).toHaveBeenCalledOnce();
    } finally {
      controller.clearScheduledResumeTimers();
      vi.useRealTimers();
    }
  });

  it("does not re-arm coalesced batch rows whose retry deadline already passed", async () => {
    const state = {
      status: "pending" as const,
      attemptCount: 1,
      nextAttemptAt: 5_000,
      batchRunIds: ["run-a", "run-b"],
    };
    const first = createRunEntry({
      runId: "run-a",
      endedAt: 4_000,
      requesterSettleWake: { ...state },
    });
    const second = createRunEntry({
      runId: "run-b",
      endedAt: 4_000,
      requesterSettleWake: { ...state },
    });
    const runs = new Map([
      [first.runId, first],
      [second.runId, second],
    ]);
    const settleWake = vi.fn(async () => false);
    const controller = createLifecycleController({
      entry: first,
      runs,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
    });

    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    try {
      controller.resumeRequesterSettleWake(first.runId, first);
      controller.resumeRequesterSettleWake(second.runId, second);
      await vi.advanceTimersByTimeAsync(0);

      expect(settleWake).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      controller.clearScheduledResumeTimers();
      vi.useRealTimers();
    }
  });

  it.each(["ok", "timeout"] as const)(
    "wakes the requester exactly once after %s announce give-up",
    async (status) => {
      const entry = createRunEntry({
        endedAt: 4_000,
        expectsCompletionMessage: true,
        cleanup: "keep",
        endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
        outcome: { status },
      });
      const settleWake = vi.fn<
        LifecycleControllerParams["maybeWakeRequesterAfterAllChildrenSettled"]
      >(async () => false);
      const controller = createLifecycleController({
        entry,
        maybeWakeRequesterAfterAllChildrenSettled: settleWake,
      });
      await controller.finalizeResumedAnnounceGiveUp({ entry, reason: "expiry" });
      expect(readLifecycleRun(entry).delivery?.status).toBe(
        status === "ok" ? "suspended" : "failed",
      );
      expect(settleWake).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          requesterSessionKey: "agent:main:main",
          settledEntry: expect.objectContaining({ runId: entry.runId }),
        }),
      );
      if (status === "timeout") {
        expect(readLifecycleRun(entry).cleanupCompletedAt).toBeTypeOf("number");
        return;
      }
      expect(readLifecycleRun(entry).cleanupCompletedAt).toBeUndefined();
      expect(readLifecycleRun(entry).requesterSettleWake).toEqual({
        status: "pending",
        attemptCount: 0,
      });
      const { completeBatch } = settleWake.mock.calls[0]![0];
      await completeBatch([entry], undefined, { delivered: true, path: "direct" });
      expect(readLifecycleRun(entry).delivery?.status).toBe("suspended");
    },
  );

  registerRequesterDatabaseAdmissionTests({ createLifecycleController, waitForLifecycleState });

  it.each(["yielded", "replacement"])(
    "preserves a newer %s batch when an admitted wake rejects",
    async (kind) => {
      const entry = createRunEntry({
        endedAt: 4_000,
        expectsCompletionMessage: true,
        delivery: { status: "delivered" },
      });
      const admittedWake = createDeferredCore<boolean>();
      const runs = new Map([[entry.runId, entry]]);
      const warn = vi.fn();
      let wakeCount = 0;
      const settleWake = vi.fn(async (params: RequesterSettleWakeParams) => {
        wakeCount += 1;
        if (wakeCount === 1) {
          return await admittedWake.promise;
        }
        await params.completeBatch(
          [params.settledEntry],
          params.settledEntry.requesterSettleWake?.rearmGeneration,
          {
            delivered: true,
            path: "direct",
          },
        );
        return true;
      });
      const controller = createLifecycleController({
        entry,
        runs,
        warn,
        maybeWakeRequesterAfterAllChildrenSettled: settleWake,
      });

      await finishCleanup(controller, entry);
      await waitForLifecycleState(() => expect(settleWake).toHaveBeenCalledOnce());

      let current = readLifecycleRun(entry);
      const previousWake = structuredClone(current.requesterSettleWake);
      if (kind === "replacement") {
        current = { ...structuredClone(current), generation: (current.generation ?? 0) + 1 };
        runs.set(entry.runId, current);
      } else {
        await mutateLifecycleRun(entry, (draft) => {
          draft.requesterTurnRunId = "run-requester";
          draft.requesterTurnYielded = true;
        });
        expect(await settleRequesterTurn(controller, entry)).toBe(true);
        expect(readLifecycleRun(entry).requesterSettleWake).toMatchObject({
          requesterYieldBatch: true,
          afterRequesterYield: true,
          rearmGeneration: 1,
        });
      }

      admittedWake.reject(new Error("wake exploded"));
      await waitForLifecycleState(() =>
        expect(warn).toHaveBeenCalledWith("requester settle wake failed", expect.anything()),
      );
      if (kind === "replacement") {
        expect(current.requesterSettleWake).toEqual(previousWake);
        expect(current.requesterSettleWake).toBeDefined();
        controller.resumeRequesterSettleWake(current.runId, current);
      }
      await waitForLifecycleState(() => expect(settleWake).toHaveBeenCalledTimes(2));
      await waitForLifecycleState(() =>
        expect(runs.get(current.runId)?.requesterSettleWake).toBeUndefined(),
      );
    },
  );

  it("holds the settle wake as tracked root work so restart drain waits for its turn", async () => {
    resetGatewayWorkAdmission();
    try {
      const entry = createRunEntry({ endedAt: 4_000 });
      let releaseWake: (() => void) | undefined;
      const settleWake = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            releaseWake = () => resolve(false);
          }),
      );
      const controller = createLifecycleController({
        entry,
        maybeWakeRequesterAfterAllChildrenSettled: settleWake,
      });

      // Schedule from inside an admitted cleanup parent that finishes before
      // the wake settles — the quiescence window: the wake must reserve its
      // own root before the parent releases.
      await runWithGatewayIndependentRootWorkAdmission(async () => {
        await finishCleanup(controller, entry);
      });
      expect(settleWake).toHaveBeenCalledTimes(1);
      await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(1));

      // A restart drain arriving between scheduling and the wake's gateway
      // turn must wait for the wake instead of reporting quiescence.
      markGatewayRestartDraining();
      expect(getActiveGatewayRootWorkCount()).toBe(1);

      releaseWake?.();
      await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    } finally {
      resetGatewayWorkAdmission();
    }
  });

  it.each([
    { replaceQueued: false, canonicalBindings: false },
    { replaceQueued: true, canonicalBindings: false },
    { replaceQueued: true, canonicalBindings: true },
  ])(
    "reserves Gateway roots before the limiter (queued row replaced: $replaceQueued, canonical bindings: $canonicalBindings)",
    async ({ replaceQueued, canonicalBindings }) => {
      resetGatewayWorkAdmission();
      const entries = [0, 1, 2].map((index) =>
        createRunEntry({
          runId: `run-restored-admission-${index}`,
          requesterSessionKey: `agent:main:requester-${index}`,
          endedAt: 4_000,
          requesterSettleWake: { status: "pending", attemptCount: 2 },
        }),
      );
      const bindExecutionResolver = (entry: SubagentRunRecord, owner: () => undefined) => {
        const resolve = vi.fn(() => {
          throw new Error("execution resolver is retired");
        });
        bindGatewayContextResolver(resolve, owner);
        bindGatewayContextResolver(entry, resolve);
        return resolve;
      };
      const originalOwner = () => undefined;
      const executionResolvers = canonicalBindings
        ? entries.map((entry) => bindExecutionResolver(entry, originalOwner))
        : [];
      const runs = new Map(entries.map((entry) => [entry.runId, entry] as const));
      const releases = new Map<string, () => void>();
      const settleWake = vi.fn(async (params: RequesterSettleWakeParams) => {
        await new Promise<void>((resolve) => {
          releases.set(params.settledEntry.runId, resolve);
        });
        // Retired bindings leave delivery pending; limiter admission needs only their owner identity.
        if (!canonicalBindings) {
          await params.completeBatch(
            [params.settledEntry],
            params.settledEntry.requesterSettleWake?.rearmGeneration,
          );
        }
        return false;
      });
      const controller = createLifecycleController({
        entry: entries[0]!,
        runs,
        maybeWakeRequesterAfterAllChildrenSettled: settleWake,
      });

      try {
        await runWithGatewayIndependentRootWorkAdmission(async () => {
          for (const entry of entries) {
            controller.resumeRequesterSettleWake(entry.runId, entry, "restore");
          }
        });
        await waitForLifecycleState(() => expect(settleWake).toHaveBeenCalledTimes(2));
        // The third callback is queued behind the two wake executions, but its
        // Gateway root is already reserved and therefore visible to drain.
        expect(getActiveGatewayRootWorkCount()).toBe(3);
        expect(getActiveGatewayRootWorkHolders()).toEqual(["subagents:lifecycle-wake (3)"]);
        const queued = entries[2]!;
        const current = replaceQueued
          ? { ...structuredClone(queued), generation: (queued.generation ?? 0) + 1 }
          : queued;
        if (replaceQueued) {
          runs.set(current.runId, current);
          if (canonicalBindings) {
            executionResolvers.push(bindExecutionResolver(current, () => undefined));
          }
          controller.resumeRequesterSettleWake(current.runId, current, "restore");
          if (canonicalBindings) {
            // The replacement Gateway owns a fresh lane while both original slots remain occupied.
            await waitForLifecycleState(() => expect(settleWake).toHaveBeenCalledTimes(3));
            expect(settleWake.mock.calls[2]![0].settledEntry).toBe(current);
          }
        }
        markGatewayRestartDraining();
        expect(getActiveGatewayRootWorkCount()).toBe(replaceQueued ? 4 : 3);
        releases.get(entries[0]!.runId)?.();
        await waitForLifecycleState(() => expect(settleWake).toHaveBeenCalledTimes(3));
        expect(settleWake.mock.calls[2]![0].settledEntry).toBe(current);
        await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(2));
        expect(runs.get(current.runId)?.requesterSettleWake).toEqual({
          status: "pending",
          attemptCount: 2,
        });
        controller.resumeRequesterSettleWake(current.runId, current, "restore");
        expect(settleWake).toHaveBeenCalledTimes(3);

        releases.get(current.runId)?.();
        if (canonicalBindings) {
          await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(1));
          expect(runs.get(current.runId)?.requesterSettleWake).toEqual({
            status: "pending",
            attemptCount: 2,
          });
        } else {
          await waitForLifecycleState(() =>
            expect(runs.get(current.runId)?.requesterSettleWake).toBeUndefined(),
          );
        }
        expect(runs.get(entries[1]!.runId)?.requesterSettleWake).toBeDefined();
        releases.get(entries[1]!.runId)?.();
        await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
        if (replaceQueued) {
          expect(queued.requesterSettleWake).toEqual({ status: "pending", attemptCount: 2 });
        }
        executionResolvers.forEach((resolve) => expect(resolve).not.toHaveBeenCalled());
      } finally {
        while (releases.size > 0) {
          const pending = Array.from(releases.values());
          releases.clear();
          pending.forEach((release) => release());
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
        }
        controller.clearScheduledResumeTimers();
        resetGatewayWorkAdmission();
      }
    },
  );

  it("does not throttle live requester-settle wakes", async () => {
    resetGatewayWorkAdmission();
    const entries = [0, 1, 2].map((index) =>
      createRunEntry({
        runId: `run-live-admission-${index}`,
        requesterSessionKey: `agent:main:live-requester-${index}`,
        endedAt: 4_000,
        requesterSettleWake: { status: "pending", attemptCount: 0 },
      }),
    );
    const runs = new Map(entries.map((entry) => [entry.runId, entry] as const));
    const releases = new Map<string, () => void>();
    const settleWake = vi.fn(async (params: RequesterSettleWakeParams) => {
      await new Promise<void>((resolve) => {
        releases.set(params.settledEntry.runId, resolve);
      });
      await params.completeBatch(
        [params.settledEntry],
        params.settledEntry.requesterSettleWake?.rearmGeneration,
      );
      return false;
    });
    const controller = createLifecycleController({
      entry: entries[0]!,
      runs,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
    });

    try {
      for (const entry of entries) {
        controller.resumeRequesterSettleWake(entry.runId, entry);
      }
      await waitForLifecycleState(() => expect(settleWake).toHaveBeenCalledTimes(3));
    } finally {
      for (const release of releases.values()) {
        release();
      }
      await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      controller.clearScheduledResumeTimers();
      resetGatewayWorkAdmission();
    }
  });

  it("retires restored classification after a rejected wake settles", async () => {
    resetGatewayWorkAdmission();
    const entries = [0, 1, 2].map((index) =>
      createRunEntry({
        runId: `run-restored-rejection-${index}`,
        childSessionKey: `agent:main:subagent:restored-rejection-${index}`,
        requesterSessionKey: `agent:main:rejection-requester-${index}`,
        endedAt: 4_000,
        requesterSettleWake: { status: "pending", attemptCount: 0 },
      }),
    );
    const rejected = entries[0]!;
    const runs = new Map(entries.map((entry) => [entry.runId, entry] as const));
    const attempts = new Map<string, number>();
    const releases = new Map<string, () => void>();
    const settleWake = vi.fn(async (params: RequesterSettleWakeParams) => {
      const runId = params.settledEntry.runId;
      const attempt = (attempts.get(runId) ?? 0) + 1;
      attempts.set(runId, attempt);
      if (runId === rejected.runId && attempt === 1) {
        throw new Error("wake exploded");
      }
      await new Promise<void>((resolve) => {
        releases.set(runId, resolve);
      });
      await params.completeBatch(
        [params.settledEntry],
        params.settledEntry.requesterSettleWake?.rearmGeneration,
      );
      return false;
    });
    const controller = createLifecycleController({
      entry: rejected,
      runs,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
    });

    try {
      for (const entry of entries) {
        controller.resumeRequesterSettleWake(entry.runId, entry, "restore");
      }
      await waitForLifecycleState(() => expect(settleWake).toHaveBeenCalledTimes(3));
      await waitForLifecycleState(() =>
        expect(runs.get(rejected.runId)?.requesterSettleWake).toBeUndefined(),
      );

      await mutateLifecycleRun(rejected, (draft) => {
        draft.requesterSettleWake = { status: "pending", attemptCount: 0 };
      });
      controller.resumeRequesterSettleWake(rejected.runId, rejected);
      await waitForLifecycleState(() => expect(settleWake).toHaveBeenCalledTimes(4));
    } finally {
      while (releases.size > 0) {
        const pending = Array.from(releases.values());
        releases.clear();
        pending.forEach((release) => release());
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
      await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      controller.clearScheduledResumeTimers();
      resetGatewayWorkAdmission();
    }
  });

  it("keeps restored requester-settle retries behind the recovery cap", async () => {
    resetGatewayWorkAdmission();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const entries = [0, 1, 2].map((index) =>
      createRunEntry({
        runId: `run-restored-retry-${index}`,
        childSessionKey: `agent:main:subagent:restored-retry-${index}`,
        requesterSessionKey: `agent:main:retry-requester-${index}`,
        endedAt: 4_000,
        requesterSettleWake: { status: "pending", attemptCount: 0 },
      }),
    );
    const runs = new Map(entries.map((entry) => [entry.runId, entry] as const));
    const attempts = new Map<string, number>();
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const settleWake = vi.fn(async (params: RequesterSettleWakeParams) => {
      const runId = params.settledEntry.runId;
      const attempt = (attempts.get(runId) ?? 0) + 1;
      attempts.set(runId, attempt);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      if (attempt === 1) {
        await params.transitionBatch(
          [params.settledEntry],
          { status: "pending", attemptCount: 1, nextAttemptAt: 100, batchRunIds: [runId] },
          () => {},
        );
      } else {
        await params.completeBatch(
          [params.settledEntry],
          params.settledEntry.requesterSettleWake?.rearmGeneration,
        );
      }
      active -= 1;
      return false;
    });
    const controller = createLifecycleController({
      entry: entries[0]!,
      runs,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
    });

    try {
      for (const entry of entries) {
        controller.resumeRequesterSettleWake(entry.runId, entry, "restore");
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(settleWake).toHaveBeenCalledTimes(2);
      expect(maxActive).toBe(2);
      releases.splice(0, 2).forEach((release) => release());
      await vi.advanceTimersByTimeAsync(0);
      expect(settleWake).toHaveBeenCalledTimes(3);
      releases.shift()?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(
        entries.map((entry) => runs.get(entry.runId)?.requesterSettleWake?.nextAttemptAt),
      ).toEqual([100, 100, 100]);
      expect(vi.getTimerCount()).toBe(3);

      await vi.advanceTimersByTimeAsync(100);
      expect(settleWake).toHaveBeenCalledTimes(5);
      expect(maxActive).toBe(2);
      releases.splice(0, 2).forEach((release) => release());
      await vi.advanceTimersByTimeAsync(0);
      expect(settleWake).toHaveBeenCalledTimes(6);
      releases.shift()?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(active).toBe(0);
      expect(maxActive).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        releases.splice(0).forEach((release) => release());
        await vi.runOnlyPendingTimersAsync();
      }
      controller.clearScheduledResumeTimers();
      vi.useRealTimers();
      resetGatewayWorkAdmission();
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
