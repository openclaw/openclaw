// Continuation (karmaterminal): restart custody for accepted delegates, on upstream #185730's
// restart semantics (🌊's ruling, karmaterminal/openclaw-bootstrap#1727) and upstream #201544's
// graceful-shutdown completion (🌊's ruling on #201544, openclaw/openclaw#129388). A continuation
// delegate hands custody to its `subagent_runs` row at admission (RFC
// docs/design/continue-work-signal-v2.md §5.4.4), so that row is the per-child custody receipt.
// 1. A graceful shutdown stops an accepted delegate with an error outcome its requester is still
//    owed. After startup the requester receives that one outcome; it is never a success return.
// 2. A delegate row the previous Gateway lifecycle left running has no execution owner; the
//    next activation settles it to an explicit interrupted outcome. It is never relaunched and
//    carries no completion text. That interruption is its one outcome: the requester receives
//    it after startup through the delegate's return mode, after a crash as after a graceful stop.
// 3. The root's generic resume input and a delegate's own outcome describe different facts: the
//    resume input names no child and claims no child completion. Every accepted delegate is
//    accounted for once, by its own outcome, and no child gets a second outcome.
// 4. The parent can inspect that row itself: its `subagents` tool and its next turn's runtime
//    facts show the child ended, and a run snapshot names the restart interruption.
// 5. A crash is pinned apart from a graceful stop: no root resume input, no graceful-stop wording,
//    and exactly one interrupted outcome for each delegate the crashed process ran, through its
//    return mode. Upstream #200807's restart sweeper fails a plain sibling but never adds a second
//    outcome for the delegate.
// 6. A restart the delegate's work survives settles nothing early: a delegate the new lifecycle
//    runs, or one parked in `sessions_yield`, gets no outcome and no terminal settlement.
// 7. A delegate whose child session entry is missing has no spawn lineage to follow (🌊's ruling
//    on upstream #201970's root walk): no root is inferred or resumed for it. While its row still
//    binds its requester, its one outcome says "lineage missing; election outcome unknown", once,
//    through its return mode. Without that binding it is recorded unresolved and delivers nothing.
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { childOutcomeText, gracefulStopStatus, parent, recordRequesterMessages, resolveGateway, restartInterruptedStatus, useRestartCustodyWorld } from "./subagent-registry.restart-custody.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { getRuntimeConfig } from "../../../config/config.js";
import { loadExactSessionEntry } from "../../../config/sessions/session-accessor.js";
import { GATEWAY_RESTART_RESUME_TEXT } from "../../../gateway/session-restart-resume-prompt.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../../../infra/agent-run-registry.js";
import { formatContinuationChildRunId } from "../../../shared/continuation-run-key.js";
import { buildRuntimeFactsContext } from "../../runtime-facts-prompt.js";
import { deriveContinuationDelegateChildSessionKey } from "../../subagent-continuation-ids.js";
import { createSubagentsTool } from "../../tools/subagents-tool.js";
import { resolveSubagentSessionAttachmentRootDir } from "../subagent-attachment-paths.js";
import { subagentRegistryLog } from "./subagent-registry-lifecycle-log.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import {
  activateSubagentRegistry,
  isSubagentRunLive,
  listUnsettledRequesterChildren,
  testing,
} from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const {
  fixture,
  addRunningChild,
  shutDownGracefully,
  restartGateway,
  removeChildSession,
  writeParentSession,
  resumeRoots,
} = useRestartCustodyWorld();

function expectInterrupted(row: SubagentRunRecord | undefined) {
  expect(row?.execution).toMatchObject({
    status: "terminal",
    endedAt: expect.any(Number),
    outcome: { status: "error", error: expect.stringContaining("interrupted") },
  });
  expect(row?.endedReason).toBe("subagent-error");
  expect(row?.completion).toMatchObject({ required: true, resultText: null });
}

/** Upstream #201544: the shutdown's error outcome, owed to the requester. */
function expectGracefullyStopped(row: SubagentRunRecord | undefined) {
  expect(row?.execution).toMatchObject({
    status: "terminal",
    outcome: { status: "error", error: "Gateway stopped" },
  });
  expect(row?.endedReason).toBe("subagent-error");
  expect(row?.completion).toMatchObject({ required: true, resultText: null });
}

