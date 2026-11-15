import { AsyncResource } from "node:async_hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import * as agentRuns from "../../infra/agent-run-registry.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import * as cronContext from "../cron-creator-authority-context.js";
import { createRequesterYieldCallback } from "../openclaw-tools.requester-yield.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../tools/gateway-caller-context.js";
import { consumeSubagentPauseNotice } from "./registry/subagent-delivery-state.js";
import { mutateSubagentRuns } from "./registry/subagent-registry-persistence.js";
import {
  markRequesterTurnYieldedInRuns,
  settleRequesterTurnAfterSessionSpawns,
} from "./registry/subagent-registry-requester-yield.js";
import { createRequesterInitialTransferFixture } from "./registry/subagent-registry-requester-yield.test-support.js";
import type { SubagentRunRecord } from "./registry/subagent-registry.types.js";
import * as requesterCron from "./requester-cron-authority.js";

const fixture = vi.hoisted(() => {
  const session: Pick<SessionEntry, "sessionId" | "lifecycleRevision" | "archivedAt"> = {
    sessionId: "requester-session",
    lifecycleRevision: "original",
  };
  return {
    session,
    markRequesterTurnYielded: vi.fn(),
    claimSubagentYield: vi.fn<typeof import("./registry/subagent-registry.js").claimSubagentYield>(
      async () => "nothing-pending",
    ),
  };
});
vi.mock("./registry/subagent-registry.js", () => ({
  markRequesterTurnYielded: fixture.markRequesterTurnYielded,
  claimSubagentYield: fixture.claimSubagentYield,
}));
vi.mock("../../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
// mock-isolation: Use revocable fixture session facts without opening the Gateway store.
vi.mock("../../gateway/session-sharing-preparation.js", () => ({
  prepareSessionMutationFacts: async () => {
    let active = true;
    return {
      readCurrent: () => {
        if (!active) {
          throw new Error("Requester session facts retired");
        }
        return { target: { entry: fixture.session } };
      },
      release: () => {
        active = false;
      },
    };
  },
}));

const SESSION = "agent:main:control-ui";
const requester = { requesterSessionKey: SESSION, requesterAgentId: "main" };
const callerIdentity = { agentId: "main", sessionKey: SESSION };
const identity = { ...callerIdentity, sessionId: "requester-session" };
type Batch = SubagentRunRecord[];
type Scope = cronContext.CronCreatorAuthorityCapability;
const runs = new Map<string, SubagentRunRecord>();
let state: OpenClawTestState;
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
});
afterAll(() => state.cleanup());

afterEach(() => {
  requesterCron.revokeRequesterCronAuthority(SESSION);
  runs.clear();
  fixture.session = { sessionId: "requester-session", lifecycleRevision: "original" };
});

function createBatch(requesterTurnRunId: string, count = 1): Batch {
  return Array.from({ length: count }, (_, index) => {
    const runId = `${requesterTurnRunId}-child-${index}`;
    const entry: SubagentRunRecord = {
      ...requester,
      runId,
      requesterTurnRunId,
      childSessionKey: `agent:main:subagent:${runId}`,
      requesterDisplayKey: "control-ui",
      task: "audit",
      cleanup: "keep",
      createdAt: 1,
      execution: { status: "terminal", endedAt: 2 },
      expectsCompletionMessage: true,
      completion: { required: true },
      delivery: { status: "delivered" },
    };
    runs.set(runId, entry);
    return entry;
  });
}

type RunOptions = Pick<Scope, "isCurrent" | "requesterOwner" | "managementEntitlement"> & {
  bindRunScope?: (scope: Scope) => void;
};

