import { expect, it, vi } from "vitest";
import { readAcpSessionEntryAsync } from "../runtime/session-meta.js";
import {
  readDurableAcpSignals,
  withAcpCancellationFixture,
} from "./manager.cancel-session.worker.test-support.js";
import {
  cancelSession,
  createGate,
  expectSuccessor,
  holdMetadataWrite,
  locatorSessionKey,
  memoryGuard,
  observeControlRead,
  replaceRuntime,
  runtimeHandle,
  startTurn,
} from "./manager.cancellation-locator.test-support.js";
import { stopAcpControllerTurns } from "./manager.controller-test-support.js";

it.each([
  ["durable", "cached-status"],
  ["durable", "cancel-rpc"],
  ["incognito", "metadata-write"],
] as const)(
  "preserves a %s same-entry runtime replacement while %s is pending and permits retry",
  async (sourceKind, boundary) => {
    await withAcpCancellationFixture(
      async (f) => {
        const assertMemoryCurrent = memoryGuard(f, sourceKind);
        // Prime the real cache so ensure cannot publish a new handle over the replacement.
        await f.manager.getSessionStatus(f.target);
        expect(f.ensureSession).toHaveBeenCalledOnce();
        const runtimeGate = createGate("runtimeGate settled before its controlled boundary");
        if (boundary === "cached-status") {
          f.getStatus.mockImplementationOnce(async () => {
            await runtimeGate.wait();
            return { summary: "ready" };
          });
        } else if (boundary === "cancel-rpc") {
          f.cancel.mockImplementationOnce(async () => {
            await runtimeGate.wait();
          });
        }
        const writer = boundary === "metadata-write" ? holdMetadataWrite(runtimeGate) : undefined;
        const close = vi.spyOn(f.runtime, "close");
        const cancellation = cancelSession(f, "locator-replacement");
        const result = Promise.allSettled([cancellation]);
        try {
          const initialCancelCalls = boundary === "cached-status" ? 0 : 1;
          await runtimeGate.reached(result);
          expect(f.cancel).toHaveBeenCalledTimes(initialCancelCalls);
          await replaceRuntime(f);
          runtimeGate.open();
          const outcomes = await result;
          const current = await readAcpSessionEntryAsync(f.target);
          expect(current?.acp).toMatchObject({
            backend: "cancellation-proof",
            runtimeSessionName: "successor-runtime",
            mode: "persistent",
            state: "running",
          });
          expect(current?.entry).toMatchObject({
            sessionId: "cancellation-session",
            lifecycleRevision: "cancellation-lifecycle",
            spawnedBy: "agent:main:main",
          });
          expect(outcomes).toMatchObject([{ status: "rejected" }]);
          expect(f.cancel).toHaveBeenCalledTimes(initialCancelCalls);
          if (initialCancelCalls === 1) {
            expect(f.cancel).toHaveBeenCalledExactlyOnceWith({
              handle: expect.objectContaining({ runtimeSessionName: "retained-runtime" }),
              reason: "locator-replacement",
            });
          }
          expect(f.ensureSession).toHaveBeenCalledOnce();
          expect(close).not.toHaveBeenCalled();
          assertMemoryCurrent();

          f.ensureSession.mockImplementationOnce(async () => runtimeHandle(f, "successor-runtime"));
          await cancelSession(f, "successor-retry");
          expect(f.ensureSession).toHaveBeenCalledTimes(2);
          expect(f.cancel).toHaveBeenCalledTimes(initialCancelCalls + 1);
          expect(f.cancel).toHaveBeenLastCalledWith({
            handle: expect.objectContaining({ runtimeSessionName: "successor-runtime" }),
            reason: "successor-retry",
          });
          expect((await readAcpSessionEntryAsync(f.target))?.acp).toMatchObject({
            runtimeSessionName: "successor-runtime",
            state: "idle",
          });
          expect(close).not.toHaveBeenCalled();
          assertMemoryCurrent();
        } finally {
          runtimeGate.open();
          await result;
          writer?.mockRestore();
          // Fixture disposal owns its ordinary close after the cancellation assertions.
          close.mockRestore();
        }
      },
      {
        sessionKey: locatorSessionKey(sourceKind, "locator-retry"),
      },
    );
  },
);