it("1: a graceful shutdown stops an accepted delegate with one outcome of its own; the root's resume input claims none", async () => {
  await writeParentSession();
  const child = await addRunningChild("graceful-delegate");

  await shutDownGracefully([child]);
  const stopped = loadSubagentRegistryFromSqlite().get("graceful-delegate");
  expectGracefullyStopped(stopped);
  // Owed, not delivered: the shutdown records the outcome and leaves delivery to startup.
  expect(stopped?.delivery).toEqual({ status: "pending" });
  expect(fixture.announce).not.toHaveBeenCalled();

  const messages = recordRequesterMessages();
  await restartGateway();
  await resumeRoots();

  // The root gets its one generic resume input, which names no child and claims no completion,
  // and the delegate's requester gets that child's one outcome: different facts, no duplicate.
  expect(messages).toEqual([
    { sessionKey: parent, source: "restart", text: GATEWAY_RESTART_RESUME_TEXT },
    {
      sessionKey: parent,
      source: "outcome:graceful-delegate",
      text: childOutcomeText("graceful-delegate", gracefulStopStatus),
    },
  ]);
  expect(GATEWAY_RESTART_RESUME_TEXT).not.toContain("graceful-delegate");
  expect(fixture.announce).toHaveBeenCalledTimes(1);
  const delivered = loadSubagentRegistryFromSqlite().get("graceful-delegate");
  expectGracefullyStopped(delivered);
  expect(delivered?.delivery).toMatchObject({ status: "delivered" });
  // Its spawn lineage is intact, so item 7 records nothing.
  expect(delivered?.continuationLineageMissing).toBeUndefined();
  expect(fixture.gateway).not.toHaveBeenCalled();
});

it("2: a crash-restored delegate whose requester had asked to stop it settles interrupted and quietly", async () => {
  await writeParentSession();
  // The kill owner committed its intent, then the process died before termination.
  await addRunningChild("crashed-killing", {
    killIntent: {
      requestedAt: Date.now() - 500,
      reason: "killed by requester",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
    },
  });
  const messages = recordRequesterMessages();

  await restartGateway();
  await resumeRoots();

  // The requester's election to stop it stands: no outcome follows, as for the finished kill.
  const settled = loadSubagentRegistryFromSqlite().get("crashed-killing");
  expectInterrupted(settled);
  expect(settled?.killIntent).toBeUndefined();
  expect(settled).toMatchObject({
    cleanupCompletedAt: expect.any(Number),
    delivery: { status: "not_required", disposition: "intentional_non_delivery" },
  });
  expect(messages).toEqual([]);
  expect(fixture.gateway).not.toHaveBeenCalled();
  expect(fixture.announce).not.toHaveBeenCalled();
});

it("2: an interrupted delegate's materialized attachments are released", async () => {
  const attachmentId = "6f9c1a52-3b7d-4e8a-9c21-0d4e5f6a7b8c";
  const childSessionKey = "agent:main:subagent:crashed-attachments";
  const attachmentDir = path.join(
    resolveSubagentSessionAttachmentRootDir({ agentId: "main", childSessionKey }),
    attachmentId,
  );
  await fs.mkdir(attachmentDir, { recursive: true });
  await fs.writeFile(path.join(attachmentDir, "input.txt"), "input", "utf8");
  await addRunningChild("crashed-attachments", { attachmentId });

  await restartGateway();

  expectInterrupted(loadSubagentRegistryFromSqlite().get("crashed-attachments"));
  await expect(fs.stat(attachmentDir)).rejects.toMatchObject({ code: "ENOENT" });
});

