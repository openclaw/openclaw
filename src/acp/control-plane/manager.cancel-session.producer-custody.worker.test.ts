import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { resolveSessionStorePathForAcp } from "../runtime/session-meta-store.js";
import { withAcpCancellationFixture } from "./manager.cancel-session.worker.test-support.js";
import { DEFAULT_DEPS } from "./manager.types.js";

it.for(["delivered", "failed"] as const)(
  "joins %s terminal delivery when cancelling a nested ACP instance without cancelling its parent or same-ID successor",
  async (terminalDelivery, { signal }) => {
    await withAcpCancellationFixture(async (f) => {
      const entered = createDeferred();
      const cancelEntered = createDeferred();
      const releaseCancel = createDeferred();
      const releaseFirst = createDeferred();
      const successorEntered = createDeferred();
      const releaseSuccessor = createDeferred();
      const firstContext = createTestAdmittedRunContext("same-id");
      const successorContext = createTestAdmittedRunContext("same-id");
      let firstSignal: AbortSignal | undefined;
      let successorSignal: AbortSignal | undefined;
      f.runTurn.mockImplementation(async function* (input) {
        if (input.text === "first") {
          firstSignal = input.signal;
          entered.resolve();
          await Promise.race([
            new Promise<void>((resolve) => {
              input.signal?.addEventListener("abort", () => resolve(), { once: true });
            }),
            releaseFirst.promise,
          ]);
          yield { type: "done", stopReason: "cancel" };
        } else {
          successorSignal = input.signal;
          successorEntered.resolve();
          await releaseSuccessor.promise;
          yield { type: "done" };
        }
      });
      f.cancel.mockImplementation(async () => {
        cancelEntered.resolve();
        await releaseCancel.promise;
      });
      const { storePath } = resolveSessionStorePathForAcp(f.target);
      await withSessionTurn(
        { ...f.target, storePath, sessionId: "cancellation-session" },
        async (parent, parentSignal) => {
          expect(parent).toBeDefined();
          const first = f.manager.runTurn({
            ...f.target,
            admittedRunContext: firstContext,
            provenance: "system",
            requestId: "same-id",
            mode: "prompt",
            text: "first",
            onEvent: (event) => {
              if (terminalDelivery === "failed" && event.type === "done") {
                throw new Error("Cancelled terminal delivery failed");
              }
            },
          });
          const firstResult = Promise.allSettled([first]);
          let successor: Promise<void> | undefined;
          let cancellation: Promise<void> | undefined;
          try {
            await withinTest(entered.promise, signal);
            successor = f.manager.runTurn({
              ...f.target,
              admittedRunContext: successorContext,
              provenance: "system",
              requestId: "same-id",
              mode: "prompt",
              text: "successor",
            });
            let cancellationSettled = false;
            cancellation = f.manager
              .cancelSession({
                ...f.target,
                expectedRunId: " same-id ",
                expectedInstanceId: ` ${firstContext.operationalRunInstance.instanceId} `,
                expectedOwnerKey: "agent:main:main",
                reason: "cancel exact nested invocation",
              })
              .then(() => {
                cancellationSettled = true;
              });
            await withinTest(
              Promise.race([
                cancelEntered.promise,
                cancellation.then(() => {
                  throw new Error("Cancellation settled before the captured backend cleanup began");
                }),
              ]),
              signal,
            );
            expect(firstSignal?.aborted).toBe(true);
            expect(parentSignal.aborted).toBe(false);
            expect(cancellationSettled).toBe(false);
            expect(f.runTurn.mock.calls.map(([input]) => input.text)).toEqual(["first"]);
            releaseCancel.resolve();
            if (terminalDelivery === "failed") {
              await expect(withinTest(cancellation, signal)).rejects.toThrow(
                "Cancelled terminal delivery failed",
              );
              expect(await firstResult).toMatchObject([
                { status: "rejected", reason: { message: "Cancelled terminal delivery failed" } },
              ]);
            } else {
              await withinTest(cancellation, signal);
              expect(await firstResult).toMatchObject([{ status: "fulfilled" }]);
            }
            await withinTest(successorEntered.promise, signal);
            expect(successorSignal?.aborted).toBe(false);
            expect(parentSignal.aborted).toBe(false);
            releaseSuccessor.resolve();
            await withinTest(successor, signal);
            expect(f.runTurn.mock.calls.map(([input]) => input.text)).toEqual([
              "first",
              "successor",
            ]);
            expect(f.cancel).toHaveBeenCalledOnce();
          } finally {
            releaseFirst.resolve();
            releaseCancel.resolve();
            releaseSuccessor.resolve();
            await Promise.allSettled([firstResult, successor, cancellation]);
          }
        },
      );
    });
  },
);