async function inAdminRun<T>(
  runId: string,
  run: (scope: Scope) => Promise<T>,
  options: RunOptions = {},
) {
  const { operationalRunInstance } = createTestAdmittedRunContext(runId);
  const authority = agentRuns.claimAgentRunDelegatedAuthority(operationalRunInstance);
  agentRuns.registerAgentRunContext(runId, { ...identity, sessionId: fixture.session.sessionId });
  const capability = cronContext.createCronCreatorAuthorityCapability(
    runId,
    { kind: "unknown" },
    options.managementEntitlement ?? { source: "control-ui-admin" },
    options.isCurrent,
    undefined,
    options.requesterOwner,
  )!;
  try {
    options.bindRunScope?.(capability);
    return await cronContext.runWithCronCreatorAuthorityCapability(capability, () =>
      withGatewayToolCallerIdentity(
        {
          ...callerIdentity,
          operationalRunInstance,
          approvalAuthority: authority,
          receiptAuthority: () => agentRuns.validateAgentRunDelegatedAuthority(authority),
        },
        () => run(capability),
      ),
    );
  } finally {
    agentRuns.releaseAgentRunDelegatedAuthority(authority);
    agentRuns.clearAgentRunContext(runId);
  }
}

function ownBatchTransfer(batch: Batch, beforeWrite?: () => void, assertCurrent?: () => void) {
  const transfer = createRequesterInitialTransferFixture(runs, beforeWrite, { assertCurrent });
  return (params: Parameters<typeof transfer>[0]) =>
    transfer({
      ...params,
      afterRelease(published) {
        params.afterRelease?.(published);
        batch.splice(0, batch.length, ...published);
      },
    });
}

async function updateBatch(batch: Batch, update: (drafts: Batch) => void, newIds: string[] = []) {
  const runIds = batch.map((entry) => entry.runId);
  await mutateSubagentRuns(
    [...runIds, ...newIds],
    (rows) => {
      const drafts = runIds.map((id) => structuredClone(expectDefined(rows.get(id), id)));
      update(drafts);
      const postimages = new Map<string, SubagentRunRecord | null>(runIds.map((id) => [id, null]));
      for (const entry of drafts) {
        postimages.set(entry.runId, entry);
      }
      return { value: drafts, postimages };
    },
    {
      runs,
      onPublished(postimages, drafts) {
        const published = drafts.map(({ runId }) => expectDefined(postimages.get(runId), runId));
        batch.splice(0, batch.length, ...published);
      },
    },
  );
}

async function replaceChild(batch: Batch, runId: string, preserve: boolean) {
  const previous = batch[0]!;
  await updateBatch(
    batch,
    (drafts) => {
      Object.assign(drafts[0]!, { runId, taskRunId: previous.runId, pauseReason: undefined });
      const batchRunIds = drafts.map((entry) => entry.runId).toSorted();
      for (const entry of drafts) {
        entry.requesterSettleWake!.batchRunIds = batchRunIds;
      }
    },
    [runId],
  );
  requesterCron.replaceRequesterCronAuthorityEntry({ previous, next: batch[0]!, preserve });
  return batch;
}

async function finishPause(batch: Batch) {
  await updateBatch(batch, ([entry]) => expect(consumeSubagentPauseNotice(entry!)).toBe(true));
  requesterCron.revokeRequesterCronAuthorityBatch([batch[0]!], 1);
}

async function mark(batch: Batch, persistOrThrow: () => void = () => {}) {
  const target = { ...requester, requesterTurnRunId: batch[0]!.requesterTurnRunId! };
  const preparedAuthority = requesterCron.prepareRequesterCronAuthority(target);
  try {
    return await markRequesterTurnYieldedInRuns({
      ...target,
      preparedAuthority: preparedAuthority ?? null,
      runs,
      transfer: ownBatchTransfer(batch, persistOrThrow, () => preparedAuthority?.assertCurrent()),
    });
  } finally {
    await preparedAuthority?.release();
  }
}

function settle(batch: Batch) {
  return settleRequesterTurnAfterSessionSpawns({
    ...requester,
    requesterTurnRunId: batch[0]!.requesterTurnRunId!,
    requesterYielded: true,
    acceptedSessionSpawns: batch,
    runs,
    transfer: ownBatchTransfer(batch),
    schedule: () => undefined,
  });
}

