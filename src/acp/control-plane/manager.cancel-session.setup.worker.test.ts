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
  cancelSession,
  createGate,
  expectSuccessor,
  locatorSessionKey,
  expectNoRuntimeEffects,
  memoryGuard,
  observeControlRead,
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
    const ensureGate = createGate("ensureGate settled before its controlled boundary");
    const stopAdmitted = createDeferred();
    const publicationGate = createGate("publicationGate settled before its controlled boundary");
    let ensureReturned = false;
    let controlPrepared = false;
    f.ensureSession.mockImplementationOnce(async () => {
      await ensureGate.wait();
      ensureReturned = true;
      return {
        sessionKey: f.target.sessionKey,
        backend: "cancellation-proof",
        runtimeSessionName: "retained-runtime",
        appliedModel: { kind: "applied", model: "fixture/denied" },
      };
    });
    f.getStatus.mockResolvedValue({ agentSessionId: "old-runtime-observation" });
    const reader = observeControlRead(
      () => {
        controlPrepared = true;
      },
      { when: () => ensureReturned, wait: publicationGate.wait },
    );
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
      await ensureGate.reached(turnResult);
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
      ensureGate.open();
      await publicationGate.reached(turnResult);
      expect(f.runTurn).not.toHaveBeenCalled();
      const successorIdentity = createIdentityFromStatus({
        status: { agentSessionId: "successor-agent" },
        now: 200,
      });
      await replaceRuntime(f, { identity: successorIdentity });
      publicationGate.open();
      await Promise.all([turnResult, cancelResult]);
      expect(await turnResult).toMatchObject([{ status: "rejected" }]);
      await expectSuccessor(f, { identity: successorIdentity });
      expect(readDurableAcpSignals(f, "policy-locator")).toEqual([]);
      expectNoRuntimeEffects(f, close);
    } finally {
      ensureGate.open();
      publicationGate.open();
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
      const ensureGate = createGate("ensureGate settled before its controlled boundary");
      f.ensureSession.mockImplementationOnce(async () => {
        await ensureGate.wait();
        return runtimeHandle(f, "normalized-runtime");
      });
      const close = vi.spyOn(f.runtime, "close");
      const cancellation = cancelSession(f, "cold-ensure-replacement");
      const result = Promise.allSettled([cancellation]);
      try {
        await ensureGate.reached(result);
        await replaceRuntime(f);
        ensureGate.open();
        const outcomes = await result;
        await expectSuccessor(f);
        expect(outcomes).toMatchObject([{ status: "rejected" }]);
        expect(f.ensureSession).toHaveBeenCalledOnce();
        expect(f.cancel).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
      } finally {
        ensureGate.open();
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
        const normalizationGate = createGate(
          "normalizationGate settled before its controlled boundary",
        );
        const admitted = createDeferred();
        f.ensureSession.mockImplementationOnce(async () => {
          if (boundary === "ensure") {
            await normalizationGate.wait();
          }
          return runtimeHandle(f, "normalized-runtime");
        });
        const upsert = DEFAULT_DEPS.upsertSessionMeta;
        const writer =
          boundary === "ensure"
            ? undefined
            : vi.spyOn(DEFAULT_DEPS, "upsertSessionMeta").mockImplementationOnce(async (params) => {
                await normalizationGate.wait();
                return upsert(params);
              });
        let controlPrepared = false;
        const reader = observeControlRead(() => {
          controlPrepared = true;
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
          await normalizationGate.reached(turnResult);
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
          normalizationGate.open();
          await Promise.all([turnResult, cancelResult]);
          expect([turnSettled, cancelSettled]).toEqual([true, true]);
          await expectSuccessor(f);
          expect(readDurableAcpSignals(f, "delayed-normalization")).toEqual([]);
          expectNoRuntimeEffects(f, close);
          assertMemoryCurrent();
        } finally {
          normalizationGate.open();
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