it("cancels the exact queued ACP instance while its parent, active sibling, and same-ID successor keep running", async ({
  signal,
}) => {
  await withAcpCancellationFixture(async (f) => {
    const blockerEntered = createDeferred();
    const releaseBlocker = createDeferred();
    const queuedContext = createTestAdmittedRunContext("queued-id");
    const successorContext = createTestAdmittedRunContext("queued-id");
    f.runTurn.mockImplementation(async function* (input) {
      if (input.text === "blocker") {
        blockerEntered.resolve();
        await releaseBlocker.promise;
      }
      yield { type: "done" };
    });
    const { storePath } = resolveSessionStorePathForAcp(f.target);
    await withSessionTurn(
      { ...f.target, storePath, sessionId: "cancellation-session" },
      async (_parent, parentSignal) => {
        const blocker = f.manager.runTurn({
          ...f.target,
          admittedRunContext: createTestAdmittedRunContext("blocker"),
          provenance: "system",
          requestId: "blocker",
          mode: "prompt",
          text: "blocker",
        });
        const blockerResult = Promise.allSettled([blocker]);
        let queued: Promise<void> | undefined;
        let successor: Promise<void> | undefined;
        try {
          await withinTest(blockerEntered.promise, signal);
          queued = f.manager.runTurn({
            ...f.target,
            admittedRunContext: queuedContext,
            provenance: "system",
            requestId: "queued-id",
            mode: "prompt",
            text: "cancelled queued invocation",
          });
          successor = f.manager.runTurn({
            ...f.target,
            admittedRunContext: successorContext,
            provenance: "system",
            requestId: "queued-id",
            mode: "prompt",
            text: "same-ID successor",
          });
          await withinTest(
            f.manager.cancelSession({
              ...f.target,
              expectedRunId: "queued-id",
              expectedInstanceId: queuedContext.operationalRunInstance.instanceId,
              expectedOwnerKey: "agent:main:main",
            }),
            signal,
          );
          expect(parentSignal.aborted).toBe(false);
          expect(f.runTurn.mock.calls.map(([input]) => input.text)).toEqual(["blocker"]);
          expect(f.cancel).not.toHaveBeenCalled();
          releaseBlocker.resolve();
          await withinTest(Promise.allSettled([blocker, queued, successor]), signal);
          expect(f.runTurn.mock.calls.map(([input]) => input.text)).toEqual([
            "blocker",
            "same-ID successor",
          ]);
          expect(parentSignal.aborted).toBe(false);
        } finally {
          releaseBlocker.resolve();
          await Promise.allSettled([blockerResult, queued, successor]);
        }
      },
    );
  });
});

it("keeps filtered preparation cancellation pending until that producer cleans up", async ({
  signal,
}) => {
  await withAcpCancellationFixture(async (f) => {
    const preparing = createDeferred();
    const releasePreparation = createDeferred();
    const context = createTestAdmittedRunContext("preparing-id");
    const ensureSession = f.ensureSession.getMockImplementation()!;
    f.ensureSession.mockImplementationOnce(async (input) => {
      preparing.resolve();
      await releasePreparation.promise;
      return await ensureSession(input);
    });
    const turn = f.manager.runTurn({
      ...f.target,
      admittedRunContext: context,
      provenance: "system",
      requestId: "preparing-id",
      mode: "prompt",
      text: "must not reach model",
    });
    const turnResult = Promise.allSettled([turn]);
    let cancellation: Promise<void> | undefined;
    try {
      await withinTest(preparing.promise, signal);
      await expect(
        f.manager.cancelSession({
          ...f.target,
          expectedInstanceId: "unrelated-instance",
          expectedOwnerKey: "agent:main:main",
        }),
      ).rejects.toMatchObject({ code: "ACP_TURN_FAILED" });
      let settled = false;
      cancellation = f.manager
        .cancelSession({
          ...f.target,
          expectedRunId: "preparing-id",
          expectedInstanceId: context.operationalRunInstance.instanceId,
          expectedOwnerKey: "agent:main:main",
        })
        .then(() => {
          settled = true;
        });
      // The held backend preparation is observable producer work, not a cancellation receipt.
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(f.runTurn).not.toHaveBeenCalled();
      releasePreparation.resolve();
      await withinTest(cancellation, signal);
      await turnResult;
      expect(f.runTurn).not.toHaveBeenCalled();
    } finally {
      releasePreparation.resolve();
      await Promise.allSettled([turnResult, cancellation]);
    }
  });
});