async function capture(runId = "original", count = 1, options: RunOptions = {}) {
  const batch = createBatch(runId, count);
  await inAdminRun(runId, async () => expect(await mark(batch)).toBe(count), options);
  expect(await settle(batch)).toBe(true);
  return batch;
}

function continuationCaller(
  batch: Batch,
  runId = "continuation",
  deliveryRoute?: Parameters<
    typeof requesterCron.captureRequesterContinuationCaller
  >[0]["deliveryRoute"],
) {
  return requesterCron.captureRequesterContinuationCaller({
    ...requester,
    requesterSessionId: "requester-session",
    batch,
    rearmGeneration: batch[0]?.requesterSettleWake?.rearmGeneration,
    runId,
    isCurrent: () => true,
    deliveryRoute,
  });
}

function dispatch<T>(batch: Batch, run: () => Promise<T>, runId = "continuation") {
  return continuationCaller(batch, runId).run(run);
}

type Admission = NonNullable<ReturnType<typeof consume>>;
async function inAdmittedScope(
  batch: Batch,
  run: (admission: Admission, scope: Scope) => Promise<void>,
) {
  const admission = await dispatch(batch, async () => {
    const admitted = consume(batch)!;
    expect(admitted.isCurrent()).toBe(true);
    await inAdminRun("continuation", (scope) => run(admitted, scope), admitted);
    return admitted;
  });
  expect(admission.isCurrent()).toBe(false);
}

function consume(batch: Batch, runId = "continuation", sourceTool = "subagent_settle") {
  return requesterCron.consumeRequesterCronAuthorityAdmission({
    runId,
    ...identity,
    inputProvenance: {
      kind: "inter_session",
      sourceTool,
      sourceSessionKey: batch[0]!.childSessionKey,
    },
  });
}

it("captures an immutable route", async () => {
  const route = {
    channel: "discord",
    to: "channel:original",
    deliveryIntent: { id: "intent-1", kind: "outbound_queue" as const },
  };
  const captured = continuationCaller(await capture(), "continuation", route);
  route.to = "channel:mutated";
  route.deliveryIntent.id = "intent-mutated";
  expect(captured.deliveryRoute).toEqual({
    channel: "discord",
    to: "channel:original",
    deliveryIntent: { id: "intent-1", kind: "outbound_queue" },
  });
});

it.each(["completion", "scope ended"] as const)(
  "retains cohort authority through a scoped pause: %s",
  async (outcome) => {
    const batch = await capture("pause-owner", 2);
    await updateBatch(batch, ([paused]) => {
      paused!.pauseReason = "sessions_yield";
      paused!.requesterSettleWake!.pauseNotice = { acknowledgment: "Need a continuation." };
    });
    await inAdmittedScope([batch[0]!], async (admission) => {
      expect(admission.managementEntitlement.source).toBe("control-ui-admin");
      if (outcome === "completion") {
        await finishPause(batch);
      }
      expect(admission.isCurrent()).toBe(true);
    });
    if (outcome === "scope ended") {
      await finishPause(batch);
    }

    const nextBatch = await replaceChild(batch, `continued-child-${outcome}`, true);
    await dispatch(nextBatch, async () => {
      const completionAdmission = consume(nextBatch)!;
      expect(completionAdmission.isCurrent()).toBe(true);
      expect(completionAdmission.managementEntitlement.source).toBe("control-ui-admin");
      await updateBatch(nextBatch, (drafts) => {
        for (const entry of drafts) {
          entry.requesterSettleWake = undefined;
        }
      });
      requesterCron.revokeRequesterCronAuthorityBatch(nextBatch, 1);
      expect(completionAdmission.isCurrent()).toBe(false);
    });
  },
);