it("2: an in-process restart settles the earlier lifecycle's delegate and leaves a pending kill to its owner", async () => {
  await writeParentSession();
  await addRunningChild("earlier-lifecycle");
  const killIntent = {
    requestedAt: Date.now() - 500,
    reason: "killed by requester",
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
  };
  await addRunningChild("earlier-lifecycle-killing", { killIntent });
  // An in-process restart keeps module state; only the lifecycle generation rotates.
  rotateAgentEventLifecycleGeneration();
  const messages = recordRequesterMessages();

  await activateSubagentRegistry(resolveGateway);
  await fixture.settle();

  const durable = loadSubagentRegistryFromSqlite();
  expectInterrupted(durable.get("earlier-lifecycle"));
  // A retained row's pending kill still has its owner: the sweeper's durable kill reconcile.
  expect(durable.get("earlier-lifecycle-killing")).toMatchObject({
    killIntent,
    execution: { status: "running" },
  });
  expect(fixture.gateway).not.toHaveBeenCalled();
  // In-process, completion custody stays live, so the settled delegate's one outcome goes out
  // now rather than waiting for restart completion recovery.
  expect(messages).toEqual([
    {
      sessionKey: parent,
      source: "outcome:earlier-lifecycle",
      text: childOutcomeText("earlier-lifecycle", restartInterruptedStatus),
    },
  ]);
  expect(loadSubagentRegistryFromSqlite().get("earlier-lifecycle")?.delivery).toMatchObject({
    status: "delivered",
  });
});

it("4: the parent inspects a crash-settled delegate as interrupted by the restart, its outcome still owed", async () => {
  await addRunningChild("inspected-delegate");
  // Another requester's delegate settles too, but never reaches this parent's view.
  await addRunningChild("other-parent-delegate", {
    requesterSessionKey: "agent:main:other",
    requesterDisplayKey: "other",
  });

  await restartGateway();

  // The parent's own tool: the list names the child as ended, never active or done...
  const subagents = createSubagentsTool({ agentSessionKey: parent });
  const list = (await subagents.execute("list", { action: "list" })).details as {
    active: Array<{ runId: string }>;
    recent: Array<{ runId: string }>;
  };
  expect(list.active).toEqual([]);
  expect(list.recent).toEqual([
    expect.objectContaining({
      runId: "inspected-delegate",
      status: "failed",
      deliveryStatus: "pending",
      endedAt: expect.any(Number),
    }),
  ]);
  // ...and a snapshot of that run shows why it ended.
  const snapshot = await subagents.execute("wait", {
    action: "wait",
    runIds: ["inspected-delegate"],
    timeoutSeconds: 0,
  });
  expect(snapshot.details).toMatchObject({
    runs: [
      {
        runId: "inspected-delegate",
        status: "terminal",
        outcome: {
          status: "error",
          error: "subagent run interrupted: the Gateway restarted before it ended",
        },
        deliveryStatus: "pending",
        endedAt: expect.any(Number),
      },
    ],
    attention: [],
  });
  expect(snapshot.details).not.toHaveProperty("unavailable");

  // The parent's next turn carries the same ended row as a result still awaiting delivery.
  const facts = (
    await buildRuntimeFactsContext({
      cfg: getRuntimeConfig(),
      executionHost: false,
      capabilityToolNames: new Set(["sessions_spawn", "subagents", "continue_delegate"]),
      sessionKey: parent,
      agentId: "main",
    })
  )
    .map((fragment) => fragment.text)
    .join("\n\n");
  expect(facts).toContain("## Child results awaiting delivery");
  expect(facts).toMatch(
    /run_json="inspected-delegate"; .*outcome=error; delivery=pending; .*result_json="";/,
  );
  expect(facts).not.toContain("## Active Subagents");
  expect(facts).not.toContain("other-parent-delegate");
  expect(fixture.announce).not.toHaveBeenCalled();
  expect(fixture.wake).not.toHaveBeenCalled();
});

