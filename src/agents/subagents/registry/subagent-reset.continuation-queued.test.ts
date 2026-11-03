// Continuation (karmaterminal): /new and /reset keep the elections the replaced head had not driven
// yet (karmaterminal/openclaw#1271). Real reset entry points (chat /reset and Gateway
// sessions.reset), real custody, registry and SQLite state; only the spawn owner and the reply
// runner are doubles, so each spawn and each continuation wake is counted where it would start.
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetContinuationCustodyProjection } from "../../../auto-reply/continuation/custody/custody-projection.js";
import {
  hydrateContinuationCustody,
  listContinuationRecords,
} from "../../../auto-reply/continuation/custody/custody-store.js";
import { custodyStateForTest } from "../../../auto-reply/continuation/custody/custody.test-support.js";
import { recoverPendingContinuationDelegates } from "../../../auto-reply/continuation/delegate-dispatch-recovery.js";
import {
  dispatchToolDelegates,
  resetDelegateDispatchHedgesForTests,
} from "../../../auto-reply/continuation/delegate-dispatch.js";
import {
  consumePendingDelegates,
  enqueuePendingDelegate,
} from "../../../auto-reply/continuation/delegate-store.js";
import { resetContinuationWorkDispatchForTests } from "../../../auto-reply/continuation/work-dispatch.js";
import { enqueuePendingWork } from "../../../auto-reply/continuation/work-store.test-support.js";
import { finalizeInboundContext } from "../../../auto-reply/reply/inbound-context.js";
import { clearReplacedSessionRuntimeState } from "../../../auto-reply/reply/session-init-reset-cleanup.js";
import { initSessionState } from "../../../auto-reply/reply/session.js";
import { captureRuntimeConfigAsyncReader, getRuntimeConfig } from "../../../config/config.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import { createChatAbortContext } from "../../../gateway/server-methods/chat.abort.test-helpers.js";
import { sessionDeleteHandlers } from "../../../gateway/server-methods/sessions-delete.js";
import { sessionMutationHandlers } from "../../../gateway/server-methods/sessions-mutations.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  childKey,
  createResetRetentionFixture,
  parentKey,
} from "./subagent-reset.continuation-retention.test-support.js";
import { resolveSubagentDisplayStatus } from "./subagent-session-metrics.js";

const doubles = vi.hoisted(() => ({
  spawns: [] as Array<{ task: string; childRunId?: string; at: number }>,
  wakes: [] as Array<{ sessionKey: string; body: string; at: number }>,
  // Holds the next spawn until released, to land a reset between claim and spawn.
  spawnGate: undefined as Promise<void> | undefined,
  spawnReached: undefined as (() => void) | undefined,
}));

// mock-isolation: the spawn owner records each launch and admits it, or reports a pre-dispatch
// admission cancel the way the real owner does (a phaseless `cancelled`, RFC §5.4.4).
vi.mock("../spawn/subagent-spawn.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../spawn/subagent-spawn.js")>()),
  spawnSubagentDirect: async (
    params: { task: string; continuationChildRunId?: string },
    context: { continuationDelegateAdmission?: { assertCurrent(boundary: string): void } },
  ) => {
    if (doubles.spawnGate) {
      doubles.spawnReached?.();
      await doubles.spawnGate;
    }
    try {
      context.continuationDelegateAdmission?.assertCurrent("child-session");
    } catch (error) {
      return { status: "cancelled", error: String(error) };
    }
    doubles.spawns.push({
      task: params.task,
      childRunId: params.continuationChildRunId,
      at: Date.now(),
    });
    return {
      status: "accepted",
      childSessionKey: childKey(`spawned-${doubles.spawns.length}`),
      runId: params.continuationChildRunId,
    };
  },
}));

// mock-isolation: the reply runner records the continuation wake turn it was asked to run.
vi.mock("../../../auto-reply/reply/get-reply.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../auto-reply/reply/get-reply.js")>()),
  getReplyFromConfig: async (
    ctx: { SessionKey: string; Body: string },
    opts: {
      onPreparedAgentRunStart?: (run: { runId: string }) => void;
      onAgentRunTerminalOutcome?: (outcome: "completed") => void;
    },
  ) => {
    doubles.wakes.push({ sessionKey: ctx.SessionKey, body: ctx.Body, at: Date.now() });
    opts.onPreparedAgentRunStart?.({ runId: `wake-run-${doubles.wakes.length}` });
    opts.onAgentRunTerminalOutcome?.("completed");
    return { text: "woke" };
  },
}));

const fixture = useSubagentControlFixture();
const { writeSession, addChild, returnFrom, returnRows, replay, drain, queuedEvents } =
  createResetRetentionFixture(() => fixture.stateDir);