it.each([
  ["channel-owner", true],
  ["channel-owner", false],
  ["control-ui-admin", false],
] as const)("retains %s across yields with plugin owner=%s", async (source, hasOwner) => {
  let current = true;
  const owner = {
    isCurrent: () => current,
    senderId: "original-owner",
    channel: "discord",
    accountId: "original-account",
  };
  const entitlement =
    source === "channel-owner" ? { source, isCurrent: owner.isCurrent } : { source };
  const batch = await capture("owner-source", 1, {
    managementEntitlement: entitlement,
    requesterOwner: hasOwner ? owner : undefined,
  });
  let retained: ReturnType<typeof cronContext.bindRequesterOwnerIdentity>;
  let next: Batch = [];
  await inAdmittedScope(batch, async (admission, scope) => {
    expect(() => admission.bindRunScope(scope)).toThrow("no longer owns");
    expect(admission.requesterOwner).toBe(hasOwner ? owner : undefined);
    const target = { ...identity, runId: "continuation" };
    expect(
      cronContext.bindRequesterOwnerIdentity({ ...target, sessionKey: "agent:main:unrelated" }),
    ).toBeUndefined();
    retained = cronContext.bindRequesterOwnerIdentity(target);
    if (hasOwner) {
      expect(retained).toMatchObject({
        senderId: "original-owner",
        channel: "discord",
        accountId: "original-account",
      });
      expect(retained?.isCurrent()).toBe(true);
      current = false;
      expect(() => retained?.assertCurrent()).toThrow("owner identity");
      current = true;
      expect(retained?.isCurrent()).toBe(true);
    } else {
      expect(retained).toBeUndefined();
    }
    expect(admission).toMatchObject({
      managementEntitlement: { source },
      callerOrigin: { kind: "unknown" },
    });
    next = await capture("second-yield", 1, {
      isCurrent: admission.isCurrent,
      managementEntitlement: admission.managementEntitlement,
      requesterOwner: admission.requesterOwner,
    });
  });
  if (hasOwner) {
    expect(retained?.isCurrent()).toBe(false);
    expect(() => retained?.assertCurrent()).toThrow("owner identity");
  }
  await dispatch(next, async () => {
    const second = consume(next)!;
    expect(second.callerOrigin).toEqual({ kind: "unknown" });
    expect(second.isCurrent()).toBe(true);
    if (source === "channel-owner") {
      current = false;
      expect(second.isCurrent()).toBe(false);
    }
  });
});

it("rejects an owner revoked before dispatch", async () => {
  let current = true;
  const batch = await capture("owner-original", 1, {
    managementEntitlement: { source: "channel-owner", isCurrent: () => current },
  });
  current = false;
  await dispatch(batch, async () => expect(consume(batch)).toBeUndefined());
});

it.each([false, true])(
  "binds yield across contexts, rejecting replaced runs: %s",
  async (replaced) => {
    const outside = new AsyncResource("requester-yield-callback");
    const batch = createBatch("original");
    fixture.markRequesterTurnYielded.mockImplementation(() => mark(batch));
    try {
      await inAdminRun("original", async () => {
        const caller = getGatewayToolCallerIdentity()!;
        const claimYield = createRequesterYieldCallback({
          ...requester,
          requesterTurnRunId: "original",
        })!;
        const claim = async () => expect(await claimYield()).toBe(true);
        await outside.runInAsyncScope(() =>
          replaced ? inAdminRun("original", claim) : withGatewayToolCallerIdentity(caller, claim),
        );
      });
      expect(await settle(batch)).toBe(true);
      await dispatch(batch, async () => expect(Boolean(consume(batch))).toBe(!replaced));
    } finally {
      outside.emitDestroy();
    }
  },
);

