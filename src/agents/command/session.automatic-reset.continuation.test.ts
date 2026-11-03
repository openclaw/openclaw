// Continuation (karmaterminal): agent-command's automatic reset (#184157) settles continuation
// custody through the reply-session reset owner. A legacy pending-reset marker (`reset`) is a head
// swap: it keeps pending work and retires only what the replaced head owned
// (karmaterminal/openclaw#1271); an idle or daily expiry keeps it too (bootstrap#1727 ruling
// 6434991502).
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createContinuationRecord,
  listContinuationRecords,
} from "../../auto-reply/continuation/custody/custody-store.js";
import { useContinuationCustodyTestState } from "../../auto-reply/continuation/custody/custody.test-support.js";
import {
  agentCommand,
  agentCommandFromGatewayIngress,
  compactionTestRuntime,
  compactionTestState as state,
  GATEWAY_INGRESS_ARGS,
  makeCompactionResult,
  registerAgentCommandCompactionTestHooks,
  requireCompactionStorePath,
} from "../agent-command.compaction.test-support.js";

// Failure seam over the real custody store; unarmed writes run the real owner.
const custodyWrite = vi.hoisted(() => ({ failure: undefined as string | undefined }));

vi.mock("../../auto-reply/continuation/custody/custody-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../auto-reply/continuation/custody/custody-store.js")>();
  return {
    ...actual,
    updateContinuationRecords: async (
      ...args: Parameters<typeof actual.updateContinuationRecords>
    ) => {
      if (custodyWrite.failure) {
        throw new Error(custodyWrite.failure);
      }
      return await actual.updateContinuationRecords(...args);
    },
  };
});

const { loadSessionEntry, replaceSessionEntry } = compactionTestRuntime;
registerAgentCommandCompactionTestHooks();
useContinuationCustodyTestState();

const SESSION_KEY = "agent:main:main";

afterEach(() => {
  custodyWrite.failure = undefined;
});

beforeEach(() => {
  state.runAgentAttemptMock.mockImplementation(async (params) => {
    await expectDefined(
      params.userTurnTranscriptRecorder,
      "command user recorder",
    ).persistApproved();
    return makeCompactionResult({
      sessionId: params.sessionId,
      text: "The new turn completed.",
      runner: "embedded",
    });
  });
});

async function seedResetSession(mode: "marker" | "idle" | "daily") {
  const cfg = expectDefined(state.cfg, "command config");
  if (mode !== "marker") {
    cfg.session = {
      ...cfg.session,
      reset: mode === "idle" ? { mode, idleMinutes: 1 } : { mode, atHour: 4 },
    };
  }
  const target = {
    agentId: "main",
    sessionKey: SESSION_KEY,
    sessionId: "before-reset",
    storePath: requireCompactionStorePath(),
  };
  const expiredAt = Date.now() - 2 * 24 * 60 * 60_000;
  await replaceSessionEntry(target, {
    sessionId: target.sessionId,
    lifecycleRevision: "before-reset",
    // Older releases persisted updatedAt=0 as an explicit pending reset marker.
    updatedAt: mode === "marker" ? 0 : expiredAt,
    sessionStartedAt: expiredAt,
    lastInteractionAt: expiredAt,
  });
  const created = await createContinuationRecord({
    recordId: `pending-work-${mode}`,
    kind: "work",
    ownerSessionKey: SESSION_KEY,
    status: "queued",
    phase: "Queued for same-session continuation wake",
    createdAt: expiredAt,
    dueAt: Date.now() + 60_000,
    stateJson: JSON.stringify({ reason: "finish the pending work" }),
  });
  expect(created.outcome).toBe("created");
  return target;
}

async function pendingWorkStatus(mode: string) {
  const [record] = await listContinuationRecords({ recordIds: [`pending-work-${mode}`] });
  return { status: record?.status, phase: record?.phase };
}

/** A post-compaction shard the replaced head staged: the one kind a head swap still retires. */
async function stageShard(mode: string) {
  const created = await createContinuationRecord({
    recordId: `staged-shard-${mode}`,
    kind: "post_compaction",
    ownerSessionKey: SESSION_KEY,
    status: "queued",
    phase: "Staged for release after compaction",
    createdAt: Date.now(),
    stateJson: JSON.stringify({ task: "restore the plan after compaction" }),
  });
  expect(created.outcome).toBe("created");
}

it("keeps pending work and retires the staged shard when agent-command resets a session marked for reset", async () => {
  const target = await seedResetSession("marker");
  await stageShard("marker");

  await agentCommand({ message: "Start over after the marker.", sessionKey: SESSION_KEY });

  expect(loadSessionEntry(target)?.lifecycleRevision).not.toBe("before-reset");
  expect(await pendingWorkStatus("marker")).toEqual({
    status: "queued",
    phase: "Queued for same-session continuation wake",
  });
  const [shard] = await listContinuationRecords({ recordIds: ["staged-shard-marker"] });
  expect(shard).toMatchObject({ status: "cancelled", phase: "Cancelled by session reset" });
});

it("settles the run's own delivery claim when reset cancellation fails after the commit", async () => {
  const target = await seedResetSession("marker");
  await stageShard("marker");
  const runId = "announce:requester-settle:synthetic-cohort:after-reset";
  custodyWrite.failure = "custody write unavailable";

  await expect(
    agentCommandFromGatewayIngress(
      {
        sessionKey: SESSION_KEY,
        runId,
        message: "Synthesize the completed child results",
        allowModelOverride: false,
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:subagent:synthetic-child",
          sourceChannel: "internal",
          sourceTool: "subagent_settle",
        },
      },
      ...GATEWAY_INGRESS_ARGS,
    ),
  ).rejects.toThrow("could not cancel continuation record staged-shard-marker");

  // The reset committed before cleanup failed.
  const committed = loadSessionEntry(target);
  expect(committed?.lifecycleRevision).not.toBe("before-reset");
  expect(state.runAgentAttemptMock).not.toHaveBeenCalled();
});

it.each(["idle", "daily"] as const)(
  "keeps pending continuation work across an agent-command %s reset",
  async (mode) => {
    const target = await seedResetSession(mode);

    await agentCommand({ message: `Resume after the ${mode} expiry.`, sessionKey: SESSION_KEY });

    expect(loadSessionEntry(target)?.lifecycleRevision).not.toBe("before-reset");
    expect(await pendingWorkStatus(mode)).toEqual({
      status: "queued",
      phase: "Queued for same-session continuation wake",
    });
  },
);
