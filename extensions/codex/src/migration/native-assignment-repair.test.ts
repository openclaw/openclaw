import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { beforeEach, expect, it, vi } from "vitest";
import { stateMigrations } from "../../doctor-contract-api.js";
import { codexNativeSubagentHistoryConnectionFingerprint } from "../app-server/native-subagent-history-owner.js";
import type { CodexNativeSubagentPendingAssignment } from "../app-server/native-subagent-pending-assignments.js";

const getSessionEntryByIdAsync = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/session-store-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/session-store-runtime")>()),
  getSessionEntryByIdAsync,
  resolveStorePath: () => "/synthetic/sessions.json",
}));

type Params = Parameters<PluginDoctorStateMigration["migrateLegacyState"]>[0];
type Row = ReturnType<NonNullable<Params["context"]["readPluginStateEntriesInKeyRange"]>>[number];
type Fields = Record<string, unknown>;
type Evidence = "current" | "absent" | "unknown";
const identity = {
  agentId: "main",
  sessionId: "parent-session",
  sessionKey: "agent:main:parent",
};
const binding = {
  threadId: "rotated-native-parent",
  cwd: "/synthetic/workspace",
  appServerRuntimeFingerprint: "current-connection",
};
const owner = {
  parentThreadId: "original-native-parent",
  sessionId: identity.sessionId,
  lifecycleRevision: "current-lifecycle",
  connectionFingerprint: codexNativeSubagentHistoryConnectionFingerprint(binding)!,
};
type Owner = typeof owner;
function task(changes: Partial<Owner> = {}, childThreadId = "child", nativeTurnId = "first-turn") {
  return {
    runId: `codex-thread:${childThreadId}:turn:${nativeTurnId}`,
    childThreadId,
    nativeTurnId,
    nativeParentThreadId: owner.parentThreadId,
    owner: { ...owner, ...changes },
  } satisfies CodexNativeSubagentPendingAssignment;
}
const assignment = task();
const alias = { ...assignment, runId: "codex-thread:child" };
const duplicateAssignments = [assignment, { ...assignment }];
const migration =
  stateMigrations.find((entry) => entry.id === "codex-native-assignment-repair") ??
  assert.fail("Codex must register its native assignment repair");
const unchanged = { changes: [], warnings: [] };
const completion = {
  childThreadId: "child",
  status: "succeeded" as const,
  statusLabel: "recorded_task_result" as const,
  result: "Preserve the recorded result",
};
function submission(childThreadId: string, callId: string) {
  return {
    parentTurnId: "parent-turn",
    callId,
    childThreadId,
    submissionId: "first-turn",
    predecessorRunId: `codex-thread:${childThreadId}`,
    predecessorNativeTurnId: "previous-turn",
  };
}
const inventory = (assignments: unknown[]) => ({ version: 1, assignments });
function fixture(tasks: unknown[] = [assignment], extra: Fields = {}, state: Evidence = "current") {
  const value = {
    version: 1,
    state: "active",
    sessionId: identity.sessionId,
    binding,
    nativeSubagentAssignments: inventory(tasks),
    nativeSubagentTaskImport: { version: 1, taskIds: ["retained-import-marker"] },
    ...extra,
  };
  const row: Row = {
    key: "session:main:parent-session",
    createdAt: 1,
    expiresAt: null,
    value,
    valueJson: JSON.stringify(value),
  };
  const context: Params["context"] = {
    openPluginStateKeyedStore: () => assert.fail("Doctor repair requires its replacement owner"),
    readPluginStateEntriesInKeyRange: (_namespace, range) => (range.after ? [] : [row]),
    readSessionIdentityEvidenceBatch: async () => [{ ...identity, state }],
    async repairPluginStateEntries(_namespace, replacements) {
      for (const replacement of replacements) {
        row.value = replacement.value;
        row.valueJson = JSON.stringify(replacement.value);
      }
      return unchanged;
    },
  };
  return {
    config: {},
    stateDir: "/synthetic",
    oauthDir: "/synthetic/oauth",
    env: { OPENCLAW_STATE_DIR: "/synthetic" },
    context,
    expectState: (changes: Fields = {}) => expect(row.value).toEqual({ ...value, ...changes }),
  };
}

const sessionEntry = (lifecycleRevision?: string) => ({
  sessionKey: identity.sessionKey,
  entry: { sessionId: identity.sessionId, lifecycleRevision },
});

beforeEach(() => {
  getSessionEntryByIdAsync.mockReset().mockResolvedValue(sessionEntry(owner.lifecycleRevision));
});

it("skips cleared bindings without warnings", async () => {
  const state = fixture(duplicateAssignments, { state: "cleared", binding: undefined });
  expect(await migration.detectLegacyState(state)).toBeNull();
  expect(await migration.migrateLegacyState(state)).toEqual(unchanged);
  state.expectState();
});

