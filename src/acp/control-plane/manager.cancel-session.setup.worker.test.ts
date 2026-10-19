import { createIdentityFromStatus } from "@openclaw/acp-core/runtime/session-identity";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { prepareOperatorModelPolicy } from "../../agents/operator-model-policy.js";
import { readAcpSessionEntryAsync } from "../runtime/session-meta.js";
import {
  readDurableAcpSignals,
  withAcpCancellationFixture,
} from "./manager.cancel-session.worker.test-support.js";
import {
  expectSuccessor,
  locatorSessionKey,
  expectNoRuntimeEffects,
  memoryGuard,
  replaceRuntime,
  runtimeHandle,
  startTurn,
} from "./manager.cancellation-locator.test-support.js";
import { stopAcpControllerTurns } from "./manager.controller-test-support.js";
import { DEFAULT_DEPS } from "./manager.types.js";

it("preserves replacement metadata when a cancelled late handle fails its applied-model policy", async () => {
  await withAcpCancellationFixture(async (f) => {
    await replaceRuntime(f, {
      runtimeSessionName: "retained-runtime",
      runtimeOptions: { model: "fixture/allowed" },
    });
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "fixture-operator",
      scopes: ["operator.write"],
      assertCurrent: () => {},
      modelPolicy: prepareOperatorModelPolicy({
        cfg: f.target.cfg,
        policy: { allow: ["fixture/allowed"] },
        manifestPlugins: [],
      }),
    });
    const admission = prepareSystemAgentRunAdmission(
      f.target.cfg,
      "policy-locator",
      "main",
      "test",
      undefined,
      authority,
    );
    const ensureEntered = createDeferred();
    const releaseEnsure = createDeferred();
    const stopAdmitted = createDeferred();
    const publicationReadEntered = createDeferred();
    const releasePublicationRead = createDeferred();
    let ensureReturned = false;
    let controlPrepared = false;
    let gated = false;
    f.ensureSession.mockImplementationOnce(async () => {
      ensureEntered.resolve();
      await releaseEnsure.promise;
      ensureReturned = true;
      return {
        sessionKey: f.target.sessionKey,
        backend: "cancellation-proof",
        runtimeSessionName: "retained-runtime",
        appliedModel: { kind: "applied", model: "fixture/denied" },
      };
    });
    f.getStatus.mockResolvedValue({ agentSessionId: "old-runtime-observation" });
    const prepare = DEFAULT_DEPS.prepareSessionControlRead;
    const reader = vi
      .spyOn(DEFAULT_DEPS, "prepareSessionControlRead")
      .mockImplementationOnce(async (params) => {
        const read = await prepare(params);
        controlPrepared = true;
        return {
          ...read,
          readCurrent: async (cfg: typeof f.target.cfg) => {
            if (ensureReturned && !gated) {
              gated = true;
              publicationReadEntered.resolve();
              await releasePublicationRead.promise;
            }
            return read.readCurrent(cfg);
          },
        };
      });
    const close = vi.spyOn(f.runtime, "close");
    let turnResult: Promise<PromiseSettledResult<void>[]> | undefined;
    let cancelResult: Promise<PromiseSettledResult<void>[]> | undefined;
    try {
      const context = await admission.admit("acp");
      const turn = startTurn(f, "policy-locator", {
        admittedRunContext: context,
        text: "late policy locator",
      });
      turnResult = Promise.allSettled([turn]);
      await awaitGateBeforeSettlement(
        ensureEntered.promise,
        turnResult,
        "Policy turn settled before backend ensure.",
      );
      const cancellation = stopAcpControllerTurns({
        ...f.target,
        assertActive: () => {
          if (controlPrepared) {
            stopAdmitted.resolve();
          }
        },
      });
      cancelResult = Promise.allSettled([cancellation]);
      await awaitGateBeforeSettlement(
        stopAdmitted.promise,
        cancelResult,
        "Stop settled before accepting late-handle cleanup.",
      );
      releaseEnsure.resolve();
      await awaitGateBeforeSettlement(
        publicationReadEntered.promise,
        turnResult,
        "Policy failure did not reach terminal publication validation.",
      );
      expect(f.runTurn).not.toHaveBeenCalled();
      const successorIdentity = createIdentityFromStatus({
        status: { agentSessionId: "successor-agent" },
        now: 200,
      });
      await replaceRuntime(f, { identity: successorIdentity });
      releasePublicationRead.resolve();
      await Promise.all([turnResult, cancelResult]);
      expect(await turnResult).toMatchObject([{ status: "rejected" }]);
      await expectSuccessor(f, { identity: successorIdentity });
      expect(readDurableAcpSignals(f, "policy-locator")).toEqual([]);
      expectNoRuntimeEffects(f, close);
    } finally {
      releaseEnsure.resolve();
      releasePublicationRead.resolve();
      await Promise.allSettled([turnResult, cancelResult]);
      reader.mockRestore();
      close.mockRestore();
      admission.close();
    }
  });
});

