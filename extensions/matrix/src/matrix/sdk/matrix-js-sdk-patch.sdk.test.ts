import { EventEmitter } from "node:events";
import { createClient, MatrixEventEvent, Method } from "matrix-js-sdk/lib/matrix.js";
import { RustCrypto } from "matrix-js-sdk/lib/rust-crypto/rust-crypto.js";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("patched matrix-js-sdk", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("request deadlines do not keep a finished CLI process alive", async () => {
    // /sync arms pollTimeout + 80s per request. A referenced deadline held each
    // Matrix CLI command open for up to 110s after its client had stopped.
    const deadlineMs = 110_000;
    const realSetTimeout = globalThis.setTimeout;
    const deadlines: NodeJS.Timeout[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      ...args: Parameters<typeof setTimeout>
    ) => {
      const timer = realSetTimeout(...args);
      if (args[1] === deadlineMs) {
        deadlines.push(timer);
      }
      return timer;
    }) as typeof setTimeout);
    const client = createClient({
      baseUrl: "https://matrix.example.org",
      accessToken: "token",
      fetchFn: async () => Response.json({}),
    });

    try {
      await client.http.authedRequest(Method.Get, "/deadline-probe", undefined, undefined, {
        localTimeoutMs: deadlineMs,
      });

      expect(deadlines).toHaveLength(1);
      expect(deadlines[0]?.hasRef()).toBe(false);
    } finally {
      deadlines.forEach((timer) => clearTimeout(timer));
    }
  });

  it("reports in-room verification failures after decryption instead of rejecting unhandled", async () => {
    // A stopped client's retired crypto store rejects late verification events.
    // The SDK starts this work without awaiting it, so a rejection stopped the CLI process.
    const storeRetired = new Error("Matrix crypto IndexedDB generation has retired");
    const warn = vi.fn();
    const crypto = {
      logger: { warn },
      onKeyVerificationEvent: vi.fn(async () => {
        throw storeRetired;
      }),
    };
    const event = Object.assign(new EventEmitter(), {
      getId: () => "$verification-mac",
      getType: () => "m.key.verification.mac",
      getUnsigned: () => ({}),
      isDecryptionFailure: () => false,
      isEncrypted: () => true,
      isState: () => false,
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      await RustCrypto.prototype.onLiveEventFromSync.call(crypto as never, event as never);
      event.emit(MatrixEventEvent.Decrypted, event);
      await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(crypto.onKeyVerificationEvent).toHaveBeenCalledWith(event);
      expect(warn.mock.calls[0]?.[1]).toBe(storeRetired);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
