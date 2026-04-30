import { describe, expect, it } from "vitest";
import { abortable } from "./abortable.js";

const gc = (globalThis as { gc?: () => void }).gc;

describe("abortable", () => {
  it("rejects with AbortError when signal aborts before inner settles", async () => {
    const ac = new AbortController();
    const inner = new Promise<void>(() => {});
    const wrapped = abortable(ac.signal, inner);
    ac.abort();
    try {
      await wrapped;
      expect.fail("expected rejection");
    } catch (err) {
      expect((err as Error).name).toBe("AbortError");
    }
  });

  it("rejects immediately when signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const inner = new Promise<void>(() => {});
    await expect(abortable(ac.signal, inner)).rejects.toThrow(/aborted/i);
  });

  it("resolves with inner value when inner settles before abort", async () => {
    const ac = new AbortController();
    await expect(abortable(ac.signal, Promise.resolve(42))).resolves.toBe(42);
  });

  it.skipIf(!gc)(
    "does not pin enclosing caller scope through a never-settling inner promise after abort",
    async () => {
      // Reproduces the runEmbeddedAttempt leak pattern. The production bug
      // had `abortable` defined as an inline closure inside the (large) run
      // scope, so its .then arrows captured the entire scope. When the inner
      // provider promise hung past abort, its handler list kept those arrows
      // -- and the run scope -- alive.
      //
      // CASE A asserts the extracted helper's .then arrows do not capture
      // caller scope. CASE B reproduces the inline pattern as a sensitivity
      // check so this test fails noisily if the harness ever stops detecting
      // retention.

      const keepAlive: Array<Promise<unknown>> = [];

      const extractedRef = (() => {
        const scope = { payload: new Uint8Array(2_000_000) };
        const ref = new WeakRef(scope);
        const ac = new AbortController();
        const inner = new Promise<unknown>(() => {});
        keepAlive.push(inner);
        const wrapped = abortable(ac.signal, inner);
        ac.abort();
        void wrapped.catch(() => {});
        void scope.payload.length;
        return ref;
      })();

      const inlineRef = (() => {
        const scope = { payload: new Uint8Array(2_000_000) };
        const ref = new WeakRef(scope);
        const ac = new AbortController();
        const inner = new Promise<unknown>(() => {});
        keepAlive.push(inner);
        const wrapped = new Promise<unknown>((resolve, reject) => {
          const onAbort = () => reject(new Error("aborted"));
          ac.signal.addEventListener("abort", onAbort, { once: true });
          inner.then(
            (v) => {
              void scope;
              resolve(v);
            },
            (e) => {
              void scope;
              reject(e);
            },
          );
        });
        ac.abort();
        void wrapped.catch(() => {});
        void scope.payload.length;
        return ref;
      })();

      for (let i = 0; i < 5; i++) {
        await new Promise<void>((r) => setImmediate(r));
        gc!();
      }

      expect(extractedRef.deref()).toBeUndefined();
      expect(inlineRef.deref()).toBeDefined();
    },
  );
});
