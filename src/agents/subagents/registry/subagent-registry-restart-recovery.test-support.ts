import { vi } from "vitest";
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
  patchSessionEntryCore: vi.fn(),
}));

vi.mock("../../../config/config.js", () => ({
  getRuntimeConfig: () => ({ session: { store: undefined } }),
}));
vi.mock("../../../config/sessions.js", () => ({
  resolveAgentIdFromSessionKey: () => "main",
  resolveSessionStorePathCore: () => mocks.storePath,
}));
vi.mock("../../../config/sessions/session-accessor.js", () => ({
  loadSessionEntry: mocks.loadSessionEntry,
  patchSessionEntryCore: mocks.patchSessionEntryCore,
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

const childSessionKey = "agent:main:subagent:restart-child";
const dispatchAgent = vi.fn();
const gatewayRuntime: GatewayRecoveryRuntime = {
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
    mocks.patchSessionEntryCore.mockImplementation(
      async (
        { sessionKey }: { sessionKey: string },
        update: (entry: SessionEntry) => SessionEntry | null,
      ) => {
        const current = mocks.entries[sessionKey];
        if (!current) {
          return null;
        }
        const next = update({ ...current });
        if (next) {
          mocks.entries[sessionKey] = next;
        }
        return next;
      },
    );
  },
};