it("3: the root's resume input is not a child outcome; each accepted delegate keeps its own receipt", async () => {
  const parentStorePath = await writeParentSession();
  const reached = await addRunningChild("resume-reached");
  // Accepted, but the bounded shutdown kill never reaches it: no execution was live for it in
  // this lifecycle (its run had not registered yet, or the kill did not settle in time).
  await addRunningChild("resume-unreached");

  await shutDownGracefully([reached]);
  // Upstream #200533 moved queued-input custody to pending rows; the marker carries no ids.
  expect(
    loadExactSessionEntry({ agentId: "main", sessionKey: parent, storePath: parentStorePath })
      ?.entry.resumeAfterRestart,
  ).toEqual({});

  const messages = recordRequesterMessages();
  await restartGateway();
  await resumeRoots();

  // The root got its one generic resume input, and each delegate its one outcome: the stopped
  // one its graceful stop, the unreached one its interruption...
  expect(messages).toEqual([
    { sessionKey: parent, source: "restart", text: GATEWAY_RESTART_RESUME_TEXT },
    {
      sessionKey: parent,
      source: "outcome:resume-reached",
      text: childOutcomeText("resume-reached", gracefulStopStatus),
    },
    {
      sessionKey: parent,
      source: "outcome:resume-unreached",
      text: childOutcomeText("resume-unreached", restartInterruptedStatus),
    },
  ]);
  // ...and every accepted delegate still has its own terminal custody receipt.
  const durable = loadSubagentRegistryFromSqlite();
  expectGracefullyStopped(durable.get("resume-reached"));
  expectInterrupted(durable.get("resume-unreached"));
  expect(durable.get("resume-reached")?.delivery).toMatchObject({ status: "delivered" });
  expect(durable.get("resume-unreached")?.delivery).toMatchObject({ status: "delivered" });
  // On its resume turn the root reads each delegate's own outcome.
  const snapshot = await createSubagentsTool({ agentSessionKey: parent }).execute("wait", {
    action: "wait",
    runIds: ["resume-reached", "resume-unreached"],
    timeoutSeconds: 0,
  });
  expect(snapshot.details).toMatchObject({
    runs: [
      {
        runId: "resume-reached",
        status: "terminal",
        outcome: { status: "error", error: "Gateway stopped" },
      },
      {
        runId: "resume-unreached",
        status: "terminal",
        outcome: {
          status: "error",
          error: "subagent run interrupted: the Gateway restarted before it ended",
        },
      },
    ],
  });
  expect(fixture.gateway).not.toHaveBeenCalled();
});

it("3: activation settles an earlier process's delegate before the sweeper, so its requester gets no second outcome", async () => {
  await writeParentSession();
  // Rows the earlier Gateway process created, owed to this requester: upstream's sweeper fails
  // such a child with its own notice once the root's resume re-admits completion custody.
  const earlier = Math.floor(performance.timeOrigin) - 10 * 60_000;
  const earlierRow = {
    requesterAgentId: "main",
    createdAt: earlier,
    execution: {
      status: "running" as const,
      startedAt: earlier,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
    },
  };
  const reached = await addRunningChild("swept-reached");
  await addRunningChild("swept-delegate", earlierRow);
  await addRunningChild("swept-plain", {
    ...earlierRow,
    drainsContinuationDelegateQueue: undefined,
  });
  await shutDownGracefully([reached]);
  const messages = recordRequesterMessages();
  const registryWarn = vi.spyOn(subagentRegistryLog, "warn");

  await restartGateway();
  // Activation has already settled the delegate, before the root resume and any sweep. A sweep
  // this early fails nothing: retired custody still owes the plain child's notice.
  expectInterrupted(subagentRuns.get("swept-delegate"));
  await testing.sweepOnceForTests();
  await fixture.settle();
  expect(subagentRuns.get("swept-plain")?.execution.endedAt).toBeUndefined();
  await resumeRoots();

  const durable = loadSubagentRegistryFromSqlite();
  const noticeRunIds = () =>
    [...fixture.announce.mock.calls, ...fixture.wake.mock.calls].map(([request]) => {
      const params = request as { childRunId?: string; settledEntry?: { runId?: string } };
      return params.childRunId ?? params.settledEntry?.runId;
    });
  // The sweeper is live here: it failed the plain child and announced that failure...
  expect(durable.get("swept-plain")?.execution.outcome).toMatchObject({
    status: "error",
    error: expect.stringContaining("did not survive the restart"),
  });
  expect(noticeRunIds()).toContain("swept-plain");
  // ...but the delegate keeps the receipt activation wrote, and its requester gets exactly that
  // one outcome beside the root's one resume input: never the sweeper's second.
  expectInterrupted(durable.get("swept-delegate"));
  expect(durable.get("swept-delegate")?.execution.outcome).toMatchObject({
    error: "subagent run interrupted: the Gateway restarted before it ended",
  });
  expect(registryWarn).not.toHaveBeenCalledWith(
    "Settling subagent interrupted by Gateway restart",
    expect.objectContaining({ runId: "swept-delegate" }),
  );
  expect(
    fixture.announce.mock.calls.filter(([request]) => request.childRunId === "swept-delegate"),
  ).toHaveLength(1);
  expect(messages.filter(({ source }) => source === "outcome:swept-delegate")).toEqual([
    {
      sessionKey: parent,
      source: "outcome:swept-delegate",
      text: childOutcomeText("swept-delegate", restartInterruptedStatus),
    },
  ]);
  expect(messages.filter(({ source }) => source === "restart")).toEqual([
    { sessionKey: parent, source: "restart", text: GATEWAY_RESTART_RESUME_TEXT },
  ]);
  // Every child is accounted for once.
  expect(messages.map(({ source }) => source)).toEqual([
    "restart",
    "outcome:swept-reached",
    "outcome:swept-delegate",
    "outcome:swept-plain",
  ]);
});

