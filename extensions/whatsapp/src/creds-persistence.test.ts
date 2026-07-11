// Whatsapp tests cover creds persistence plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enqueueCredsSave,
  runInCredsSaveQueue,
  waitForCredsSaveQueueWithTimeout,
} from "./creds-persistence.js";

describe("creds-persistence", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("caps oversized credential flush timeouts before scheduling", async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const authDir = "oversized-timeout";
    enqueueCredsSave(
      authDir,
      () => undefined,
      () => undefined,
    );

    await waitForCredsSaveQueueWithTimeout(authDir, Number.MAX_SAFE_INTEGER);

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });

  it("serializes auth mutations with credential saves for the same directory", async () => {
    const authDir = "serialized-auth-mutation";
    const order: string[] = [];
    let releaseFirstSave = () => {};
    let markFirstSaveStarted = () => {};
    const firstSaveGate = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    const firstSaveStarted = new Promise<void>((resolve) => {
      markFirstSaveStarted = resolve;
    });

    enqueueCredsSave(
      authDir,
      async () => {
        order.push("save-1:start");
        markFirstSaveStarted();
        await firstSaveGate;
        order.push("save-1:end");
      },
      () => undefined,
    );
    const mutation = runInCredsSaveQueue(authDir, async () => {
      order.push("mutation");
      return "mutated";
    });
    enqueueCredsSave(
      authDir,
      () => {
        order.push("save-2");
      },
      () => undefined,
    );

    await firstSaveStarted;
    expect(order).toEqual(["save-1:start"]);
    releaseFirstSave();

    await expect(mutation).resolves.toBe("mutated");
    await waitForCredsSaveQueueWithTimeout(authDir);
    expect(order).toEqual(["save-1:start", "save-1:end", "mutation", "save-2"]);
  });
});
