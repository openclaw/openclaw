import assert from "node:assert/strict";
import type {
  PluginDoctorStateMigration,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stateMigrations } from "../../doctor-contract-api.js";
import { codexNativeSubagentHistoryConnectionFingerprint } from "../app-server/native-subagent-history-owner.js";
import type { CodexNativeSubagentPendingAssignment } from "../app-server/native-subagent-pending-assignments.js";
import { bindingStoreKey } from "../app-server/session-binding-record.js";

const sessionStore = vi.hoisted(() => ({
  getSessionEntryByIdAsync: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/session-store-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/session-store-runtime")>()),
  ...sessionStore,
  resolveStorePath: () => "/synthetic/sessions.json",
}));

type Params = Parameters<PluginDoctorStateMigration["migrateLegacyState"]>[0];
type Row = ReturnType<
  NonNullable<PluginDoctorStateMigrationContext["readPluginStateEntriesInKeyRange"]>
>[number];
const identity = {
  kind: "session" as const,
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
const assignment: CodexNativeSubagentPendingAssignment = {
  runId: "codex-thread:child:turn:first-turn",
  childThreadId: "child",
  nativeTurnId: "first-turn",
  nativeParentThreadId: owner.parentThreadId,
  owner,
};
const migration = stateMigrations.find((entry) => entry.id === "codex-native-assignment-repair");
assert(migration, "Codex must register its native assignment repair");
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
function staleAssignment(childThreadId: string, overrides: Partial<typeof owner>) {
  return {
    ...assignment,
    runId: `codex-thread:${childThreadId}`,
    childThreadId,
    owner: { ...owner, ...overrides },
  };
}
async function expectPreserved(state: ReturnType<typeof fixture>, warning = "", exact = false) {
  const result = await migration.migrateLegacyState(state.params);
  expect(state.read()).toEqual(state.original);
  expect(result.warningDisposition).toBe("recoverable");
  if (exact) {
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining(warning)]);
  } else if (warning) {
    expect(result.warnings.join(" ")).toContain(warning);
  }
  return result;
}

function fixture(assignments: unknown[], extra: Record<string, unknown> = {}) {
  const value = {
    version: 1,
    state: "active",
    sessionId: identity.sessionId,
    binding,
    nativeSubagentAssignments: { version: 1, assignments },
    nativeSubagentTaskImport: { version: 1, taskIds: ["retained-import-marker"] },
    retainedMetadata: "unchanged",
    ...extra,
  };
  const row: Row = {
    key: bindingStoreKey(identity),
    createdAt: 1,
    expiresAt: null,
    value,
    valueJson: JSON.stringify(value),
  };
  const context: PluginDoctorStateMigrationContext = {
    openPluginStateKeyedStore() {
      throw new Error("Doctor repair must use its backed-up replacement owner");
    },
    readPluginStateEntriesInKeyRange(_namespace, range) {
      return range.after ? [] : [row];
    },
    readSessionIdentityEvidenceBatch: async () => [{ ...identity, state: "current" }],
    async repairPluginStateEntries(_namespace, replacements) {
      for (const replacement of replacements) {
        if (replacement.entry.valueJson !== row.valueJson) {
          throw new Error("Binding changed during repair");
        }
        Object.assign(row, {
          value: replacement.value,
          valueJson: JSON.stringify(replacement.value),
        });
      }
      return { changes: [], warnings: [] };
    },
  };
  const params: Params = {
    config: {},
    stateDir: "/synthetic",
    oauthDir: "/synthetic/oauth",
    env: { OPENCLAW_STATE_DIR: "/synthetic" },
    context,
  };
  return { params, original: value, read: () => row.value };
}

beforeEach(() => {
  sessionStore.getSessionEntryByIdAsync.mockReset().mockResolvedValue({
    sessionKey: identity.sessionKey,
    entry: {
      sessionId: identity.sessionId,
      lifecycleRevision: owner.lifecycleRevision,
      updatedAt: 1,
    },
  });
});