const target = "agent:main:target";
const silentWake = (runId: string) => ({ reason: "silent-wake-enrichment", parentRunId: runId });
const RETURN_MODES = [
  {
    mode: "silent",
    fields: { silentAnnounce: true },
    recipient: parent,
    wakeRecipients: false,
    returnWake: (_runId: string) => false,
    wakes: false,
  },
  {
    mode: "silent-wake",
    fields: { silentAnnounce: true, wakeOnReturn: true },
    recipient: parent,
    wakeRecipients: false,
    returnWake: silentWake,
    wakes: true,
  },
  {
    mode: "targeted",
    fields: { continuationTargetSessionKey: target },
    recipient: target,
    wakeRecipients: true,
    returnWake: (_runId: string) => undefined,
    wakes: false,
  },
] as const;

it.each(RETURN_MODES)(
  "3: a $mode return carries the stopped and the unreached delegate's one outcome each",
  async ({ mode, fields, recipient, wakeRecipients, returnWake, wakes }) => {
    await writeParentSession();
    const reached = await addRunningChild(`${mode}-reached`, fields);
    await addRunningChild(`${mode}-unreached`, fields);
    await shutDownGracefully([reached]);

    const messages = recordRequesterMessages();
    await restartGateway();
    await resumeRoots();

    // Each delegate's outcome travels its own return route, once; the root's resume input stays
    // the root's.
    const returned = (runId: string, status: (runId: string) => string) => [
      {
        sessionKey: recipient,
        source: `return:${runId}`,
        text: childOutcomeText(runId, status),
        wakeRecipients,
        returnWake: returnWake(runId),
      },
      ...(wakes
        ? [{ sessionKey: parent, source: `wake:${runId}`, reason: "silent-wake-enrichment" }]
        : []),
    ];
    expect(messages).toEqual([
      { sessionKey: parent, source: "restart", text: GATEWAY_RESTART_RESUME_TEXT },
      ...returned(`${mode}-reached`, gracefulStopStatus),
      ...returned(`${mode}-unreached`, restartInterruptedStatus),
    ]);
    expect(fixture.announce).toHaveBeenCalledTimes(2);
  },
);

const DIRECT_RETURN = {
  mode: "direct",
  fields: {},
  recipient: parent,
  wakeRecipients: undefined,
  returnWake: (_runId: string) => undefined,
  wakes: false,
} as const;

/** What one delegate's outcome looks like at the delivery seams for its return mode. */
function deliveredThrough(
  {
    mode,
    recipient,
    wakeRecipients,
    returnWake,
    wakes,
  }: (typeof RETURN_MODES)[number] | typeof DIRECT_RETURN,
  runId: string,
  status: (runId: string) => string,
  childSessionKey?: string,
) {
  if (mode === "direct") {
    return [
      {
        sessionKey: parent,
        source: `outcome:${runId}`,
        text: childOutcomeText(runId, status, childSessionKey),
      },
    ];
  }
  return [
    {
      sessionKey: recipient,
      source: `return:${runId}`,
      text: childOutcomeText(runId, status, childSessionKey),
      wakeRecipients,
      returnWake: returnWake(runId),
    },
    ...(wakes
      ? [{ sessionKey: parent, source: `wake:${runId}`, reason: "silent-wake-enrichment" }]
      : []),
  ];
}