beforeEach(async () => {
  doubles.spawns.length = 0;
  doubles.wakes.length = 0;
  doubles.spawnGate = undefined;
  doubles.spawnReached = undefined;
  const config = {
    agents: { defaults: { workspace: fixture.stateDir, continuation: { enabled: true } } },
  };
  await writeFile(path.join(fixture.stateDir, "openclaw.json"), JSON.stringify(config));
  setRuntimeConfigSnapshot(config);
  await captureRuntimeConfigAsyncReader()();
  await hydrateContinuationCustody();
});

afterEach(() => {
  resetContinuationWorkDispatchForTests();
  resetDelegateDispatchHedgesForTests();
  resetContinuationCustodyProjection();
});

const SETTLE_MS = 8_000;
const WAITING = "waiting for external continuation";
const readRecord = async (recordId: string) =>
  (await listContinuationRecords({ recordIds: [recordId] }))[0];
/** When the wake was claimed for its turn: the durable release time, not the double's clock. */
const releasedAt = async (recordId: string) => {
  const record = await readRecord(recordId);
  return record ? (custodyStateForTest(record).releasedAt as number) : undefined;
};

function adminCall<P>(params: P) {
  const respond = vi.fn();
  return {
    respond,
    request: {
      params,
      context: createChatAbortContext({
        getRuntimeConfig,
        getSessionEventSubscriberConnIds: () => new Set(),
      }) as never,
      respond,
      client: { connect: { scopes: ["operator.admin"] } } as never,
      req: { type: "req" as const, id: "queued", method: "sessions" },
      isWebchatConnect: () => false,
    },
  };
}

async function reset(boundary: "chat" | "rpc", sessionKey = parentKey): Promise<void> {
  if (boundary === "chat") {
    const result = await initSessionState({
      ctx: finalizeInboundContext({
        Body: "/new",
        From: "telegram:123",
        To: "telegram:123",
        ChatType: "direct",
        SessionKey: sessionKey,
        Provider: "telegram",
      }),
      cfg: getRuntimeConfig(),
      commandAuthorized: true,
    });
    expect(result.resetTriggered).toBe(true);
    return;
  }
  const { respond, request } = adminCall({ key: sessionKey });
  await sessionMutationHandlers["sessions.reset"]!(request);
  expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true }), undefined);
}

/** A continue_work elected while the head was idle, due `dueInMs` from now. */
async function electWork(reason: string, dueInMs: number, sessionKey = parentKey) {
  const electedAt = Date.now();
  const work = await enqueuePendingWork({
    sessionKey,
    hop: 1,
    delayMs: dueInMs,
    electedAt,
    dueAt: electedAt + dueInMs,
    anchorFinalizedAt: electedAt,
    maxChainLength: 8,
    reason,
  });
  return { recordId: work!.flowId!, dueAt: work!.dueAt };
}

const wakesFor = (reason: string) => doubles.wakes.filter((wake) => wake.body.includes(reason));
const spawnsFor = (task: string) => doubles.spawns.filter((spawn) => spawn.task.includes(task));

it.each(["chat", "rpc"] as const)(
  "%s reset keeps a queued delegate, which spawns once for the successor",
  async (boundary) => {
    await writeSession(parentKey, "parent", "before-reset");
    const delegate = await enqueuePendingDelegate(parentKey, {
      task: "search the winter annex fire",
      delayMs: 300,
    });

    await reset(boundary);

    expect(await readRecord(delegate.recordId)).toMatchObject({ status: "queued" });
    await vi.waitFor(
      async () => {
        expect(spawnsFor("winter annex")).toHaveLength(1);
        expect(await readRecord(delegate.recordId)).toMatchObject({
          status: "succeeded",
          handoff: { target: "subagent_runs" },
        });
      },
      { timeout: SETTLE_MS },
    );
    await delay(400);
    expect(spawnsFor("winter annex")).toHaveLength(1);
  },
);

it.each(["chat", "rpc"] as const)(
  "%s reset keeps a queued continue_work, which wakes the successor once at its original due time",
  async (boundary) => {
    await writeSession(parentKey, "parent", "before-reset");
    const work = await electWork("resume the annex search", 1_200);

    await reset(boundary);

    expect(await readRecord(work.recordId)).toMatchObject({ status: "queued", dueAt: work.dueAt });
    await vi.waitFor(() => expect(wakesFor("resume the annex search")).toHaveLength(1), {
      timeout: SETTLE_MS,
    });
    const [wake] = wakesFor("resume the annex search");
    expect(wake).toMatchObject({ sessionKey: parentKey });
    expect(wake!.body).toContain("[continuation:wake]");
    await vi.waitFor(async () =>
      expect(await readRecord(work.recordId)).toMatchObject({ status: "succeeded" }),
    );
    expect(await releasedAt(work.recordId)).toBeGreaterThanOrEqual(work.dueAt);
    await delay(400);
    expect(wakesFor("resume the annex search")).toHaveLength(1);
  },
);

