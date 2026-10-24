import { AsyncResource } from "node:async_hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  claimAgentRunDelegatedAuthority,
  clearAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunDelegatedAuthority,
  rotateAgentRunRegistryLifecycleGeneration,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import {
  createCronCreatorAuthorityCapability,
  type CronCreatorAuthorityCapability,
  bindRequesterOwnerIdentity,
  runWithCronCreatorAuthorityCapability,
} from "../cron-creator-authority-context.js";
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
import { isSameSubagentRunOwner } from "./registry/subagent-run-generation.js";
import {
  consumeRequesterCronAuthorityAdmission,
  captureRequesterContinuationCaller,
  prepareRequesterCronAuthority,
  replaceRequesterCronAuthorityEntry,
  revokeRequesterCronAuthority,
  revokeRequesterCronAuthorityBatch,
} from "./requester-cron-authority.js";

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
const runs = new Map<string, SubagentRunRecord>();
let state: OpenClawTestState;
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
});
afterAll(async () => {
  await state.cleanup();
});

afterEach(() => {
  revokeRequesterCronAuthority(SESSION);
  runs.clear();
  fixture.session = {
    sessionId: "requester-session",
    lifecycleRevision: "original",
  };
});

function createBatch(requesterTurnRunId: string, count = 1): SubagentRunRecord[] {
  return Array.from({ length: count }, (_, index) => {
    const runId = `${requesterTurnRunId}-child-${index}`;
    const entry: SubagentRunRecord = {
      runId,
      requesterTurnRunId,
      requesterAgentId: "main",
      childSessionKey: `agent:main:subagent:${runId}`,
      requesterSessionKey: SESSION,
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

type RunOptions = Pick<CronCreatorAuthorityCapability, "isCurrent" | "requesterOwner"> & {
  entitlement?: CronCreatorAuthorityCapability["managementEntitlement"];
};

async function inAdminRun<T>(runId: string, run: () => Promise<T>, options: RunOptions = {}) {
  const { operationalRunInstance } = createTestAdmittedRunContext(runId);
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  registerAgentRunContext(runId, {
    ...identity,
    sessionId: fixture.session.sessionId,
  });
  const capability = createCronCreatorAuthorityCapability(
    runId,
    { kind: "unknown" },
    options.entitlement ?? { source: "control-ui-admin" },
    options.isCurrent,
    undefined,
    options.requesterOwner,
  )!;
  try {
    const withCaller = () =>
      withGatewayToolCallerIdentity(
        {
          ...callerIdentity,
          operationalRunInstance,
          approvalAuthority: authority,
          receiptAuthority: () => validateAgentRunDelegatedAuthority(authority),
        },
        run,
      );
    return await runWithCronCreatorAuthorityCapability(capability, withCaller);
  } finally {
    releaseAgentRunDelegatedAuthority(authority);
    clearAgentRunContext(runId);
  }
}

function ownBatchTransfer(
  batch: SubagentRunRecord[],
  beforeWrite?: () => void,
  assertCurrent?: () => void,
) {
  const transfer = createRequesterInitialTransferFixture(runs, beforeWrite, { assertCurrent });
  return async (params: Parameters<typeof transfer>[0]) => {
    await transfer({
      ...params,
      afterRelease(published) {
        params.afterRelease?.(published);
        batch.splice(0, batch.length, ...published);
      },
    });
  };
}

async function updateBatch(
  batch: SubagentRunRecord[],
  update: (drafts: SubagentRunRecord[]) => void,
): Promise<void> {
  const observed = [...batch];
  await mutateSubagentRuns(
    observed.map((entry) => entry.runId),
    (rows) => {
      const drafts = observed.map((entry) => {
        const current = expectDefined(rows.get(entry.runId), "current fixture batch member");
        expect(isSameSubagentRunOwner(current, entry)).toBe(true);
        return structuredClone(current);
      });
      update(drafts);
      return { value: undefined, postimages: new Map(drafts.map((entry) => [entry.runId, entry])) };
    },
    publishBatch(batch),
  );
}

function publishBatch(batch: SubagentRunRecord[]) {
  const observed = [...batch];
  return {
    runs,
    onPublished(postimages: ReadonlyMap<string, SubagentRunRecord | null>) {
      batch.splice(
        0,
        batch.length,
        ...observed.map((entry) =>
          expectDefined(postimages.get(entry.runId), "acknowledged fixture batch member"),
        ),
      );
    },
  };
}

async function replaceChild(batch: SubagentRunRecord[], runId: string, preserve: boolean) {
  const [previous, ...siblings] = batch;
  const next = structuredClone(batch);
  Object.assign(next[0]!, { runId, taskRunId: previous!.runId, pauseReason: undefined });
  const batchRunIds = [runId, ...siblings.map((entry) => entry.runId)].toSorted();
  for (const entry of next) {
    entry.requesterSettleWake!.batchRunIds = batchRunIds;
  }
  await mutateSubagentRuns(
    [previous!.runId, ...next.map((entry) => entry.runId)],
    () => ({
      value: undefined,
      postimages: new Map<string, SubagentRunRecord | null>([
        [previous!.runId, null],
        ...next.map((entry) => [entry.runId, entry] as const),
      ]),
    }),
    publishBatch(next),
  );
  replaceRequesterCronAuthorityEntry({ previous: previous!, next: next[0]!, preserve });
  return next;
}

async function finishPause(batch: SubagentRunRecord[]) {
  await updateBatch(batch, ([entry]) => expect(consumeSubagentPauseNotice(entry!)).toBe(true));
  revokeRequesterCronAuthorityBatch([batch[0]!], 1);
}

async function mark(batch: SubagentRunRecord[], persistOrThrow: () => void = () => {}) {
  const target = {
    ...requester,
    requesterTurnRunId: batch[0]!.requesterTurnRunId!,
  };
  const preparedAuthority = prepareRequesterCronAuthority(target);
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

function settle(batch: SubagentRunRecord[]) {
  return settleRequesterTurnAfterSessionSpawns({
    ...requester,
    requesterTurnRunId: batch[0]!.requesterTurnRunId!,
    requesterYielded: true,
    acceptedSessionSpawns: batch.map((entry) => ({
      runId: entry.runId,
      childSessionKey: entry.childSessionKey,
      expectsCompletionMessage: true,
    })),
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
  batch: SubagentRunRecord[],
  runId = "continuation",
  deliveryRoute?: Parameters<typeof captureRequesterContinuationCaller>[0]["deliveryRoute"],
) {
  return captureRequesterContinuationCaller({
    ...requester,
    requesterSessionId: "requester-session",
    batch,
    rearmGeneration: batch[0]?.requesterSettleWake?.rearmGeneration,
    runId,
    isCurrent: () => true,
    deliveryRoute,
  });
}

function dispatch<T>(batch: SubagentRunRecord[], run: () => Promise<T>, runId = "continuation") {
  return continuationCaller(batch, runId).run(run);
}

type Admission = NonNullable<ReturnType<typeof consume>>;
async function inAdmittedScope(
  batch: SubagentRunRecord[],
  run: (admission: Admission, scope: CronCreatorAuthorityCapability) => Promise<void>,
  runId = "continuation",
) {
  let admission: Admission;
  await dispatch(
    batch,
    async () => {
      admission = consume(batch, runId)!;
      expect(admission.isCurrent()).toBe(true);
      const scope = createCronCreatorAuthorityCapability(
        runId,
        { kind: "unknown" },
        admission.managementEntitlement,
        admission.isCurrent,
      )!;
      admission.bindRunScope(scope);
      await runWithCronCreatorAuthorityCapability(scope, () => run(admission, scope));
    },
    runId,
  );
  expect(admission!.isCurrent()).toBe(false);
}

function consume(
  batch: SubagentRunRecord[],
  runId = "continuation",
  sourceTool = "subagent_settle",
) {
  return consumeRequesterCronAuthorityAdmission({
    runId,
    ...identity,
    inputProvenance: {
      kind: "inter_session",
      sourceTool,
      sourceSessionKey: batch[0]!.childSessionKey,
    },
  });
}

describe("requester cron authority lifetime", () => {
  it("captures an immutable route and revalidates its owner", async () => {
    const batch = await capture();
    const route = {
      channel: "discord",
      to: "channel:original",
      deliveryIntent: { id: "intent-1", kind: "outbound_queue" as const },
    };
    const captured = continuationCaller(batch, "continuation", route);

    const currentDispatch = vi.fn(async () => {
      expect(consume(batch)?.managementEntitlement.source).toBe("control-ui-admin");
    });
    await captured.run(currentDispatch);
    expect(currentDispatch).toHaveBeenCalledOnce();
    route.to = "channel:mutated";
    route.deliveryIntent.id = "intent-mutated";
    expect(captured.deliveryRoute).toEqual({
      channel: "discord",
      to: "channel:original",
      deliveryIntent: { id: "intent-1", kind: "outbound_queue" },
    });
    fixture.session.lifecycleRevision = "replacement";
    const replacementDispatch = vi.fn(async () => {
      expect(consume(batch)).toBeUndefined();
    });
    await captured.run(replacementDispatch);
    expect(replacementDispatch).toHaveBeenCalledOnce();
    expect(captured.deliveryRoute?.to).toBe("channel:original");
  });

  it.each(["completion", "scope ended", "reset"] as const)(
    "retains cohort authority through a scoped pause: %s",
    async (outcome) => {
      const batch = await capture("pause-owner", 2);
      await updateBatch(batch, ([paused]) => {
        paused!.pauseReason = "sessions_yield";
        paused!.requesterSettleWake!.pauseNotice = { acknowledgment: "Need a continuation." };
      });
      await inAdmittedScope(
        [batch[0]!],
        async (admission) => {
          expect(admission.managementEntitlement.source).toBe("control-ui-admin");
          expect(admission.isCurrent()).toBe(true);
          if (outcome === "reset") {
            fixture.session.lifecycleRevision = "replacement";
          } else if (outcome === "completion") {
            await finishPause(batch);
          }
          expect(admission.isCurrent()).toBe(outcome !== "reset");
        },
        "pause-turn",
      );
      if (outcome === "reset") {
        await dispatch(batch, async () => expect(consume(batch)).toBeUndefined());
        return;
      }
      if (outcome === "scope ended") {
        await finishPause(batch);
      }

      const nextBatch = await replaceChild(batch, `continued-child-${outcome}`, true);
      await dispatch(nextBatch, async () => {
        const completionAdmission = consume(nextBatch)!;
        expect(completionAdmission.managementEntitlement.source).toBe("control-ui-admin");
        expect(completionAdmission.isCurrent()).toBe(true);
        await updateBatch(nextBatch, (drafts) => {
          for (const entry of drafts) {
            entry.requesterSettleWake = undefined;
          }
        });
        revokeRequesterCronAuthorityBatch(nextBatch, 1);
        expect(completionAdmission.isCurrent()).toBe(false);
      });
    },
  );

  it.each([true, false])("transfers only admitted plugin ownership: %s", async (hasOwner) => {
    let current = true;
    const owner = {
      isCurrent: () => current,
      senderId: "original-owner",
      channel: "discord",
      accountId: "original-account",
    };
    const entitlement = hasOwner
      ? { source: "channel-owner" as const, isCurrent: owner.isCurrent }
      : { source: "control-ui-admin" as const };
    const batch = await capture("owner-source", 1, {
      entitlement,
      requesterOwner: hasOwner ? owner : undefined,
    });
    let retained: ReturnType<typeof bindRequesterOwnerIdentity>;
    await dispatch(batch, async () => {
      const admission = consume(batch)!;
      expect(admission.requesterOwner).toBe(hasOwner ? owner : undefined);
      await inAdminRun(
        "continuation",
        async () => {
          const target = { ...identity, runId: "continuation" };
          expect(
            bindRequesterOwnerIdentity({ ...target, sessionKey: "agent:main:unrelated" }),
          ).toBeUndefined();
          retained = bindRequesterOwnerIdentity(target);
          if (!hasOwner) {
            expect(retained).toBeUndefined();
            return;
          }
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
        },
        {
          isCurrent: admission.isCurrent,
          entitlement: admission.managementEntitlement,
          requesterOwner: admission.requesterOwner,
        },
      );
    });
    if (hasOwner) {
      expect(retained?.isCurrent()).toBe(false);
      expect(() => retained?.assertCurrent()).toThrow("owner identity");
    }
  });

  it.each([
    ["channel-owner", "before dispatch"],
    ["channel-owner", "after second yield"],
    ["control-ui-admin", "after second yield"],
  ] as const)("retains %s authority %s without its original run", async (source, when) => {
    let owner = true;
    const entitlement =
      source === "channel-owner" ? { source, isCurrent: () => owner } : { source };
    const first = await capture("owner-original", 1, { entitlement });
    if (when === "before dispatch") {
      owner = false;
    }
    let next: SubagentRunRecord[] = [];
    await dispatch(first, async () => {
      const admission = consume(first);
      if (when === "before dispatch") {
        expect(admission).toBeUndefined();
        return;
      }
      expect(admission).toMatchObject({
        managementEntitlement: { source },
        callerOrigin: { kind: "unknown" },
      });
      expect(admission?.isCurrent()).toBe(true);
      next = createBatch("continuation");
      await inAdminRun("continuation", async () => expect(await mark(next)).toBe(1), {
        isCurrent: admission!.isCurrent,
        entitlement: admission!.managementEntitlement,
      });
      expect(await settle(next)).toBe(true);
    });
    if (when === "after second yield") {
      await dispatch(
        next,
        async () => {
          const second = consume(next, "second-continuation");
          expect(second?.callerOrigin).toEqual({ kind: "unknown" });
          expect(second?.isCurrent()).toBe(true);
          if (source === "channel-owner") {
            owner = false;
            expect(second?.isCurrent()).toBe(false);
          }
        },
        "second-continuation",
      );
    }
  });

  it("transfers cleanup to the exact scope, preserving session revocation", async () => {
    const batch = await capture();
    await inAdmittedScope(batch, async (admission, scope) => {
      expect(() => admission.bindRunScope(scope)).toThrow("no longer owns");
      await mutateSubagentRuns(
        batch.map((entry) => entry.runId),
        () => ({
          value: undefined,
          postimages: new Map(batch.map((entry) => [entry.runId, null])),
        }),
        { runs },
      );
      await Promise.resolve();
      expect(admission.isCurrent()).toBe(true);
      fixture.session.lifecycleRevision = "reset";
      expect(admission.isCurrent()).toBe(false);
    });
  });

  it.each([false, true])(
    "binds yield across contexts, rejecting replaced runs: %s",
    async (replaced) => {
      const outside = new AsyncResource("requester-yield-callback");
      const batch = createBatch("original");
      fixture.markRequesterTurnYielded.mockImplementation(() => mark(batch));
      fixture.claimSubagentYield.mockClear();
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
        expect(fixture.claimSubagentYield).toHaveBeenCalledExactlyOnceWith({
          runId: "original",
          sessionKey: identity.sessionKey,
          agentId: identity.agentId,
          waitForMessage: false,
          acknowledgment: undefined,
          hasPendingWork: expect.any(Function),
        });
        // This root has a real completion claim, not a native child message wait.
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
    ["Gateway replacement", rotateAgentRunRegistryLifecycleGeneration],
    [
      "cancel",
      (batch: SubagentRunRecord[]) =>
        updateBatch(batch, ([entry]) => {
          entry!.killIntent = { requestedAt: 3, reason: "stop", suppressTaskDelivery: true };
        }),
    ],
    [
      "batch replacement",
      (batch: SubagentRunRecord[]) => runs.set(batch[0]!.runId, structuredClone(batch[0]!)),
    ],
    [
      "new yield generation",
      (batch: SubagentRunRecord[]) =>
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
    "partial cohort",
    "reconstructed cohort",
    "arbitrary child message",
    "one stopped child",
  ] as const)("admits only an owned cohort continuation: %s", async (input) => {
    const batch = await capture("original", 2);
    if (input === "one stopped child") {
      await updateBatch(batch, ([entry]) => {
        entry!.killIntent = { requestedAt: 3, reason: "stop" };
        entry!.suppressCompletionDelivery = true;
      });
    }
    const candidate =
      input === "partial cohort"
        ? batch.slice(0, 1)
        : input === "reconstructed cohort"
          ? structuredClone(batch)
          : batch;
    await dispatch(candidate, async () => {
      if (input === "partial cohort" || input === "reconstructed cohort") {
        expect(consume(batch)).toBeUndefined();
        return;
      }
      if (input === "arbitrary child message") {
        expect(consume(batch, "continuation", "sessions_send")).toBeUndefined();
      }
      const admission = consume(batch);
      expect(admission).toBeDefined();
      expect(admission?.isCurrent()).toBe(true);
    });
    if (candidate !== batch) {
      await dispatch(batch, async () => expect(consume(batch)).toBeDefined());
    }
  });

  it.each([true, false])("preserves replacements only for continued work: %s", async (preserve) => {
    const batch = await capture();
    const replacement = await replaceChild(batch, `child-successor-${preserve}`, preserve);
    await dispatch(replacement, async () => {
      expect(Boolean(consume(replacement))).toBe(preserve);
    });
  });

  it.each(["returned", "thrown"] as const)(
    "retries %s unadmitted failures without replay",
    async (failure) => {
      const batch = await capture();
      if (failure === "returned") {
        await dispatch(batch, async () => ({ delivered: false, path: "none" }));
      } else {
        await expect(
          dispatch(batch, async () => {
            throw new Error("before admission");
          }),
        ).rejects.toThrow("before admission");
      }
      let admitted: ReturnType<typeof consume>;
      await expect(
        dispatch(batch, async () => {
          admitted = consume(batch);
          expect(admitted).toBeDefined();
          expect(admitted?.isCurrent()).toBe(true);
          expect(consume(batch)).toBeUndefined();
          throw new Error("ambiguous transport");
        }),
      ).rejects.toThrow("ambiguous transport");
      expect(admitted!.isCurrent()).toBe(true);
      await dispatch(batch, async () => expect(consume(batch)).toBeUndefined());
      expect(admitted!.isCurrent()).toBe(true);
      revokeRequesterCronAuthority(SESSION);
      expect(admitted!.isCurrent()).toBe(false);
    },
  );

  it.each(["failed persistence", "fresh user during persistence"] as const)(
    "does not retain provisional authority after %s",
    async (kind) => {
      const batch = createBatch("original");
      await inAdminRun("original", async () => {
        const persist = () => {
          if (kind === "failed persistence") {
            throw new Error("write failed");
          }
          revokeRequesterCronAuthority(SESSION);
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
});