it("rejects a different owner without aborting the selected live ACP invocation", async ({
  signal,
}) => {
  await withAcpCancellationFixture(async (f) => {
    const entered = createDeferred();
    const release = createDeferred();
    const context = createTestAdmittedRunContext("owned-id");
    let runSignal: AbortSignal | undefined;
    f.runTurn.mockImplementationOnce(async function* (input) {
      runSignal = input.signal;
      entered.resolve();
      await release.promise;
      yield { type: "done" };
    });
    const turn = f.manager.runTurn({
      ...f.target,
      admittedRunContext: context,
      provenance: "system",
      requestId: "owned-id",
      mode: "prompt",
      text: "owned invocation",
    });
    const result = Promise.allSettled([turn]);
    try {
      await withinTest(entered.promise, signal);
      await expect(
        f.manager.cancelSession({
          ...f.target,
          expectedRunId: "owned-id",
          expectedInstanceId: context.operationalRunInstance.instanceId,
          expectedOwnerKey: "agent:other:parent",
        }),
      ).rejects.toMatchObject({ code: "ACP_TURN_FAILED" });
      expect(runSignal?.aborted).toBe(false);
      expect(f.cancel).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await result;
    }
  });
});

it.for(["before-effect", "after-effect"] as const)(
  "honors caller revocation %s without replaying a captured cancellation",
  async (timing, { signal }) => {
    await withAcpCancellationFixture(async (f) => {
      const entered = createDeferred();
      const guardEntered = createDeferred();
      const releaseGuard = createDeferred();
      const cancelEntered = createDeferred();
      const releaseCancel = createDeferred();
      const releaseRun = createDeferred();
      const context = createTestAdmittedRunContext("revocation-id");
      let callerCurrent = true;
      let invocationSignal: AbortSignal | undefined;
      f.runTurn.mockImplementationOnce(async function* (input) {
        invocationSignal = input.signal;
        entered.resolve();
        await Promise.race([
          new Promise<void>((resolve) => {
            input.signal?.addEventListener("abort", () => resolve(), { once: true });
          }),
          releaseRun.promise,
        ]);
        yield { type: "done", stopReason: "cancel" };
      });
      f.cancel.mockImplementationOnce(async () => {
        cancelEntered.resolve();
        await releaseCancel.promise;
      });
      const turn = f.manager.runTurn({
        ...f.target,
        admittedRunContext: context,
        provenance: "system",
        requestId: "revocation-id",
        mode: "prompt",
        text: "revocable cancellation",
      });
      const turnResult = Promise.allSettled([turn]);
      await withinTest(entered.promise, signal);
      // Selection is allowed; hold the first current-owner read after this invocation
      // was aborted, while the backend cancellation effect has not started yet.
      const prepareControl = DEFAULT_DEPS.prepareSessionControlRead;
      let guarded = false;
      const intercepted = vi
        .spyOn(DEFAULT_DEPS, "prepareSessionControlRead")
        .mockImplementation(async (params) => {
          const control = await prepareControl(params);
          return {
            ...control,
            readCurrent: async (...args) => {
              const current = await control.readCurrent(...args);
              if (timing === "before-effect" && invocationSignal?.aborted && !guarded) {
                guarded = true;
                guardEntered.resolve();
                await releaseGuard.promise;
              }
              return current;
            },
          };
        });
      const cancellation = f.manager.cancelSession({
        ...f.target,
        expectedRunId: "revocation-id",
        expectedInstanceId: context.operationalRunInstance.instanceId,
        expectedOwnerKey: "agent:main:main",
        assertActive: () => {
          if (!callerCurrent) {
            throw new Error("Cancellation caller was revoked");
          }
        },
      });
      const cancellationResult = Promise.allSettled([cancellation]);
      try {
        await withinTest(
          Promise.race([
            timing === "before-effect" ? guardEntered.promise : cancelEntered.promise,
            cancellation.then(() => {
              throw new Error("Cancellation completed before the authority boundary");
            }),
          ]),
          signal,
        );
        callerCurrent = false;
        releaseGuard.resolve();
        releaseCancel.resolve();
        const result = await withinTest(cancellationResult, signal);
        expect(f.cancel).toHaveBeenCalledTimes(timing === "before-effect" ? 0 : 1);
        expect(result).toMatchObject(
          timing === "before-effect"
            ? [{ status: "rejected", reason: { message: "Cancellation caller was revoked" } }]
            : [{ status: "fulfilled" }],
        );
      } finally {
        releaseRun.resolve();
        releaseGuard.resolve();
        releaseCancel.resolve();
        await Promise.allSettled([turnResult, cancellationResult]);
        intercepted.mockRestore();
      }
    });
  },
);