it.each([DIRECT_RETURN, ...RETURN_MODES])(
  "5: after a crash, a $mode delegate the crashed process ran gets one interrupted outcome on its own route",
  async (returnMode) => {
    await writeParentSession();
    // The crashed process created and ran these, under the lifecycle it held.
    const earlier = Math.floor(performance.timeOrigin) - 10 * 60_000;
    const earlierRow = {
      createdAt: earlier,
      execution: {
        status: "running" as const,
        startedAt: earlier,
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
      },
    };
    const delegate = `crashed-${returnMode.mode}`;
    const plain = `${delegate}-plain`;
    await addRunningChild(delegate, { ...returnMode.fields, ...earlierRow });
    // A plain sibling: upstream #200807's restart sweeper is live and fails it.
    await addRunningChild(plain, { ...earlierRow, drainsContinuationDelegateQueue: undefined });
    // The process dies here: no shutdown kill, no resume marker.
    const messages = recordRequesterMessages();
    const registryWarn = vi.spyOn(subagentRegistryLog, "warn");

    await restartGateway();
    // Activation settles the delegate before any sweep; retired custody delivers nothing yet.
    expectInterrupted(loadSubagentRegistryFromSqlite().get(delegate));
    expect(loadSubagentRegistryFromSqlite().get(delegate)?.delivery).toEqual({ status: "pending" });
    await testing.sweepOnceForTests();
    await fixture.settle();
    expect(messages).toEqual([]);
    await resumeRoots();

    // One interrupted outcome on the delegate's own route, and no root resume input.
    const forDelegate = messages.filter(({ source }) => source.endsWith(`:${delegate}`));
    expect(forDelegate).toEqual(deliveredThrough(returnMode, delegate, restartInterruptedStatus));
    expect(messages.filter(({ source }) => source === "restart")).toEqual([]);
    // Neither the graceful stop's wording nor the sweeper's ("The Gateway stopped before...").
    for (const message of forDelegate) {
      expect("text" in message ? message.text : "").not.toContain("Gateway stopped");
    }
    const durable = loadSubagentRegistryFromSqlite();
    expect(durable.get(delegate)?.execution.outcome).toMatchObject({
      status: "error",
      error: "subagent run interrupted: the Gateway restarted before it ended",
    });
    expect(durable.get(delegate)?.delivery).toMatchObject({ status: "delivered" });
    expect(
      fixture.announce.mock.calls.filter(([request]) => request.childRunId === delegate),
    ).toHaveLength(1);
    // The sweeper settled the plain sibling with its own outcome, and never the delegate.
    const restartSettles = registryWarn.mock.calls
      .filter(([message]) => message === "Settling subagent interrupted by Gateway restart")
      .map(([, meta]) => (meta as { runId?: string }).runId);
    expect(restartSettles).toEqual([plain]);
    expect(durable.get(plain)?.execution.outcome).toMatchObject({
      status: "error",
      error: expect.stringContaining("did not survive the restart"),
    });
    // Never relaunched, and no longer running work its requester waits for.
    expect(fixture.gateway).not.toHaveBeenCalled();
    const unsettled = await listUnsettledRequesterChildren({ requesterSessionKey: parent });
    expect(unsettled.map((child) => child.runId)).not.toContain(delegate);
  },
);