describe("Codex native assignment Doctor repair", () => {
  it("warns and preserves an active assignment row missing binding.cwd", async () => {
    const state = fixture([assignment, { ...assignment }], {
      binding: { threadId: binding.threadId },
    });

    expect(await migration.detectLegacyState(state.params)).not.toBeNull();
    await expectPreserved(state, "binding could not be decoded", true);
  });

  it("skips valid cleared bindings without warnings", async () => {
    const state = fixture([assignment, { ...assignment }], {
      state: "cleared",
      binding: undefined,
    });

    expect(await migration.detectLegacyState(state.params)).toBeNull();
    expect(await migration.migrateLegacyState(state.params)).toEqual(unchanged);
    expect(state.read()).toEqual(state.original);
  });

  it.each([
    { field: "authProfileId", value: 42 },
    { field: "appServerRuntimeFingerprint", value: 42 },
    { field: "appServerRuntimeFingerprint", value: undefined },
    { field: "appServerRuntimeFingerprint", value: "" },
  ])("preserves uninspectable ownership: $field=$value", async ({ field, value }) => {
    const state = fixture([assignment], { binding: { ...binding, [field]: value } });

    expect(await migration.detectLegacyState(state.params)).not.toBeNull();
    await expectPreserved(state, "ownership inspection prerequisites are incomplete", true);
  });

  it.each(["assignment", "session"])("preserves missing %s lifecycle evidence", async (missing) => {
    const legacy =
      missing === "assignment"
        ? { ...assignment, owner: { ...owner, lifecycleRevision: undefined } }
        : assignment;
    if (missing === "session") {
      sessionStore.getSessionEntryByIdAsync.mockResolvedValue({
        sessionKey: identity.sessionKey,
        entry: { sessionId: identity.sessionId, updatedAt: 1 },
      });
    }
    await expectPreserved(fixture([legacy]), "unknown lifecycle evidence");
  });

  it.each([false, true])("merges aliases, keeps turns, converges (reverse=%s)", async (reverse) => {
    const receipt = submission("child", "child-call");
    const aliases = [
      { ...assignment, submission: receipt },
      { ...assignment, runId: "codex-thread:child", recordedCompletion: completion },
    ];
    if (reverse) {
      aliases.reverse();
    }
    const followup = {
      ...assignment,
      runId: "codex-thread:child:turn:second-turn",
      nativeTurnId: "second-turn",
    };
    const state = fixture([...aliases, assignment, { ...assignment }, followup]);
    expect(await migration.detectLegacyState(state.params)).not.toBeNull();
    expect(state.read()).toEqual(state.original);

    const repaired = await migration.migrateLegacyState(state.params);

    expect(repaired.warnings).toEqual([]);
    expect(state.read()).toEqual({
      ...state.original,
      nativeSubagentAssignments: {
        version: 1,
        assignments: [
          { ...assignment, submission: receipt, recordedCompletion: completion },
          followup,
        ],
      },
    });
    expect(await migration.detectLegacyState(state.params)).toBeNull();
    expect(await migration.migrateLegacyState(state.params)).toEqual(unchanged);
  });

  it("removes only assignments contradicted by the canonical requester lifecycle or connection", async () => {
    const stale = [
      staleAssignment("old-session", { sessionId: "retired-session" }),
      staleAssignment("old-lifecycle", { lifecycleRevision: "retired-lifecycle" }),
      staleAssignment("old-connection", { connectionFingerprint: "0".repeat(64) }),
    ];
    const receipt = submission("old-lifecycle", "stale-call");
    const retainedReceipt = { ...receipt, callId: "retained-call", submissionId: "different-turn" };
    const submissions = {
      version: 1,
      owner: stale[1]!.owner,
      receipts: [receipt, retainedReceipt],
    };
    const state = fixture([assignment, ...stale], { nativeSubagentSubmissions: submissions });

    await migration.migrateLegacyState(state.params);

    expect(state.read()).toEqual({
      ...state.original,
      nativeSubagentAssignments: { version: 1, assignments: [assignment] },
      nativeSubagentSubmissions: { ...submissions, receipts: [retainedReceipt] },
    });
  });

  it("removes an absent requester's assignments without losing the task import marker", async () => {
    const state = fixture([assignment]);
    state.params.context.readSessionIdentityEvidenceBatch = async () => [
      { agentId: identity.agentId, sessionId: identity.sessionId, state: "absent" },
    ];

    await migration.migrateLegacyState(state.params);

    const { nativeSubagentAssignments: _assignments, ...expected } = state.original;
    expect(state.read()).toEqual(expected);
    expect(await migration.migrateLegacyState(state.params)).toEqual(unchanged);
  });

  it("preserves conflicting assignment facts and uncertain requester ownership", async () => {
    const conflict = fixture([
      { ...assignment, recordedCompletion: completion },
      {
        ...assignment,
        runId: "codex-thread:child",
        recordedCompletion: { ...completion, result: "conflicting result" },
      },
    ]);
    await expectPreserved(conflict);

    const locators = fixture([
      assignment,
      { ...assignment, runId: "codex-thread:child:turn:other-submission" },
    ]);
    await expectPreserved(locators);

    sessionStore.getSessionEntryByIdAsync.mockRejectedValue(
      new Error("Requester store unavailable"),
    );
    await expectPreserved(fixture([assignment]), "Could not establish requester ownership");

    const unknown = fixture([
      { ...assignment, owner: { ...owner, lifecycleRevision: "unverified-old-lifecycle" } },
    ]);
    unknown.params.context.readSessionIdentityEvidenceBatch = async () => [
      { agentId: identity.agentId, sessionId: identity.sessionId, state: "unknown" },
    ];
    expect(await migration.detectLegacyState(unknown.params)).not.toBeNull();
    await expectPreserved(unknown, "unknown requester evidence");
  });

  it("leaves changed bindings untouched when the maintenance owner rejects the repair", async () => {
    const state = fixture([assignment, { ...assignment }]);
    state.params.context.repairPluginStateEntries = async () => {
      throw new Error("Binding changed during repair");
    };

    const repaired = await expectPreserved(state);
    expect(repaired.changes).toEqual([]);
  });
});
