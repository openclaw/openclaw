// Memory Core tests cover blank search manager preflight behavior.
import { describe, expect, it, vi } from "vitest";
import { MemoryIndexManager } from "./manager.js";

type SearchMethod = (
  this: unknown,
  query: string,
  opts?: Parameters<MemoryIndexManager["search"]>[1],
) => ReturnType<MemoryIndexManager["search"]>;

describe("memory manager blank query preflight", () => {
  it("returns empty results before provider init or search bootstrap", async () => {
    const manager = {
      providerRequirement: { mode: "required" },
      ensureProviderInitialized: vi.fn(async () => {
        throw new Error("provider should not initialize for blank searches");
      }),
      assertRequiredProviderAvailable: vi.fn(),
      hasIndexedContent: vi.fn(() => false),
      sync: vi.fn(async () => {}),
    };
    const search = Object.getOwnPropertyDescriptor(MemoryIndexManager.prototype, "search")
      ?.value as SearchMethod | undefined;
    if (!search) {
      throw new Error("MemoryIndexManager.search missing");
    }

    const results = await search.call(manager, " \n\t ");

    expect(results).toStrictEqual([]);
    expect(manager.ensureProviderInitialized).not.toHaveBeenCalled();
    expect(manager.assertRequiredProviderAvailable).not.toHaveBeenCalled();
    expect(manager.hasIndexedContent).not.toHaveBeenCalled();
    expect(manager.sync).not.toHaveBeenCalled();
  });
});
