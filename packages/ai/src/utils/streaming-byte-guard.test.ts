import { describe, expect, it } from "vitest";
import { withinTest } from "../../../../test/helpers/promise.js";
import { makeStallingStream } from "../providers/provider-stream.test-support.js";
import { createSseByteGuard } from "./streaming-byte-guard.js";

describe("createSseByteGuard cancellation", () => {
  it("reports overflow without waiting for upstream cancellation", async ({ signal }) => {
    let cancelStarted = false;
    const body = makeStallingStream([new Uint8Array(2)], () => {
      cancelStarted = true;
      return new Promise<void>(() => {});
    });
    const guard = createSseByteGuard(body.getReader(), { maxBytes: 1 });

    await expect(withinTest(guard.read(), signal)).rejects.toThrow(
      "SSE stream exceeds 1 bytes (received 2)",
    );
    expect(cancelStarted).toBe(true);
    expect(guard.overflowed()).toBe(true);
  });

  it("finishes explicit cancellation after handing cleanup upstream", async ({ signal }) => {
    let cancelStarted = false;
    const body = makeStallingStream([], () => {
      cancelStarted = true;
      return new Promise<void>(() => {});
    });
    const guard = createSseByteGuard(body.getReader(), { maxBytes: 1 });

    await expect(withinTest(guard.cancel("done"), signal)).resolves.toBeUndefined();
    expect(cancelStarted).toBe(true);
    expect(guard.cancelled()).toBe(true);
  });
});
