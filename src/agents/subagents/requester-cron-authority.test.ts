import { AsyncResource } from "node:async_hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import { readOperatorToolGatewayAuthority } from "../../gateway/operator-tool-gateway-authority.js";
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
import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../admitted-run-context.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import {
  createCronCreatorAuthorityCapability,
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
  retireRequesterAuthorityCohort,
  settleRequesterAuthorityWave,
} from "./requester-cron-authority-cohort.js";
import {
  consumeRequesterCronAuthorityAdmission,
  prepareRequesterCronAuthority,
  replaceRequesterCronAuthorityEntry,
  revokeRequesterCronAuthority,
  revokeRequesterCronAuthorityBatch,
  withRequesterCronAuthority,
} from "./requester-cron-authority.js";

const fixture = vi.hoisted(() => {
  const session: Pick<SessionEntry, "sessionId" | "lifecycleRevision" | "archivedAt"> = {
    sessionId: "requester-session",
    lifecycleRevision: "original",
  };
  return { session, markRequesterTurnYielded: vi.fn() };
});
vi.mock("./registry/subagent-registry.js", () => ({
  markRequesterTurnYielded: fixture.markRequesterTurnYielded,
}));
vi.mock("../../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../../gateway/session-sharing-preparation.js", () => ({
  prepareSessionMutationFacts: async (params: { sessionKey: string; agentId: string }) => {
    let active = true;
    const target = {
      agentId: params.agentId,
      canonicalKey: params.sessionKey,
      storeKey: params.sessionKey,
      storeKeys: [params.sessionKey],
      storePath: "/synthetic/requester.sqlite",
    };
    return {
      storageTarget: target,
      bindCreation: vi.fn(),
      readCurrent: () => {
        if (!active) {
          throw new Error("Requester session facts retired");
        }
        return { target: { ...target, entry: fixture.session }, membership: new Set() };
      },
      release: () => {
        active = false;
      },
    };
  },
}));

const SESSION = "agent:main:control-ui";
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

async function inAdminRun<T>(
  runId: string,
  run: () => Promise<T>,
  isCurrent?: () => boolean,
  entitlement: NonNullable<
    NonNullable<ReturnType<typeof createCronCreatorAuthorityCapability>>["managementEntitlement"]
  > = { source: "control-ui-admin" },
  requesterOwner?: {
    isCurrent: () => boolean;
    senderId?: string;
    channel?: string;
    accountId?: string;
  },
  operatorAuthority?: AdmittedRunOperatorAuthority,
  includeCron = true,
) {
  const { operationalRunInstance } = createTestAdmittedRunContext(runId);
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  registerAgentRunContext(runId, {
    agentId: "main",
    sessionKey: SESSION,
    sessionId: fixture.session.sessionId,
  });
  const capability = createCronCreatorAuthorityCapability(
    runId,
    { kind: "unknown" },
    entitlement,
    isCurrent,
    undefined,
    requesterOwner,
  )!;
  try {
    const withCaller = () =>
      withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: SESSION,
          operationalRunInstance,
          approvalAuthority: authority,
          operatorAuthority,
          receiptAuthority: () => validateAgentRunDelegatedAuthority(authority),
        },
        run,
      );
    return await (includeCron
      ? runWithCronCreatorAuthorityCapability(capability, withCaller)
      : withCaller());
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
    {
      runs,
      onPublished(postimages) {
        batch.splice(
          0,
          batch.length,
          ...observed.map((entry) =>
            expectDefined(postimages.get(entry.runId), "acknowledged fixture batch member"),
          ),
        );
      },
    },
  );
}

