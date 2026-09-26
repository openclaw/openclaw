import { beforeEach, vi } from "vitest";
import type {
  countActiveDescendantRuns,
  hasDescendantRunAwaitingSettle,
} from "../registry/subagent-registry-read.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import type { maybeWakeRequesterAfterAllChildrenSettled } from "./subagent-announce.requester-settle-wake.js";
import {
  REQUESTER,
  makeSettledChild,
  transitionBatch,
  completeBatch,
  transitionBatchSpy,
  completeBatchSpy,
  deliverSpy,
} from "./subagent-announce.requester-settle-wake.test-support.js";

let sessionStore: Record<string, { sessionId?: string; lastChannel?: string; lastTo?: string }>;

const { registryRuntimeMock, findTranscriptEventMock } = vi.hoisted(() => ({
  findTranscriptEventMock: vi.fn<
    typeof import("../../../config/sessions/session-accessor.js").findTranscriptEvent
  >(async () => undefined),
  registryRuntimeMock: {
    getLatestLiveSubagentRunByChildSessionKey: vi.fn(() => undefined),
    countActiveDescendantRuns: vi.fn<typeof countActiveDescendantRuns>(() => 0),
    countPendingDescendantRuns: vi.fn((_rootSessionKey: string) => 0),
    isSubagentSessionRunActive: vi.fn((_childSessionKey: string) => true),
    shouldIgnorePostCompletionAnnounceForSession: vi.fn((_childSessionKey: string) => false),
    hasDescendantRunAwaitingSettle: vi.fn<typeof hasDescendantRunAwaitingSettle>(() => false),
    listSubagentRunsForRequester: vi.fn((_requesterSessionKey: string): unknown[] => []),
    getLatestSubagentRunByChildSessionKey: vi.fn(
      (
        _childSessionKey: string,
      ): Pick<SubagentRunRecord, "runId" | "requesterSessionKey"> | undefined => undefined,
    ),
    resolveRequesterForChildSession: vi.fn((_childSessionKey: string) => null),
  },
}));

vi.mock("../registry/subagent-registry-read.js", () => registryRuntimeMock);

vi.mock(import("../../../tasks/task-progress-requester.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  withTaskProgressRequesterContinuation: (async (_params, run) =>
    await run()) satisfies typeof import("../../../tasks/task-progress-requester.js").withTaskProgressRequesterContinuation,
}));

vi.mock("../../../config/sessions/session-accessor.js", () => ({
  findTranscriptEvent: findTranscriptEventMock,
  loadSessionEntryReadOnly: ({ sessionKey }: { sessionKey: string }) => sessionStore[sessionKey],
}));

vi.mock("./subagent-announce.runtime.js", () => ({
  callSubagentLifecycleGateway: vi.fn(async () => ({})),
  dispatchGatewayMethodInProcess: vi.fn(async () => ({})),
  isEmbeddedAgentRunActive: vi.fn(() => false),
  getRuntimeConfig: () => ({ session: { mainKey: "main", scope: "per-sender" } }),
  loadSessionStore: vi.fn(() => ({})),
  readSessionMessagesAsync: vi.fn(async () => []),
  readSubagentSessionEntry: vi.fn(
    (_storePath: string, sessionKey: string) => sessionStore[sessionKey],
  ),
  resolveAgentIdFromSessionKey: vi.fn(() => "main"),
  resolveMainSessionKey: vi.fn(() => "agent:main:main"),
  resolveSessionStorePathCore: vi.fn(() => "/tmp/sessions.json"),
  waitForEmbeddedAgentRunEnd: vi.fn(async () => true),
}));

vi.mock("./subagent-announce-delivery.js", () => ({
  deliverSubagentAnnouncement: (params: Record<string, unknown>) => deliverSpy(params),
  loadRequesterSessionEntry: (sessionKey: string) => ({
    entry: sessionStore[sessionKey],
    canonicalKey: sessionKey,
  }),
  loadSessionEntryByKey: (sessionKey: string) => sessionStore[sessionKey],
  runAnnounceDeliveryWithRetry: async <T>(params: { run: () => Promise<T> }) => await params.run(),
  resolveSubagentAnnounceTimeoutMs: () => 10_000,
  resolveSubagentCompletionOrigin: async (params: { requesterOrigin?: unknown }) =>
    params.requesterOrigin,
}));

vi.mock("../spawn/subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: (sessionKey: string) =>
    sessionKey.split(":subagent:").length - 1,
}));

function listedRequesterRuns(): SubagentRunRecord[] {
  return registryRuntimeMock.listSubagentRunsForRequester(REQUESTER) as SubagentRunRecord[];
}

function wakeParams(
  overrides?: Partial<Parameters<typeof maybeWakeRequesterAfterAllChildrenSettled>[0]>,
) {
  return {
    requesterSessionKey: REQUESTER,
    settledEntry:
      listedRequesterRuns().find((entry) => entry.runId === "run-b") ??
      makeSettledChild({ runId: "run-b" }),
    transitionBatch,
    completeBatch,
    ...overrides,
  };
}

beforeEach(() => {
  findTranscriptEventMock.mockReset().mockResolvedValue(undefined);
  deliverSpy.mockClear();
  transitionBatchSpy.mockClear();
  completeBatchSpy.mockClear();
  sessionStore = { [REQUESTER]: { sessionId: "sess-main" } };
  registryRuntimeMock.countActiveDescendantRuns.mockReset().mockReturnValue(0);
  registryRuntimeMock.hasDescendantRunAwaitingSettle.mockReset().mockReturnValue(false);
  registryRuntimeMock.listSubagentRunsForRequester.mockReset().mockReturnValue([]);
  registryRuntimeMock.getLatestSubagentRunByChildSessionKey.mockReset().mockReturnValue(undefined);
});

function setSessionStore(store: typeof sessionStore): void {
  sessionStore = store;
}

export {
  sessionStore,
  setSessionStore,
  registryRuntimeMock,
  findTranscriptEventMock,
  listedRequesterRuns,
  wakeParams,
};