it.each([
  ["reset", () => Object.assign(fixture.session, { lifecycleRevision: "reset" })],
  ["archive", () => Object.assign(fixture.session, { archivedAt: 3 })],
  ["Gateway replacement", agentRuns.rotateAgentRunRegistryLifecycleGeneration],
  [
    "cancel",
    (batch: Batch) =>
      updateBatch(batch, ([entry]) => {
        entry!.killIntent = { requestedAt: 3, reason: "stop", suppressTaskDelivery: true };
      }),
  ],
  ["batch replacement", (batch: Batch) => runs.set(batch[0]!.runId, structuredClone(batch[0]!))],
  [
    "new yield generation",
    (batch: Batch) =>
      updateBatch(batch, ([entry]) => {
        entry!.requesterSettleWake!.rearmGeneration = 2;
      }),
  ],
] as const)("revokes an admitted continuation after %s", async (_label, invalidate) => {
  const batch = await capture();
  await dispatch(batch, async () => {
    const admission = consume(batch)!;
    expect(admission.isCurrent()).toBe(true);
    await Promise.resolve();
    await invalidate(batch);
    expect(admission.isCurrent()).toBe(false);
  });
});

it.each([
  ["partial", (batch: Batch) => batch.slice(0, 1)],
  ["reconstructed", (batch: Batch) => structuredClone(batch)],
] as const)("rejects a %s cohort without consuming the owner", async (_label, candidate) => {
  const batch = await capture("original", 2);
  await dispatch(candidate(batch), async () => expect(consume(batch)).toBeUndefined());
  await dispatch(batch, async () => expect(consume(batch)).toBeDefined());
});

it("admits the owned cohort, not arbitrary messages, with one stopped child", async () => {
  const batch = await capture("original", 2);
  await updateBatch(batch, ([entry]) => {
    entry!.killIntent = { requestedAt: 3, reason: "stop" };
    entry!.suppressCompletionDelivery = true;
  });
  await dispatch(batch, async () => {
    expect(consume(batch, "continuation", "sessions_send")).toBeUndefined();
    expect(consume(batch)?.isCurrent()).toBe(true);
  });
});

it.each([true, false])("preserves replacements only for continued work: %s", async (preserve) => {
  const batch = await capture();
  const replacement = await replaceChild(batch, `child-successor-${preserve}`, preserve);
  await dispatch(replacement, async () => expect(Boolean(consume(replacement))).toBe(preserve));
});

it("retries returned and thrown unadmitted failures without replaying admission", async () => {
  const batch = await capture();
  await dispatch(batch, async () => ({ delivered: false, path: "none" }));
  await expect(
    dispatch(batch, async () => {
      throw new Error("before admission");
    }),
  ).rejects.toThrow("before admission");
  let admitted: ReturnType<typeof consume>;
  await expect(
    dispatch(batch, async () => {
      admitted = consume(batch);
      expect(admitted?.isCurrent()).toBe(true);
      expect(consume(batch)).toBeUndefined();
      throw new Error("ambiguous transport");
    }),
  ).rejects.toThrow("ambiguous transport");
  expect(admitted!.isCurrent()).toBe(true);
  await dispatch(batch, async () => expect(consume(batch)).toBeUndefined());
  expect(admitted!.isCurrent()).toBe(true);
  requesterCron.revokeRequesterCronAuthority(SESSION);
  expect(admitted!.isCurrent()).toBe(false);
});

it.each(["failed persistence", "fresh user during persistence"] as const)(
  "does not retain provisional authority after %s",
  async (kind) => {
    const batch = createBatch("original");
    await inAdminRun("original", async () => {
      const persist = () => {
        if (kind === "failed persistence") {
          throw new Error("write failed");
        }
        requesterCron.revokeRequesterCronAuthority(SESSION);
      };
      if (kind === "failed persistence") {
        await expect(mark(batch, persist)).rejects.toThrow("write failed");
      } else {
        await expect(mark(batch, persist)).rejects.toMatchObject({
          outcome: "not-committed",
          cause: expect.objectContaining({
            message: expect.stringContaining("Requester authority retired"),
          }),
        });
      }
    });
    expect(runs.get(batch[0]!.runId)?.requesterTurnYielded).toBeUndefined();
    await updateBatch(batch, (drafts) => {
      for (const entry of drafts) {
        entry.requesterTurnYielded = true;
      }
    });
    expect(await settle(batch)).toBe(true);
    await dispatch(batch, async () => expect(consume(batch)).toBeUndefined());
  },
);