async function mark(batch: SubagentRunRecord[], persistOrThrow: () => void = () => {}) {
  const requester = {
    requesterSessionKey: SESSION,
    requesterAgentId: "main",
    requesterTurnRunId: batch[0]!.requesterTurnRunId!,
  };
  const preparedAuthority = prepareRequesterCronAuthority(requester);
  try {
    return await markRequesterTurnYieldedInRuns({
      ...requester,
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
    requesterSessionKey: SESSION,
    requesterAgentId: "main",
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

async function capture(runId = "original", count = 1) {
  const batch = createBatch(runId, count);
  await inAdminRun(runId, async () => expect(await mark(batch)).toBe(count));
  expect(await settle(batch)).toBe(true);
  return batch;
}

function dispatch<T>(batch: SubagentRunRecord[], run: () => Promise<T>, runId = "continuation") {
  return withRequesterCronAuthority(
    {
      requesterSessionKey: SESSION,
      requesterSessionId: "requester-session",
      requesterAgentId: "main",
      batch,
      rearmGeneration: batch[0]?.requesterSettleWake?.rearmGeneration,
      runId,
      isCurrent: () => true,
    },
    run,
  );
}

function consume(
  batch: SubagentRunRecord[],
  runId = "continuation",
  sourceTool = "subagent_settle",
) {
  return consumeRequesterCronAuthorityAdmission({
    runId,
    sessionKey: SESSION,
    sessionId: "requester-session",
    inputProvenance: {
      kind: "inter_session",
      sourceTool,
      sourceSessionKey: batch[0]!.childSessionKey,
    },
  });
}

describe("requester cron authority lifetime", () => {
  it.each(["completion", "scope ended", "reset"] as const)(
    "retains the full cohort's authority across a scoped child pause until %s",
    async (outcome) => {
      const operator = createAdmittedRunOperatorAuthority({
        profileId: "pause-requester",
        scopes: ["operator.read"],
        assertCurrent: () => {},
      });
      const batch = createBatch("pause-owner", 2);
      await inAdminRun(
        "pause-owner",
        async () => expect(await mark(batch)).toBe(2),
        undefined,
        undefined,
        undefined,
        operator,
      );
      expect(await settle(batch)).toBe(true);
      await updateBatch(batch, ([paused]) => {
        paused!.pauseReason = "sessions_yield";
        paused!.requesterSettleWake!.pauseNotice = { acknowledgment: "Need a continuation." };
      });
      let paused = batch[0]!;
      let pauseAdmission: ReturnType<typeof consume>;
      await dispatch(
        [paused],
        async () => {
          expect(readOperatorToolGatewayAuthority()?.operatorRunAuthority).toBe(operator);
          pauseAdmission = consume([paused], "pause-turn");
          expect(pauseAdmission?.managementEntitlement.source).toBe("control-ui-admin");
          expect(pauseAdmission?.isCurrent()).toBe(true);
          const scope = createCronCreatorAuthorityCapability(
            "pause-turn",
            { kind: "unknown" },
            pauseAdmission!.managementEntitlement,
            pauseAdmission!.isCurrent,
          )!;
          pauseAdmission!.bindRunScope(scope);
          await runWithCronCreatorAuthorityCapability(scope, async () => {
            expect(pauseAdmission!.isCurrent()).toBe(true);
            if (outcome === "reset") {
              fixture.session.lifecycleRevision = "replacement";
            } else if (outcome === "completion") {
              await updateBatch(batch, ([draft]) =>
                expect(consumeSubagentPauseNotice(draft!)).toBe(true),
              );
              paused = batch[0]!;
              revokeRequesterCronAuthorityBatch([paused], 1);
            }
            expect(pauseAdmission!.isCurrent()).toBe(outcome !== "reset");
          });
        },
        "pause-turn",
      );
      expect(pauseAdmission!.isCurrent()).toBe(false);
      if (outcome === "reset") {
        const work = vi.fn(async () => {});
        await expect(dispatch(batch, work)).rejects.toThrow("no longer current");
        expect(work).not.toHaveBeenCalled();
        return;
      }
      if (outcome === "scope ended") {
        await updateBatch(batch, ([draft]) =>
          expect(consumeSubagentPauseNotice(draft!)).toBe(true),
        );
        paused = batch[0]!;
        revokeRequesterCronAuthorityBatch([paused], 1);
      }

      const continued = structuredClone(paused);
      continued.runId = "continued-child";
      continued.taskRunId = paused.runId;
      continued.pauseReason = undefined;
      const nextBatch = [continued, structuredClone(batch[1]!)];
      const batchRunIds = nextBatch.map((entry) => entry.runId).toSorted();
      for (const entry of nextBatch) {
        entry.requesterSettleWake!.batchRunIds = batchRunIds;
      }
      await mutateSubagentRuns(
        [paused.runId, ...nextBatch.map((entry) => entry.runId)],
        () => ({
          value: undefined,
          postimages: new Map<string, SubagentRunRecord | null>([
            [paused.runId, null],
            ...nextBatch.map((entry) => [entry.runId, entry] as const),
          ]),
        }),
        {
          runs,
          onPublished(postimages) {
            nextBatch.splice(
              0,
              nextBatch.length,
              ...nextBatch.map((entry) =>
                expectDefined(postimages.get(entry.runId), "acknowledged continued batch member"),
              ),
            );
          },
        },
      );
      replaceRequesterCronAuthorityEntry({ previous: paused, next: nextBatch[0]!, preserve: true });
      await dispatch(nextBatch, async () => {
        expect(readOperatorToolGatewayAuthority()?.operatorRunAuthority).toBe(operator);
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

  it("keeps cohort authority for each wave split off by a consumed pause notice", async () => {
    const operator = createAdmittedRunOperatorAuthority({
      profileId: "split-requester",
      scopes: ["operator.read"],
      assertCurrent: () => {},
    });
    const batch = createBatch("split-owner", 2);
    await inAdminRun(
      "split-owner",
      async () => expect(await mark(batch)).toBe(2),
      undefined,
      undefined,
      undefined,
      operator,
    );
    expect(await settle(batch)).toBe(true);
    const operatorDispatch = (wave: SubagentRunRecord[], runId: string) =>
      dispatch(
        wave,
        async () => expect(readOperatorToolGatewayAuthority()?.operatorRunAuthority).toBe(operator),
        runId,
      );
    await updateBatch(batch, ([paused]) => {
      paused!.pauseReason = "sessions_yield";
      paused!.requesterSettleWake!.pauseNotice = { acknowledgment: "Need a continuation." };
    });
    await operatorDispatch([batch[0]!], "pause-turn");
    await updateBatch(batch, ([paused]) => expect(consumeSubagentPauseNotice(paused!)).toBe(true));
    revokeRequesterCronAuthorityBatch([batch[0]!], 1);

    // The sibling's wave no longer waits for the detached child and keeps the operator.
    await updateBatch(batch, ([, sibling]) => {
      sibling!.requesterSettleWake!.batchRunIds = [sibling!.runId];
    });
    await operatorDispatch([batch[1]!], "sibling-turn");
    await updateBatch(batch, ([, sibling]) => {
      sibling!.requesterSettleWake = undefined;
    });
    revokeRequesterCronAuthorityBatch([batch[1]!], 1);
    await expect(dispatch([batch[1]!], async () => {})).rejects.toThrow(
      "Requester operator authority does not own this continuation",
    );

    // The resumed child's own later wave still carries the cohort's operator.
    const paused = batch[0]!;
    const continued = structuredClone(paused);
    continued.runId = "continued-split-child";
    continued.taskRunId = paused.runId;
    continued.pauseReason = undefined;
    continued.requesterSettleWake!.batchRunIds = [continued.runId];
    const resumed = [continued];
    await mutateSubagentRuns(
      [paused.runId, continued.runId],
      () => ({
        value: undefined,
        postimages: new Map<string, SubagentRunRecord | null>([
          [paused.runId, null],
          [continued.runId, continued],
        ]),
      }),
      {
        runs,
        onPublished(postimages) {
          resumed[0] = expectDefined(postimages.get(continued.runId), "acknowledged resumed child");
        },
      },
    );
    replaceRequesterCronAuthorityEntry({ previous: paused, next: resumed[0]!, preserve: true });
    await operatorDispatch(resumed, "resumed-turn");
    await updateBatch(resumed, ([draft]) => {
      draft!.requesterSettleWake = undefined;
    });
    revokeRequesterCronAuthorityBatch(resumed, 1);
    await expect(dispatch(resumed, async () => {})).rejects.toThrow("Requester operator authority");
  });

  it("keeps an admitted wave's turn when another wave's member is cancelled", async () => {
    const operator = createAdmittedRunOperatorAuthority({
      profileId: "split-turn-requester",
      scopes: ["operator.read"],
      assertCurrent: () => {},
    });
    const batch = createBatch("split-turn-owner", 2);
    await inAdminRun(
      "split-turn-owner",
      async () => expect(await mark(batch)).toBe(2),
      undefined,
      undefined,
      undefined,
      operator,
    );
    expect(await settle(batch)).toBe(true);
    await updateBatch(batch, ([paused]) => {
      paused!.pauseReason = "sessions_yield";
      paused!.requesterSettleWake!.pauseNotice = { acknowledgment: "Need a continuation." };
    });
    await dispatch([batch[0]!], async () => {}, "pause-turn");
    await updateBatch(batch, ([paused]) => expect(consumeSubagentPauseNotice(paused!)).toBe(true));
    revokeRequesterCronAuthorityBatch([batch[0]!], 1);
    await updateBatch(batch, ([, sibling]) => {
      sibling!.requesterSettleWake!.batchRunIds = [sibling!.runId];
    });

    let admission: ReturnType<typeof consume>;
    await dispatch(
      [batch[1]!],
      async () => {
        admission = consume([batch[1]!], "sibling-turn");
        const scope = createCronCreatorAuthorityCapability(
          "sibling-turn",
          { kind: "unknown" },
          admission!.managementEntitlement,
          admission!.isCurrent,
        )!;
        admission!.bindRunScope(scope);
        await runWithCronCreatorAuthorityCapability(scope, async () => {
          // The waiting child is cancelled while the sibling's admitted turn runs.
          await updateBatch(batch, ([waiting]) => {
            waiting!.requesterSettleWake = undefined;
          });
          revokeRequesterCronAuthorityBatch([batch[0]!], 1);
          expect(admission!.isCurrent()).toBe(true);
          expect(readOperatorToolGatewayAuthority()?.operatorRunAuthority).toBe(operator);
        });
      },
      "sibling-turn",
    );
    // The retired cohort is released once its last admitted turn ends.
    expect(admission!.isCurrent()).toBe(false);
    await expect(dispatch([batch[1]!], async () => {})).rejects.toThrow(
      "Requester operator authority",
    );
  });

  it.each([
    "complete",
    "source revoked",
    "source revoked during dispatch",
    "session reset",
    "failed persistence",
  ])(
    "holds an operator-only source through yield until %s without granting Cron management",
    async (outcome) => {
      let holds = 1;
      let revoked = false;
      const assertSourceCurrent = () => {
        if (revoked || holds === 0) {
          throw new Error("source retired");
        }
      };
      const source = createAdmittedRunOperatorAuthority({
        profileId: "requester-profile",
        scopes: ["operator.read"],
        assertCurrent: assertSourceCurrent,
        retain: () => {
          assertSourceCurrent();
          holds += 1;
          let released = false;
          return () => {
            if (!released) {
              released = true;
              holds -= 1;
            }
          };
        },
      });
      const batch = createBatch("operator-only");
      if (outcome === "failed persistence") {
        await inAdminRun(
          "operator-only",
          async () => {
            await expect(
              mark(batch, () => {
                throw new Error("persist refused");
              }),
            ).rejects.toThrow("persist refused");
          },
          undefined,
          undefined,
          undefined,
          source,
          false,
        );
        holds -= 1;
        expect(holds).toBe(0);
        expect(() => source.assertCurrent()).toThrow();
        return;
      }
      await inAdminRun(
        "operator-only",
        async () => expect(await mark(batch)).toBe(1),
        undefined,
        undefined,
        undefined,
        source,
        false,
      );
      holds -= 1;
      expect(holds).toBe(1);
      expect(await settle(batch)).toBe(true);
      if (outcome === "source revoked") {
        revoked = true;
      }
      if (outcome === "session reset") {
        fixture.session.lifecycleRevision = "replacement";
      }
      if (outcome === "source revoked during dispatch") {
        queueMicrotask(() => {
          revoked = true;
        });
      }
      const work = vi.fn(async () => {
        expect(() => source.assertCurrent()).not.toThrow();
        expect(consume(batch)).toBeUndefined();
      });
      if (outcome === "complete") {
        await dispatch(batch, work);
        expect(work).toHaveBeenCalledOnce();
        revokeRequesterCronAuthority(SESSION);
      } else {
        await expect(dispatch(batch, work)).rejects.toThrow("no longer current");
        await expect(dispatch(batch, work)).rejects.toThrow("no longer current");
        expect(work).not.toHaveBeenCalled();
      }
      expect(holds).toBe(0);
      expect(() => source.assertCurrent()).toThrow();
    },
  );

  it.each([true, false])(
    "carries only explicitly admitted plugin ownership: %s",
    async (hasOwner) => {
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
      const batch = createBatch("owner-source");
      await inAdminRun(
        "owner-source",
        async () => expect(await mark(batch)).toBe(1),
        undefined,
        entitlement,
        hasOwner ? owner : undefined,
      );
      expect(await settle(batch)).toBe(true);
      let retained: ReturnType<typeof bindRequesterOwnerIdentity>;
      await dispatch(batch, async () => {
        const admission = consume(batch)!;
        expect(admission.requesterOwner).toBe(hasOwner ? owner : undefined);
        await inAdminRun(
          "continuation",
          async () => {
            const identity = {
              runId: "continuation",
              sessionKey: SESSION,
              sessionId: "requester-session",
              agentId: "main",
            };
            expect(
              bindRequesterOwnerIdentity({ ...identity, sessionKey: "agent:main:unrelated" }),
            ).toBeUndefined();
            retained = bindRequesterOwnerIdentity(identity);
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
          admission.isCurrent,
          admission.managementEntitlement,
          admission.requesterOwner,
        );
      });
      if (hasOwner) {
        expect(retained?.isCurrent()).toBe(false);
        expect(() => retained?.assertCurrent()).toThrow("owner identity");
      }
    },
  );

  it.each([
    ["channel-owner", "before dispatch"],
    ["channel-owner", "after second yield"],
    ["control-ui-admin", "after second yield"],
  ] as const)("retains %s authority %s without retaining a closed run", async (source, when) => {
    let owner = true;
    const entitlement =
      source === "channel-owner" ? { source, isCurrent: () => owner } : { source };
    const first = createBatch("owner-original");
    await inAdminRun(
      "owner-original",
      async () => expect(await mark(first)).toBe(1),
      undefined,
      entitlement,
    );
    expect(await settle(first)).toBe(true);
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
      expect(admission?.managementEntitlement.source).toBe(source);
      expect(admission?.callerOrigin).toEqual({ kind: "unknown" });
      expect(admission?.isCurrent()).toBe(true);
      next = createBatch("continuation");
      await inAdminRun(
        "continuation",
        async () => expect(await mark(next)).toBe(1),
        admission!.isCurrent,
        admission!.managementEntitlement,
      );
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

  it("transfers cleanup to the exact successor scope without losing session revocation", async () => {
    const batch = await capture();
    await dispatch(batch, async () => {
      const admission = consume(batch)!;
      const scope = createCronCreatorAuthorityCapability(
        "continuation",
        { kind: "unknown" },
        admission.managementEntitlement,
        admission.isCurrent,
      )!;
      admission.bindRunScope(scope);
      expect(() => admission.bindRunScope(scope)).toThrow("no longer owns");
      await runWithCronCreatorAuthorityCapability(scope, async () => {
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
      expect(admission.isCurrent()).toBe(false);
    });
  });

  it.each([false, true])(
    "binds explicit yield outside its creation context while rejecting a replaced run: %s",
    async (replaced) => {
      const outside = new AsyncResource("requester-yield-callback");
      const batch = createBatch("original");
      fixture.markRequesterTurnYielded.mockImplementation(() => mark(batch));
      try {
        await inAdminRun("original", async () => {
          const caller = getGatewayToolCallerIdentity()!;
          const claimYield = createRequesterYieldCallback({
            requesterSessionKey: SESSION,
            requesterAgentId: "main",
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
    [
      "reset",
      () => {
        fixture.session.lifecycleRevision = "reset";
      },
    ],
    [
      "archive",
      () => {
        fixture.session.archivedAt = 3;
      },
    ],
    [
      "Gateway replacement",
      () => {
        rotateAgentRunRegistryLifecycleGeneration();
      },
    ],
    [
      "cancel",
      (batch: SubagentRunRecord[]) =>
        updateBatch(batch, ([entry]) => {
          entry!.killIntent = { requestedAt: 3, reason: "stop", suppressTaskDelivery: true };
        }),
    ],
    [
      "batch replacement",
      (batch: SubagentRunRecord[]) => {
        runs.set(batch[0]!.runId, structuredClone(batch[0]!));
      },
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

  it.each([true, false])(
    "preserves a committed child replacement only for continued work: %s",
    async (preserve) => {
      const batch = await capture();
      const previous = batch[0]!;
      const next = structuredClone(previous);
      next.runId = "child-successor";
      next.taskRunId = previous.runId;
      next.requesterSettleWake!.batchRunIds = [next.runId];
      const replacement = [next];
      await mutateSubagentRuns(
        [previous.runId, next.runId],
        () => ({
          value: undefined,
          postimages: new Map<string, SubagentRunRecord | null>([
            [previous.runId, null],
            [next.runId, next],
          ]),
        }),
        {
          runs,
          onPublished(postimages) {
            replacement[0] = expectDefined(
              postimages.get(next.runId),
              "acknowledged replacement child",
            );
          },
        },
      );
      replaceRequesterCronAuthorityEntry({ previous, next: replacement[0]!, preserve });
      await dispatch(replacement, async () => {
        expect(Boolean(consume(replacement))).toBe(preserve);
      });
    },
  );

  it.each(["returned", "thrown"] as const)(
    "can retry a %s unadmitted failure without replaying admitted authority",
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
  it("retains an unsettled admitted-wave receipt after all scoped turns end", async () => {
    const batch = createBatch("unsettled-wave-member");
    const cohort = {
      batch,
      runs: new Map(batch.map((entry) => [entry.runId, entry])),
      scopedTurns: 0,
      operatorAuthority: {},
      admittedWaves: new Map([["accepted-wave", { batch }]]),
    };
    const discard = vi.fn();
    const bindings = new WeakMap<object, unknown>();
    retireRequesterAuthorityCohort(cohort, bindings, () => true, discard);
    expect(discard).not.toHaveBeenCalled();
    expect(cohort).toHaveProperty("retired", true);
    settleRequesterAuthorityWave(cohort, batch);
    retireRequesterAuthorityCohort(cohort, bindings, () => true, discard);
    expect(discard).toHaveBeenCalledOnce();
  });

  it("revokes a retired cohort immediately even with unsettled admitted receipts", () => {
    const batch = createBatch("revoked-unsettled-wave");
    const cohort = {
      batch,
      runs: new Map(batch.map((entry) => [entry.runId, entry])),
      retired: true as const,
      scopedTurns: 1,
      operatorAuthority: {},
      admittedWaves: new Map([["accepted-wave", { batch }]]),
    };
    const discard = vi.fn();
    retireRequesterAuthorityCohort(cohort, new WeakMap(), () => false, discard);
    expect(discard).toHaveBeenCalledOnce();
  });
});