it.each([
  ["incognito", "named-backend"],
  ["durable", "empty-backend"],
] as const)(
  "cancels the normalized %s handle from %s and persists its idle state",
  async (sourceKind, returnedBackend) => {
    await withAcpCancellationFixture(
      async (f) => {
        const assertMemoryCurrent = memoryGuard(f, sourceKind);
        f.ensureSession.mockImplementationOnce(async () => ({
          sessionKey: f.target.sessionKey,
          backend: returnedBackend === "empty-backend" ? "" : "cancellation-proof",
          runtimeSessionName: "normalized-runtime",
        }));
        const close = vi.spyOn(f.runtime, "close");
        try {
          await cancelSession(f, "normalized-cancel");
          expect(f.cancel).toHaveBeenCalledExactlyOnceWith({
            handle: expect.objectContaining({
              backend: "cancellation-proof",
              runtimeSessionName: "normalized-runtime",
            }),
            reason: "normalized-cancel",
          });
          expect((await readAcpSessionEntryAsync(f.target))?.acp).toMatchObject({
            backend: "cancellation-proof",
            runtimeSessionName: "normalized-runtime",
            mode: "persistent",
            state: "idle",
          });
          expect(close).not.toHaveBeenCalled();
          assertMemoryCurrent();
        } finally {
          close.mockRestore();
        }
      },
      {
        sessionKey: locatorSessionKey(sourceKind, "locator-normalization"),
      },
    );
  },
);

it.each([
  ["incognito", "post-abort-read", "cancelled"],
  ["durable", "cancel-rpc", "completed"],
] as const)(
  "settles %s active cancellation held at %s with a %s producer without publishing over its replacement",
  async (sourceKind, boundary, terminalStatus) => {
    await withAcpCancellationFixture(
      async (f) => {
        const assertMemoryCurrent = memoryGuard(f, sourceKind);
        const turnGate = createGate("turnGate settled before its controlled boundary");
        const readGate = createGate("readGate settled before its controlled boundary");
        const cancelGate = createGate("cancelGate settled before its controlled boundary");
        let signal: AbortSignal | undefined;
        f.runTurn.mockImplementationOnce(async function* (input) {
          signal = input.signal;
          // The producer reports its own outcome independently of cancellation RPC settlement.
          await turnGate.wait();
          yield { type: "done", status: terminalStatus };
        });
        f.cancel.mockImplementationOnce(async () => {
          await cancelGate.wait();
        });
        const reader = observeControlRead(undefined, {
          when: () => boundary === "post-abort-read" && Boolean(signal?.aborted),
          wait: readGate.wait,
        });
        const close = vi.spyOn(f.runtime, "close");
        const events: unknown[] = [];
        let turnSettled = false;
        let cancelSettled = false;
        const turn = startTurn(f, "active-locator", {
          text: "active locator",
          onEvent: (event) => {
            events.push(event);
          },
        });
        const turnResult = Promise.allSettled([turn]).then((result) => {
          turnSettled = true;
          return result;
        });
        let cancelResult: Promise<PromiseSettledResult<void>[]> | undefined;
        try {
          await turnGate.reached(turnResult);
          const cancellation = stopAcpControllerTurns({
            ...f.target,
            reason: "active-locator-replacement",
          });
          cancelResult = Promise.allSettled([cancellation]).then((result) => {
            cancelSettled = true;
            return result;
          });
          await (boundary === "post-abort-read" ? readGate : cancelGate).reached(cancelResult);
          expect(signal?.aborted).toBe(true);
          expect(f.cancel).toHaveBeenCalledTimes(boundary === "post-abort-read" ? 0 : 1);
          await replaceRuntime(f);
          readGate.open();
          turnGate.open();
          if (boundary === "cancel-rpc") {
            await new Promise<void>((resolve) => {
              setImmediate(resolve);
            });
            expect([turnSettled, cancelSettled]).toEqual([false, false]);
          }
          expect(close).not.toHaveBeenCalled();
          cancelGate.open();
          await Promise.all([turnResult, cancelResult]);
          expect([turnSettled, cancelSettled]).toEqual([true, true]);
          await expectSuccessor(f, { mode: "persistent" });
          expect(readDurableAcpSignals(f, "active-locator")).toEqual([]);
          expect(events).toContainEqual({ type: "done", status: terminalStatus });
          if (boundary === "cancel-rpc") {
            expect(f.cancel).toHaveBeenCalledExactlyOnceWith({
              handle: expect.objectContaining({ runtimeSessionName: "retained-runtime" }),
              reason: "active-locator-replacement",
            });
          } else {
            expect(f.cancel).not.toHaveBeenCalled();
          }
          expect(close).not.toHaveBeenCalled();
          assertMemoryCurrent();
        } finally {
          readGate.open();
          turnGate.open();
          cancelGate.open();
          await Promise.allSettled([turnResult, cancelResult]);
          reader.mockRestore();
          close.mockRestore();
        }
      },
      {
        sessionKey: locatorSessionKey(sourceKind, "active-locator"),
      },
    );
  },
);
