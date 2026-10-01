import { AsyncResource } from "node:async_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { settleRequesterTurnAfterSessionSpawns } from "./registry/subagent-registry-requester-yield.js";
import {
  createRequesterInitialTransferFixture,
  markRequesterTurnYieldedWithAuthority,
} from "./registry/subagent-registry-requester-yield.test-support.js";
import type { SubagentRunRecord } from "./registry/subagent-registry.types.js";
import {
  consumeRequesterCronAuthorityAdmission,
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

async function mark(batch: SubagentRunRecord[], persistOrThrow: () => void = () => {}) {
  return await markRequesterTurnYieldedWithAuthority({
    requesterSessionKey: SESSION,
    requesterAgentId: "main",
    requesterTurnRunId: batch[0]!.requesterTurnRunId!,
    runs,
    transfer: createRequesterInitialTransferFixture(runs, persistOrThrow),
  });
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
    transfer: createRequesterInitialTransferFixture(runs, () => undefined),
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

function consume(batch: SubagentRunRecord[], runId = "continuation") {
  return consumeRequesterCronAuthorityAdmission({
    runId,
    sessionKey: SESSION,
    sessionId: "requester-session",
    inputProvenance: {
      kind: "inter_session",
      sourceTool: "subagent_settle",
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
      const paused = batch[0]!;
      paused.pauseReason = "sessions_yield";
      paused.requesterSettleWake!.pauseNotice = { acknowledgment: "Need a continuation." };
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
              expect(consumeSubagentPauseNotice(paused)).toBe(true);
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
        expect(consumeSubagentPauseNotice(paused)).toBe(true);
        revokeRequesterCronAuthorityBatch([paused], 1);
      }

      const continued = structuredClone(paused);
      continued.runId = "continued-child";
      continued.taskRunId = paused.runId;
      continued.pauseReason = undefined;
      const nextBatch = [continued, batch[1]!];
      const batchRunIds = nextBatch.map((entry) => entry.runId).toSorted();
      for (const entry of nextBatch) {
        entry.requesterSettleWake!.batchRunIds = batchRunIds;
      }
      runs.delete(paused.runId);
      runs.set(continued.runId, continued);
      replaceRequesterCronAuthorityEntry({ previous: paused, next: continued, preserve: true });
      await dispatch(nextBatch, async () => {
        expect(readOperatorToolGatewayAuthority()?.operatorRunAuthority).toBe(operator);
        const completionAdmission = consume(nextBatch)!;
        expect(completionAdmission.managementEntitlement.source).toBe("control-ui-admin");
        expect(completionAdmission.isCurrent()).toBe(true);
        for (const entry of nextBatch) {
          entry.requesterSettleWake = undefined;
        }
        revokeRequesterCronAuthorityBatch(nextBatch, 1);
        expect(completionAdmission.isCurrent()).toBe(false);
      });
    },
  );

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

  it("carries separately admitted owner identity through explicit yield and expires retained bindings", async () => {
    let current = true;
    const owner = {
      isCurrent: () => current,
      senderId: "original-owner",
      channel: "discord",
      accountId: "original-account",
    };
    const entitlement = { source: "channel-owner" as const, isCurrent: owner.isCurrent };
    const batch = createBatch("owner-source");
    await inAdminRun(
      "owner-source",
      async () => expect(await mark(batch)).toBe(1),
      undefined,
      entitlement,
      owner,
    );
    expect(await settle(batch)).toBe(true);
    let retained: ReturnType<typeof bindRequesterOwnerIdentity>;
    await dispatch(batch, async () => {
      const admission = consume(batch)!;
      expect(admission.requesterOwner).toBe(owner);
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
    expect(retained?.isCurrent()).toBe(false);
    expect(() => retained?.assertCurrent()).toThrow("owner identity");
  });

  it("does not turn management-only yield authority into plugin ownership", async () => {
    const batch = await capture();
    await dispatch(batch, async () => {
      const admission = consume(batch)!;
      expect(admission.requesterOwner).toBeUndefined();
      await inAdminRun(
        "continuation",
        async () => {
          expect(
            bindRequesterOwnerIdentity({
              runId: "continuation",
              sessionKey: SESSION,
              sessionId: "requester-session",
              agentId: "main",
            }),
          ).toBeUndefined();
        },
        admission.isCurrent,
        admission.managementEntitlement,
      );
    });
  });

  it.each(["before dispatch", "after admission", "after second yield"])(
    "rechecks original channel ownership %s without retaining a closed run",
    async (when) => {
      let owner = true;
      const entitlement = { source: "channel-owner" as const, isCurrent: () => owner };
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
      await dispatch(first, async () => {
        const admission = consume(first);
        if (when === "before dispatch") {
          expect(admission).toBeUndefined();
          return;
        }
        expect(admission?.managementEntitlement.source).toBe("channel-owner");
        expect(admission?.callerOrigin).toEqual({ kind: "unknown" });
        expect(admission?.isCurrent()).toBe(true);
        if (when === "after admission") {
          owner = false;
          expect(admission?.isCurrent()).toBe(false);
          return;
        }
        const next = createBatch("continuation");
        await inAdminRun(
          "continuation",
          async () => expect(await mark(next)).toBe(1),
          admission!.isCurrent,
          admission!.managementEntitlement,
        );
        expect(await settle(next)).toBe(true);
        await dispatch(
          next,
          async () => {
            const second = consume(next, "second-continuation");
            expect(second?.isCurrent()).toBe(true);
            owner = false;
            expect(second?.isCurrent()).toBe(false);
          },
          "second-continuation",
        );
      });
    },
  );

  it("does not admit an arbitrary child message from the expected child", async () => {
    const batch = await capture();
    await dispatch(batch, async () => {
      expect(
        consumeRequesterCronAuthorityAdmission({
          runId: "continuation",
          sessionKey: SESSION,
          sessionId: "requester-session",
          inputProvenance: {
            kind: "inter_session",
            sourceTool: "sessions_send",
            sourceSessionKey: batch[0]!.childSessionKey,
          },
        }),
      ).toBeUndefined();
      expect(consume(batch)).toBeDefined();
    });
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
        batch[0]!.requesterSettleWake = undefined;
        runs.clear();
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
    ["fresh user turn", () => revokeRequesterCronAuthority(SESSION)],
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
      (batch: SubagentRunRecord[]) => {
        batch[0]!.killIntent = { requestedAt: 3, reason: "stop", suppressTaskDelivery: true };
      },
    ],
    [
      "batch replacement",
      (batch: SubagentRunRecord[]) => {
        runs.set(batch[0]!.runId, structuredClone(batch[0]!));
      },
    ],
    [
      "new yield generation",
      (batch: SubagentRunRecord[]) => {
        batch[0]!.requesterSettleWake!.rearmGeneration = 2;
      },
    ],
  ] as const)("revokes an admitted continuation after %s", async (_label, invalidate) => {
    const batch = await capture();
    await dispatch(batch, async () => {
      const admission = consume(batch)!;
      expect(admission.isCurrent()).toBe(true);
      await Promise.resolve();
      invalidate(batch);
      expect(admission.isCurrent()).toBe(false);
    });
  });

  it("keeps the parent authorized when only one child is stopped", async () => {
    const batch = await capture("original", 2);
    batch[0]!.killIntent = { requestedAt: 3, reason: "stop" };
    batch[0]!.suppressCompletionDelivery = true;
    await dispatch(batch, async () => expect(consume(batch)?.isCurrent()).toBe(true));
  });

  it("retains an unadmitted handoff after a returned retryable delivery failure", async () => {
    const batch = await capture();
    await dispatch(batch, async () => ({ delivered: false, path: "none" }));
    await dispatch(batch, async () => expect(consume(batch)?.isCurrent()).toBe(true));
  });

  it("does not promote a partial or reconstructed batch", async () => {
    const batch = await capture("original", 2);
    await dispatch(batch.slice(0, 1), async () => expect(consume(batch)).toBeUndefined());
    await dispatch(structuredClone(batch), async () => expect(consume(batch)).toBeUndefined());
    await dispatch(batch, async () => expect(consume(batch)).toBeDefined());
  });

  it("preserves the next yielded batch when the preceding delivery completes", async () => {
    const first = await capture();
    let next: SubagentRunRecord[] = [];
    await dispatch(first, async () => {
      const admission = consume(first)!;
      next = createBatch(admission.runId);
      await inAdminRun(
        admission.runId,
        async () => expect(await mark(next)).toBe(1),
        admission.isCurrent,
      );
      expect(await settle(next)).toBe(true);
    });
    await dispatch(
      next,
      async () => {
        const admission = consume(next, "second-continuation")!;
        expect(admission.callerOrigin).toEqual({ kind: "unknown" });
        expect(admission.isCurrent()).toBe(true);
      },
      "second-continuation",
    );
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
      runs.delete(previous.runId);
      runs.set(next.runId, next);
      replaceRequesterCronAuthorityEntry({ previous, next, preserve });
      await dispatch([next], async () => {
        expect(Boolean(consume([next]))).toBe(preserve);
      });
    },
  );

  it("can retry an unadmitted transport failure without replaying admitted authority", async () => {
    const batch = await capture();
    await expect(
      dispatch(batch, async () => {
        throw new Error("before admission");
      }),
    ).rejects.toThrow("before admission");
    let admitted: ReturnType<typeof consume>;
    await expect(
      dispatch(batch, async () => {
        admitted = consume(batch);
        expect(admitted).toBeDefined();
        expect(consume(batch)).toBeUndefined();
        throw new Error("ambiguous transport");
      }),
    ).rejects.toThrow("ambiguous transport");
    expect(admitted!.isCurrent()).toBe(true);
    await dispatch(batch, async () => expect(consume(batch)).toBeUndefined());
    expect(admitted!.isCurrent()).toBe(true);
    revokeRequesterCronAuthority(SESSION);
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
          revokeRequesterCronAuthority(SESSION);
        };
        if (kind === "failed persistence") {
          await expect(mark(batch, persist)).rejects.toThrow("write failed");
          batch[0]!.requesterTurnYielded = true;
        } else {
          await expect(mark(batch, persist)).rejects.toThrow("Requester authority retired");
          expect(batch[0]!.requesterTurnYielded).toBe(true);
        }
      });
      expect(await settle(batch)).toBe(true);
      await dispatch(batch, async () => expect(consume(batch)).toBeUndefined());
    },
  );
});
