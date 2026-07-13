import { describe, expect, it, vi } from "vitest";
import {
  combineTelegramDeferredAdmissionCallbacks,
  settleTelegramDeferredAdmissionCallbacks,
} from "./deferred-admission.js";

describe("combineTelegramDeferredAdmissionCallbacks", () => {
  it("admits one combined turn and finalizes remaining source messages", async () => {
    const first = vi.fn(async () => false);
    const primary = vi.fn(async () => false);
    const combined = combineTelegramDeferredAdmissionCallbacks([first, primary], primary);

    await expect(combined?.(true)).resolves.toBe(false);
    expect(primary).toHaveBeenCalledWith(true);
    expect(first).toHaveBeenCalledWith(false);
  });

  it("finalizes other source messages when the combined turn is suppressed", async () => {
    const first = vi.fn(async () => false);
    const primary = vi.fn(async () => true);
    const combined = combineTelegramDeferredAdmissionCallbacks([first, primary], primary);

    await expect(combined?.(true)).resolves.toBe(true);
    expect(first).toHaveBeenCalledWith(false, false);
  });

  it("finalizes every source message when mention admission rejects the combined turn", async () => {
    const first = vi.fn(async () => false);
    const second = vi.fn(async () => false);
    const combined = combineTelegramDeferredAdmissionCallbacks([first, second]);

    await expect(combined?.(false)).resolves.toBe(false);
    expect(first).toHaveBeenCalledWith(false);
    expect(second).toHaveBeenCalledWith(false);
  });

  it("cannot suppress siblings that already passed admission", async () => {
    const deferred = vi.fn(async () => true);
    const combined = combineTelegramDeferredAdmissionCallbacks([deferred], deferred, false);

    await expect(combined?.(true)).resolves.toBe(false);
    expect(deferred).toHaveBeenCalledWith(false);
  });
});

describe("settleTelegramDeferredAdmissionCallbacks", () => {
  it("settles every callback without retrying rejected cache work", async () => {
    const failure = new Error("cache unavailable");
    const failing = vi.fn(async () => {
      throw failure;
    });
    const succeeding = vi.fn(async () => false);

    await expect(
      settleTelegramDeferredAdmissionCallbacks({
        callbacks: [failing, succeeding],
        admitted: false,
        cacheMessage: false,
      }),
    ).resolves.toEqual([failure]);
    expect(failing).toHaveBeenCalledWith(false, false);
    expect(succeeding).toHaveBeenCalledWith(false, false);
  });
});
