import { expect, it, vi } from "vitest";
import { writeMatrixStateChunks } from "./chunked-state.js";

const rows = {
  chunks: [
    { key: "chunk:new:0", value: "first" },
    { key: "chunk:new:1", value: "second" },
  ],
  meta: { key: "meta", value: "new" },
};

function createStore(beforeRegister?: (key: string) => Promise<void>) {
  const values = new Map([
    ["meta", "old"],
    ["chunk:old:0", "previous"],
    ["unrelated", "retained"],
  ]);
  return {
    values,
    store: {
      register: vi.fn(async (key: string, value: string) => {
        await beforeRegister?.(key);
        values.set(key, value);
      }),
      entries: vi.fn(async () => [...values].map(([key, value]) => ({ key, value, createdAt: 0 }))),
      delete: vi.fn(async (key: string) => values.delete(key)),
    },
  };
}

it.each(["chunk:new:1", "meta"])(
  "retains the published generation when writing %s fails",
  async (failedKey) => {
    const failure = new Error("write failed");
    const { values, store } = createStore(async (key) => {
      if (key === failedKey) {
        throw failure;
      }
    });

    await expect(writeMatrixStateChunks(store, rows, "chunk:")).rejects.toBe(failure);

    expect(values.get("meta")).toBe("old");
    expect(values.get("chunk:old:0")).toBe("previous");
    expect(store.entries).not.toHaveBeenCalled();
    expect(store.delete).not.toHaveBeenCalled();
  },
);

it("waits for every chunk before publishing metadata and removing the old generation", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { values, store } = createStore(async (key) => {
    if (key === "chunk:new:1") {
      started.resolve();
      await release.promise;
    }
  });
  const writing = writeMatrixStateChunks(store, rows, "chunk:");
  try {
    await started.promise;
    expect(values.get("meta")).toBe("old");
    expect(values.get("chunk:old:0")).toBe("previous");
    expect(store.entries).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await writing;
  }

  expect(values).toEqual(
    new Map([
      ["meta", "new"],
      ["unrelated", "retained"],
      ["chunk:new:0", "first"],
      ["chunk:new:1", "second"],
    ]),
  );
});
