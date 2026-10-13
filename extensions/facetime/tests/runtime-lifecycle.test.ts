import { describe, expect, it, vi } from "vitest";
import { stopRetainedRuntime } from "../src/runtime-lifecycle.js";

describe("FaceTime runtime lifecycle", () => {
  it("retains a failed shutdown until the same runtime stops successfully", async () => {
    const runtime = Promise.resolve({
      stop: vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error("carrier hangup pending"))
        .mockResolvedValue(undefined),
    });
    const clearIfCurrent = vi.fn();

    await expect(stopRetainedRuntime(runtime, clearIfCurrent)).rejects.toThrow(
      "carrier hangup pending",
    );
    expect(clearIfCurrent).not.toHaveBeenCalled();
    await stopRetainedRuntime(runtime, clearIfCurrent);
    expect(clearIfCurrent).toHaveBeenCalledExactlyOnceWith(runtime);
  });

  it("clears a rejected runtime-construction promise so startup can recover", async () => {
    const runtime = Promise.reject(new Error("startup failed"));
    const clearIfCurrent = vi.fn();

    await expect(stopRetainedRuntime(runtime, clearIfCurrent)).rejects.toThrow("startup failed");
    expect(clearIfCurrent).toHaveBeenCalledWith(runtime);
  });
});