it("preserves a durable replacement while cold cancellation ensure normalizes its handle", async () => {
  await withAcpCancellationFixture(
    async (f) => {
      const entered = createDeferred();
      const release = createDeferred();
      f.ensureSession.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return runtimeHandle(f, "normalized-runtime");
      });
      const close = vi.spyOn(f.runtime, "close");
      const cancellation = f.manager.cancelSession({
        ...f.target,
        reason: "cold-ensure-replacement",
      });
      const result = Promise.allSettled([cancellation]);
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          result,
          "Cold cancellation settled before runtime ensure.",
        );
        await replaceRuntime(f);
        release.resolve();
        const outcomes = await result;
        await expectSuccessor(f);
        expect(outcomes).toMatchObject([{ status: "rejected" }]);
        expect(f.ensureSession).toHaveBeenCalledOnce();
        expect(f.cancel).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await result;
        close.mockRestore();
      }
    },
    {
      sessionKey: "agent:main:acp:cold-locator",
    },
  );
});

it.each([
  ["durable", "ensure"],
  ["durable", "metadata-write"],
  ["incognito", "metadata-write"],
] as const)(
  "joins %s cancelled setup at %s without publishing normalization over a replacement",
  async (sourceKind, boundary) => {
    await withAcpCancellationFixture(
      async (f) => {
        const assertMemoryCurrent = memoryGuard(f, sourceKind);
        const reached = createDeferred();
        const release = createDeferred();
        const admitted = createDeferred();
        f.ensureSession.mockImplementationOnce(async () => {
          if (boundary === "ensure") {
            reached.resolve();
            await release.promise;
          }
          return runtimeHandle(f, "normalized-runtime");
        });
        const upsert = DEFAULT_DEPS.upsertSessionMeta;
        const writer =
          boundary === "ensure"
            ? undefined
            : vi.spyOn(DEFAULT_DEPS, "upsertSessionMeta").mockImplementationOnce(async (params) => {
                reached.resolve();
                await release.promise;
                return upsert(params);
              });
        const prepare = DEFAULT_DEPS.prepareSessionControlRead;
        let controlPrepared = false;
        const reader = vi
          .spyOn(DEFAULT_DEPS, "prepareSessionControlRead")
          .mockImplementationOnce(async (params) => {
            const read = await prepare(params);
            controlPrepared = true;
            return read;
          });
        const close = vi.spyOn(f.runtime, "close");
        let turnSettled = false;
        let cancelSettled = false;
        const turn = startTurn(f, "delayed-normalization", {
          text: "delayed normalization",
        });
        const turnResult = Promise.allSettled([turn]).then((result) => {
          turnSettled = true;
          return result;
        });
        let cancelResult: Promise<PromiseSettledResult<void>[]> | undefined;
        try {
          await awaitGateBeforeSettlement(
            reached.promise,
            turnResult,
            "Normalization settled before its write gate.",
          );
          expect((await readAcpSessionEntryAsync(f.target))?.acp?.runtimeSessionName).toBe(
            "retained-runtime",
          );
          expect(f.runTurn).not.toHaveBeenCalled();
          const cancellation = stopAcpControllerTurns({
            ...f.target,
            assertActive: () => {
              if (controlPrepared) {
                admitted.resolve();
              }
            },
          });
          cancelResult = Promise.allSettled([cancellation]).then((result) => {
            cancelSettled = true;
            return result;
          });
          await awaitGateBeforeSettlement(
            admitted.promise,
            cancelResult,
            "Stop settled before delayed-write cancellation admission.",
          );
          await replaceRuntime(f);
          expect([turnSettled, cancelSettled]).toEqual([false, false]);
          release.resolve();
          await Promise.all([turnResult, cancelResult]);
          expect([turnSettled, cancelSettled]).toEqual([true, true]);
          await expectSuccessor(f);
          expect(readDurableAcpSignals(f, "delayed-normalization")).toEqual([]);
          expectNoRuntimeEffects(f, close);
          assertMemoryCurrent();
        } finally {
          release.resolve();
          await Promise.allSettled([turnResult, cancelResult]);
          reader.mockRestore();
          writer?.mockRestore();
          close.mockRestore();
        }
      },
      {
        sessionKey: locatorSessionKey(sourceKind, "delayed-normalization"),
      },
    );
  },
);