it("two head swaps before the due time still wake once, not postponed", async () => {
  await writeSession(parentKey, "parent", "before-reset");
  const work = await electWork("one wake across two swaps", 1_500);

  await reset("chat");
  await reset("rpc");

  expect(await readRecord(work.recordId)).toMatchObject({ status: "queued", dueAt: work.dueAt });
  await vi.waitFor(() => expect(wakesFor("one wake across two swaps")).toHaveLength(1), {
    timeout: SETTLE_MS,
  });
  await vi.waitFor(async () =>
    expect(await readRecord(work.recordId)).toMatchObject({ status: "succeeded" }),
  );
  // Not re-based on either reset: the wake is claimed at the elected due time, not a delay later.
  const claimedAt = await releasedAt(work.recordId);
  expect(claimedAt).toBeGreaterThanOrEqual(work.dueAt);
  expect(claimedAt).toBeLessThan(work.dueAt + 1_000);
  await delay(400);
  expect(wakesFor("one wake across two swaps")).toHaveLength(1);
});

it("an automatic reset with no retention scope re-arms the kept wake in its post-commit cleanup", async () => {
  await writeSession(parentKey, "before-rollover", "before-reset");
  const work = await electWork("wake after an automatic rollover", 600);
  // The rollover committed the successor; agent-command then runs the post-commit cleanup.
  const storePath = await writeSession(parentKey, "after-rollover", "after-reset");
  await clearReplacedSessionRuntimeState({
    sessionKey: parentKey,
    storePath,
    agentId: "main",
    previousSessionEntry: { sessionId: "before-rollover" },
    previousSessionEndReason: "reset",
  });

  await vi.waitFor(() => expect(wakesFor("wake after an automatic rollover")).toHaveLength(1), {
    timeout: SETTLE_MS,
  });
  expect(await releasedAt(work.recordId)).toBeGreaterThanOrEqual(work.dueAt);
});

it("a delegate claimed before the reset spawns once after it, never twice", async () => {
  await writeSession(parentKey, "parent", "before-reset");
  const delegate = await enqueuePendingDelegate(parentKey, { task: "claimed across the swap" });
  let reached!: () => void;
  const atSpawn = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let release!: () => void;
  doubles.spawnGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  doubles.spawnReached = reached;
  // The replaced head's own drain: it claims the delegate, then the reset lands before spawn.
  const replacedHeadDrain = dispatchToolDelegates({
    sessionKey: parentKey,
    chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
    ctx: { sessionKey: parentKey },
    maxChainLength: 8,
  });
  await atSpawn;
  expect(await readRecord(delegate.recordId)).toMatchObject({ status: "running" });

  await reset("rpc");
  doubles.spawnGate = undefined;
  release();
  await replacedHeadDrain;

  // The aborted claim never dispatched, so it went back to the queue rather than ending.
  expect(spawnsFor("claimed across the swap")).toHaveLength(0);
  expect(await readRecord(delegate.recordId)).toMatchObject({ status: "queued" });
  // The successor's own drain spawns it.
  await dispatchToolDelegates({
    sessionKey: parentKey,
    chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
    ctx: { sessionKey: parentKey },
    maxChainLength: 8,
  });
  expect(spawnsFor("claimed across the swap")).toHaveLength(1);
  const settled = await readRecord(delegate.recordId);
  expect(settled).toMatchObject({ status: "succeeded", handoff: { target: "subagent_runs" } });
  // The second attempt's run ID is the one admitted; the first attempt is recorded, not reused.
  expect(settled!.spawnAttempts).toHaveLength(2);
  expect(spawnsFor("claimed across the swap")[0]!.childRunId).toBe(
    settled!.spawnAttempts[1]!.childRunId,
  );
  await recoverPendingContinuationDelegates({ includeRunningUpdatedAtOrBefore: Date.now() });
  expect(spawnsFor("claimed across the swap")).toHaveLength(1);
});

it("a claim the reset kept and a crash left unresolved ends in one interrupted notice, never a spawn", async () => {
  await writeSession(parentKey, "parent", "before-reset");
  const delegate = await enqueuePendingDelegate(parentKey, {
    task: "crash between claim and spawn",
  });
  // Claimed, and the process that claimed it died before spawning.
  expect(await consumePendingDelegates(parentKey)).toHaveLength(1);

  await reset("chat");

  expect(await readRecord(delegate.recordId)).toMatchObject({ status: "running" });
  // Gateway boot resolves the unresolved claim from subagent_runs: no row, so no second child.
  await recoverPendingContinuationDelegates({ includeRunningUpdatedAtOrBefore: Date.now() });
  await recoverPendingContinuationDelegates({ includeRunningUpdatedAtOrBefore: Date.now() });
  expect(spawnsFor("crash between claim and spawn")).toHaveLength(0);
  expect(await readRecord(delegate.recordId)).toMatchObject({
    status: "failed",
    failureReason: expect.stringContaining("spawn-interrupted"),
  });
});

