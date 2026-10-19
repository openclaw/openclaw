import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as fetchRuntime from "openclaw/plugin-sdk/fetch-runtime";
import { expect, vi } from "vitest";

// Each transport supplies its real wire fixture; only the shared authority interleaving lives here.
export async function expectPreparedHandoff(
  revoked: boolean,
  setup: (gate: {
    arrive: () => void;
    response: Promise<void>;
    assertHandoff: () => void;
  }) => Promise<{
    send: () => Promise<unknown>;
    assertCount: (count: number) => void;
    result: unknown;
  }>,
) {
  const preparing = createDeferred<void>();
  const prepared = createDeferred<void>();
  const arrived = createDeferred<void>();
  const response = createDeferred<void>();
  const caller = new AbortController();
  const failure = new Error("Signal caller ended during preparation");
  const authority = fetchRuntime.captureEffectAuthority();
  vi.spyOn(fetchRuntime, "captureEffectAuthority").mockReturnValue({
    ...authority,
    async initiate(effect) {
      preparing.resolve();
      await prepared.promise;
      return authority.initiate(effect);
    },
  });
  const fixture = await setup({
    arrive: () => arrived.resolve(),
    response: response.promise,
    assertHandoff: () => caller.signal.throwIfAborted(),
  });
  let settled = false;
  const sending = fixture
    .send()
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    .finally(() => {
      settled = true;
    });
  try {
    await Promise.race([
      preparing.promise,
      arrived.promise.then(() => {
        throw new Error("transport bypassed preparation");
      }),
    ]);
    fixture.assertCount(0);
    if (revoked) {
      caller.abort(failure);
    }
    prepared.resolve();
    if (!revoked) {
      await arrived.promise;
      expect(settled).toBe(false);
      response.resolve();
    }
    expect(await sending).toEqual(revoked ? { error: failure } : { value: fixture.result });
    fixture.assertCount(revoked ? 0 : 1);
  } finally {
    caller.abort(failure);
    prepared.resolve();
    response.resolve();
    await sending;
  }
}
