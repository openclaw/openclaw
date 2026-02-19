import { describe, expect, it, vi } from "vitest";

vi.mock("./file-store.js", () => ({
  clearSwappedFileStore: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./summary-store.js", () => ({
  clearSummaryStore: vi.fn().mockResolvedValue(undefined),
  clearGroupSummaryStore: vi.fn().mockResolvedValue(undefined),
}));

import { clearAllDecayStores } from "./clear-stores.js";
import { clearSwappedFileStore } from "./file-store.js";
import { clearGroupSummaryStore, clearSummaryStore } from "./summary-store.js";

describe("clearAllDecayStores", () => {
  it("calls all three clear functions with the session file path", async () => {
    const sessionFile = "/tmp/test-session.jsonl";
    await clearAllDecayStores(sessionFile);

    expect(clearSummaryStore).toHaveBeenCalledWith(sessionFile);
    expect(clearGroupSummaryStore).toHaveBeenCalledWith(sessionFile);
    expect(clearSwappedFileStore).toHaveBeenCalledWith(sessionFile);
  });

  it("runs all clears in parallel (all called before any resolves)", async () => {
    const order: string[] = [];
    vi.mocked(clearSummaryStore).mockImplementation(async () => {
      order.push("summary");
    });
    vi.mocked(clearGroupSummaryStore).mockImplementation(async () => {
      order.push("group");
    });
    vi.mocked(clearSwappedFileStore).mockImplementation(async () => {
      order.push("swap");
    });

    await clearAllDecayStores("/tmp/s.jsonl");
    expect(order).toHaveLength(3);
    expect(order).toContain("summary");
    expect(order).toContain("group");
    expect(order).toContain("swap");
  });

  it("propagates errors from any clear function", async () => {
    vi.mocked(clearGroupSummaryStore).mockRejectedValueOnce(new Error("disk full"));

    await expect(clearAllDecayStores("/tmp/s.jsonl")).rejects.toThrow("disk full");
  });
});