it("6: an in-process restart leaves a delegate the new lifecycle is running: no outcome, no terminal state", async () => {
  await writeParentSession();
  // An in-process restart keeps module state; only the lifecycle generation rotates.
  rotateAgentEventLifecycleGeneration();
  // This lifecycle admitted the delegate before activation, and its run is live.
  const live = await addRunningChild("live-delegate");
  const before = loadSubagentRegistryFromSqlite().get("live-delegate");
  const claim = claimAgentRunContext(
    live.runId,
    { sessionKey: live.childSessionKey },
    { trackOwner: true, ownsContext: true },
  );
  const messages = recordRequesterMessages();
  const registryWarn = vi.spyOn(subagentRegistryLog, "warn");
  try {
    await activateSubagentRegistry(resolveGateway);
    await fixture.settle();
    await resumeRoots();

    expect(loadSubagentRegistryFromSqlite().get("live-delegate")).toEqual(before);
    expect(messages).toEqual([]);
    expect(fixture.announce).not.toHaveBeenCalled();
    expect(isSubagentRunLive(live)).toBe(true);
    expect(registryWarn).not.toHaveBeenCalledWith(
      "Settling subagent interrupted by Gateway restart",
      expect.anything(),
    );
  } finally {
    releaseAgentRunContext(live.runId, claim);
  }
});

it("6: a crash leaves a delegate parked in sessions_yield to its message wait: no outcome, no terminal settlement", async () => {
  await writeParentSession();
  const earlier = Math.floor(performance.timeOrigin) - 10 * 60_000;
  // The crashed process ran it until it yielded, waiting for its requester's next message.
  await addRunningChild("parked-delegate", {
    createdAt: earlier,
    pauseReason: "sessions_yield",
    waitForMessage: true,
    execution: {
      status: "terminal",
      startedAt: earlier,
      endedAt: earlier + 1_000,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
    },
  });
  const before = loadSubagentRegistryFromSqlite().get("parked-delegate");
  const messages = recordRequesterMessages();

  await restartGateway();
  await resumeRoots();

  const parked = loadSubagentRegistryFromSqlite().get("parked-delegate");
  expect(parked).toMatchObject({ pauseReason: "sessions_yield", waitForMessage: true });
  expect(parked?.execution).toEqual(before?.execution);
  expect(parked?.endedReason).toBe(before?.endedReason);
  expect(parked?.delivery).toEqual(before?.delivery);
  expect(messages).toEqual([]);
  expect(fixture.announce).not.toHaveBeenCalled();
  expect(fixture.gateway).not.toHaveBeenCalled();
});

/** A production delegate: its run id is its election's claimed launch key (RFC §5.4.4). */
function productionDelegate(name: string) {
  const electionId = `election-${name}`;
  return {
    electionId,
    runId: formatContinuationChildRunId(electionId, 1),
    childSessionKey: deriveContinuationDelegateChildSessionKey("main", `flow-${name}`),
  };
}

const gracefulStopCause = (runId: string) =>
  `stopped by a graceful Gateway shutdown before run ${runId} finished (recorded error: Gateway stopped)`;
const restartInterruptedCause = (runId: string) =>
  `interrupted: the Gateway restarted before run ${runId} ended, and no graceful shutdown reached it`;
/** Item 7: the delegate's one outcome when its spawn lineage is missing. */
const lineageMissingStatus =
  (electionId: string, cause: (runId: string) => string) => (runId: string) =>
    `lineage missing; election outcome unknown (election ${electionId}): ${cause(runId)}. Its child session entry is missing, so no root was resumed for it and any work it saved cannot be located. Not a task failure; the run was not resumed.`;

it.each([DIRECT_RETURN, ...RETURN_MODES])(
  "7: a graceful restart that finds a $mode delegate's child session entry missing sends one lineage-missing outcome on its route and resumes no root",
  async (returnMode) => {
    await writeParentSession();
    const delegate = productionDelegate(`graceful-${returnMode.mode}`);
    const child = await addRunningChild(delegate.runId, {
      ...returnMode.fields,
      childSessionKey: delegate.childSessionKey,
    });
    await removeChildSession(child);

    await shutDownGracefully([child]);
    const messages = recordRequesterMessages();
    await restartGateway();
    await resumeRoots();

    // The requester's one message is the delegate's outcome, on its own route; no root resume
    // input, since nothing verifies the requester as the root of this delegate's work.
    expect(messages).toEqual(
      deliveredThrough(
        returnMode,
        delegate.runId,
        lineageMissingStatus(delegate.electionId, gracefulStopCause),
        delegate.childSessionKey,
      ),
    );
    const durable = loadSubagentRegistryFromSqlite().get(delegate.runId);
    expectGracefullyStopped(durable);
    expect(durable?.continuationLineageMissing).toEqual({ recordedAt: expect.any(Number) });
    expect(durable?.delivery).toMatchObject({ status: "delivered" });
    expect(fixture.announce).toHaveBeenCalledTimes(1);
    expect(fixture.gateway).not.toHaveBeenCalled();
  },
);