it.each(
  Object.entries({
    undecodable: () => fixture(duplicateAssignments, { binding: { ...binding, cwd: undefined } }),
    "invalid auth profile": () =>
      fixture(undefined, { binding: { ...binding, authProfileId: 42 } }),
    "missing connection": () =>
      fixture(undefined, { binding: { ...binding, appServerRuntimeFingerprint: undefined } }),
    "missing assignment lifecycle": () => fixture([task({ lifecycleRevision: undefined })]),
    "missing session lifecycle": () => {
      getSessionEntryByIdAsync.mockResolvedValue(sessionEntry());
      return fixture();
    },
    "conflicting completions": () =>
      fixture([
        { ...assignment, recordedCompletion: completion },
        { ...alias, recordedCompletion: { ...completion, result: "conflict" } },
      ]),
    "conflicting locators": () =>
      fixture([assignment, { ...assignment, runId: "codex-thread:child:turn:other-submission" }]),
    "unreadable requester": () => {
      getSessionEntryByIdAsync.mockRejectedValue(new Error("Requester store unavailable"));
      return fixture();
    },
    "unknown requester": () =>
      fixture([task({ lifecycleRevision: "unverified-old-lifecycle" })], {}, "unknown"),
    "rejected repair": () => {
      const state = fixture(duplicateAssignments);
      state.context.repairPluginStateEntries = async () => {
        throw new Error("Binding changed during repair");
      };
      return state;
    },
  }),
)("preserves %s state", async (_name, setup) => {
  const state = setup();
  expect(await migration.detectLegacyState(state)).not.toBeNull();
  expect(await migration.migrateLegacyState(state)).toEqual({
    changes: [],
    warnings: [expect.any(String)],
    warningDisposition: "recoverable",
  });
  state.expectState();
});

it.each([false, true])("merges aliases, keeps turns, converges (reverse=%s)", async (reverse) => {
  const receipt = submission("child", "child-call");
  const aliases = [
    { ...assignment, submission: receipt },
    { ...alias, recordedCompletion: completion },
  ];
  const ordered = reverse ? aliases.toReversed() : aliases;
  const followup = task({}, "child", "second-turn");
  const state = fixture([...ordered, ...duplicateAssignments, followup]);
  expect(await migration.detectLegacyState(state)).not.toBeNull();
  state.expectState();

  expect((await migration.migrateLegacyState(state)).warnings).toEqual([]);
  state.expectState({
    nativeSubagentAssignments: inventory([
      { ...assignment, submission: receipt, recordedCompletion: completion },
      followup,
    ]),
  });
  expect(await migration.detectLegacyState(state)).toBeNull();
  expect(await migration.migrateLegacyState(state)).toEqual(unchanged);
});

it("removes stale ownership and only its matching receipts", async () => {
  const stale = [
    task({ sessionId: "retired-session" }, "old-session"),
    task({ lifecycleRevision: "retired-lifecycle" }, "old-lifecycle"),
    task({ connectionFingerprint: "0".repeat(64) }, "old-connection"),
  ];
  const receipt = submission("old-lifecycle", "stale-call");
  const retainedReceipt = { ...receipt, callId: "retained-call", submissionId: "different-turn" };
  const submissions = { version: 1, owner: stale[1]!.owner, receipts: [receipt, retainedReceipt] };
  const state = fixture([assignment, ...stale], { nativeSubagentSubmissions: submissions });
  await migration.migrateLegacyState(state);
  state.expectState({
    nativeSubagentAssignments: inventory([assignment]),
    nativeSubagentSubmissions: { ...submissions, receipts: [retainedReceipt] },
  });
});

it("removes absent requesters but preserves task imports", async () => {
  const state = fixture([assignment], {}, "absent");
  await migration.migrateLegacyState(state);
  state.expectState({ nativeSubagentAssignments: undefined });
  expect(await migration.migrateLegacyState(state)).toEqual(unchanged);
});

it("admits event-loop work between full detection pages", async () => {
  const state = fixture();
  const rows = Array.from({ length: 512 }, (_, index): Row => ({
    key: `binding:${index}`,
    value: {},
    valueJson: "{}",
    createdAt: 1,
    expiresAt: null,
  }));
  let advanced = false;
  let pageReads = 0;
  let progress: Promise<void> | undefined;
  state.context.readPluginStateEntriesInKeyRange = (_namespace, range) => {
    pageReads++;
    if (!range.after) {
      progress = nextTurn().then(() => {
        advanced = true;
      });
      return rows;
    }
    expect(advanced).toBe(true);
    return [];
  };
  try {
    expect(await migration.detectLegacyState(state)).toBeNull();
    expect(pageReads).toBe(2);
  } finally {
    await progress;
  }
});
