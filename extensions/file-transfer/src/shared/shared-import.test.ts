import { describe, expect, it, vi } from "vitest";
import { createSharedImport } from "./shared-import.js";

describe("createSharedImport", () => {
  it("gives concurrent callers one in-flight load", async () => {
    let resolveLoad!: (value: { id: string }) => void;
    const load = vi.fn(
      () =>
        new Promise<{ id: string }>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const shared = createSharedImport(load);

    const first = shared();
    const second = shared();
    resolveLoad({ id: "module" });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { id: "module" },
      { id: "module" },
    ]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("retries after a rejected load", async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("load failed"))
      .mockResolvedValueOnce("module");
    const shared = createSharedImport(load);

    await expect(shared()).rejects.toThrow("load failed");
    await expect(shared()).resolves.toBe("module");
    expect(load).toHaveBeenCalledTimes(2);
  });
});