it("7: the lineage-missing outcome goes out once: a replayed activation, a second restart and its sweeps add none", async () => {
  await writeParentSession();
  const delegate = productionDelegate("once");
  const child = await addRunningChild(delegate.runId, {
    childSessionKey: delegate.childSessionKey,
  });
  await removeChildSession(child);
  await shutDownGracefully([child]);
  const messages = recordRequesterMessages();

  await restartGateway();
  const decided = loadSubagentRegistryFromSqlite().get(delegate.runId)?.continuationLineageMissing;
  expect(decided).toEqual({ recordedAt: expect.any(Number) });
  // Activation replays before startup delivers, then the same state restarts again.
  await activateSubagentRegistry(resolveGateway);
  await fixture.settle();
  await resumeRoots();
  await restartGateway();
  await resumeRoots();

  expect(messages).toEqual(
    deliveredThrough(
      DIRECT_RETURN,
      delegate.runId,
      lineageMissingStatus(delegate.electionId, gracefulStopCause),
      delegate.childSessionKey,
    ),
  );
  expect(fixture.announce).toHaveBeenCalledTimes(1);
  expect(loadSubagentRegistryFromSqlite().get(delegate.runId)?.continuationLineageMissing).toEqual(
    decided,
  );
});

it("7: after a crash, a delegate whose child session entry is missing gets one lineage-missing interrupted outcome", async () => {
  await writeParentSession();
  const earlier = Math.floor(performance.timeOrigin) - 10 * 60_000;
  const delegate = productionDelegate("crashed");
  const child = await addRunningChild(delegate.runId, {
    childSessionKey: delegate.childSessionKey,
    createdAt: earlier,
    execution: {
      status: "running",
      startedAt: earlier,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
    },
  });
  await removeChildSession(child);
  const messages = recordRequesterMessages();

  await restartGateway();
  await resumeRoots();

  expect(messages).toEqual(
    deliveredThrough(
      DIRECT_RETURN,
      delegate.runId,
      lineageMissingStatus(delegate.electionId, restartInterruptedCause),
      delegate.childSessionKey,
    ),
  );
  const durable = loadSubagentRegistryFromSqlite().get(delegate.runId);
  expectInterrupted(durable);
  expect(durable?.continuationLineageMissing).toEqual({ recordedAt: expect.any(Number) });
  expect(durable?.delivery).toMatchObject({ status: "delivered" });
});

it("7: with no requester binding left, a missing child session entry is recorded unresolved: no notice, no root resume", async () => {
  // The requester's session is gone too: the row names a requester nothing can admit.
  const delegate = productionDelegate("unbound");
  const child = await addRunningChild(delegate.runId, {
    childSessionKey: delegate.childSessionKey,
  });
  await removeChildSession(child);
  await shutDownGracefully([child]);
  const messages = recordRequesterMessages();
  const registryWarn = vi.spyOn(subagentRegistryLog, "warn");

  await restartGateway();
  await resumeRoots();

  expect(messages).toEqual([]);
  expect(fixture.announce).not.toHaveBeenCalled();
  expect(fixture.gateway).not.toHaveBeenCalled();
  const durable = loadSubagentRegistryFromSqlite().get(delegate.runId);
  expectGracefullyStopped(durable);
  expect(durable).toMatchObject({
    continuationLineageMissing: {
      recordedAt: expect.any(Number),
      unresolved: "requester-session-missing",
    },
    cleanupCompletedAt: expect.any(Number),
    delivery: { status: "not_required", disposition: "intentional_non_delivery" },
  });
  expect(registryWarn).toHaveBeenCalledWith(
    "continuation delegate restart lineage missing; outcome left unresolved",
    {
      runId: delegate.runId,
      electionId: delegate.electionId,
      childSessionKey: delegate.childSessionKey,
      requesterSessionKey: parent,
      reason: "requester-session-missing",
    },
  );
});
