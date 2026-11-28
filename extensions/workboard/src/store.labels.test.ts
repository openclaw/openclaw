import { describe, expect, it } from "vitest";
import { createKernelStores } from "./test/sqlite-kernel.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

const createStore = () => createWorkboardSqliteTestStore({ createStores: createKernelStores });

describe("Workboard label limits", () => {
  it("accepts 12 distinct labels after collapsing duplicates and empty entries", async () => {
    const store = createStore();
    const labels = Array.from({ length: 12 }, (_, index) => "l" + index);
    const exact = await store.create({ title: "Exactly 12 labels", labels });
    expect(exact.labels).toEqual(labels);
    const repeated = [...labels, ...labels, ...labels.slice(0, 4), "", "  "];
    expect(repeated).toHaveLength(30);
    const collapsed = await store.create({ title: "Repeated labels", labels: repeated });
    expect(collapsed.labels).toEqual(labels);
  });

  it("rejects excess labels without creating or updating a card", async () => {
    const store = createStore();
    const labels = Array.from({ length: 13 }, (_, index) => "l" + index);
    await expect(store.create({ title: "Too many labels", labels })).rejects.toThrow(
      "labels supports at most 12 entries.",
    );
    expect(await store.list()).toEqual([]);
    const card = await store.create({ title: "Keep labels", labels: ["original"] });
    await expect(store.update(card.id, { labels })).rejects.toThrow(
      "labels supports at most 12 entries.",
    );
    expect((await store.get(card.id))?.labels).toEqual(["original"]);
  });
});
