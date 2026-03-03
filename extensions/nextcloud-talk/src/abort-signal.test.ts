import { describe, expect, it } from "vitest";
import { waitForAbortSignal } from "./abort-signal.js";

describe("waitForAbortSignal", () => {
  it("resolves immediately when signal is undefined", async () => {
    await expect(waitForAbortSignal(undefined)).resolves.toBeUndefined();
  });

  it("resolves immediately when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(waitForAbortSignal(controller.signal)).resolves.toBeUndefined();
  });

  it("waits until signal aborts", async () => {
    const controller = new AbortController();
    let resolved = false;
    const wait = waitForAbortSignal(controller.signal).then(() => {
      resolved = true;
    });

    expect(resolved).toBe(false);
    controller.abort();
    await wait;
    expect(resolved).toBe(true);
  });
});
