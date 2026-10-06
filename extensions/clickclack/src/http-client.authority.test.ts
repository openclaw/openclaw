import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { expect, it, vi } from "vitest";
import { createClickClackClient } from "./http-client.js";

const effectGate = vi.hoisted((): { prepare: (() => Promise<void>) | undefined } => ({
  prepare: undefined,
}));
vi.mock("openclaw/plugin-sdk/fetch-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/fetch-runtime")>();
  return {
    ...actual,
    captureEffectAuthority: () => {
      const authority = actual.captureEffectAuthority();
      const prepare = effectGate.prepare;
      return prepare
        ? {
            ...authority,
            initiate: async <T>(effect: () => T | Promise<T>) => {
              await prepare();
              return authority.initiate(effect);
            },
          }
        : authority;
    },
  };
});

it.each([false, true])(
  "rechecks the message caller after effect preparation (retired=%s)",
  async (retired) => {
    const preparing = createDeferred();
    const prepared = createDeferred();
    const dispatched = createDeferred();
    const response = createDeferred<Response>();
    const caller = new AbortController();
    const failure = new Error("ClickClack caller retired");
    effectGate.prepare = async () => {
      preparing.resolve();
      await prepared.promise;
    };
    const fetch = vi.fn<typeof globalThis.fetch>(() => {
      dispatched.resolve();
      return response.promise;
    });
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "fake",
      fetch,
      beforeRequest: () => caller.signal.throwIfAborted(),
    });
    const sending = client.createChannelMessage("chn_1", "hello").then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await Promise.race([
        preparing.promise,
        dispatched.promise.then(() => {
          throw new Error("dispatched before preparation");
        }),
      ]);
      expect(fetch).not.toHaveBeenCalled();
      if (retired) {
        caller.abort(failure);
      }
      prepared.resolve();
      if (!retired) {
        await dispatched.promise;
        caller.abort(failure);
      }
      response.resolve(Response.json({ message: { id: "msg_1" } }));
      expect(await sending).toEqual(retired ? { error: failure } : { value: { id: "msg_1" } });
      expect(fetch).toHaveBeenCalledTimes(retired ? 0 : 1);
    } finally {
      prepared.resolve();
      response.resolve(Response.json({ message: { id: "msg_1" } }));
      await sending;
      effectGate.prepare = undefined;
    }
  },
);
