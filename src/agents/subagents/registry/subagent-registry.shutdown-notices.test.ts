// Continuation (karmaterminal): older shutdown quiet kills before a deploy (🌊's ruling on upstream
// #201544, item 4; openclaw/openclaw#129388). Before #201544 a graceful shutdown ended a live child
// as a quiet kill, and upstream #201706's restore re-owes every such row still pending on the next
// boot. A row an older restart left behind would reach its requester late, as a surprise. The
// fixtures are written by that older shutdown's own call; the boot afterwards is this build's real
// restore, root resume and announce flow.
// 1. The count is read-only and names exactly the rows restore would re-owe.
// 2. A settle closes the rows that ended before its cutoff as an intentional non-delivery, after a
//    backup: none of them is delivered late, none is deleted, and each stays in the requester's
//    account as an ended run. A row the deploy's own restart stopped is still delivered.
// 3. The undo puts the rows back byte for byte, and restore then re-owes them as it would have.
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { childOutcomeText, gracefulStopStatus, parent, recordRequesterMessages, useRestartCustodyWorld } from "./subagent-registry.restart-custody.test-support.js";
import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { GATEWAY_RESTART_RESUME_TEXT } from "../../../gateway/session-restart-resume-prompt.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { closeOpenClawStateDatabaseAsync } from "../../../state/openclaw-state-db.js";
import { createSubagentsTool } from "../../tools/subagents-tool.js";
import {
  readShutdownNoticeStatus,
  settleShutdownNotices,
  undoShutdownNoticeSettle,
} from "./subagent-registry-shutdown-notices.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import {
  markSubagentRunTerminated,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const {
  fixture,
  addRunningChild,
  shutDownGracefully,
  restartGateway,
  resumeRoots,
  writeParentSession,
} = useRestartCustodyWorld();

const DAY_MS = 24 * 60 * 60_000;

/** The pre-#201544 shutdown's kill (82e52b648c): a quiet kill whose delivery stays pending. */
function quietKill(live: SubagentRunRecord[]) {
  return async () => {
    for (const row of live) {
      await markSubagentRunTerminated({
        runId: row.runId,
        reason: "Gateway stopped",
        suppressTaskDelivery: true,
        suppressSessionEffects: true,
      });
    }
  };
}

/** An older Gateway's graceful shutdown at `at`, of every row in `live`. */
async function olderShutdown(live: SubagentRunRecord[], at: number) {
  const now = vi.spyOn(Date, "now").mockReturnValue(at);
  try {
    await shutDownGracefully(live, quietKill(live));
  } finally {
    now.mockRestore();
  }
}

/** The stopped seat before a deploy: three re-owed quiet kills and an explicit Stop. */
async function seatWithQuietKills() {
  await writeParentSession();
  const lastWeek = Date.now() - 7 * DAY_MS;
  const older = [
    await addRunningChild("older-delegate"),
    await addRunningChild("older-plain", { drainsContinuationDelegateQueue: undefined }),
  ];
  // The requester stopped this one before the shutdown: an explicit Stop, never reopened.
  const stopped = await addRunningChild("older-stopped", {
    killIntent: {
      requestedAt: lastWeek - 1_000,
      reason: "killed by requester",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
    },
  });
  await olderShutdown([...older, stopped], lastWeek);
  // The deploy's own restart: this shutdown stopped it moments ago.
  const recent = await addRunningChild("recent-delegate");
  await shutDownGracefully([recent], quietKill([recent]));
  // The Gateway is stopped: nothing holds the store open.
  await fixture.settle();
  await resetSubagentRegistryForTests({ persist: false });
  await closeOpenClawStateDatabaseAsync();
  return { cutoff: lastWeek + DAY_MS };
}

const noticeRow = (runId: string, delegate = true) =>
  expect.objectContaining({
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: parent,
    delegate,
  });

it("1: the count names exactly the rows restore would re-owe, and an unsettled seat delivers the older ones late", async () => {
  await seatWithQuietKills();

  expect(await readShutdownNoticeStatus(process.env)).toEqual({
    databasePath: expect.stringMatching(/state[/\\]openclaw\.sqlite$/),
    reowed: 3,
    rows: [
      noticeRow("older-delegate"),
      noticeRow("older-plain", false),
      noticeRow("recent-delegate"),
    ],
  });

  // The hazard: without a settle, this build's restore re-owes all three on its first boot.
  const messages = recordRequesterMessages();
  await restartGateway();
  await resumeRoots();
  expect(messages.map(({ source }) => source).toSorted()).toEqual([
    "outcome:older-delegate",
    "outcome:older-plain",
    "outcome:recent-delegate",
    "restart",
  ]);
});

