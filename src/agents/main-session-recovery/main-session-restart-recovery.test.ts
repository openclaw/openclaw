// Verifies restart recovery marks and resumes interrupted main-agent sessions.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/index.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import {
  emptySqliteCounts,
  observeParentSqlite,
} from "../../../test/helpers/sqlite-parent-observer.js";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { resolveReplyRunDeliveryContext } from "../../auto-reply/reply/agent-runner-core.js";
import { markInboundContextLabel } from "../../auto-reply/reply/inbound-context-marker.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import type { CliDeps } from "../../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../../config/config.js";
import * as configSessions from "../../config/sessions.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import {
  appendTranscriptMessage,
  listSessionEntriesCore,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { resolveAgentRestartRecoveryExecutionIdentityAdmission } from "../../gateway/agent-turn/agent-restart-recovery-context.js";
import { callGateway } from "../../gateway/call.js";
import type { RestartRecoveryCandidate } from "../../gateway/chat-abort.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { persistGatewaySessionLifecycleEvent } from "../../gateway/session-lifecycle-state.js";
import {
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { loadDeliveryQueueEntry } from "../../infra/delivery-queue-sqlite.js";
import { completeDeliveryQueueEntryInDatabase } from "../../infra/delivery-queue-sqlite.kernel.js";
import { seedDeliveryQueueEntry } from "../../infra/delivery-queue-sqlite.test-support.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "../../infra/outbound/delivery-queue-media-staging.js";
import type { QueuedDelivery } from "../../infra/outbound/delivery-queue-types.js";
import { createUnmodifiedPreparedOutboundBatch } from "../../infra/outbound/prepared-batch.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { addTestHook } from "../../plugins/hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
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
import {
  beginSessionWorkAdmission,
  interruptSessionWorkAdmissions,
  isSessionLifecycleMutationActive,
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  createAgentDatabaseInspectionRefusal,
  preparePendingAgentDatabase,
  recordAgentDatabaseAdmissions,
} from "../../state/agent-database-admission.js";
import {
  beginAgentDeletionJournal,
  removeAgentDeletionJournal,
} from "../../state/agent-deletion-journal.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { buildCurrentRunRestartRecoveryClaim } from "../agent-command-restart-recovery.js";
import { deliverAgentCommandResult } from "../command/delivery.js";
import { setActiveEmbeddedRunLifecycleGeneration } from "../embedded-agent-runner/run-state.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
} from "../embedded-agent-runner/runs.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../internal-runtime-context.js";
import { AGENT_RUN_RESTART_ABORT_ERROR_CODE } from "../run-termination.js";
import { SessionManager } from "../sessions/session-manager.js";
import {
  createAssistantToolCallMessage,
  createSessionEntry,
  createSessionStore,
  createSubagentRunRecord,
  type SessionEntryFixture,
  expectRecord,
  mockCallArg,
  waitForFast,
} from "../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../subagents/registry/subagent-registry-memory.js";
import { registerHarnessCompletionRecoveryCases } from "./main-session-harness-completion.test-harness.js";
import { registerParentRestartRecoveryCases } from "./main-session-parent-recovery.test-harness.js";
import * as recoveryOwnerRelease from "./main-session-recovery-owner-release.js";
import { createRecoveryRuntimeFixture } from "./main-session-recovery-runtime.test-support.js";
import {
  claimMainSessionRecoveryOwner,
  commitMainSessionRecovery,
} from "./main-session-recovery-store.js";
import { dispatchRestartRecoveryUntilStarted } from "./main-session-restart-dispatch-start.js";
import { readStartupRecoveryWarning } from "./main-session-restart-recovery-diagnostics.js";
import { createRestartRecoveryTranscriptFixture } from "./main-session-restart-recovery-fixture.test-support.js";
import {
  discoverRestartRecoveryStoreTargets,
  mainSessionRecoveryLog,
} from "./main-session-restart-recovery-shared.js";
import { recoverStore } from "./main-session-restart-recovery-store.js";
import {
  codeModeCheckpointMessage,
  codeModeWaitCallMessage,
  makeAssistantTextMessage,
  makeMessageDeliveryTranscript,
  makeMessageToolCall,
  makeMessageToolResult,
  makeToolResultMessage,
  makeUserMessage,
} from "./main-session-restart-recovery-transcript.test-support.js";
import {
  markRestartAbortedMainSessions,
  markStartupOrphanedMainSessionsForRecovery,
  recoverRestartAbortedMainSessions as recoverRestartAbortedMainSessionsBase,
  retryRestartAbortedMainSessionRecovery as retryRestartAbortedMainSessionRecoveryBase,
  scheduleRestartAbortedMainSessionRecoveryAfterOwnerRelease,
  scheduleRestartAbortedMainSessionRecovery as scheduleRestartAbortedMainSessionRecoveryBase,
} from "./main-session-restart-recovery.js";

const transcriptMocks = vi.hoisted(() => ({
  appendAssistantMessageToSessionTranscript: vi.fn(),
}));
const discordDeliveryContext = {
  channel: "discord",
  to: "discord:dm:123",
} as const;
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

const recoverRestartAbortedMainSessions = (
  params: RecoveryParams<Parameters<typeof recoverRestartAbortedMainSessionsBase>[0]>,
) => recoverRestartAbortedMainSessionsBase({ gatewayRuntime: mockRecoveryRuntime, ...params });
const retryRestartAbortedMainSessionRecovery = (
  params: RecoveryParams<Parameters<typeof retryRestartAbortedMainSessionRecoveryBase>[0]>,
) => retryRestartAbortedMainSessionRecoveryBase({ gatewayRuntime: mockRecoveryRuntime, ...params });
const scheduleRestartAbortedMainSessionRecovery = (
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
  expected: { started: number; settled: number; failed: number; skipped: number },
  cfg?: Parameters<typeof recoverRestartAbortedMainSessions>[0]["cfg"],
): Promise<void> {
  const params = cfg === undefined ? { stateDir: tmpDir } : { cfg, stateDir: tmpDir };
  await expect(recoverRestartAbortedMainSessions(params)).resolves.toEqual(expected);
}

function gatewayParams(): Record<string, unknown> {
  return expectRecord(mockCallArg(callGateway).params, "gateway params");
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
const transcriptFixture = createRestartRecoveryTranscriptFixture(readStore);
const { writeTranscript } = transcriptFixture;

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
  }
});

