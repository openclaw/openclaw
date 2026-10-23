import { expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { resolveSessionStorePathForAcp } from "../runtime/session-meta-store.js";
import { withAcpCancellationFixture } from "./manager.cancel-session.worker.test-support.js";
import {
  createGate,
  startTurn,
  untilAborted,
} from "./manager.cancellation-locator.test-support.js";
import { DEFAULT_DEPS } from "./manager.types.js";

type Fixture = Parameters<Parameters<typeof withAcpCancellationFixture>[0]>[0];

function invocation(f: Fixture, requestId: string, text = requestId) {
  const context = createTestAdmittedRunContext(requestId);
  return {
    context,
    start: (onEvent?: NonNullable<Parameters<typeof startTurn>[2]>["onEvent"]) =>
      startTurn(f, requestId, { admittedRunContext: context, text, onEvent }),
    cancel: (overrides: Partial<Parameters<Fixture["manager"]["cancelSession"]>[0]> = {}) =>
      f.manager.cancelSession({
        ...f.target,
        expectedRunId: requestId,
        expectedInstanceId: context.operationalRunInstance.instanceId,
        expectedOwnerKey: "agent:main:main",
        ...overrides,
      }),
  };
}

it.for(["delivered", "failed"] as const)(
  "joins %s terminal delivery when cancelling a nested ACP instance without cancelling its parent or same-ID successor",
  async (terminalDelivery, { signal }) => {
    await withAcpCancellationFixture(async (f) => {
      const firstGate = createGate("First turn ended before entering the runtime");
      const cancelGate = createGate("Cancellation settled before backend cleanup");
      const successorGate = createGate("Successor ended before entering the runtime");
      const terminalError = "Cancelled terminal delivery failed";
      const firstInvocation = invocation(f, "same-id", "first");
      const successorInvocation = invocation(f, "same-id", "successor");
      let firstSignal: AbortSignal | undefined;
      let successorSignal: AbortSignal | undefined;
      f.runTurn.mockImplementation(async function* (input) {
        if (input.text === "first") {
          firstSignal = input.signal;
          await Promise.race([untilAborted(input.signal), firstGate.wait()]);
          yield { type: "done", stopReason: "cancel" };
        } else {
          successorSignal = input.signal;
          await successorGate.wait();
          yield { type: "done" };
        }
      });
      f.cancel.mockImplementation(cancelGate.wait);
      const { storePath } = resolveSessionStorePathForAcp(f.target);
      await withSessionTurn(
        { ...f.target, storePath, sessionId: "cancellation-session" },
        async (parent, parentSignal) => {
          expect(parent).toBeDefined();
          const first = firstInvocation.start((event) => {
            if (terminalDelivery === "failed" && event.type === "done") {
              throw new Error(terminalError);
            }
          });
          const firstResult = Promise.allSettled([first]);
          let successor: Promise<void> | undefined;
          let cancellation: Promise<void> | undefined;
          try {
            await withinTest(firstGate.reached(first), signal);
            successor = successorInvocation.start();
            let cancellationSettled = false;
            cancellation = firstInvocation
              .cancel({
                expectedRunId: " same-id ",
                expectedInstanceId: ` ${firstInvocation.context.operationalRunInstance.instanceId} `,
                reason: "cancel exact nested invocation",
              })
              .then(() => {
                cancellationSettled = true;
              });
            await withinTest(cancelGate.reached(cancellation), signal);
            expect([firstSignal, parentSignal]).toMatchObject([
              { aborted: true },
              { aborted: false },
            ]);
            expect(cancellationSettled).toBe(false);
            expect(f.runTurn.mock.calls.map(([input]) => input.text)).toEqual(["first"]);
            cancelGate.open();
            if (terminalDelivery === "failed") {
              await expect(withinTest(cancellation, signal)).rejects.toThrow(terminalError);
              expect(await firstResult).toMatchObject([
                { status: "rejected", reason: { message: terminalError } },
              ]);
            } else {
              await withinTest(cancellation, signal);
              expect(await firstResult).toMatchObject([{ status: "fulfilled" }]);
            }
            await withinTest(successorGate.reached(successor), signal);
            expect([successorSignal, parentSignal]).toMatchObject([
              { aborted: false },
              { aborted: false },
            ]);
            successorGate.open();
            await withinTest(successor, signal);
            expect(f.runTurn.mock.calls.map(([input]) => input.text)).toEqual([
              "first",
              "successor",
            ]);
            expect(f.cancel).toHaveBeenCalledOnce();
          } finally {
            firstGate.open();
            cancelGate.open();
            successorGate.open();
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
    const blockerGate = createGate("Blocker ended before entering the runtime");
    const queuedInvocation = invocation(f, "queued-id", "cancelled queued invocation");
    const successorInvocation = invocation(f, "queued-id", "same-ID successor");
    f.runTurn.mockImplementation(async function* (input) {
      if (input.text === "blocker") {
        await blockerGate.wait();
      }
      yield { type: "done" };
    });
    const { storePath } = resolveSessionStorePathForAcp(f.target);
    await withSessionTurn(
      { ...f.target, storePath, sessionId: "cancellation-session" },
      async (_parent, parentSignal) => {
        const blocker = startTurn(f, "blocker");
        const blockerResult = Promise.allSettled([blocker]);
        let queued: Promise<void> | undefined;
        let successor: Promise<void> | undefined;
        try {
          await withinTest(blockerGate.reached(blocker), signal);
          queued = queuedInvocation.start();
          successor = successorInvocation.start();
          await withinTest(queuedInvocation.cancel(), signal);
          expect(parentSignal.aborted).toBe(false);
          expect(f.runTurn.mock.calls.map(([input]) => input.text)).toEqual(["blocker"]);
          expect(f.cancel).not.toHaveBeenCalled();
          blockerGate.open();
          await withinTest(Promise.allSettled([blocker, queued, successor]), signal);
          expect(f.runTurn.mock.calls.map(([input]) => input.text)).toEqual([
            "blocker",
            "same-ID successor",
          ]);
          expect(parentSignal.aborted).toBe(false);
        } finally {
          blockerGate.open();
          await Promise.allSettled([blockerResult, queued, successor]);
        }
      },
    );
  });
});

it("joins filtered cancellation to backend preparation cleanup", async ({ signal }) => {
  await withAcpCancellationFixture(async (f) => {
    const preparation = createGate("Turn ended before backend preparation");
    const selected = invocation(f, "preparing-id", "must not reach model");
    const ensureSession = f.ensureSession.getMockImplementation()!;
    f.ensureSession.mockImplementationOnce(async (input) => {
      await preparation.wait();
      return await ensureSession(input);
    });
    const turn = selected.start();
    const turnResult = Promise.allSettled([turn]);
    let cancellation: Promise<void> | undefined;
    try {
      await withinTest(preparation.reached(turn), signal);
      await expect(
        f.manager.cancelSession({
          ...f.target,
          expectedInstanceId: "unrelated-instance",
          expectedOwnerKey: "agent:main:main",
        }),
      ).rejects.toMatchObject({ code: "ACP_TURN_FAILED" });
      let settled = false;
      cancellation = selected.cancel().then(() => {
        settled = true;
      });
      // The held backend preparation is observable producer work, not a cancellation receipt.
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(f.runTurn).not.toHaveBeenCalled();
      preparation.open();
      await withinTest(cancellation, signal);
      await turnResult;
      expect(f.runTurn).not.toHaveBeenCalled();
    } finally {
      preparation.open();
      await Promise.allSettled([turnResult, cancellation]);
    }
  });
});

it("rejects another owner without aborting the live invocation", async ({ signal }) => {
  await withAcpCancellationFixture(async (f) => {
    const runtimeGate = createGate("Owned turn ended before entering the runtime");
    const selected = invocation(f, "owned-id", "owned invocation");
    let runSignal: AbortSignal | undefined;
    f.runTurn.mockImplementationOnce(async function* (input) {
      runSignal = input.signal;
      await runtimeGate.wait();
      yield { type: "done" };
    });
    const turn = selected.start();
    const result = Promise.allSettled([turn]);
    try {
      await withinTest(runtimeGate.reached(turn), signal);
      await expect(
        selected.cancel({ expectedOwnerKey: "agent:other:parent" }),
      ).rejects.toMatchObject({ code: "ACP_TURN_FAILED" });
      expect(runSignal?.aborted).toBe(false);
      expect(f.cancel).not.toHaveBeenCalled();
    } finally {
      runtimeGate.open();
      await result;
    }
  });
});

it.for(["before-effect", "after-effect"] as const)(
  "honors caller revocation %s without replaying a captured cancellation",
  async (timing, { signal }) => {
    await withAcpCancellationFixture(async (f) => {
      const runtimeGate = createGate("Revocable turn ended before entering the runtime");
      const guardGate = createGate("Cancellation completed before the authority boundary");
      const cancelGate = createGate("Cancellation completed before the authority boundary");
      const selected = invocation(f, "revocation-id", "revocable cancellation");
      let callerCurrent = true;
      let invocationSignal: AbortSignal | undefined;
      f.runTurn.mockImplementationOnce(async function* (input) {
        invocationSignal = input.signal;
        await Promise.race([untilAborted(input.signal), runtimeGate.wait()]);
        yield { type: "done", stopReason: "cancel" };
      });
      f.cancel.mockImplementationOnce(cancelGate.wait);
      const turn = selected.start();
      const turnResult = Promise.allSettled([turn]);
      await withinTest(runtimeGate.reached(turn), signal);
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
                await guardGate.wait();
              }
              return current;
            },
          };
        });
      const cancellation = selected.cancel({
        assertActive: () => {
          if (!callerCurrent) {
            throw new Error("Cancellation caller was revoked");
          }
        },
      });
      const cancellationResult = Promise.allSettled([cancellation]);
      try {
        const boundary = timing === "before-effect" ? guardGate : cancelGate;
        await withinTest(boundary.reached(cancellation), signal);
        callerCurrent = false;
        guardGate.open();
        cancelGate.open();
        const result = await withinTest(cancellationResult, signal);
        expect(f.cancel).toHaveBeenCalledTimes(timing === "before-effect" ? 0 : 1);
        expect(result).toMatchObject(
          timing === "before-effect"
            ? [{ status: "rejected", reason: { message: "Cancellation caller was revoked" } }]
            : [{ status: "fulfilled" }],
        );
      } finally {
        runtimeGate.open();
        guardGate.open();
        cancelGate.open();
        await Promise.allSettled([turnResult, cancellationResult]);
        intercepted.mockRestore();
      }
    });
  },
);