it("2: a settle closes the older rows after a backup; none is delivered late or lost, and the deploy's own stop is delivered", async () => {
  const { cutoff } = await seatWithQuietKills();
  const before = loadSubagentRegistryFromSqlite();

  const receipt = await settleShutdownNotices(process.env, { endedBefore: cutoff });
  expect(receipt).toEqual({
    databasePath: expect.stringMatching(/state[/\\]openclaw\.sqlite$/),
    endedBefore: cutoff,
    backupPath: expect.stringMatching(/backups[/\\]subagent-shutdown-notices[/\\]settle-.+\.json$/),
    settled: [noticeRow("older-delegate"), noticeRow("older-plain", false)],
    kept: [noticeRow("recent-delegate")],
    changed: [],
  });
  const backup = JSON.parse(await fs.readFile(receipt.backupPath, "utf8"));
  expect(backup).toMatchObject({
    kind: "openclaw.subagent-shutdown-notice-settle",
    version: 1,
    rows: [
      { original: { run_id: "older-delegate" }, settledPayloadJson: expect.any(String) },
      { original: { run_id: "older-plain" }, settledPayloadJson: expect.any(String) },
    ],
  });
  expect((await fs.stat(receipt.backupPath)).mode & 0o777).toBe(0o600);
  // Closed as an intentional non-delivery, nothing else changed and nothing deleted.
  const after = loadSubagentRegistryFromSqlite();
  expect([...after.keys()].toSorted()).toEqual([...before.keys()].toSorted());
  for (const runId of ["older-delegate", "older-plain"]) {
    expect(after.get(runId)).toEqual({
      ...before.get(runId),
      suppressCompletionDelivery: true,
      delivery: { status: "not_required", disposition: "intentional_non_delivery" },
    });
  }
  expect(after.get("older-stopped")).toEqual(before.get("older-stopped"));
  expect(after.get("recent-delegate")).toEqual(before.get("recent-delegate"));
  // A second count sees only the row the deploy's own restart owes.
  expect((await readShutdownNoticeStatus(process.env)).rows).toEqual([
    noticeRow("recent-delegate"),
  ]);

  const messages = recordRequesterMessages();
  await restartGateway();
  await resumeRoots();
  // The prince receives the root's resume input and the deploy restart's one stopped delegate:
  // nothing late from last week.
  expect(messages).toEqual([
    { sessionKey: parent, source: "restart", text: GATEWAY_RESTART_RESUME_TEXT },
    {
      sessionKey: parent,
      source: "outcome:recent-delegate",
      text: childOutcomeText("recent-delegate", gracefulStopStatus),
    },
  ]);
  // Not lost: each settled run stays in his account by its run id, ended by the shutdown with no
  // delivery owed. (A week-old run is past the list's 24-hour window, as any ended run is.)
  const snapshot = await createSubagentsTool({ agentSessionKey: parent }).execute("wait", {
    action: "wait",
    runIds: ["older-delegate", "older-plain"],
    timeoutSeconds: 0,
  });
  const settledRun = (runId: string) => ({
    runId,
    status: "terminal",
    outcome: { status: "error", error: "Gateway stopped" },
    deliveryStatus: "not_required",
    endedAt: expect.any(Number),
  });
  expect(snapshot.details).toMatchObject({
    runs: [settledRun("older-delegate"), settledRun("older-plain")],
  });
  expect(snapshot.details).not.toHaveProperty("unavailable");
});

it("3: the undo puts the settled rows back byte for byte, and restore re-owes them as before", async () => {
  const { cutoff } = await seatWithQuietKills();
  const before = loadSubagentRegistryFromSqlite();
  const { backupPath } = await settleShutdownNotices(process.env, { endedBefore: cutoff });

  expect(await undoShutdownNoticeSettle(process.env, backupPath)).toEqual({
    databasePath: expect.stringMatching(/state[/\\]openclaw\.sqlite$/),
    backupPath,
    restored: ["older-delegate", "older-plain"],
    changed: [],
  });
  expect(loadSubagentRegistryFromSqlite()).toEqual(before);
  // A second undo finds nothing as the settle wrote it.
  expect(await undoShutdownNoticeSettle(process.env, backupPath)).toMatchObject({
    restored: [],
    changed: ["older-delegate", "older-plain"],
  });

  const messages = recordRequesterMessages();
  await restartGateway();
  await resumeRoots();
  expect(messages.map(({ source }) => source).toSorted()).toEqual([
    "outcome:older-delegate",
    "outcome:older-plain",
    "outcome:recent-delegate",
    "restart",
  ]);
});