async function makeSessionsDir(agentId = "main"): Promise<string> {
  const sessionsDir = path.join(tmpDir, "agents", agentId, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  return sessionsDir;
}

async function writeStorePath(
  storePath: string,
  store: Record<string, SessionEntryFixture>,
): Promise<void> {
  await Promise.all(
    Object.entries(store).map(([sessionKey, entry]) =>
      replaceSessionEntry({ storePath, sessionKey }, createSessionEntry(entry)),
    ),
  );
}

async function writeStore(
  sessionsDir: string,
  store: Record<string, SessionEntryFixture>,
): Promise<void> {
  await writeStorePath(path.join(sessionsDir, "sessions.json"), store);
}

function mainSessionEntry(overrides: SessionEntryFixture = {}): SessionEntry {
  return createSessionEntry({
    sessionId: "main-session",
    permissionMode: "guarded",
    updatedAt: Date.now() - 10_000,
    status: "interrupted",
    abortedLastRun: true,
    mainRestartRecovery: { cycleId: "interrupted-cycle", revision: 1, chargedAttempts: 0 },
    ...overrides,
  });
}

function runningSessionEntry(sessionId: string, overrides: SessionEntryFixture = {}): SessionEntry {
  return createSessionEntry({
    sessionId,
    updatedAt: Date.now() - 10_000,
    restartRecoveryDeliveryRunId: `${sessionId}-run`,
    ...overrides,
  });
}

function activeRestartRun(
  sessionKey = "agent:main:main",
  sessionId = "main-session",
  overrides: Partial<RestartRecoveryCandidate> = {},
): RestartRecoveryCandidate {
  return {
    sessionKey,
    sessionId,
    runId: "restart-run",
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    ...overrides,
  };
}

function mainSessionStore(
  overrides: SessionEntryFixture = {},
  sessionKey = "agent:main:main",
): Record<string, SessionEntry> {
  return createSessionStore(mainSessionEntry(overrides), sessionKey);
}

async function makeMainSessionFixture(
  overrides: SessionEntryFixture & { agentId?: string; sessionKey?: string } = {},
) {
  const { agentId = "main", sessionKey = "agent:main:main", ...entry } = overrides;
  const sessionsDir = await makeSessionsDir(agentId);
  await writeMainSession({ sessionsDir, sessionKey, ...entry });
  const storePath = path.join(sessionsDir, "sessions.json");
  return {
    sessionsDir,
    storePath,
    sessionKey,
    readEntry: () => loadSessionEntry({ sessionKey, storePath }),
  };
}

function makePendingFinalDelivery(
  text = "interrupted response",
  overrides: Partial<NonNullable<SessionEntry["pendingFinalDelivery"]>> = {},
): NonNullable<SessionEntry["pendingFinalDelivery"]> {
  return {
    kind: "replayable",
    text,
    createdAt: Date.now(),
    intentId: "intent-prepared-default",
    deliveries: [{ id: "delivery-prepared-default", state: "prepared" }],
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

async function writeMainSession({
  sessionsDir,
  sessionKey = "agent:main:main",
  ...entry
}: SessionEntryFixture & { sessionsDir: string; sessionKey?: string }): Promise<void> {
  await writeStore(sessionsDir, mainSessionStore(entry, sessionKey));
}

function readStore(storePath: string): Record<string, SessionEntry> {
  return Object.fromEntries(
    listSessionEntriesCore({ storePath }).map(({ sessionKey, entry }) => [sessionKey, entry]),
  );
}

async function writePreparedMainSessionTranscript(
  messages: readonly unknown[],
  entry: SessionEntryFixture = {},
): Promise<string> {
  tmpDir = transcriptFixture.prepareRoot();
  const sessionsDir = await makeSessionsDir();
  await writeMainSession({ sessionsDir, ...entry });
  await writeTranscript(sessionsDir, "main-session", messages);
  return sessionsDir;
}

async function writeCompletedToolTranscript(sessionsDir: string, human = false): Promise<void> {
  await writeTranscript(sessionsDir, "main-session", [
    makeUserMessage("run the tool", human ? { provenance: { kind: "external_user" } } : {}),
    { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
    makeToolResultMessage(),
  ]);
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

function observeRecoveryRootCompletions(
  expectedOrigin: "main-session:startup-recovery" | "main-session:restart-recovery",
  expectedCount: number,
) {
  const completed = createDeferred();
  const admit = gatewayWorkAdmission.runWithGatewayIndependentRootWorkAdmission;
  let count = 0;
  const spy = vi
    .spyOn(gatewayWorkAdmission, "runWithGatewayIndependentRootWorkAdmission")
    .mockImplementation(
      async <T>(run: () => Promise<T>, origin?: string, signal?: AbortSignal): Promise<T> => {
        try {
          return await admit(run, origin, signal);
        } finally {
          if (origin === expectedOrigin && ++count === expectedCount) {
            completed.resolve();
          }
        }
      },
    );
  return { completed: completed.promise, restore: () => spy.mockRestore() };
}

async function deliverRecoveryReply(
  request: Record<string, unknown>,
  sessionEntry: SessionEntry | undefined,
  text: string,
) {
  const runId = String(request.idempotencyKey);
  const sessionKey = String(request.sessionKey);
  const result = {
    payloads: [{ text }],
    meta: { durationMs: 1 },
  };
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
  it("preserves exact restart identities against stale same-id rows", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKeys = ["agent:main:active", "agent:main:sibling"];
    await writeStore(
      sessionsDir,
      Object.fromEntries(sessionKeys.map((key) => [key, runningSessionEntry("shared-session")])),
    );
    const activeRuns = [
      activeRestartRun("agent:main:active", "shared-session", { runId: "run-active" }),
    ];
    for (const run of activeRuns) {
      registerAgentRunContext(run.runId, run);
    }
    const result = await markRestartAbortedMainSessions({
      resolveGatewayContext,
      stateDir: tmpDir,
      activeRuns,
      isActiveRun: () => true,
    });
    expect(result).toEqual({ marked: 1, skipped: 0 });
    const store = readStore(storePath);
    for (const key of sessionKeys) {
      const expected = activeRuns.filter((run) => run.sessionKey === key);
      expect(store[key]?.abortedLastRun).toBe(expected.length > 0 ? true : undefined);
      expect(store[key]?.restartRecoveryRuns).toEqual(
        expected.length > 0
          ? expected.map(({ runId, lifecycleGeneration }) => ({ runId, lifecycleGeneration }))
          : undefined,
      );
    }
  });

  it("marks only recoverable sessions owned by active runs", async () => {
    // Only top-level admitted main sessions are restart-recoverable. Completed,
    // child, cron, and non-active sessions must not be marked.
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        ...runningSessionEntry("main-session"),
      },
      "agent:main:completed": {
        sessionId: "completed-session",
        updatedAt: Date.now() - 10_000,
        status: "done",
      },
      "agent:main:subagent:child": {
        ...runningSessionEntry("child-session"),
        spawnDepth: 1,
      },
      "cron:nightly": {
        ...runningSessionEntry("cron-session"),
      },
      "agent:main:other": {
        ...runningSessionEntry("other-session"),
      },
    });

    registerAgentRunContext("restart-run", {
      sessionKey: "agent:main:main",
      sessionId: "main-session",
    });
    registerAgentRunContext("key-only-run", {
      sessionKey: "agent:main:main",
    });
    registerAgentRunContext("stale-session-run", {
      sessionKey: "agent:main:main",
      sessionId: "stale-session",
    });
    const result = await markRestartAbortedMainSessions({
      resolveGatewayContext,
      stateDir: tmpDir,
      activeRuns: [
        activeRestartRun(),
        activeRestartRun("agent:main:subagent:child", "child-session"),
      ],
    });

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 1, skipped: 1 });
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:completed"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:subagent:child"]?.abortedLastRun).toBeUndefined();
    expect(store["cron:nightly"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:other"]?.abortedLastRun).toBeUndefined();
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    expect(store["agent:main:main"]?.restartRecoveryRuns).toEqual([
      { runId: "key-only-run", lifecycleGeneration },
      { runId: "restart-run", lifecycleGeneration },
    ]);
  });

  it.each<{
    name: string;
    identities: string[][];
    expected: string[];
  }>([
    { name: "ID-only turn", identities: [["session-main"]], expected: ["main", "stale"] },
    {
      name: "crossed pairs from separate turns",
      identities: [
        ["main", "session-sibling"],
        ["sibling", "session-main"],
      ],
      expected: [],
    },
  ])("recovers an admitted $name without a chat run", async ({ identities, expected }) => {
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
        beginSessionWorkAdmission({
          resolveGatewayContext,
          scope: storePath,
          identities: group.map((identity) =>
            identity === "main" || identity === "sibling" ? key(identity) : identity,
          ),
          assertAllowed: () => undefined,
        }),
      ),
    );
    try {
      await expect(
        markRestartAbortedMainSessions({
          resolveGatewayContext,
          cfg: { session: { store: otherStorePath } },
          stateDir: tmpDir,
          activeRuns: [],
        }),
      ).resolves.toEqual({
        marked: expected.length,
        skipped: 0,
      });
      const store = readStore(storePath);
      for (const name of ["main", "sibling", "stale"]) {
        expect(store[key(name)]?.abortedLastRun).toBe(expected.includes(name) ? true : undefined);
        expect(store[key(name)]?.restartRecoveryForceSafeTools).toBe(
          expected.includes(name) ? true : undefined,
        );
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

    const cfg = {
      agents: { entries: { main: {} } },
    } as OpenClawConfig;
    const observer = observeParentSqlite();
    try {
      const storeTargets = await discoverRestartRecoveryStoreTargets({
        cfg,
        stateDir: tmpDir,
      });

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
    await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
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
      let admission: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
      try {
        await writeStorePath(storePath, {
          [sessionKey]: runningSessionEntry("custom-session"),
        });
        admission = await beginSessionWorkAdmission({
          resolveGatewayContext,
          scope: storePath,
          identities: [sessionKey, "custom-session"],
          assertAllowed: () => undefined,
        });

        await expect(
          markRestartAbortedMainSessions({
            resolveGatewayContext,
            cfg: { agents: { entries: { main: {} } } },
            stateDir: tmpDir,
            activeRuns: [],
          }),
        ).resolves.toEqual({ marked: 1, skipped: 0 });
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
    await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
      const storePath = path.join(tmpDir, "retired-active", "shared.sqlite");
      const retired = { agentId: "main", sessionKey: "global", storePath };
      const configured = { agentId: "ops", sessionKey: "agent:ops:idle", storePath };
      await replaceSessionEntry(retired, runningSessionEntry("retired-active-session"));
      await replaceSessionEntry(
        configured,
        mainSessionEntry({
          sessionId: "configured-idle-session",
          status: "done",
          abortedLastRun: false,
          mainRestartRecovery: undefined,
        }),
      );
      const configuredBefore = sessionAccessor.loadSessionEntry(configured);
      const admission = await beginSessionWorkAdmission({
        resolveGatewayContext,
        scope: storePath,
        identities: [retired.sessionKey, "retired-active-session"],
        assertAllowed: () => undefined,
      });
      try {
        await expect(
          markRestartAbortedMainSessions({
            resolveGatewayContext,
            cfg: {
              agents: { ownership: "explicit", entries: { ops: {} } },
              session: { store: storePath },
            },
            stateDir: tmpDir,
            activeRuns: [],
          }),
        ).resolves.toEqual({ marked: 1, skipped: 0 });
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

  it.each([
    { selection: "all", agentIds: undefined },
    { selection: "unrelated logical owner", agentIds: new Set(["main"]) },
    { selection: "physical owner", agentIds: new Set(["old"]) },
  ])(
    "selects a configured fixed store by its physical owner ($selection)",
    async ({ agentIds, selection }) => {
      const sessionsDir = await makeSessionsDir("old");
      const storePath = path.join(sessionsDir, "sessions.json");
      await writeStore(sessionsDir, { "agent:old:main": mainSessionEntry() });

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

  it("preserves the yielded global requester owner in a shared store", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
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
        { agentId: "main", sessionKey: "agent:main:unrelated", storePath },
        mainSessionEntry({
          sessionId: "unrelated",
          status: "done",
          abortedLastRun: false,
          mainRestartRecovery: undefined,
        }),
      );
      const target = { agentId: "ops", sessionKey: "global", storePath };
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
        await expect(
          markRestartAbortedMainSessions({
            cfg,
            stateDir: tmpDir,
            resolveGatewayContext,
            activeRuns: [activeRestartRun("global", "yielded-requester")],
          }),
        ).resolves.toEqual({ marked: 0, skipped: 0 });
        expect(sessionAccessor.loadSessionEntry(target)?.abortedLastRun).toBe(false);

        await sessionAccessor.patchSessionEntryCore(target, () => ({
          abortedLastRun: true,
          mainRestartRecovery: { cycleId: "yielded-cycle", revision: 1, chargedAttempts: 0 },
        }));
        await expect(
          markStartupOrphanedMainSessionsForRecovery({ cfg, stateDir: tmpDir }),
        ).resolves.toEqual({ marked: 0, skipped: 1 });
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
      await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
        const shared = layout.startsWith("shared-");
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
          session: {
            store: configuredStore,
            scope: "global",
          },
        } satisfies OpenClawConfig;
        const storePath = configSessions.resolveSessionStorePathCore(configuredStore, {
          agentId: "ops",
        });
        const mainStorePath = configSessions.resolveSessionStorePathCore(configuredStore, {
          agentId: "main",
        });
        const mainTarget = {
          agentId: "main",
          storePath: mainStorePath,
          sessionKey: "agent:main:unrelated",
        };
        await replaceSessionEntry(
          mainTarget,
          mainSessionEntry({
            sessionId: "unrelated-main-session",
            status: "done",
            abortedLastRun: false,
            mainRestartRecovery: undefined,
          }),
        );
        const mainBefore = sessionAccessor.loadExactSessionEntryReadOnly(mainTarget)?.entry;
        const target = { agentId: "ops", storePath, sessionKey };
        await replaceSessionEntry(
          target,
          mainSessionEntry({
            sessionId: "ops-startup-session",
            pendingFinalDelivery: makePendingFinalDelivery(),
            restartRecoveryForceSafeTools: true,
          }),
        );
        if (shared) {
          expect(openOpenClawAgentDatabase({ agentId: "main", path: storePath }).agentId).toBe(
            "main",
          );
        }

        await expect(recoverRestartAbortedMainSessions({ cfg, stateDir: tmpDir })).resolves.toEqual(
          {
            started: 1,
            settled: 0,
            failed: 0,
            skipped: 0,
          },
        );
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
      await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
        const storePath = path.join(tmpDir, "two-owners", "sessions.json");
        const cfg = {
          agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
          session: { store: storePath, scope: "global" },
        } satisfies OpenClawConfig;
        const keys = {
          main: "global",
          ops: "global",
        };
        const targets = (["main", "ops"] as const).map((agentId) => ({
          agentId,
          storePath,
          sessionKey: keys[agentId],
        }));
        for (const target of targets) {
          await replaceSessionEntry(
            target,
            mainSessionEntry({
              sessionId: `${target.agentId}-startup-session`,
              abortedLastRun: false,
              pendingFinalDelivery: makePendingFinalDelivery(),
              restartRecoveryForceSafeTools: true,
            }),
          );
        }
        const startupCheckedStorePaths = new Set<string>();
        if (phase === "checkpoint") {
          await expect(
            markStartupOrphanedMainSessionsForRecovery({
              cfg: { ...cfg, agents: { ...cfg.agents, entries: { main: {} } } },
              stateDir: tmpDir,
              startupCheckedStorePaths,
            }),
          ).resolves.toEqual({ marked: 1, skipped: 0 });
          const mainBefore = sessionAccessor.loadSessionEntry(targets[0]!);
          await expect(
            markStartupOrphanedMainSessionsForRecovery({
              cfg,
              stateDir: tmpDir,
              startupCheckedStorePaths,
            }),
          ).resolves.toEqual({ marked: 1, skipped: 0 });
          expect(sessionAccessor.loadSessionEntry(targets[0]!)).toEqual(mainBefore);
        } else {
          await expect(
            markStartupOrphanedMainSessionsForRecovery({
              cfg,
              stateDir: tmpDir,
              startupCheckedStorePaths,
            }),
          ).resolves.toEqual({ marked: 2, skipped: 0 });
        }
        for (const target of targets) {
          expect(sessionAccessor.loadSessionEntry(target)?.abortedLastRun).toBe(true);
        }
        if (phase === "dispatch") {
          const handledSessionKeys = new Set<string>();
          await expect(
            recoverRestartAbortedMainSessions({ cfg, stateDir: tmpDir, handledSessionKeys }),
          ).resolves.toEqual({ started: 2, settled: 0, failed: 0, skipped: 0 });
          const dispatches = vi
            .mocked(callGateway)
            .mock.calls.filter(([call]) => call.method === "agent")
            .map(([call]) => call.params);
          expect(dispatches).toHaveLength(2);
          expect(dispatches).toEqual(
            expect.arrayContaining(
              targets.map(({ agentId, sessionKey }) =>
                expect.objectContaining({ agentId, sessionKey }),
              ),
            ),
          );
          await expect(
            recoverRestartAbortedMainSessions({ cfg, stateDir: tmpDir, handledSessionKeys }),
          ).resolves.toMatchObject({ started: 0, failed: 0 });
          expect(
            vi.mocked(callGateway).mock.calls.filter(([call]) => call.method === "agent"),
          ).toHaveLength(2);
        }
      });
    },
  );

  it("dispatches a config-less bare recovery under the legacy implicit owner", async () => {
    const storePath = path.join(tmpDir, "legacy-shared", "sessions.json");
    await writeStorePath(storePath, {
      global: mainSessionEntry({
        pendingFinalDelivery: makePendingFinalDelivery(),
        restartRecoveryForceSafeTools: true,
      }),
    });

    await expect(
      recoverStore({
        gatewayRuntime: mockRecoveryRuntime,
        handledSessionKeys: new Set(),
        storePath,
      }),
    ).resolves.toEqual({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(gatewayParams()).toMatchObject({ agentId: "main", sessionKey: "global" });
  });

  it("marks queued abort-registry runs before lifecycle start", async () => {
    tmpDir = transcriptFixture.prepareRoot();
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
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
    const result = await markRestartAbortedMainSessions({
      resolveGatewayContext,
      stateDir: tmpDir,
      activeRuns: [
        {
          runId: "queued-run",
          lifecycleGeneration: "pre-restart",
          sessionKey: "agent:main:main",
          sessionId: "main-session",
        },
      ],
    });

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(store["agent:main:main"]).toEqual(
      expect.objectContaining({
        status: "interrupted",
        abortedLastRun: true,
        restartRecoveryRuns: [
          {
            runId: "queued-run",
            lifecycleGeneration: "pre-restart",
          },
        ],
      }),
    );
    expect(store["agent:main:main"]?.startedAt).toBeUndefined();
    expect(store["agent:main:main"]?.endedAt).toBe(3_000);
    expect(store["agent:main:main"]?.runtimeMs).toBeUndefined();
  });

  it.each([
    {
      name: "does not reopen a queued run that completed before store persistence",
      updatedAt: undefined,
      runId: "completed-run",
      observedAt: undefined,
      isActive: false,
      currentGeneration: false,
    },
    {
      name: "does not reopen a terminal row written at the observed event timestamp",
      updatedAt: 2_000,
      runId: "just-persisted-run",
      observedAt: 2_000,
      isActive: true,
      currentGeneration: false,
    },
    {
      name: "does not reopen a completed session via current-generation maintenance-expired abort controller",
      updatedAt: 3_000,
      runId: "stale-abort-controller-run",
      observedAt: 5_000,
      isActive: true,
      currentGeneration: true,
    },
  ])("$name", async ({ updatedAt, runId, observedAt, isActive, currentGeneration }) => {
    tmpDir = transcriptFixture.prepareRoot();
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": createSessionEntry({
        sessionId: "main-session",
        updatedAt: updatedAt ?? Date.now() - 10_000,
        status: "done",
      }),
    });

    const result = await markRestartAbortedMainSessions({
      resolveGatewayContext,
      stateDir: tmpDir,
      activeRuns: [
        {
          runId,
          lifecycleGeneration: currentGeneration
            ? getAgentEventLifecycleGeneration()
            : "pre-restart",
          sessionKey: "agent:main:main",
          sessionId: "main-session",
          ...(observedAt === undefined ? {} : { observedAt }),
        },
      ],
      isActiveRun: () => isActive,
    });

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 0, skipped: 0 });
    expect(store["agent:main:main"]?.status).toBe("done");
    expect(store["agent:main:main"]?.restartRecoveryRuns).toBeUndefined();
  });

  it.each([
    {
      name: "preserves current-generation markers across repeated restart marking",
      repeated: true,
    },
    {
      name: "replaces an older marker when the same run id is active after another restart",
      repeated: false,
    },
  ])("$name", async ({ repeated }) => {
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
    await markRestartAbortedMainSessions({
      resolveGatewayContext,
      stateDir: tmpDir,
      activeRuns: [activeRestartRun("agent:main:main", "main-session", next)],
    });
    expect(readEntry()?.restartRecoveryRuns).toEqual(repeated ? [previous, next] : [next]);
  });

  it("uses active pairs to avoid marking stale duplicate keys in another store", async () => {
    // Custom and default stores can contain the same session key. Active ids
    // keep restart marking tied to the store that owned the interrupted run.
    const defaultSessionsDir = await makeSessionsDir();
    await writeStore(defaultSessionsDir, {
      "agent:main:issue-82433": {
        ...runningSessionEntry("stale-default-session"),
      },
    });

    const storePath = path.join(tmpDir, "custom-duplicate-key", "sessions.json");
    await writeStorePath(storePath, {
      "agent:main:issue-82433": {
        ...runningSessionEntry("active-custom-session"),
      },
    });

    const result = await markRestartAbortedMainSessions({
      resolveGatewayContext,
      cfg: { session: { store: storePath } },
      stateDir: tmpDir,
      activeRuns: [activeRestartRun("agent:main:issue-82433", "active-custom-session")],
    });

    const defaultStore = readStore(path.join(defaultSessionsDir, "sessions.json"));
    const customStore = readStore(storePath);
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(defaultStore["agent:main:issue-82433"]?.abortedLastRun).toBeUndefined();
    expect(customStore["agent:main:issue-82433"]?.abortedLastRun).toBe(true);
  });

  it("resumes when durable commentary is mirrored after the restart recovery mark", async () => {
    tmpDir = transcriptFixture.prepareRoot();
    const sessionsDir = await makeSessionsDir();
    const sessionKey = "agent:main:main";
    await writeStore(sessionsDir, {
      [sessionKey]: runningSessionEntry("main-session"),
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "finish the interrupted long-running turn" },
    ]);

    await expect(
      markRestartAbortedMainSessions({
        resolveGatewayContext,
        stateDir: tmpDir,
        activeRuns: [activeRestartRun(sessionKey)],
        reason: "gateway restart drain",
      }),
    ).resolves.toEqual({ marked: 1, skipped: 0 });

    await writeTranscript(sessionsDir, "main-session", [
      makeAssistantTextMessage("Checking the remaining background task.", {
        stopReason: "stop",
        openclawStreamFallback: {
          replacementText: "Checking the remaining background task.",
          source: "segment",
          itemId: "progress-after-recovery-mark",
        },
      }),
      makeAssistantTextMessage("The restart handoff is in progress.", {
        stopReason: "stop",
        openclawStreamFallback: {
          replacementText: "The restart handoff is in progress.",
          source: "segment",
          itemId: "progress-after-recovery-mark-2",
        },
      }),
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(gatewayParams().sessionKey).toBe(sessionKey);
    expect(readStore(path.join(sessionsDir, "sessions.json"))[sessionKey]?.status).toBeUndefined();
    expect(readStore(path.join(sessionsDir, "sessions.json"))[sessionKey]).toMatchObject({
      abortedLastRun: false,
    });

    const transcript = await loadTestTranscript(
      sessionKey,
      path.join(sessionsDir, "sessions.json"),
    );
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
    await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
      const sessionsDir = await makeSessionsDir();
      const storePath = path.join(sessionsDir, "sessions.json");
      const sessionKey = "agent:main:main";
      const runId = "drain-overlap-run";
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      await writeStore(sessionsDir, {
        [sessionKey]: runningSessionEntry("main-session"),
      });
      await writeTranscript(sessionsDir, "main-session", [
        { role: "user", content: "finish the admitted work after the restart" },
      ]);

      const rootAdmission = tryBeginGatewayRootWorkAdmission();
      expect(rootAdmission).not.toBeNull();
      await rootAdmission?.run(async () => {
        await expect(
          markRestartAbortedMainSessions({
            resolveGatewayContext,
            stateDir: tmpDir,
            activeRuns: [{ runId, lifecycleGeneration, sessionKey, sessionId: "main-session" }],
            reason: "gateway restart drain",
          }),
        ).resolves.toEqual({ marked: 1, skipped: 0 });
        markGatewayRestartDraining();
        await expect(
          runWithGatewayIndependentRootWorkAdmission(async () => undefined),
        ).rejects.toBeInstanceOf(GatewayDrainingError);
        await writeTranscript(sessionsDir, "main-session", [
          makeToolResultMessage([{ type: "text", text: "Gateway restart admission is closed." }], {
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
      const recovery = scheduleRestartAbortedMainSessionRecovery({
        delayMs: 0,
        maxRetries: 1,
      });
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
    writePreparedMainSessionTranscript,
    expectRecovery,
    gatewayParams,
  });

  registerHarnessCompletionRecoveryCases(getHarnessRecoveryFixture);

  it("delivers a resumed reply through hooks using the interrupted route", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
      try {
        const sessionsDir = await makeSessionsDir();
        const storePath = path.join(sessionsDir, "sessions.json");
        const deliveredText = vi.fn();
        const hookHandler = vi.fn(
          async (event: { payload: { text?: string } }, context: Record<string, unknown>) => ({
            payload: {
              ...event.payload,
              text: `hooked: ${event.payload.text ?? ""}`,
            },
            metadata: context,
          }),
        );
        const discordOutbound: ChannelOutboundAdapter = {
          deliveryMode: "direct",
          sendText: async ({ to, text }) => {
            deliveredText({ to, text });
            return { channel: "discord", messageId: "delivered-1" };
          },
        };
        const registry = createTestRegistry([
          {
            pluginId: "discord",
            source: "test",
            plugin: createOutboundTestPlugin({ id: "discord", outbound: discordOutbound }),
          },
        ]);
        addTestHook({
          registry,
          pluginId: "recovery-hook-test",
          hookName: "reply_payload_sending",
          handler: hookHandler,
        });
        resetGlobalHookRunner();
        initializeGlobalHookRunner(registry);
        setActivePluginRegistry(registry);
        await writeMainSession({
          sessionsDir,
          sessionKey: "agent:main:discord:direct:123",
          deliveryContext: { channel: "discord", to: "discord:dm:stale", accountId: "old" },
          restartRecoveryDeliveryContext: {
            channel: "discord",
            to: "discord:dm:123",
            accountId: "main",
            threadId: 123,
          },
        });
        await writeCompletedToolTranscript(sessionsDir);
        vi.mocked(callGateway).mockImplementationOnce(async ({ params }) => {
          const request = params as Record<string, unknown>;
          const sessionKey = String(request.sessionKey);
          return await deliverRecoveryReply(
            request,
            loadSessionEntry({ sessionKey, storePath }),
            "final answer",
          );
        });

        await expectRecovery({ started: 0, settled: 1, failed: 0, skipped: 0 });
        const resumeParams = gatewayParams() as Record<string, unknown>;
        expect(resumeParams).toMatchObject({
          bestEffortDeliver: true,
          lane: "main",
          threadId: "123",
        });
        const recoveryRunId = String(resumeParams.idempotencyKey);
        expect(hookHandler).toHaveBeenCalledWith(
          {
            payload: expect.objectContaining({ text: "final answer" }),
            kind: "final",
            channel: "discord",
            sessionKey: "agent:main:discord:direct:123",
            runId: recoveryRunId,
            usageState: undefined,
          },
          {
            channelId: "discord",
            accountId: "main",
            conversationId: "discord:dm:123",
            sessionKey: "agent:main:discord:direct:123",
            runId: recoveryRunId,
          },
        );
        expect(deliveredText).toHaveBeenCalledExactlyOnceWith({
          to: "discord:dm:123",
          text: "hooked: final answer",
        });
      } finally {
        try {
          await cleanupSessionStateForTest({ stateDir: tmpDir });
        } finally {
          resetGlobalHookRunner();
          setActivePluginRegistry(createEmptyPluginRegistry());
        }
      }
    });
  });

  it("keeps recovered Telegram notice authority current after a transport failure", async () => {
    const sessionsDir = await makeSessionsDir();
    const sessionKey = "agent:main:telegram:group:-100123:topic:99";
    const storePath = path.join(sessionsDir, "sessions.json");
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
    sendRecoveryNotice.mockRejectedValueOnce(new Error("temporary transport failure"));
    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(sendRecoveryNotice).toHaveBeenCalledOnce();
    const notice = sendRecoveryNotice.mock.calls[0]?.[0];
    expect(notice).toMatchObject({
      channel: "telegram",
      to: "telegram:-100123",
      accountId: "work",
      threadId: 99,
      text: "I'm continuing your interrupted request now (the gateway has just restarted).  Don't be concerned with the lack of typing; I am working behind the scenes and I'll send a message when I'm done!",
      idempotencyKey: `main-session-restart-recovery:${String(gatewayParams().idempotencyKey)}:resumed-notice`,
    });
    expect(notice?.isCurrent?.({})).toBe(true);
    const current = loadSessionEntry({ sessionKey, storePath });
    if (!current) {
      throw new Error("expected recovered session");
    }
    await writeStore(sessionsDir, {
      [sessionKey]: { ...current, abortedLastRun: true },
    });
    expect(notice?.isCurrent?.({})).toBe(false);
    await writeStore(sessionsDir, {
      [sessionKey]: { ...current, sessionId: "replacement-session" },
    });
    expect(notice?.isCurrent?.({})).toBe(false);
    await writeStore(sessionsDir, { [sessionKey]: current });
    expect(notice?.isCurrent?.({})).toBe(true);
    dispatchSettlement.resolve();
    await waitForFast(() => expect(notice?.isCurrent?.({})).toBe(false));
  });

  it("re-adopts a persisted Telegram private-topic route and releases the next turn", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
      try {
        const sessionsDir = await makeSessionsDir();
        const storePath = path.join(sessionsDir, "sessions.json");
        const sessionKey = "agent:main:telegram:direct:12345:thread:12345:99";
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
        const interruptedEntry = mainSessionEntry({ delivery });
        const recoveryContext = resolveReplyRunDeliveryContext({
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
          sessionEntry: interruptedEntry,
          sessionKey,
        });
        expect(recoveryContext).toEqual({ ...deliveryContext, threadId: 99 });
        await writeMainSession({
          sessionsDir,
          sessionKey,
          delivery,
        });
        await writeCompletedToolTranscript(sessionsDir);

        const deliveredText = vi.fn();
        const telegramOutbound: ChannelOutboundAdapter = {
          deliveryMode: "direct",
          sendText: async ({ to, text, threadId }) => {
            deliveredText({ to, text, threadId });
            return { channel: "telegram", messageId: "delivered-telegram-1" };
          },
        };
        resetGlobalHookRunner();
        setActivePluginRegistry(
          createTestRegistry([
            {
              pluginId: "telegram",
              source: "test",
              plugin: createOutboundTestPlugin({ id: "telegram", outbound: telegramOutbound }),
            },
          ]),
        );
        vi.mocked(callGateway).mockImplementationOnce(async ({ params }) => {
          const request = params as Record<string, unknown>;
          const runId = String(request.idempotencyKey);
          const current = loadSessionEntry({ sessionKey, storePath });
          if (!current) {
            throw new Error("expected claimed Telegram recovery session");
          }
          expect(
            buildCurrentRunRestartRecoveryClaim({
              deliveryContext,
              entry: current,
              runId,
            }),
          ).toMatchObject({
            restartRecoveryDeliveryContext: deliveryContext,
            restartRecoveryDeliveryRunId: runId,
          });
          return await deliverRecoveryReply(request, current, "recovered private-topic reply");
        });

        await expectRecovery({ started: 0, settled: 1, failed: 0, skipped: 0 });
        expect(gatewayParams()).toMatchObject({
          sessionKey,
          channel: "telegram",
          accountId: "work",
        });
        expect(deliveredText).toHaveBeenCalledWith({
          to: "telegram:12345",
          text: "recovered private-topic reply",
          threadId: "99",
        });
        expect(sendRecoveryNotice).not.toHaveBeenCalled();
        const completed = loadSessionEntry({ sessionKey, storePath });
        expect(completed).toMatchObject({ status: "done", abortedLastRun: false });
        expect(completed?.restartRecoveryDeliveryRunId).toBeUndefined();
        expect(completed?.restartRecoveryDeliveryContext).toBeUndefined();
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
      } finally {
        try {
          await cleanupSessionStateForTest({ stateDir: tmpDir });
        } finally {
          resetGlobalHookRunner();
          setActivePluginRegistry(createEmptyPluginRegistry());
        }
      }
    });
  });

  it("reuses a transcript-only claim without inferring historical session routes", async () => {
    const { sessionsDir, readEntry } = await makeMainSessionFixture({
      sessionKey: "agent:main:discord:direct:123",
      restartRecoveryDeliveryRunId: "control-ui-run",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
      restartRecoverySourceIngress: "internal",
      restartRecoverySourceReplyDeliveryMode: "message_tool_only",
      deliveryContext: {
        channel: "discord",
        to: "discord:dm:stale",
        accountId: "old",
      },
    });
    await writeCompletedToolTranscript(sessionsDir, true);
    let claimAtDispatch: string | undefined;
    let sourceClaimAtDispatch: string | undefined;
    vi.mocked(callGateway).mockImplementationOnce(async ({ params }) => {
      const entry = readEntry();
      claimAtDispatch = entry?.restartRecoveryDeliveryRunId;
      sourceClaimAtDispatch = entry?.restartRecoveryDeliverySourceRunId;
      return { runId: String((params as { idempotencyKey?: unknown }).idempotencyKey) };
    });

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    const resumeParams = gatewayParams() as Record<string, unknown>;
    expect(resumeParams.deliver).toBe(false);
    expect(resumeParams.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(claimAtDispatch).toBe(resumeParams.idempotencyKey);
    expect(claimAtDispatch).not.toBe("control-ui-run");
    expect(sourceClaimAtDispatch).toBe("control-ui-run");
  });

  it("stores no recovery identity with default configuration", async () => {
    const { sessionsDir, readEntry } = await makeMainSessionFixture();
    await writeCompletedToolTranscript(sessionsDir);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });

    const entry = readEntry();
    expect(entry?.mainRestartRecovery?.executionIdentity).toBeUndefined();
    expect(gatewayParams()).not.toHaveProperty("internalExecutionIdentityRetry");
    expect(gatewayParams().internalExecutionIdentityRecoveryAttempt).toBe(1);
  });

  it("keeps ambiguous pre-admission recovery identity unbound", async () => {
    const { sessionsDir, readEntry } = await makeMainSessionFixture({
      restartRecoveryDeliveryRunId: "control-ui-run",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
    });
    await writeCompletedToolTranscript(sessionsDir);
    vi.mocked(callGateway).mockRejectedValueOnce(new Error("gateway unavailable"));

    await expectRecovery(
      { started: 0, settled: 0, failed: 1, skipped: 0 },
      executionIdentityEnabledConfig,
    );

    const firstRecoveryRunId = (
      vi.mocked(callGateway).mock.calls[0]?.[0].params as { idempotencyKey?: unknown } | undefined
    )?.idempotencyKey;
    expect(firstRecoveryRunId).toEqual(expect.any(String));
    expect(firstRecoveryRunId).not.toBe("control-ui-run");
    const pending = readEntry();
    expect(pending).toMatchObject({
      abortedLastRun: true,
      mainRestartRecovery: { chargedAttempts: 1 },
      restartRecoveryDeliveryRunId: firstRecoveryRunId,
      restartRecoveryDeliverySourceRunId: "control-ui-run",
      sessionId: "main-session",
      status: "interrupted",
    });
    expect(pending?.mainRestartRecovery?.reservation).toBeUndefined();
    expect(pending?.mainRestartRecovery?.executionIdentity).toBeUndefined();
    const firstRequest = vi.mocked(callGateway).mock.calls[0]?.[0];
    expect(firstRequest).toBeDefined();
    expect((firstRequest!.params as Record<string, unknown>).internalExecutionIdentityRetry).toBe(
      false,
    );
    expect(
      (firstRequest!.params as Record<string, unknown>).internalExecutionIdentityRecoveryAttempt,
    ).toBe(1);

    await expectRecovery(
      { started: 1, settled: 0, failed: 0, skipped: 0 },
      executionIdentityEnabledConfig,
    );
    const runIds = vi
      .mocked(callGateway)
      .mock.calls.map(([request]) =>
        request.method === "agent"
          ? (request.params as { idempotencyKey?: unknown }).idempotencyKey
          : undefined,
      )
      .filter((runId) => runId !== undefined);
    expect(runIds).toEqual([firstRecoveryRunId, firstRecoveryRunId]);
    const recovered = readEntry();
    expect(recovered).toMatchObject({
      abortedLastRun: false,
      mainRestartRecovery: { chargedAttempts: 2 },
      restartRecoveryDeliveryRunId: firstRecoveryRunId,
      restartRecoveryDeliverySourceRunId: "control-ui-run",
    });
    expect(recovered?.status).toBeUndefined();
    const agentRequests = vi
      .mocked(callGateway)
      .mock.calls.map(([request]) => request)
      .filter((request) => request.method === "agent");
    expect(agentRequests[1]).toBeDefined();
    expect(
      (agentRequests[1]!.params as Record<string, unknown>).internalExecutionIdentityRetry,
    ).toBe(true);
    expect(
      (agentRequests[1]!.params as Record<string, unknown>)
        .internalExecutionIdentityRecoveryAttempt,
    ).toBe(2);
  });

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
    let dispatchError: unknown;
    vi.mocked(callGateway).mockImplementationOnce(async ({ method, params }) => {
      expect(method).toBe("agent");
      dispatchedRunId = String((params as { idempotencyKey?: unknown }).idempotencyKey);
      const sessionManager = SessionManager.open(
        { agentId: "main", sessionId: "main-session", sessionKey, storePath },
        sessionsDir,
      );
      try {
        const sessionEntry = readEntry();
        const gatewayAdmission = resolveAgentRestartRecoveryExecutionIdentityAdmission({
          collectionEnabled: true,
          isRestartRecoveryResumeRun: true,
          retryOnly:
            (params as { internalExecutionIdentityRetry?: unknown })
              .internalExecutionIdentityRetry === true,
          runId: dispatchedRunId,
          sessionEntry,
        });
        expect(gatewayAdmission?.consume(dispatchedRunId)).toEqual({
          accepted: true,
          token: previousExecutionIdentity,
        });
        const recoveryMessage = {
          role: "user" as const,
          content: "[System] continue after restart",
          idempotencyKey: `${dispatchedRunId}:user`,
          timestamp: Date.now(),
        };
        sessionManager.appendMessage(recoveryMessage);
      } catch (error) {
        dispatchError = error;
        throw error;
      }
      return { runId: dispatchedRunId };
    });

    const recoveryResult = await recoverRestartAbortedMainSessions({
      cfg: executionIdentityEnabledConfig,
      stateDir: tmpDir,
    });

    expect(dispatchError).toBeUndefined();
    expect(recoveryResult).toEqual({ started: 1, settled: 0, failed: 0, skipped: 0 });
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

  it("schedules exact reservation cleanup after immediate retries are exhausted", async () => {
    const scheduled = createDeferred();
    const { sessionsDir, storePath, readEntry } = await makeMainSessionFixture();
    await writeCompletedToolTranscript(sessionsDir);
    let dispatchFailed = false;
    vi.mocked(callGateway).mockImplementationOnce(async () => {
      dispatchFailed = true;
      throw new Error("gateway unavailable");
    });
    const applySessionEntryReplacements = sessionAccessor.applySessionEntryReplacements;
    const schedulePendingSpy = vi
      .spyOn(recoveryOwnerRelease, "scheduleMainSessionRecoveryPendingTarget")
      .mockImplementation(() => scheduled.resolve());
    let cleanupFailures = 0;
    const replacementSpy = vi
      .spyOn(sessionAccessor, "applySessionEntryReplacements")
      .mockImplementation(async (params) => {
        if (dispatchFailed && params.requireWriteSuccess && cleanupFailures < 3) {
          cleanupFailures += 1;
          throw new Error("extended session-store failure");
        }
        return await applySessionEntryReplacements(params);
      });

    try {
      await expectRecovery({ started: 0, settled: 0, failed: 1, skipped: 0 }, {});
      expect(readEntry()?.mainRestartRecovery?.reservation).toBeDefined();
      await scheduled.promise;
      expect(readEntry()?.mainRestartRecovery?.reservation).toBeUndefined();
      expect(schedulePendingSpy).toHaveBeenCalledWith({
        agentId: "main",
        sessionId: "main-session",
        sessionKey: "agent:main:main",
        storePath,
      });
    } finally {
      schedulePendingSpy.mockRestore();
      replacementSpy.mockRestore();
    }

    expect(cleanupFailures).toBe(3);
    expect(readEntry()?.mainRestartRecovery).toMatchObject({ chargedAttempts: 1 });
  });

  it("retries reservation cleanup when durable dispatch preparation is rejected", async () => {
    const { sessionsDir, readEntry } = await makeMainSessionFixture();
    await writeCompletedToolTranscript(sessionsDir);
    const applySessionEntryReplacements = sessionAccessor.applySessionEntryReplacements;
    let preparationRejected = false;
    let cleanupFailures = 0;
    const replacementSpy = vi
      .spyOn(sessionAccessor, "applySessionEntryReplacements")
      .mockImplementation(async (params) => {
        const entry = readEntry();
        if (
          !preparationRejected &&
          params.requireWriteSuccess !== true &&
          entry?.mainRestartRecovery?.reservation
        ) {
          preparationRejected = true;
          return false;
        }
        if (preparationRejected && params.requireWriteSuccess && cleanupFailures < 2) {
          cleanupFailures += 1;
          throw new Error("transient session-store failure");
        }
        return await applySessionEntryReplacements(params);
      });

    try {
      await expectRecovery({ started: 0, settled: 0, failed: 1, skipped: 0 }, {});
    } finally {
      replacementSpy.mockRestore();
    }

    expect(preparationRejected).toBe(true);
    expect(cleanupFailures).toBe(2);
    expect(callGateway).not.toHaveBeenCalled();
    const entry = readEntry();
    expect(entry?.mainRestartRecovery).toMatchObject({ chargedAttempts: 0 });
    expect(entry?.mainRestartRecovery?.reservation).toBeUndefined();
  });

  it("refunds an explicit Gateway rejection before recovery admission", async () => {
    const { sessionsDir, readEntry } = await makeMainSessionFixture();
    await writeCompletedToolTranscript(sessionsDir);
    vi.mocked(callGateway).mockRejectedValueOnce(
      new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "restart recovery reservation is stale",
        retryable: false,
      }),
    );

    await expectRecovery({ started: 0, settled: 0, failed: 1, skipped: 0 }, {});

    expect(callGateway).toHaveBeenCalledOnce();
    const entry = readEntry();
    expect(entry?.mainRestartRecovery).toMatchObject({ chargedAttempts: 0 });
    expect(entry?.mainRestartRecovery?.reservation).toBeUndefined();
  });

  it("rolls back the reservation when ambiguous settlement persistence fails", async () => {
    const { sessionsDir, readEntry } = await makeMainSessionFixture();
    await writeCompletedToolTranscript(sessionsDir);
    let dispatchFailed = false;
    vi.mocked(callGateway).mockImplementation(async (request) => {
      if (request.method === "agent") {
        dispatchFailed = true;
        throw new Error("ambiguous dispatch transport failure");
      }
      return { runId: "recovery-run", status: "ok", endedAt: Date.now() };
    });
    const applySessionEntryReplacements = sessionAccessor.applySessionEntryReplacements;
    let postDispatchWrites = 0;
    let settlementFailed = false;
    const replacementSpy = vi
      .spyOn(sessionAccessor, "applySessionEntryReplacements")
      .mockImplementation(async (params) => {
        if (dispatchFailed && params.requireWriteSuccess !== true) {
          postDispatchWrites += 1;
          if (postDispatchWrites === 2) {
            settlementFailed = true;
            throw new Error("settlement store failure");
          }
        }
        return await applySessionEntryReplacements(params);
      });

    try {
      await expectRecovery({ started: 0, settled: 0, failed: 1, skipped: 0 }, {});
    } finally {
      replacementSpy.mockRestore();
    }
    expect(settlementFailed).toBe(true);
    const entry = readEntry();
    expect(entry).toMatchObject({ status: "interrupted", abortedLastRun: true });
    expect(entry?.mainRestartRecovery).toMatchObject({ chargedAttempts: 1 });
    expect(entry?.mainRestartRecovery?.reservation).toBeUndefined();
  });

  it("settles an admitted recovery that completed before its ambiguous response", async () => {
    const { sessionsDir, storePath, readEntry } = await makeMainSessionFixture();
    await writeCompletedToolTranscript(sessionsDir);
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

    await expectRecovery({ started: 0, settled: 1, failed: 0, skipped: 0 }, {});
    expect(readEntry()).toMatchObject({
      abortedLastRun: false,
      status: "done",
    });
  });

  it("settles a reused recovery RPC whose accepted cache already completed", async () => {
    const { sessionsDir, readEntry } = await makeMainSessionFixture({
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
    });
    await writeCompletedToolTranscript(sessionsDir);
    vi.mocked(callGateway)
      .mockResolvedValueOnce({
        runId: "recovery-run",
        status: "accepted",
      })
      .mockResolvedValueOnce({
        runId: "recovery-run",
        status: "ok",
        endedAt: Date.now(),
      });

    await expectRecovery({ started: 0, settled: 1, failed: 0, skipped: 0 }, {});

    expect(gatewayParams().idempotencyKey).toBe("recovery-run");
    expect(vi.mocked(callGateway).mock.calls[1]?.[0]).toMatchObject({
      method: "agent.wait",
      params: { runId: "recovery-run", timeoutMs: 0 },
    });
    expect(readEntry()).toMatchObject({
      abortedLastRun: false,
      endedAt: expect.any(Number),
      restartRecoveryTerminalRunIds: ["control-ui-run", "recovery-run"],
      sessionId: "main-session",
      status: "done",
    });
    const settled = readEntry();
    expect(settled?.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(settled?.restartRecoveryDeliverySourceRunId).toBeUndefined();
    expect(settled?.mainRestartRecovery).toBeUndefined();
  });

  it("does not settle a cached terminal response after a foreground owner wins admission", async () => {
    const { sessionsDir, storePath, readEntry } = await makeMainSessionFixture({
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
    });
    await writeCompletedToolTranscript(sessionsDir);
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

    await expectRecovery({ started: 0, settled: 0, failed: 1, skipped: 0 }, {});
    expect(readEntry()).toMatchObject({
      abortedLastRun: true,
      status: "interrupted",
      mainRestartRecovery: {
        foregroundClaims: { tokens: [expect.any(String)] },
      },
    });
  });

  it("honors session send-policy denial for the interrupted route", async () => {
    const { sessionsDir } = await makeMainSessionFixture({
      sessionKey: "agent:main:discord:direct:123",
      restartRecoveryDeliveryContext: {
        channel: "discord",
        to: "discord:dm:123",
        accountId: "main",
      },
    });
    await writeCompletedToolTranscript(sessionsDir);

    const result = await recoverRestartAbortedMainSessions({
      cfg: { session: { sendPolicy: { default: "deny" } } },
      stateDir: tmpDir,
    });

    expect(result).toEqual({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(gatewayParams().deliver).toBe(false);
  });

  it("resumes stale approval-pending exec tool results with restart-safe tools", async () => {
    const sessionsDir = await writePreparedMainSessionTranscript([
      { role: "user", content: "run a command that needs approval" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      makeToolResultMessage("Approval required (id stale, full stale-approval-id).", {
        details: {
          status: "approval-pending",
          approvalId: "stale-approval-id",
          host: "gateway",
          command: "echo stale",
        },
      }),
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.status).toBeUndefined();
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
  });

  it("resumes safely when pending final delivery identities are missing", async () => {
    const sessionsDir = await makeSessionsDir();
    const pendingPayload = "The final answer is 42.";
    await writeMainSession({
      sessionsDir,
      restartRecoveryForceSafeTools: true,
      pendingFinalDelivery: {
        kind: "replayable",
        text: pendingPayload,
        createdAt: Date.now() - 5_000,
        context: {
          channel: "discord",
          to: "discord:dm:final",
          accountId: "main",
        },
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
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "calculate the answer" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "calc" }] },
      { role: "toolResult", content: "42" },
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 }, {});
    expect(callGateway).toHaveBeenCalledOnce();
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
    expect(gatewayParams().message).toContain(pendingPayload);
    expect(sendRecoveryNotice).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/:resumed-notice$/),
      }),
    );
  });

  it("defers mixed deliveries while any exact queue owner is pending", async () => {
    try {
      seedQueuedFinal("delivery-still-pending", "Pending sibling.");
      await makeMainSessionFixture({
        pendingFinalDelivery: makePendingFinalDelivery("Partially delivered answer.", {
          context: discordDeliveryContext,
          intentId: "intent-mixed-pending",
          deliveries: [
            { id: "delivery-already-delivered", state: "delivered" },
            { id: "delivery-still-pending", state: "queued" },
          ],
        }),
      });

      await expectRecovery({ started: 0, settled: 0, failed: 0, skipped: 1 });

      expect(callGateway).not.toHaveBeenCalled();
      expect(sendRecoveryNotice).not.toHaveBeenCalled();
    } finally {
      closeOpenClawStateDatabaseForTest();
    }
  });

  it("completes terminal deliveries despite a residual pending queue row", async () => {
    try {
      seedQueuedFinal("delivery-terminal-with-row", "Already delivered.");
      const { storePath } = await makeMainSessionFixture({
        pendingFinalDelivery: makePendingFinalDelivery("Already delivered.", {
          intentId: "intent-terminal-with-row",
          deliveries: [
            { id: "delivery-terminal-with-row", state: "delivered" },
            { id: "delivery-suppressed", state: "suppressed" },
          ],
        }),
      });

      await expectRecovery({ started: 0, settled: 1, failed: 0, skipped: 0 });

      expect(callGateway).not.toHaveBeenCalled();
      expect(sendRecoveryNotice).not.toHaveBeenCalled();
      const entry = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
      expect(entry).toMatchObject({ status: "done", abortedLastRun: false });
      expect(entry?.pendingFinalDelivery).toBeUndefined();
    } finally {
      closeOpenClawStateDatabaseForTest();
    }
  });

  it("resumes safely when residual ambiguity has no notice identity", async () => {
    await makeMainSessionFixture({
      pendingFinalDelivery: {
        kind: "transport-only",
        createdAt: Date.now(),
        // No context and no intentId: debt cannot be recorded, so the remaining
        // fail arm resumes under restart-safe tool policy.
        deliveries: [{ id: "delivery-identity-less", state: "unknown" }],
      },
    });

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });

    expect(callGateway).toHaveBeenCalledOnce();
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
  });

  it.each([
    {
      name: "completes an unqueued media-only final with owed notice debt",
      kind: "transport-only",
      text: undefined,
      intentId: "intent-media-only",
      deliveries: [{ id: "delivery-media-only", state: "prepared" }],
      acknowledged: false,
    },
    {
      name: "preserves an acknowledged notice when the same pending final completes",
      kind: "replayable",
      text: "Uncertain reply.",
      intentId: "intent-notice-retained",
      deliveries: [{ id: "delivery-notice-retained", state: "unknown" }],
      acknowledged: true,
    },
    {
      name: "records notice debt for unknown delivery mixed with prepared work",
      kind: "replayable",
      text: "Do not regenerate this aggregate.",
      intentId: "intent-mixed-unknown",
      deliveries: [
        { id: "delivery-unknown", state: "unknown" },
        { id: "delivery-still-prepared", state: "prepared" },
      ],
      acknowledged: false,
    },
  ] as const)("$name", async ({ kind, text, intentId, deliveries, acknowledged }) => {
    const createdAt = Date.now();
    const { readEntry } = await makeMainSessionFixture({
      pendingFinalDelivery: {
        ...(kind === "replayable" ? { kind, text } : { kind }),
        createdAt,
        intentId,
        deliveries: [...deliveries],
        context: discordDeliveryContext,
      },
      ...(acknowledged
        ? {
            pendingDeliveryNotice: {
              createdAt,
              context: discordDeliveryContext,
              intentId,
              state: "acknowledged" as const,
            },
          }
        : {}),
    });
    await expectRecovery({ started: 0, settled: 1, failed: 0, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
    expect(sendRecoveryNotice).not.toHaveBeenCalled();
    const entry = readEntry();
    expect(entry?.status).toBe("done");
    expect(entry?.pendingFinalDelivery).toBeUndefined();
    expect(entry?.pendingDeliveryNotice).toMatchObject({
      intentId,
      state: acknowledged ? "acknowledged" : "owed",
      context: discordDeliveryContext,
    });
  });

  it.each(["completed", "settling"] as const)(
    "keeps a prepared pending final aligned with its exact queue owner in %s",
    async (ownerStatus) => {
      const deliveryId = `delivery-owner-${ownerStatus}`;
      try {
        seedQueuedFinal(deliveryId, "Queue owns this final.");
        if (ownerStatus === "settling") {
          const entry = loadDeliveryQueueEntry(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryId, tmpDir)!;
          seedDeliveryQueueEntry({
            queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
            entry: { ...entry, recoveryState: "settlement_pending" },
            status: "failed",
            stateDir: tmpDir,
          });
        } else if (ownerStatus === "completed") {
          completeDeliveryQueueEntryInDatabase(
            openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir } }),
            OUTBOUND_DELIVERY_QUEUE_NAME,
            deliveryId,
          );
        }
        const { sessionsDir } = await makeMainSessionFixture({
          pendingFinalDelivery: makePendingFinalDelivery("Queue owns this final.", {
            context: discordDeliveryContext,
            intentId: `intent-owner-${ownerStatus}`,
            deliveries: [{ id: deliveryId, state: "prepared" }],
          }),
        });

        await expectRecovery(
          ownerStatus === "settling"
            ? { started: 0, settled: 0, failed: 0, skipped: 1 }
            : { started: 0, settled: 1, failed: 0, skipped: 0 },
        );

        expect(callGateway).not.toHaveBeenCalled();
        expect(sendRecoveryNotice).not.toHaveBeenCalled();
        if (ownerStatus !== "settling") {
          const sessionsStorePath = path.join(sessionsDir, "sessions.json");
          expect(
            loadSessionEntry({ sessionKey: "agent:main:main", storePath: sessionsStorePath })
              ?.pendingDeliveryNotice,
          ).toMatchObject({ intentId: `intent-owner-${ownerStatus}`, state: "owed" });
        }
      } finally {
        closeOpenClawStateDatabaseForTest();
      }
    },
  );

  it("retains restart safety when the first restart follows pending final persistence", async () => {
    const sessionsDir = await writePreparedMainSessionTranscript(
      [
        { role: "user", content: "do the thing" },
        makeToolResultMessage(
          [
            {
              type: "text",
              text: JSON.stringify({ status: "completed", value: "done", replaySafe: true }),
            },
          ],
          { toolName: "exec" },
        ),
        makeAssistantTextMessage("Safe work finished."),
      ],
      {
        pendingFinalDelivery: makePendingFinalDelivery("Safe work finished.", {
          createdAt: Date.now() - 5_000,
        }),
      },
    );

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.restartRecoveryForceSafeTools).toBe(true);
  });

  it("sanitizes durable pending final delivery payloads before resume prompts", async () => {
    tmpDir = transcriptFixture.prepareRoot();
    const sessionsDir = await makeSessionsDir();
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
    await writeMainSession({
      sessionsDir,
      pendingFinalDelivery: makePendingFinalDelivery(pendingPayload, {
        createdAt: Date.now() - 5_000,
      }),
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "calculate the answer" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "calc" }] },
      { role: "toolResult", content: "42" },
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(gatewayParams().message).toContain("The final answer is 42.");
    expect(gatewayParams().message).not.toContain(INTERNAL_RUNTIME_CONTEXT_BEGIN);
    expect(gatewayParams().message).not.toContain("Conversation info");

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.pendingFinalDelivery).toMatchObject({
      kind: "replayable",
      text: "The final answer is 42.",
    });
  });

  it("resumes an unguarded pending final delivery without a transcript", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        ...runningSessionEntry("missing-transcript-session", { status: "interrupted" }),
        abortedLastRun: true,
        pendingFinalDelivery: makePendingFinalDelivery("The durable final answer.", {
          createdAt: Date.now() - 5_000,
        }),
      },
    });

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(gatewayParams().message).toContain("The durable final answer.");
    expect(gatewayParams()).not.toHaveProperty("forceRestartSafeTools");
  });

  it("skips restart-aborted sessions that a current process owns", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:active-key": {
        ...runningSessionEntry("active-key-session", { status: "interrupted" }),
        abortedLastRun: true,
      },
      "agent:main:active-id": {
        ...runningSessionEntry("active-id-session", { status: "interrupted" }),
        abortedLastRun: true,
      },
      "agent:main:recoverable": {
        ...runningSessionEntry("recoverable-session", { status: "interrupted" }),
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "active-key-session", [
      { role: "user", content: "new run owns this key" },
      { role: "toolResult", content: "done" },
    ]);
    await writeTranscript(sessionsDir, "active-id-session", [
      { role: "user", content: "new run owns this id" },
      { role: "toolResult", content: "done" },
    ]);
    await writeTranscript(sessionsDir, "recoverable-session", [
      { role: "user", content: "recover this one" },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({
      stateDir: tmpDir,
      activeSessionKeys: ["agent:main:active-key"],
      activeSessionIds: ["active-key-session", "active-id-session"],
    });

    expect(result).toEqual({ started: 1, settled: 0, failed: 0, skipped: 2 });
    expect(callGateway).toHaveBeenCalledOnce();
    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:active-key"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:active-id"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:recoverable"]?.abortedLastRun).toBe(false);
  });

  it("recovers duplicate-key restart-aborted rows when the active run owns a different session id", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        ...runningSessionEntry("stale-session", { status: "interrupted" }),
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "stale-session", [
      { role: "user", content: "recover the stale duplicate" },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({
      stateDir: tmpDir,
      activeSessionKeys: ["agent:main:main"],
      activeSessionIds: ["new-current-session"],
    });

    expect(result).toEqual({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
  });

  it("marks startup-orphaned admission claims before recovery", async () => {
    const sessionsDir = await makeSessionsDir();
    const cutoff = Date.now();
    const archivedKey = "agent:main:archived";
    const archived: SessionEntry = {
      sessionId: "archived-session",
      updatedAt: cutoff - 10_000,
      archivedAt: cutoff - 5_000,
      status: "interrupted",
      abortedLastRun: true,
      restartRecoveryDeliveryRunId: "archived-recovery",
      restartRecoveryDeliverySourceRunId: "archived-source",
      pendingFinalDelivery: makePendingFinalDelivery(),
    };
    await writeStore(sessionsDir, {
      [archivedKey]: archived,
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: cutoff - 10_000,
        restartRecoveryRuns: [{ runId: "main-run", lifecycleGeneration: "prior-process" }],
      },
      "agent:main:active-key": {
        sessionId: "active-key-session",
        updatedAt: cutoff - 10_000,
        restartRecoveryDeliveryRunId: "active-key-run",
      },
      "agent:main:active-id": {
        sessionId: "active-id-session",
        updatedAt: cutoff - 10_000,
        restartRecoveryDeliveryRunId: "active-id-run",
      },
      "agent:main:fresh": {
        sessionId: "fresh-session",
        updatedAt: cutoff + 1,
        restartRecoveryDeliveryRunId: "fresh-run",
      },
      "agent:main:subagent:child": {
        sessionId: "child-session",
        updatedAt: cutoff - 10_000,
        restartRecoveryDeliveryRunId: "child-run",
        spawnDepth: 1,
      },
      "agent:main:cron:nightly": {
        sessionId: "cron-session",
        updatedAt: cutoff - 10_000,
        restartRecoveryDeliveryRunId: "cron-run",
      },
      "agent:main:completed": {
        sessionId: "completed-session",
        updatedAt: cutoff - 10_000,
        status: "done",
        mainRestartRecovery: { cycleId: "completed-cycle", revision: 1, chargedAttempts: 0 },
        restartRecoveryTerminalRunIds: ["completed-prior-process-run"],
        restartRecoveryRuns: [
          {
            runId: "completed-prior-process-run",
            lifecycleGeneration: "prior-process",
          },
        ],
      },
      "agent:main:already-marked": {
        sessionId: "already-marked-session",
        updatedAt: cutoff - 10_000,
        status: "interrupted",
        abortedLastRun: true,
        restartRecoveryRuns: [
          {
            runId: "marked-prior-process-run",
            lifecycleGeneration: "prior-process",
          },
        ],
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run the tool" },
      { role: "toolResult", content: "done" },
    ]);
    await writeTranscript(sessionsDir, "already-marked-session", [
      { role: "user", content: "already interrupted" },
      { role: "toolResult", content: "done" },
    ]);
    await writeTranscript(sessionsDir, archived.sessionId, [
      { role: "user", content: "do not recover while archived" },
    ]);
    const storePath = path.join(sessionsDir, "sessions.json");
    const before = readStore(storePath);
    const archivedScope = {
      agentId: "main",
      sessionKey: archivedKey,
      sessionId: archived.sessionId,
      storePath,
    };
    const archivedHistory = await loadTranscriptEvents(archivedScope);

    const marked = await markStartupOrphanedMainSessionsForRecovery({
      stateDir: tmpDir,
      activeSessionKeys: ["agent:main:active-key"],
      activeSessionIds: ["active-key-session", "active-id-session"],
      updatedBeforeMs: cutoff,
    });

    expect(marked).toEqual({ marked: 1, skipped: 3 });
    let store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:active-key"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:active-id"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:fresh"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:subagent:child"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:cron:nightly"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:completed"]?.abortedLastRun).toBe(false);
    expect(store["agent:main:already-marked"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:completed"]?.restartRecoveryRuns).toBeUndefined();
    expect(store["agent:main:already-marked"]?.restartRecoveryRuns).toHaveLength(1);

    const recovered = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(recovered).toEqual({ started: 2, settled: 0, failed: 0, skipped: 1 });
    expect(callGateway).toHaveBeenCalledTimes(2);
    store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
    expect(store["agent:main:already-marked"]?.abortedLastRun).toBe(false);
    for (const key of [archivedKey, "agent:main:active-key", "agent:main:active-id"]) {
      expect(store[key]).toEqual(before[key]);
    }
    expect(await loadTranscriptEvents(archivedScope)).toEqual(archivedHistory);
  });

  it.each<{
    name: string;
    residue: Partial<SessionEntry>;
  }>([
    {
      name: "a stale before-reply phase",
      residue: { restartRecoveryBeforeAgentReplyState: "pending" },
    },
    {
      name: "an incomplete terminal-delivery receipt",
      residue: { restartRecoveryDeliveryReceiptState: "delivered-terminal" },
    },
    {
      name: "a completed delivery claim with a stale handled phase",
      residue: {
        restartRecoveryDeliveryRunId: "finished-run",
        restartRecoveryBeforeAgentReplyState: "handled-reply",
      },
    },
  ])("does not resume completed work from $name", async ({ residue }) => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:main";
    await writeStore(sessionsDir, {
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

    await markStartupOrphanedMainSessionsForRecovery({ stateDir: tmpDir });
    await expect(recoverRestartAbortedMainSessions({ stateDir: tmpDir })).resolves.toMatchObject({
      started: 0,
      failed: 0,
    });

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
    expect(entry?.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(entry?.mainRestartRecovery).toBeUndefined();
    expect(entry?.restartRecoveryRuns).toBeUndefined();
  });

  it("does not create empty agent databases while scanning startup recovery", async () => {
    const agentIds = Array.from({ length: 12 }, (_, index) => `agent-${index + 1}`);
    const databasePaths = await Promise.all(
      agentIds.map(async (agentId) => {
        await makeSessionsDir(agentId);
        return path.join(tmpDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
      }),
    );

    await expect(markStartupOrphanedMainSessionsForRecovery({ stateDir: tmpDir })).resolves.toEqual(
      { marked: 0, skipped: 0 },
    );
    for (const databasePath of databasePaths) {
      await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("keeps corrupt existing agent databases on the startup recovery error path", async () => {
    await makeSessionsDir();
    const databasePath = path.join(tmpDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    await fs.writeFile(databasePath, "not a sqlite database");

    await expect(markStartupOrphanedMainSessionsForRecovery({ stateDir: tmpDir })).resolves.toEqual(
      {
        marked: 0,
        skipped: 0,
        failedTargets: [
          {
            agentId: "main",
            storePath: path.join(tmpDir, "agents", "main", "sessions", "sessions.json"),
          },
        ],
      },
    );
    expect(readStartupRecoveryWarning()).toBeDefined();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("preserves a live session after delayed stale registration", async () => {
    const sessionsDir = await makeSessionsDir();
    const cutoff = Date.now();
    const sessionKey = "agent:main:generation-race";
    const sessionId = "generation-race-session";
    await writeStore(sessionsDir, {
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
    await writeTranscript(sessionsDir, "control-session", [
      { role: "user", content: "resume the control session" },
      { role: "toolResult", content: "done" },
    ]);

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
    setActiveEmbeddedRunLifecycleGeneration(staleHandle, priorLifecycleGeneration);

    rotateAgentEventLifecycleGeneration();
    const currentHandle = createHandle("current-generation-run");
    setActiveEmbeddedRun(sessionId, currentHandle, sessionKey);
    setActiveEmbeddedRun(sessionId, staleHandle, sessionKey);

    const recovery = scheduleRestartAbortedMainSessionRecovery({
      delayMs: 0,
    });
    try {
      await mockRecoveryRuntime.expectAdmission(1, recovery, {
        sessionKey: "agent:main:control",
        storePath: path.join(sessionsDir, "sessions.json"),
      });

      expect(callGateway).toHaveBeenCalledOnce();
      const activeEntry = loadSessionEntry({
        sessionKey,
        storePath: path.join(sessionsDir, "sessions.json"),
      });
      expect(activeEntry?.status).toBeUndefined();
      expect(activeEntry?.abortedLastRun).toBeUndefined();
    } finally {
      clearActiveEmbeddedRun(sessionId, currentHandle, sessionKey);
      clearActiveEmbeddedRun(sessionId, staleHandle, sessionKey);
    }
  });

  it("cancels a stale startup owner after a mid-scan lifecycle rotation", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:generation-race";
    const sessionId = "generation-race-session";
    await writeStore(sessionsDir, {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now() - 10_000,
        restartRecoveryDeliveryRunId: "generation-race-run",
      },
    });

    const originalApply = sessionAccessor.applySessionEntryReplacements;
    const markerEntered = createDeferred();
    const releaseMarker = createDeferred();
    let pausedMarker = false;
    const replacementSpy = vi
      .spyOn(sessionAccessor, "applySessionEntryReplacements")
      .mockImplementation(async (params) => {
        if (params.requireWriteSuccess === true && !pausedMarker) {
          pausedMarker = true;
          markerEntered.resolve();
          await releaseMarker.promise;
        }
        return await originalApply(params);
      });
    const recovery = scheduleRestartAbortedMainSessionRecovery({
      delayMs: 0,
    });
    await markerEntered.promise;
    expect(getActiveGatewayRootWorkCount()).toBe(1);

    // Rotate while the production scheduler owns the startup scan. Its marker
    // must re-read the replacement generation's owner before writing, while
    // stop waits for that in-flight root-work admission to leave cleanly.
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
      expect(entry?.status).toBeUndefined();
      expect(entry?.abortedLastRun).toBeUndefined();
      expect(entry?.mainRestartRecovery).toBeUndefined();
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
    const defaultSessionsDir = await makeSessionsDir();
    await writeStore(defaultSessionsDir, {
      "agent:main:main": {
        sessionId: "default-main-session",
        updatedAt: cutoff - 10_000,
        restartRecoveryDeliveryRunId: "default-main-run",
      },
    });
    await writeTranscript(defaultSessionsDir, "default-main-session", [
      { role: "user", content: "continue default" },
      { role: "toolResult", content: "default result" },
    ]);

    const customStorePath = path.join(tmpDir, "custom-startup-duplicate", "sessions.json");
    await writeStorePath(customStorePath, {
      "agent:main:main": {
        sessionId: "custom-main-session",
        updatedAt: cutoff - 10_000,
        restartRecoveryDeliveryRunId: "custom-main-run",
      },
    });
    await writeTranscript(path.dirname(customStorePath), "custom-main-session", [
      { role: "user", content: "continue custom" },
      { role: "toolResult", content: "custom result" },
    ]);

    const recovery = scheduleRestartAbortedMainSessionRecovery({
      getConfig: () => ({ session: { store: customStorePath } }),
      delayMs: 0,
    });
    await mockRecoveryRuntime.expectAdmission(1, recovery, {
      sessionKey: "agent:main:main",
      storePath: customStorePath,
    });

    expect(callGateway).toHaveBeenCalledOnce();
    const defaultStore = readStore(path.join(defaultSessionsDir, "sessions.json"));
    const customStore = readStore(customStorePath);
    expect(defaultStore["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(customStore["agent:main:main"]?.abortedLastRun).toBe(false);
  });

  it("rediscovers a restored configured store between startup marking and recovery", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeMainSession({ sessionsDir, abortedLastRun: undefined });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "resume the interrupted main session" },
      { role: "toolResult", content: "main result" },
    ]);

    const lateSessionsDir = path.join(tmpDir, "agents", "late", "sessions");
    const lateStorePath = path.join(lateSessionsDir, "sessions.json");
    const cfg = {
      agents: { entries: { main: {}, late: {} } },
    } as OpenClawConfig;
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
          await writeTranscript(lateSessionsDir, "late-session", [
            { role: "user", content: "resume the restored session" },
            { role: "toolResult", content: "late result" },
          ]);
        }
        return result;
      });

    const firstDispatch = createDeferred();
    vi.mocked(callGateway).mockImplementationOnce(async () => {
      firstDispatch.resolve();
      return { runId: "run-resumed" };
    });
    const recovery = scheduleRestartAbortedMainSessionRecovery({
      getConfig: () => cfg,
      delayMs: 0,
    });
    try {
      await firstDispatch.promise;
      expect(callGateway).toHaveBeenCalledOnce();
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

  it("cancels startup recovery when its gateway lifecycle stops", async () => {
    tmpDir = transcriptFixture.prepareRoot();
    const { sessionsDir } = await makeMainSessionFixture({
      pendingFinalDelivery: makePendingFinalDelivery(),
    });

    vi.useFakeTimers();
    try {
      const recovery = scheduleRestartAbortedMainSessionRecovery({
        delayMs: 5_000,
      });

      await Promise.all([recovery.stop(), recovery.stop()]);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(callGateway).not.toHaveBeenCalled();
      expect(
        loadSessionEntry({
          sessionKey: "agent:main:main",
          storePath: path.join(sessionsDir, "sessions.json"),
        }),
      ).toMatchObject({ status: "interrupted", abortedLastRun: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops startup recovery while its Gateway admission is suspended", async () => {
    tmpDir = transcriptFixture.prepareRoot();
    const { readEntry } = await makeMainSessionFixture({
      pendingFinalDelivery: makePendingFinalDelivery(),
    });
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension).not.toBeNull();
    vi.useFakeTimers();
    const recovery = scheduleRestartAbortedMainSessionRecovery({
      delayMs: 0,
    });
    let stopping: Promise<void> | undefined;
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      let stopped = false;
      stopping = recovery.stop().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(true);

      suspension?.rollback();
      await vi.advanceTimersByTimeAsync(0);
      expect(callGateway).not.toHaveBeenCalled();
      expect(readEntry()).toMatchObject({
        status: "interrupted",
        abortedLastRun: true,
      });
    } finally {
      suspension?.rollback();
      await (stopping ?? recovery.stop());
      vi.useRealTimers();
    }
  });

  it.for([
    { publication: "during the initial scan", owner: "main", shared: false },
    { publication: "after the initial scan", owner: "main", shared: false },
    { publication: "after stop", owner: "main", shared: false },
    { publication: "after the initial scan", owner: "old", shared: false },
    { publication: "after the initial scan", owner: "old", shared: true },
  ])(
    "observes deferred database admission $publication (owner=$owner, shared=$shared)",
    async ({ publication, owner, shared }, { signal }) => {
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
          { role: "user", content: "resume after database admission" },
          { role: "toolResult", content: "main result" },
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
        const recovery = scheduleRestartAbortedMainSessionRecovery({
          getConfig: () => cfg,
          delayMs: 0,
          maxRetries: 1,
          stateDir: tmpDir,
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
            await mockRecoveryRuntime.expectAdmission(1, recovery, {
              sessionKey,
              storePath,
            });
            const fresh = loadSessionEntry({
              agentId: logicalOwner,
              sessionKey: freshSessionKey,
              storePath,
            });
            expect(fresh).toMatchObject({
              sessionId: "fresh-session",
            });
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

  it("waits for startup release while preserving the registration cutoff", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const releaseStartup = createDeferred();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        ...runningSessionEntry("pre-start-session"),
        updatedAt: 1,
      },
    });
    await writeTranscript(sessionsDir, "pre-start-session", [
      { role: "user", content: "resume the interrupted work" },
      { role: "toolResult", content: "done" },
    ]);

    const recovery = scheduleRestartAbortedMainSessionRecovery({
      delayMs: 0,
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
    await writeTranscript(sessionsDir, "post-start-session", [
      { role: "user", content: "new work from this gateway" },
      { role: "toolResult", content: "done" },
    ]);

    releaseStartup.resolve();
    await mockRecoveryRuntime.expectAdmission(1, recovery, {
      storePath,
      sessionKey: "agent:main:main",
    });

    const store = readStore(storePath);
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
    expect(store["agent:main:fresh"]).toMatchObject({
      sessionId: "post-start-session",
    });
    expect(store["agent:main:fresh"]?.status).toBeUndefined();
    expect(store["agent:main:fresh"]?.abortedLastRun).toBeUndefined();
  });

  it("uses the live configured roster after the startup recovery barrier", async () => {
    const sessionsDir = await makeSessionsDir("work");
    const storePath = path.join(sessionsDir, "sessions.json");
    const releaseStartup = createDeferred();
    await writeMainSession({ sessionsDir, sessionKey: "agent:work:main" });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "resume after config reload" },
      { role: "toolResult", content: "done" },
    ]);
    let currentConfig = {
      agents: { entries: { main: {} } },
    } as OpenClawConfig;

    const recovery = scheduleRestartAbortedMainSessionRecovery({
      delayMs: 0,
      getConfig: () => currentConfig,
      waitForStart: () => releaseStartup.promise,
    });
    await Promise.resolve();
    currentConfig = {
      agents: { entries: { main: {}, work: {} } },
    } as OpenClawConfig;
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

    const recovery = scheduleRestartAbortedMainSessionRecovery({
      delayMs: 0,
      waitForStart: () => releaseStartup.promise,
    });
    await recovery.stop();
    releaseStartup.resolve();
    await Promise.resolve();

    expect(callGateway).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(readEntry()).toMatchObject({
      status: "interrupted",
      abortedLastRun: true,
    });
  });

  it("fences an in-flight startup recovery before its durable session claim", async () => {
    tmpDir = transcriptFixture.prepareRoot();
    const { readEntry } = await makeMainSessionFixture({
      pendingFinalDelivery: makePendingFinalDelivery(),
    });

    const originalApply = sessionAccessor.applySessionEntryReplacements;
    const observeEntered = createDeferred();
    const releaseObserve = createDeferred();
    let pausedObservation = false;
    const replacementSpy = vi
      .spyOn(sessionAccessor, "applySessionEntryReplacements")
      .mockImplementation(async (params) => {
        if (params.requireWriteSuccess === true && !pausedObservation) {
          pausedObservation = true;
          observeEntered.resolve();
          await releaseObserve.promise;
        }
        return await originalApply(params);
      });

    const recovery = scheduleRestartAbortedMainSessionRecovery({
      delayMs: 0,
    });
    let stopping: Promise<void> | undefined;
    try {
      await observeEntered.promise;
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      let stopSettled = false;
      stopping = recovery.stop().then(() => {
        stopSettled = true;
      });
      await Promise.resolve();

      expect(stopSettled).toBe(false);
      expect(callGateway).not.toHaveBeenCalled();

      releaseObserve.resolve();
      await stopping;

      expect(callGateway).not.toHaveBeenCalled();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(readEntry()).toMatchObject({
        status: "interrupted",
        abortedLastRun: true,
      });
      expect(readEntry()?.mainRestartRecovery).toMatchObject({
        cycleId: "interrupted-cycle",
        revision: 1,
        chargedAttempts: 0,
      });
    } finally {
      releaseObserve.resolve();
      await stopping;
      replacementSpy.mockRestore();
    }
  });

  it("joins an in-flight startup dispatch before stopping its recovery owner", async () => {
    tmpDir = transcriptFixture.prepareRoot();
    await makeMainSessionFixture({
      pendingFinalDelivery: makePendingFinalDelivery(),
    });

    const dispatchEntered = createDeferred();
    const releaseDispatch = createDeferred();
    vi.mocked(callGateway).mockImplementationOnce(async () => {
      dispatchEntered.resolve();
      await releaseDispatch.promise;
      return { runId: "run-resumed" };
    });

    const recovery = scheduleRestartAbortedMainSessionRecovery({
      delayMs: 0,
    });
    let stopping: Promise<void> | undefined;
    try {
      await dispatchEntered.promise;
      let stopSettled = false;
      stopping = recovery.stop().then(() => {
        stopSettled = true;
      });
      await Promise.resolve();

      expect(stopSettled).toBe(false);
      expect(getActiveGatewayRootWorkCount()).toBe(1);

      releaseDispatch.resolve();
      await stopping;

      expect(callGateway).toHaveBeenCalledOnce();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      releaseDispatch.resolve();
      await stopping;
    }
  });

  it("fences an ambiguous terminal probe when its startup recovery owner stops", async () => {
    tmpDir = transcriptFixture.prepareRoot();
    const { readEntry } = await makeMainSessionFixture({
      pendingFinalDelivery: makePendingFinalDelivery(),
    });

    const probeEntered = createDeferred();
    const releaseProbe = createDeferred();
    let recoveryRunId: string | undefined;
    vi.mocked(callGateway).mockImplementation(async (request) => {
      if (request.method === "agent") {
        recoveryRunId = String((request.params as { idempotencyKey?: unknown }).idempotencyKey);
        throw new Error("ambiguous recovery dispatch transport failure");
      }
      if (request.method === "agent.wait") {
        probeEntered.resolve();
        await releaseProbe.promise;
        return { runId: recoveryRunId, status: "ok", endedAt: Date.now() };
      }
      return { runId: "run-resumed" };
    });

    const recovery = scheduleRestartAbortedMainSessionRecovery({
      delayMs: 0,
    });
    let stopping: Promise<void> | undefined;
    try {
      await probeEntered.promise;
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      expect(recoveryRunId).toEqual(expect.any(String));

      let stopSettled = false;
      stopping = recovery.stop().then(() => {
        stopSettled = true;
      });
      await Promise.resolve();

      expect(stopSettled).toBe(false);
      expect(callGateway).toHaveBeenCalledTimes(2);

      releaseProbe.resolve();
      await stopping;

      const entry = readEntry();
      expect(entry).toMatchObject({
        status: "interrupted",
        abortedLastRun: true,
        pendingFinalDelivery: {
          kind: "replayable",
          text: "interrupted response",
        },
        mainRestartRecovery: { chargedAttempts: 1 },
      });
      expect(entry?.mainRestartRecovery?.reservation).toBeUndefined();
      expect(entry?.restartRecoveryTerminalRunIds ?? []).not.toContain(recoveryRunId);
      expect(entry?.restartRecoveryRuns ?? []).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ runId: recoveryRunId })]),
      );
      expect(callGateway).toHaveBeenCalledTimes(2);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      releaseProbe.resolve();
      await (stopping ?? recovery.stop());
    }
  });

  it.each([false, true])(
    "resumes healthy stores when another startup marker fails (transient=%s)",
    async (transient) => {
      const cfg = { agents: { entries: { main: {}, worker: {} } } };
      for (const agentId of ["main", "worker"]) {
        const sessionsDir = await makeSessionsDir(agentId);
        await writeStore(sessionsDir, {
          [`agent:${agentId}:main`]: {
            sessionId: `${agentId}-session`,
            updatedAt: 1,
            restartRecoveryDeliveryRunId: `${agentId}-run`,
            lifecycleRunId: `${agentId}-run`,
            abortedLastRun: false,
          },
        });
        await writeTranscript(sessionsDir, `${agentId}-session`, [
          { role: "user", content: "finish the interrupted work" },
          { role: "toolResult", content: "ready" },
        ]);
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
      const attempts = observeRecoveryRootCompletions(
        "main-session:startup-recovery",
        transient ? 2 : 1,
      );
      const recovery = scheduleRestartAbortedMainSessionRecovery({
        getConfig: () => cfg,
        delayMs: transient ? 1 : 0,
        maxRetries: transient ? 2 : 1,
      });
      try {
        await failedMark.promise;
        if (transient) {
          await firstDispatch.promise;
          expect(callGateway).toHaveBeenCalledOnce();
          dispatchSettlement.resolve(); // Retried stores share the same bounded recovery slot.
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
        rotateAgentEventLifecycleGeneration();
      }
    },
  );

  it("retains canonical retry backoff when startup recovery begins immediately", async () => {
    const { sessionsDir } = await makeMainSessionFixture({
      pendingFinalDelivery: makePendingFinalDelivery(),
    });
    const cfg = {} as OpenClawConfig;
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
    const retryScheduled = createDeferred();
    const fakeSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((...args: Parameters<typeof setTimeout>) => {
        const timer = fakeSetTimeout(...args);
        if (args[1] === 5_000) {
          retryScheduled.resolve();
        }
        return timer;
      });
    const countAgentDispatches = () =>
      vi.mocked(callGateway).mock.calls.filter(([request]) => request.method === "agent").length;
    let recovery: ReturnType<typeof scheduleRestartAbortedMainSessionRecovery> | undefined;
    try {
      recovery = scheduleRestartAbortedMainSessionRecovery({
        getConfig: () => cfg,
        delayMs: 0,
        maxRetries: 2,
      });
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
      await writeTranscript(sessionsDir, "late-startup-session", [
        { role: "user", content: "this row appeared after startup marking" },
        { role: "toolResult", content: "done" },
      ]);

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
      expect(lateEntry?.status).toBeUndefined();
      expect(lateEntry?.abortedLastRun).toBeUndefined();
    } finally {
      await recovery?.stop();
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("retries only the requested abandoned durable claim", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, {
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
      "agent:main:other": {
        ...runningSessionEntry("other-session", { status: "interrupted" }),
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: "recovery-other",
        restartRecoveryDeliverySourceRunId: "source-other",
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "recover only me" },
    ]);
    await writeTranscript(sessionsDir, "other-session", [
      { role: "user", content: "leave me pending" },
    ]);

    const result = await retryRestartAbortedMainSessionRecovery({
      cfg: {},
      expectedRecoveryRunId: "recovery-main",
      expectedRecoverySourceRunId: "source-main",
      expectedSessionId: "main-session",
      sessionKey: "agent:main:main",
      storePath,
    });

    expect(result).toEqual({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(gatewayParams().idempotencyKey).toBe("recovery-main");
    expect(sendRecoveryNotice).not.toHaveBeenCalled();
    expect(gatewayParams()).toMatchObject({
      expectedExistingSessionId: "main-session",
      internalRuntimeHandoffId: expect.any(String),
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

  it("retries a failed exact owner-release recovery with bounded backoff", async () => {
    const { sessionsDir, storePath, readEntry } = await makeMainSessionFixture({
      restartRecoveryDeliveryRunId: "control-ui-run",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
    });
    await writeCompletedToolTranscript(sessionsDir);
    vi.mocked(callGateway)
      .mockRejectedValueOnce(new Error("temporary dispatch failure"))
      .mockResolvedValueOnce({ runId: "run-resumed", status: "running" })
      .mockResolvedValueOnce({ runId: "run-resumed" });

    const attempts = observeRecoveryRootCompletions("main-session:restart-recovery", 2);
    try {
      scheduleRestartAbortedMainSessionRecoveryAfterOwnerRelease({
        delayMs: 0,
        expectedSessionId: "main-session",
        getConfig: () => ({}),
        getGatewayRuntime: () => mockRecoveryRuntime,
        maxRetries: 2,
        sessionKey: "agent:main:main",
        storePath,
      });

      await attempts.completed;
      expect(callGateway).toHaveBeenCalledTimes(3);
      expect(readEntry()).toMatchObject({
        abortedLastRun: false,
      });
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      attempts.restore();
    }
  });

  it("tombstones exhausted recovery with replacement-session instructions", async () => {
    const { readEntry } = await makeMainSessionFixture({
      sessionKey: "agent:main:discord:direct:123",
      mainRestartRecovery: {
        cycleId: "cycle-exhausted",
        revision: 1,
        chargedAttempts: 3,
      },
      restartRecoveryDeliveryContext: discordDeliveryContext,
    });

    await expectRecovery({ started: 0, settled: 0, failed: 0, skipped: 1 });
    expect(sendRecoveryNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Resume in new session"),
      }),
    );
    expect(sendRecoveryNotice).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("/new or /reset") }),
    );
    expect(readEntry()).toMatchObject({
      status: "failed",
      mainRestartRecovery: { tombstone: expect.any(Object) },
    });
  });

  it("rejects foreground takeover while tombstoning exhausted recovery", async () => {
    tmpDir = transcriptFixture.prepareRoot();
    const { sessionsDir, storePath, sessionKey, readEntry } = await makeMainSessionFixture({
      mainRestartRecovery: {
        cycleId: "cycle-exhausted",
        revision: 1,
        chargedAttempts: 3,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "continue this turn" },
    ]);
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

    await expectRecovery({ started: 0, settled: 0, failed: 0, skipped: 1 });

    const entry = readEntry();
    expect(entry).toMatchObject({
      status: "failed",
      abortedLastRun: false,
      mainRestartRecovery: { tombstone: expect.any(Object) },
    });
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

  it("retries tombstoning after a transcript metadata conflict", async () => {
    tmpDir = transcriptFixture.prepareRoot();
    const { sessionsDir, readEntry } = await makeMainSessionFixture({
      mainRestartRecovery: {
        cycleId: "cycle-exhausted",
        revision: 1,
        chargedAttempts: 3,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "continue this turn" },
    ]);
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockResolvedValueOnce({
      ok: false,
      code: "session-rebound",
      reason: "session metadata changed",
    });

    await expectRecovery({ started: 0, settled: 0, failed: 0, skipped: 1 });

    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledTimes(2);
    expect(readEntry()).toMatchObject({
      status: "failed",
      abortedLastRun: false,
      mainRestartRecovery: { tombstone: expect.any(Object) },
    });
  });

  it("tombstones when the final owner-release retry consumes the last charge", async () => {
    const { sessionsDir, storePath, readEntry } = await makeControlUiRecoveryFixture({
      mainRestartRecovery: {
        cycleId: "cycle-final-attempt",
        revision: 1,
        chargedAttempts: 2,
      },
    });
    await writeCompletedToolTranscript(sessionsDir);
    vi.mocked(callGateway)
      .mockRejectedValueOnce(new Error("final ambiguous dispatch failure"))
      .mockResolvedValueOnce({ runId: "run-resumed", status: "running" });

    const attempts = observeRecoveryRootCompletions("main-session:restart-recovery", 2);
    scheduleRestartAbortedMainSessionRecoveryAfterOwnerRelease({
      delayMs: 0,
      expectedSessionId: "main-session",
      getConfig: () => ({}),
      getGatewayRuntime: () => mockRecoveryRuntime,
      maxRetries: 1,
      sessionKey: "agent:main:main",
      storePath,
    });

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
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "recover only with delivery authority" },
    ]);

    await expectRecovery({ started: 0, settled: 0, failed: 0, skipped: 1 });
    expect(sendRecoveryNotice).toHaveBeenCalledOnce();
    expect(sendRecoveryNotice).toHaveBeenCalledWith({
      accountId: "work",
      channel: "discord",
      to: "discord:dm:main",
      threadId: undefined,
      idempotencyKey: "main-session-restart-recovery:recovery-main:failed-notice",
      text: expect.stringContaining("Resume in new session"),
    });
    const failedEntry = readEntry();
    expect(failedEntry).toMatchObject({
      abortedLastRun: false,
      status: "failed",
      mainRestartRecovery: { tombstone: expect.any(Object) },
    });
    expect(failedEntry?.restartRecoveryDeliveryRunId).toBe("recovery-main");
    expect(failedEntry?.restartRecoverySourceReplyDeliveryMode).toBe("message_tool_only");
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
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do not inherit a fallback route" },
    ]);

    await expectRecovery({ started: 0, settled: 0, failed: 0, skipped: 1 });
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
        content: [
          {
            type: "text",
            text: expect.stringContaining("Resume in new session"),
          },
        ],
      },
    });
    expect(readEntry()).toMatchObject({
      status: "failed",
      abortedLastRun: false,
      mainRestartRecovery: { tombstone: expect.any(Object) },
    });
  });

  it("aborts an exact recovery accepted after the execution-start deadline", async () => {
    vi.useFakeTimers();
    let accept: (() => void) | undefined;
    const abort = vi.fn(() => true);
    const dispatchAgent = vi.fn(
      async (
        _request: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[0],
        _timeoutMs: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[1],
        options: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[2],
      ) => {
        accept = () => {
          options?.onStartOwner?.({
            observe: () => ({ executionStarted: false, expiresAtMs: Date.now() + 60_000 }),
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
        gatewayRuntime: {
          dispatchSessionMethod: vi.fn(),
          dispatchAgent: dispatchAgent as GatewayRecoveryRuntime["dispatchAgent"],
          sendRecoveryNotice: vi.fn(),
          waitForAgent: vi.fn(),
        },
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

  it("restores an accepted recovery that fails before execution starts", async () => {
    const { sessionsDir, storePath, readEntry } = await makeMainSessionFixture({
      restartRecoveryDeliveryRunId: "recovery-main",
      restartRecoveryDeliverySourceRunId: "source-main",
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "recover without losing the owner" },
    ]);
    const scheduleSpy = vi
      .spyOn(recoveryOwnerRelease, "scheduleMainSessionRecoveryPendingTarget")
      .mockImplementation(() => {});
    let acceptedObserver: ((payload: unknown) => void) | undefined;
    const dispatchAgent = vi.fn<GatewayRecoveryRuntime["dispatchAgent"]>(
      async (request, _timeoutMs, options) => {
        const runId = request.idempotencyKey!;
        await commitMainSessionRecovery({
          command: {
            kind: "admit_recovery",
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
            now: Date.now(),
            runId,
            sessionId: "main-session",
          },
          requireWriteSuccess: true,
          target: { sessionKey: "agent:main:main", storePath },
        });
        acceptedObserver = options?.onAccepted;
        acceptedObserver?.({ runId, status: "accepted" });
        throw new Error("detached execution failed before provider start");
      },
    );

    try {
      const result = await retryRestartAbortedMainSessionRecovery({
        cfg: {},
        expectedRecoveryRunId: "recovery-main",
        expectedRecoverySourceRunId: "source-main",
        expectedSessionId: "main-session",
        sessionKey: "agent:main:main",
        storePath,
        gatewayRuntime: {
          dispatchSessionMethod: vi.fn(),
          dispatchAgent: dispatchAgent as GatewayRecoveryRuntime["dispatchAgent"],
          waitForAgent: vi.fn(async () => ({
            runId: "recovery-main",
            status: "timeout",
            timeoutPhase: "queue",
            providerStarted: false,
          })) as GatewayRecoveryRuntime["waitForAgent"],
          sendRecoveryNotice: vi.fn(),
        },
      });

      expect(result).toEqual({ started: 0, settled: 0, failed: 1, skipped: 0 });
      expect(acceptedObserver).toBeTypeOf("function");
      expect(scheduleSpy).toHaveBeenCalledWith({
        agentId: "main",
        sessionId: "main-session",
        sessionKey: "agent:main:main",
        storePath,
      });
      expect(readEntry()).toMatchObject({
        status: "interrupted",
        abortedLastRun: true,
        restartRecoveryDeliverySourceRunId: "source-main",
        mainRestartRecovery: { chargedAttempts: 1 },
      });
      expect(readEntry()?.restartRecoveryDeliveryRunId).toBeUndefined();
    } finally {
      scheduleSpy.mockRestore();
    }
  });

  it.each([
    {
      label: "restores the interrupted claim after confirmed cancellation",
      aborted: true,
      cached: false,
      expectedAbortedLastRun: true,
      expectedRunId: undefined,
      expectedScheduleCount: 1,
    },
    {
      label: "keeps the claim fenced when cancellation is not confirmed",
      aborted: false,
      cached: false,
      expectedAbortedLastRun: false,
      expectedRunId: "recovery-main",
      expectedScheduleCount: 0,
    },
    {
      label: "restores a cached in-flight claim after confirmed cancellation",
      aborted: true,
      cached: true,
      expectedAbortedLastRun: true,
      expectedRunId: undefined,
      expectedScheduleCount: 1,
    },
  ])(
    "$label when accepted recovery never starts",
    async ({ aborted, cached, expectedAbortedLastRun, expectedRunId, expectedScheduleCount }) => {
      vi.useFakeTimers();
      const { sessionsDir, storePath, readEntry } = await makeMainSessionFixture({
        restartRecoveryDeliveryRunId: "recovery-main",
        restartRecoveryDeliverySourceRunId: "source-main",
      });
      await writeTranscript(sessionsDir, "main-session", [
        { role: "user", content: "recover after a stalled accepted dispatch" },
      ]);
      const scheduleSpy = vi
        .spyOn(recoveryOwnerRelease, "scheduleMainSessionRecoveryPendingTarget")
        .mockImplementation(() => {});
      const accepted = createDeferred();
      const abort = vi.fn(() => aborted);
      const dispatchAgent = vi.fn(
        async (
          request: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[0],
          _timeoutMs: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[1],
          options: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[2],
        ) => {
          const runId = request.idempotencyKey!;
          const expiresAtMs = Date.now() + 10_000;
          options?.onStartOwner?.({
            observe: () => ({ executionStarted: false, expiresAtMs }),
            abort,
          });
          await commitMainSessionRecovery({
            command: {
              kind: "admit_recovery",
              lifecycleGeneration: getAgentEventLifecycleGeneration(),
              now: Date.now(),
              runId,
              sessionId: "main-session",
            },
            requireWriteSuccess: true,
            target: { sessionKey: "agent:main:main", storePath },
          });
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
        const recovery = retryRestartAbortedMainSessionRecovery({
          cfg: {},
          expectedRecoveryRunId: "recovery-main",
          expectedRecoverySourceRunId: "source-main",
          expectedSessionId: "main-session",
          sessionKey: "agent:main:main",
          storePath,
          gatewayRuntime: {
            dispatchSessionMethod: vi.fn(),
            dispatchAgent: dispatchAgent as GatewayRecoveryRuntime["dispatchAgent"],
            waitForAgent: vi.fn(async () => ({
              runId: "recovery-main",
              status: "timeout",
              timeoutPhase: "queue",
              providerStarted: false,
            })) as GatewayRecoveryRuntime["waitForAgent"],
            sendRecoveryNotice: vi.fn(),
          },
        });

        await accepted.promise;
        await vi.advanceTimersByTimeAsync(10_000);
        await expect(recovery).resolves.toEqual({ started: 0, settled: 0, failed: 1, skipped: 0 });
        expect(abort).toHaveBeenCalledOnce();
        expect(scheduleSpy).toHaveBeenCalledTimes(expectedScheduleCount);
        expect(readEntry()?.status).toBe(expectedAbortedLastRun ? "interrupted" : undefined);
        expect(readEntry()).toMatchObject({
          abortedLastRun: expectedAbortedLastRun,
          restartRecoveryDeliverySourceRunId: "source-main",
        });
        expect(readEntry()?.restartRecoveryDeliveryRunId).toBe(expectedRunId);
      } finally {
        scheduleSpy.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it("holds lifecycle replacement behind the targeted recovery dispatch", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:main";
    const sessionId = "main-session";
    await writeStore(sessionsDir, {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now() - 10_000,
        status: "interrupted",
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: "recovery-main",
        restartRecoveryDeliverySourceRunId: "source-main",
      },
    });
    await writeTranscript(sessionsDir, sessionId, [{ role: "user", content: "recover me" }]);
    const dispatchEntered = createDeferred();
    const releaseDispatch = createDeferred();
    vi.mocked(callGateway).mockImplementationOnce(async () => {
      dispatchEntered.resolve();
      await releaseDispatch.promise;
      return { runId: "recovery-main" };
    });

    const recovery = retryRestartAbortedMainSessionRecovery({
      cfg: {},
      expectedRecoveryRunId: "recovery-main",
      expectedRecoverySourceRunId: "source-main",
      expectedSessionId: sessionId,
      sessionKey,
      storePath,
    });
    let mutationRan = false;
    let mutation: Promise<void> | undefined;
    try {
      await dispatchEntered.promise;
      expect(isSessionWorkAdmissionActive(storePath, [sessionKey, sessionId])).toBe(true);
      mutation = runExclusiveSessionLifecycleMutation("recover", {
        scope: storePath,
        identities: [sessionKey, sessionId],
        prepare: async () => {
          expect(
            await interruptSessionWorkAdmissions({
              scope: storePath,
              identities: [sessionKey, sessionId],
              timeoutMs: 1_000,
            }),
          ).toBe(true);
        },
        run: async () => {
          mutationRan = true;
        },
      });
      await waitForFast(() =>
        expect(isSessionLifecycleMutationActive(storePath, [sessionKey, sessionId])).toBe(true),
      );
      expect(mutationRan).toBe(false);

      releaseDispatch.resolve();
      await expect(recovery).resolves.toEqual({ started: 1, settled: 0, failed: 0, skipped: 0 });
      await mutation;
      expect(mutationRan).toBe(true);
    } finally {
      releaseDispatch.resolve();
      await Promise.allSettled([recovery, ...(mutation ? [mutation] : [])]);
    }
  });

  it("does not retry a replacement durable claim", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, {
      "agent:main:main": {
        ...runningSessionEntry("replacement-session", { status: "interrupted" }),
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: "replacement-recovery",
        restartRecoveryDeliverySourceRunId: "replacement-source",
      },
    });
    await writeTranscript(sessionsDir, "replacement-session", [
      { role: "user", content: "replacement turn" },
    ]);

    const result = await retryRestartAbortedMainSessionRecovery({
      expectedRecoveryRunId: "stale-recovery",
      expectedRecoverySourceRunId: "stale-source",
      expectedSessionId: "stale-session",
      sessionKey: "agent:main:main",
      storePath,
    });

    expect(result).toEqual({ started: 0, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      abortedLastRun: true,
      restartRecoveryDeliveryRunId: "replacement-recovery",
      restartRecoveryDeliverySourceRunId: "replacement-source",
      sessionId: "replacement-session",
    });
  });

  it("completes an interrupted turn whose exact terminal source reply was delivered", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:discord:direct:123";
    await writeStore(sessionsDir, {
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
      { role: "user", content: "do the thing", idempotencyKey: "discord-message-1" },
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
      makeToolResultMessage([{ type: "text", text: "sent" }], {
        toolCallId: "message-call-1",
        toolName: "message",
      }),
    ]);

    await expectRecovery({ started: 0, settled: 1, failed: 0, skipped: 0 });

    expect(callGateway).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      status: "done",
      abortedLastRun: false,
      restartRecoveryTerminalRunIds: ["discord-message-1"],
    });
    const completed = loadSessionEntry({ sessionKey, storePath });
    expect(completed?.lastRunId).toBeUndefined();
    expect(completed?.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(completed?.restartRecoveryDeliverySourceRunId).toBeUndefined();
    expect(completed?.restartRecoveryDeliveryContext).toBeUndefined();
    expect(completed?.restartRecoveryBeforeAgentReplyState).toBeUndefined();
    expect(completed?.pendingFinalDelivery).toBeUndefined();
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
    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
    expect(sendRecoveryNotice).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/:resumed-notice$/) }),
    );
    expect(readEntry()?.status).toBeUndefined();
    expect(readEntry()).toMatchObject({ abortedLastRun: false });
  });

  it("reconciles a receipt delivered during a restart-recovery continuation", async () => {
    const { sessionsDir, storePath, sessionKey, readEntry } =
      await makeDeliveredReceiptFixture("message-call-recovered");
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

    await expectRecovery({ started: 0, settled: 1, failed: 0, skipped: 0 });

    expect(callGateway).not.toHaveBeenCalled();
    expect(readEntry()).toMatchObject({
      status: "done",
      abortedLastRun: false,
      restartRecoveryTerminalRunIds: ["discord-message-1"],
    });
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
  });

  it.each([
    {
      label: "missing message tool call",
      sourceTurnId: "discord-message-1",
      messages: [makeUserMessage("do the thing", { idempotencyKey: "discord-message-1" })],
    },
    {
      label: "missing durable source turn",
      sourceTurnId: "discord-message-missing",
      messages: [makeMessageToolCall()],
    },
    {
      label: "checkpoint from an earlier turn",
      sourceTurnId: "discord-message-current",
      messages: [
        makeUserMessage("current turn", { idempotencyKey: "discord-message-current" }),
        makeMessageToolCall("message-call-1", "current answer"),
        makeUserMessage("later turn", { idempotencyKey: "discord-message-later" }),
      ],
    },
    {
      label: "unfinished sibling tool work",
      sourceTurnId: "discord-message-1",
      messages: [
        makeUserMessage("do the thing", { idempotencyKey: "discord-message-1" }),
        createAssistantToolCallMessage([
          {
            type: "toolCall",
            id: "message-call-1",
            name: "message",
            arguments: { action: "send", message: "current answer" },
          },
          { type: "toolCall", id: "pending-write", name: "write", arguments: {} },
        ]),
        makeMessageToolResult("message-call-1"),
      ],
    },
    {
      label: "non-successful existing tool result",
      sourceTurnId: "discord-message-1",
      messages: [
        ...makeMessageDeliveryTranscript(),
        makeToolResultMessage([{ type: "text", text: "transport reported failure" }], {
          toolCallId: "message-call-1",
          toolName: "message",
          isError: true,
        }),
      ],
    },
  ])(
    "resumes safely when terminal completion cannot reconcile $label",
    async ({ sourceTurnId, messages }) => {
      const { sessionsDir, readEntry } = await makeDeliveredReceiptFixture(
        "message-call-1",
        sourceTurnId,
      );
      await writeTranscript(sessionsDir, "main-session", messages);

      await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });

      expect(callGateway).toHaveBeenCalledOnce();
      expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
      expect(sendRecoveryNotice).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          idempotencyKey: expect.stringMatching(/:resumed-notice$/),
        }),
      );
      expect(readEntry()?.status).toBeUndefined();
      expect(readEntry()).toMatchObject({
        abortedLastRun: false,
      });
    },
  );

  it("matches a checkpointed Control UI hook to its run-keyed user turn", async () => {
    tmpDir = transcriptFixture.prepareRoot();
    const { sessionsDir, readEntry } = await makeControlUiRecoveryFixture({
      restartRecoveryBeforeAgentReplyState: "handled-silent",
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "quiet", idempotencyKey: "control-ui-run:user" },
    ]);

    await expectRecovery({ started: 0, settled: 1, failed: 0, skipped: 0 });

    expect(callGateway).not.toHaveBeenCalled();
    expect(readEntry()).toMatchObject({
      status: "done",
      abortedLastRun: false,
      lastRunId: "control-ui-run",
      restartRecoveryTerminalRunIds: ["control-ui-run"],
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
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      makeAssistantTextMessage("not this turn's terminal answer", {
        stopReason: "stop",
        openclawDeliveryMirror: {
          kind: "message-tool-source-reply",
          final,
          sourceTurnId,
          toolCallId: "message-call-1",
        },
      }),
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(sendRecoveryNotice).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/:resumed-notice$/),
      }),
    );
  });

  it("reconciles a provider error carrying a non-restart abort code", async () => {
    await writePreparedMainSessionTranscript([
      { role: "user", content: "do the thing" },
      makeAssistantTextMessage("", {
        stopReason: "error",
        errorMessage: "This operation was aborted",
        errorCode: "OPENCLAW_FIRST_EVENT_TIMEOUT",
      }),
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(gatewayParams()).not.toHaveProperty("forceRestartSafeTools");
  });

  it.each<{
    name: string;
    messages: unknown[];
    entry?: SessionEntryFixture;
    safeTools?: "required" | "absent" | "unrestricted";
    codeMode?: "required" | "absent";
    promptIncludes?: string[];
  }>([
    {
      name: "resumes a pre-upgrade errored tail without an abort code",
      messages: [
        { role: "user", content: "do the thing" },
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "Request was aborted",
        },
      ],
    },
    {
      name: "reads a provider-native Code Mode wait input",
      messages: [
        { role: "user", content: "do the thing" },
        codeModeCheckpointMessage("exec"),
        createAssistantToolCallMessage([
          {
            type: "tool_use",
            id: "call-wait-1",
            name: "wait",
            input: { runId: "cm_interrupted" },
          },
        ]),
      ],
      safeTools: "required",
      codeMode: "required",
    },
    {
      name: "withholds Code Mode tools for an unsafe direct waiting checkpoint",
      messages: [
        { role: "user", content: "do the thing" },
        codeModeCheckpointMessage("exec", {
          status: "waiting",
          runId: "cm_interrupted",
          replaySafe: false,
        }),
      ],
      safeTools: "required",
      codeMode: "absent",
    },
    {
      name: "keeps restart safety after a failed Code Mode result",
      messages: [
        { role: "user", content: "do the thing" },
        makeToolResultMessage(
          [
            {
              type: "text",
              text: JSON.stringify({
                status: "failed",
                replaySafe: true,
                error: "safe failure",
              }),
            },
          ],
          { toolName: "wait" },
        ),
      ],
      safeTools: "required",
    },
    {
      name: "keeps replay safety outside the recent transcript window under full access",
      messages: [
        { role: "user", content: "do the thing" },
        codeModeCheckpointMessage(),
        {
          role: "user",
          content: "Continue after restart",
          provenance: { kind: "internal_system", sourceTool: "main_session_restart_recovery" },
        },
        ...Array.from({ length: 24 }, (_, index) =>
          makeToolResultMessage([{ type: "text", text: `read result ${index}` }], {
            toolName: "read",
          }),
        ),
      ],
      entry: { permissionMode: "full", restartRecoveryForceSafeTools: true },
      safeTools: "required",
    },
    {
      name: "resumes an in-flight safe tool call across a repeated restart",
      messages: [
        { role: "user", content: "do the thing" },
        createAssistantToolCallMessage([
          { type: "thinking", thinking: "I need one more read." },
          { type: "toolCall", id: "call-read-2", name: "read", arguments: { path: "README.md" } },
        ]),
      ],
      entry: { restartRecoveryForceSafeTools: true },
      safeTools: "required",
    },
    {
      name: "retains replay safety after a provider error under full access",
      messages: [
        { role: "user", content: "do the thing" },
        codeModeCheckpointMessage(),
        makeAssistantTextMessage("Provider failed.", { stopReason: "error" }),
      ],
      entry: { permissionMode: "full", restartRecoveryForceSafeTools: true },
      safeTools: "required",
    },
    {
      name: "ends prior replay restrictions at a new full-access user turn",
      messages: [
        { role: "user", content: "the earlier request" },
        codeModeCheckpointMessage(),
        {
          role: "user",
          provenance: { kind: "internal_system", sourceTool: "main_session_restart_recovery" },
          content:
            "[System] Your previous turn was interrupted by a gateway restart while OpenClaw was waiting on tool/model work. Continue from the existing transcript and finish the interrupted response.",
        },
        makeAssistantTextMessage("Finished that recovery."),
        { role: "user", content: "a later request" },
        makeAssistantTextMessage("Finished the later request."),
      ],
      entry: { permissionMode: "full", restartRecoveryForceSafeTools: true },
      safeTools: "absent",
    },
    {
      name: "resumes safely without replaying visible assistant text beside a Code Mode wait",
      messages: [
        { role: "user", content: "do the thing" },
        codeModeCheckpointMessage("exec"),
        createAssistantToolCallMessage([
          { type: "text", text: "I already sent this part." },
          {
            type: "toolCall",
            id: "call-wait-1",
            name: "wait",
            arguments: { runId: "cm_interrupted" },
          },
        ]),
      ],
      safeTools: "required",
      codeMode: "absent",
    },
    {
      name: "keeps partial provider-abort output under replay-safe recovery",
      messages: [
        { role: "user", content: "do the thing" },
        codeModeCheckpointMessage("exec"),
        codeModeWaitCallMessage(),
        makeAssistantTextMessage("partial answer", {
          stopReason: "error",
          errorMessage: "Request was aborted",
          errorCode: AGENT_RUN_RESTART_ABORT_ERROR_CODE,
        }),
      ],
      safeTools: "required",
    },
    {
      name: "resumes a partial streamed answer interrupted by a restart",
      messages: [
        { role: "user", content: "do the thing" },
        makeAssistantTextMessage("Here is the first half of the answer", {
          stopReason: "aborted",
          errorMessage: "This operation was aborted",
        }),
      ],
      safeTools: "unrestricted",
    },
    {
      name: "reports an interrupted native tool outcome as unknown",
      messages: [
        { role: "user", content: "run the command" },
        createAssistantToolCallMessage([
          { type: "toolCall", id: "call-bash-1", name: "bash", arguments: { command: "true" } },
        ]),
        makeToolResultMessage("native tool call had no matching result", {
          toolName: "bash",
          toolCallId: "call-bash-1",
          details: { reason: "missing_tool_result" },
          isError: true,
        }),
      ],
      safeTools: "required",
      promptIncludes: ["unknown outcome", "never claim completion or success"],
    },
    {
      name: "keeps a dangling side-effecting call in an aborted tail restricted",
      messages: [
        { role: "user", content: "do the thing" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Kicking that off." },
            { type: "toolCall", id: "call-bash-1", name: "bash", arguments: { command: "true" } },
          ],
          stopReason: "aborted",
          errorMessage: "This operation was aborted",
        },
      ],
      safeTools: "required",
    },
    {
      name: "resumes an interrupted replay-safe tool call without restricting tools",
      messages: [
        { role: "user", content: "do the thing" },
        createAssistantToolCallMessage([
          { type: "text", text: "Let me look that up." },
          { type: "toolCall", id: "call-read-1", name: "read", arguments: { path: "README.md" } },
        ]),
      ],
      safeTools: "unrestricted",
    },
    {
      name: "resumes through the shutdown error persisted for an interrupted Code Mode wait",
      messages: [
        { role: "user", content: "do the thing" },
        codeModeCheckpointMessage(),
        codeModeWaitCallMessage(),
        makeToolResultMessage([{ type: "text", text: "Error: The operation was aborted." }], {
          toolName: "wait",
          toolCallId: "call-wait-1",
          details: {
            status: "failed",
            error: "Error: The operation was aborted.",
            code: "internal_error",
          },
          isError: true,
        }),
        {
          role: "assistant",
          content: [],
          stopReason: "aborted",
          errorMessage: "Request was aborted",
        },
      ],
      safeTools: "required",
      codeMode: "required",
      promptIncludes: [
        "Continue from the existing transcript",
        "the tool surface has been narrowed to replay-safe tools",
        "the full tool surface restores on the next user turn",
      ],
    },
    {
      name: "resumes through the current Code Mode abort persisted for an interrupted wait",
      messages: [
        { role: "user", content: "do the thing" },
        codeModeCheckpointMessage(),
        codeModeWaitCallMessage(),
        makeToolResultMessage(
          [
            {
              type: "text",
              text: JSON.stringify({
                status: "failed",
                code: "aborted",
                error: "code mode execution aborted",
              }),
            },
          ],
          {
            toolName: "wait",
            toolCallId: "call-wait-1",
            details: {
              status: "failed",
              code: "aborted",
              error: "code mode execution aborted",
              replaySafe: true,
            },
            isError: true,
          },
        ),
        {
          role: "assistant",
          content: [],
          stopReason: "aborted",
          errorCode: "OPENCLAW_RESTART_ABORT",
          errorMessage: "agent run aborted for restart",
        },
      ],
      safeTools: "required",
      codeMode: "required",
    },
    {
      name: "resumes a mixed Code Mode wait and side-effecting tool tail safely",
      messages: [
        { role: "user", content: "do the thing" },
        codeModeCheckpointMessage("exec"),
        createAssistantToolCallMessage([
          {
            type: "toolCall",
            id: "call-wait-1",
            name: "wait",
            arguments: { runId: "cm_interrupted" },
          },
          {
            type: "toolCall",
            id: "call-write-1",
            name: "write",
            arguments: { path: "result.txt", content: "done" },
          },
        ]),
      ],
      safeTools: "required",
      codeMode: "absent",
    },
  ])("$name", async ({ messages, entry, safeTools, codeMode, promptIncludes }) => {
    await writePreparedMainSessionTranscript(messages, entry);
    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    const request = gatewayParams();
    if (safeTools === "required") {
      expect(request).toMatchObject({ forceRestartSafeTools: true });
    }
    if (safeTools === "absent") {
      expect(request).not.toHaveProperty("forceRestartSafeTools");
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
    {
      label: "a replay-safe checkpoint earlier in the interrupted turn",
      messages: [
        { role: "user", content: "do the thing" },
        codeModeCheckpointMessage("exec"),
        createAssistantToolCallMessage([
          {
            type: "toolCall",
            id: "call-read-current",
            name: "read",
            arguments: { path: "README.md" },
          },
        ]),
        makeToolResultMessage([{ type: "text", text: "current read result" }], {
          toolName: "read",
          toolCallId: "call-read-current",
        }),
      ],
      forceRestartSafeTools: true,
    },
    {
      label: "a replay-safe checkpoint from an earlier user turn",
      messages: [
        { role: "user", content: "finish the earlier turn" },
        codeModeCheckpointMessage("exec"),
        { role: "user", content: "start the current turn" },
        createAssistantToolCallMessage([
          {
            type: "toolCall",
            id: "call-read-current",
            name: "read",
            arguments: { path: "README.md" },
          },
        ]),
        makeToolResultMessage([{ type: "text", text: "current read result" }], {
          toolName: "read",
          toolCallId: "call-read-current",
        }),
      ],
      forceRestartSafeTools: false,
    },
  ])(
    "preserves the restart-safe boundary after an ordinary tool result with $label",
    async ({ messages, forceRestartSafeTools }) => {
      await writePreparedMainSessionTranscript(messages);

      await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
      if (forceRestartSafeTools) {
        expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
      } else {
        expect(gatewayParams()).not.toMatchObject({ forceRestartSafeTools: true });
      }
    },
  );

  it.each([
    { label: "inherited full access", mode: "full", permissionMode: undefined, restricted: false },
    { label: "explicit guarded access", mode: "full", permissionMode: "guarded", restricted: true },
  ] as const)(
    "continues interrupted work with $label",
    async ({ mode, permissionMode, restricted }) => {
      const sessionsDir = await writePreparedMainSessionTranscript(
        [
          { role: "user", content: "do the thing" },
          createAssistantToolCallMessage([
            { type: "text", text: "Running the check now." },
            {
              type: "toolCall",
              id: "call-exec-1",
              name: "exec",
              arguments: { code: "await shell({command: 'true'})" },
            },
          ]),
        ],
        { permissionMode, restartRecoveryForceSafeTools: true },
      );

      await expectRecovery(
        { started: 1, settled: 0, failed: 0, skipped: 0 },
        { tools: { exec: { mode } } },
      );
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
    {
      label: "mismatched failed-wait result identity",
      toolCallIds: ["call-other"],
    },
    {
      label: "missing failed-wait result identity",
      toolCallIds: [undefined],
    },
    {
      label: "duplicate failed-wait result identities",
      toolCallIds: ["call-wait-1", "call-wait-1"],
    },
  ])("does not restore Code Mode tools for $label", async ({ toolCallIds }) => {
    await writePreparedMainSessionTranscript([
      { role: "user", content: "do the thing" },
      codeModeCheckpointMessage(),
      codeModeWaitCallMessage(),
      ...toolCallIds.map((toolCallId) => ({
        role: "toolResult",
        toolName: "wait",
        ...(toolCallId ? { toolCallId } : {}),
        content: [{ type: "text", text: "Error: The operation was aborted." }],
        details: {
          status: "failed",
          error: "Error: The operation was aborted.",
          code: "internal_error",
        },
        isError: true,
      })),
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
    expect(gatewayParams()).not.toHaveProperty("forceCodeModeTools");
  });

  it.each([
    {
      label: "non-replay-safe checkpoint",
      checkpoint: {
        status: "waiting",
        runId: "cm_interrupted",
        reason: "pending_tools",
        replaySafe: false,
      },
    },
    {
      label: "replay-safe checkpoint for another run",
      checkpoint: {
        status: "waiting",
        runId: "cm_other",
        reason: "yield",
        replaySafe: true,
      },
    },
  ])("resumes a Code Mode wait safely after a $label", async ({ checkpoint }) => {
    await writePreparedMainSessionTranscript([
      { role: "user", content: "do the thing" },
      codeModeCheckpointMessage("wait", checkpoint),
      codeModeWaitCallMessage(),
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(gatewayParams()).toMatchObject({ forceRestartSafeTools: true });
    expect(gatewayParams()).not.toHaveProperty("forceCodeModeTools");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
