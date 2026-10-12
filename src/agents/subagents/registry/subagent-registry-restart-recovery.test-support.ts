import { vi } from "vitest";
import type { applySessionEntryExactReplacements } from "../../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import type { SessionEntryCurrentFacts } from "../../../config/sessions/session-entry-current.types.js";
import type { InternalSessionEntry as SessionEntry } from "../../../config/sessions/types.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import {
  createSubagentRunRecord,
  type SubagentRunRecordOverrides,
} from "../../subagent-test-fixtures.test-helpers.js";
import { recoverInterruptedSubagentRow } from "./subagent-registry-restart-recovery.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const mocks = vi.hoisted(() => ({
  entries: {} as Record<string, SessionEntry>,
  storePath: "/tmp/openclaw-subagent-recovery/agents/main/sessions/sessions.json",
  loadSessionEntry: vi.fn(),
  readSessionCurrent:
    vi.fn<({ sessionKey }: { sessionKey: string }) => SessionEntryCurrentFacts | undefined>(),
  applySessionEntryExactReplacements: vi.fn<typeof applySessionEntryExactReplacements>(),
}));

vi.mock("../../../config/config.js", () => ({
  getRuntimeConfig: () => ({ session: { store: undefined } }),
}));
vi.mock("../../../config/sessions.js", () => ({
  resolveAgentIdFromSessionKey: () => "main",
  resolveSessionStorePathCore: () => mocks.storePath,
}));
vi.mock("../../../config/sessions/session-accessor.sqlite-replacement-projection.js", () => ({
  applySessionEntryExactReplacements: mocks.applySessionEntryExactReplacements,
}));

vi.mock("../../../config/sessions/session-entry-read-runtime.js", () => ({
  withSessionEntryReadOnlyInWorker: async (
    scope: unknown,
    assertCurrent: () => void,
    consume: (read: { ok: true; value: SessionEntry | undefined }) => Promise<unknown>,
  ) => {
    assertCurrent();
    return await consume({ ok: true, value: mocks.loadSessionEntry(scope) });
  },
}));

vi.mock("../../../config/sessions/session-entry-current-runtime.js", () => ({
  captureSessionEntryCurrentRead: (scope: { sessionKey: string }) => ({
    source: {
      agentId: "main",
      path: mocks.storePath,
      databaseIdentity: "recovery-fixture",
      sessionKey: scope.sessionKey,
    },
    assertSourceCurrent: () => {},
    readCurrent: async () => mocks.readSessionCurrent(scope),
  }),
}));

const childSessionKey = "agent:main:subagent:restart-child";
const dispatchAgent = vi.fn();
const gatewayRuntime: GatewayRecoveryRuntime = {
  prepareRestartRecovery: () => undefined,
  dispatchSessionMethod: vi.fn(),
  dispatchAgent: dispatchAgent as GatewayRecoveryRuntime["dispatchAgent"],
  waitForAgent: vi.fn(),
  sendRecoveryNotice: vi.fn(),
};
const warn = vi.fn();

function run(overrides: Partial<SubagentRunRecordOverrides> = {}): SubagentRunRecord {
  return createSubagentRunRecord({
    runId: "original-run",
    childSessionKey,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    requesterOrigin: { channel: "qa-channel", to: "qa-requester", accountId: "default" },
    task: "finish the restart-safe task",
    cleanup: "keep",
    createdAt: Date.now() - 60_000,
    startedAt: Date.now() - 55_000,
    ...overrides,
  });
}

function recover(
  entry: SubagentRunRecord,
  overrides: Partial<Parameters<typeof recoverInterruptedSubagentRow>[0]> = {},
) {
  return recoverInterruptedSubagentRow({
    runId: entry.runId,
    entry,
    gatewayRuntime,
    isCurrent: () => true,
    warn,
    ...overrides,
  });
}

export const restartRecoveryTestHarness = {
  mocks,
  childSessionKey,
  gatewayRuntime,
  dispatchAgent,
  warn,
  run,
  recover,
  reset() {
    vi.clearAllMocks();
    mocks.storePath = "/tmp/openclaw-subagent-recovery/agents/main/sessions/sessions.json";
    mocks.entries = {
      [childSessionKey]: {
        sessionId: "session-id",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
    };
    mocks.loadSessionEntry.mockImplementation(
      ({ sessionKey }: { sessionKey: string }) => mocks.entries[sessionKey],
    );
    mocks.readSessionCurrent.mockImplementation(({ sessionKey }) => {
      const entry = mocks.entries[sessionKey];
      return (
        entry && {
          sessionId: entry.sessionId,
          lifecycleRevision: entry.lifecycleRevision,
          lifecycleRunId: entry.lifecycleRunId,
          activeWriterRunId: entry.activeWriterRunId,
          subagentRecovery: entry.subagentRecovery,
        }
      );
    });
    mocks.applySessionEntryExactReplacements.mockImplementation(async (params) => {
      const operation = await params.update(
        (params.sessionKeys ?? []).flatMap((sessionKey) => {
          const entry = mocks.entries[sessionKey];
          return entry ? [{ sessionKey, entry: { ...entry } }] : [];
        }),
      );
      const replacements = [...(operation.replacements ?? [])];
      if (replacements.length) {
        params.assertCommitAllowed?.();
        for (const { sessionKey, entry } of replacements) {
          mocks.entries[sessionKey] = entry;
        }
      }
      return operation.result;
    });
  },
};