it.each(["chat", "rpc"] as const)(
  "%s reset of an intermediate node delivers every result and the wake to its successor, redoing nothing",
  async (boundary) => {
    // The node under reset sits mid-tree: its admitted "ladder" child already ran and has a child
    // of its own; a delayed branch and a continue_work are still queued.
    await writeSession(parentKey, "parent", "before-reset");
    await addChild("ladder", true);
    await addChild("grandchild", true, childKey("ladder"));
    const branch = await enqueuePendingDelegate(parentKey, {
      task: "delayed branch of the forest",
      delayMs: 400,
    });
    const work = await electWork("forest wake", 1_200);

    await reset(boundary);

    expect(resolveSubagentDisplayStatus(subagentRuns.get("ladder")!)).toBe(WAITING);
    expect(subagentRuns.get("ladder")?.continuationResetRetention?.state).toBe("adopted");
    expect(resolveSubagentDisplayStatus(subagentRuns.get("grandchild")!)).toBe(WAITING);
    // The grandchild reports to the ladder child; the ladder child reports to the successor.
    const grandResult = "grandchild result to the ladder";
    expect((await returnFrom("grandchild", grandResult, childKey("ladder"))).handled).toBe(true);
    const ladderResult = "ladder result to the successor";
    expect((await returnFrom("ladder", ladderResult)).handled).toBe(true);
    const [row] = await returnRows("ladder");
    expect(await replay(row!)).toBe("queued");
    expect(await replay(row!)).toBe("queued");
    expect(queuedEvents(ladderResult)).toHaveLength(1);

    await vi.waitFor(
      async () => {
        expect(spawnsFor("delayed branch of the forest")).toHaveLength(1);
        expect(wakesFor("forest wake")).toHaveLength(1);
        expect(await readRecord(branch.recordId)).toMatchObject({ status: "succeeded" });
        expect(await readRecord(work.recordId)).toMatchObject({ status: "succeeded" });
      },
      { timeout: SETTLE_MS },
    );
    expect(await releasedAt(work.recordId)).toBeGreaterThanOrEqual(work.dueAt);
    // Finished work is not redone: no admitted run is spawned again, and the ladder's result
    // reached the successor once (above).
    expect(doubles.spawns.map((spawn) => spawn.task)).toEqual([
      expect.stringContaining("delayed branch of the forest"),
    ]);
  },
);

it("a reset followed by delete and recreation never delivers the kept work to the new occupant", async () => {
  // The main session cannot be deleted; a direct session can.
  const sessionKey = "agent:main:telegram:default:direct:forest-owner";
  await writeSession(sessionKey, "parent", "before-reset");
  const delegate = await enqueuePendingDelegate(sessionKey, {
    task: "branch for the deleted owner",
    delayMs: 600,
  });
  const work = await electWork("wake for the deleted owner", 900, sessionKey);
  await addChild("routed", true, sessionKey);
  await reset("rpc", sessionKey);
  expect(await readRecord(delegate.recordId)).toMatchObject({ status: "queued" });
  expect(await readRecord(work.recordId)).toMatchObject({ status: "queued" });
  expect(subagentRuns.get("routed")?.continuationResetRetention?.state).toBe("adopted");

  const deletion = adminCall({ key: sessionKey });
  await sessionDeleteHandlers["sessions.delete"]!(deletion.request);
  expect(deletion.respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
  await writeSession(sessionKey, "new-occupant", "new-occupant-revision");

  expect(await readRecord(delegate.recordId)).toMatchObject({ status: "cancelled" });
  expect(await readRecord(work.recordId)).toMatchObject({ status: "cancelled" });
  await delay(1_500);
  expect(spawnsFor("branch for the deleted owner")).toHaveLength(0);
  expect(wakesFor("wake for the deleted owner")).toHaveLength(0);
  // The admitted child's return was bound to the old owner's recipient authority, which the
  // delete advanced: the new occupant never receives it.
  const late = "late result for the old owner";
  await returnFrom("routed", late, sessionKey);
  for (const row of await returnRows("routed")) {
    expect(await drain(row)).not.toBe("recovered");
  }
  expect(queuedEvents(late, sessionKey)).toEqual([]);
});
