import { describe, expect, it } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { serializeCacheTtlToolResultProjections } from "./cache-ttl-checkpoint.js";
import {
  createToolResultPromptProjectionState,
  persistToolResultProjections,
  type ToolResultPromptProjectionState,
} from "./session-prompt-state.js";
import { restoreCacheTtlToolResultProjections } from "./tool-result-truncation.js";

type Mark = { mode: "soft" } | { mode: "hard"; placeholder: string };
type Model = {
  marks: Map<string, Mark>;
  frozen: Map<string, { sourceHash: string; texts?: string[] }>;
  ambiguous: Set<string>;
};
type Entry = { type: string; customType?: string; data?: unknown };

function createModel(): Model {
  return { marks: new Map(), frozen: new Map(), ambiguous: new Set() };
}

function cumulativeSnapshot(model: Model) {
  return {
    prunedToolResults: [...model.marks].map(([key, mark]) => Object.assign({ key }, mark)),
    ambiguousToolResultBaseKeys: [...model.ambiguous],
    frozenToolResults: [...model.frozen].map(([key, frozen]) => Object.assign({ key }, frozen)),
  };
}

function normalize(snapshot: ReturnType<typeof cumulativeSnapshot>) {
  return {
    prunedToolResults: snapshot.prunedToolResults.toSorted((a, b) => a.key.localeCompare(b.key)),
    ambiguousToolResultBaseKeys: snapshot.ambiguousToolResultBaseKeys.toSorted(),
    frozenToolResults: snapshot.frozenToolResults.toSorted((a, b) => a.key.localeCompare(b.key)),
  };
}

function loadModel(state: ToolResultPromptProjectionState, model: Model, materialize = false) {
  state.replacements.clear();
  state.restoredCacheTtl.clear();
  state.frozen.clear();
  state.sourceHashByKey.clear();
  state.ambiguousBaseKeys = new Set(model.ambiguous);
  for (const [key, value] of model.frozen) {
    state.frozen.add(key);
    state.sourceHashByKey.set(key, value.sourceHash);
    if (value.texts) {
      state.replacements.set(key, {
        content: value.texts.map((text) => ({ type: "text", text })),
      });
    }
  }
  for (const [key, mark] of model.marks) {
    if (materialize) {
      state.replacements.set(key, {
        cacheTtl: mark.mode,
        content: [{ type: "text", text: mark.mode === "hard" ? mark.placeholder : "trimmed" }],
      });
    } else {
      state.restoredCacheTtl.set(key, mark);
    }
  }
}

function appendTo(entries: Entry[]) {
  return async (customType: string, data: unknown) => {
    entries.push({ type: "custom", customType, data: structuredClone(data) });
  };
}

function restore(entries: Entry[]) {
  const state = createToolResultPromptProjectionState();
  restoreCacheTtlToolResultProjections(state, entries);
  return state;
}

function expectModel(entries: Entry[], model: Model) {
  expect(normalize(serializeCacheTtlToolResultProjections(restore(entries)))).toEqual(
    normalize(cumulativeSnapshot(model)),
  );
}

function randomSequence(seed: number) {
  let value = seed;
  return (bound: number) => {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
    return Math.floor((value / 0x1_0000_0000) * bound);
  };
}

function changeModel(model: Model, step: number, random: (bound: number) => number) {
  const key = `tool:result-${random(24)}:42`;
  const sourceHash = `source-${step}`;
  switch (random(7)) {
    case 0:
    case 1:
      model.marks.set(
        key,
        random(2) ? { mode: "soft" } : { mode: "hard", placeholder: `[cleared ${step}]` },
      );
      model.frozen.set(key, { sourceHash });
      break;
    case 2:
      model.marks.delete(key);
      model.frozen.delete(key);
      break;
    case 3:
      model.frozen.set(key, { ...model.frozen.get(key), sourceHash });
      break;
    case 4:
      model.marks.delete(key);
      model.frozen.set(key, { sourceHash, texts: [`projected ${step}`, "保留 😀"] });
      break;
    case 5:
      if (!model.ambiguous.delete(key)) {
        model.ambiguous.add(key);
      }
      break;
    case 6:
      model.marks.delete(key);
      model.frozen.set(key, { sourceHash });
      break;
  }
}

function checkpointBounds(entries: Entry[]) {
  let deltas = 0;
  let bytes = 0;
  let checkpoints = 0;
  for (const { data } of entries) {
    if (!data || typeof data !== "object") {
      continue;
    }
    if ("prunedToolResults" in data) {
      deltas = 0;
      bytes = 0;
      checkpoints++;
    } else if ("cacheTtlDelta" in data) {
      deltas++;
      bytes += Buffer.byteLength(JSON.stringify(data.cacheTtlDelta));
      expect(deltas).toBeLessThanOrEqual(31);
      expect(bytes).toBeLessThan(65_536);
    }
  }
  return checkpoints;
}

describe("cache-TTL checkpoint and delta persistence", () => {
  it.each([1, 448, 942_078, 0xdeadbeef])(
    "matches cumulative snapshots at every retained branch boundary (seed %s)",
    async (seed) => {
      const random = randomSequence(seed);
      let model = createModel();
      let state = createToolResultPromptProjectionState();
      let entries: Entry[] = [];
      const retained: { entries: Entry[]; model: Model }[] = [];
      for (let step = 0; step < 180; step++) {
        if (step === 64 || step === 128) {
          entries.push({ type: "reset" });
          model = createModel();
          state = restore(entries);
          expectModel(entries, model);
        } else if (step > 128 && step % 9 === 0) {
          const boundary = retained[random(retained.length)]!;
          entries = boundary.entries.slice();
          model = structuredClone(boundary.model);
          state = restore(entries);
          expectModel(entries, model);
        }
        changeModel(model, step, random);
        loadModel(state, model, step % 2 === 0);
        if (step % 47 === 0) {
          await appendTo(entries)("openclaw.cache-ttl", cumulativeSnapshot(model));
          state = restore(entries);
        } else {
          await persistToolResultProjections(state, appendTo(entries));
        }
        if (step % 11 === 0) {
          await appendTo(entries)("openclaw.cache-ttl", {
            timestamp: step,
            provider: "anthropic",
            modelId: "claude-sonnet-4-6",
          });
        }
        expectModel(entries, model);
        retained.push({ entries: entries.slice(), model: structuredClone(model) });
      }
    },
  );

  it("does not publish an old append baseline after restoring an empty branch", async () => {
    const model = createModel();
    model.marks.set("retained", { mode: "soft" });
    model.frozen.set("retained", { sourceHash: "original" });
    const state = createToolResultPromptProjectionState();
    loadModel(state, model);
    const committed = createDeferred();
    const release = createDeferred();
    const oldBranch: Entry[] = [];
    const pending = persistToolResultProjections(state, async (customType, data) => {
      await appendTo(oldBranch)(customType, data);
      committed.resolve();
      await release.promise;
    });
    await awaitGateBeforeSettlement(committed.promise, pending, "append did not commit");
    restoreCacheTtlToolResultProjections(state, []);
    release.resolve();
    await pending;
    const newBranch: Entry[] = [];
    await persistToolResultProjections(state, appendTo(newBranch));
    expectModel(oldBranch, model);
    expectModel(newBranch, model);
  });

  it.each([false, true])(
    "re-establishes projections after an uncertain append (durable=%s)",
    async (durable) => {
      const model = createModel();
      model.marks.set("removed", { mode: "soft" });
      model.frozen.set("removed", { sourceHash: "original" });
      const state = createToolResultPromptProjectionState();
      loadModel(state, model);
      const entries: Entry[] = [];
      await persistToolResultProjections(state, appendTo(entries));
      const previous = structuredClone(model);
      model.marks.delete("removed");
      model.frozen.delete("removed");
      model.marks.set("added", { mode: "hard", placeholder: "[cleared]" });
      model.frozen.set("added", { sourceHash: "replacement" });
      model.frozen.set("ordinary", { sourceHash: "projected", texts: ["retained text"] });
      loadModel(state, model);
      await expect(
        persistToolResultProjections(state, async (customType, data) => {
          if (durable) {
            await appendTo(entries)(customType, data);
          }
          throw new Error("append rejected");
        }),
      ).rejects.toThrow("append rejected");
      expectModel(entries, durable ? model : previous);
      const retryModel = durable ? createModel() : model;
      loadModel(state, retryModel);
      await persistToolResultProjections(state, appendTo(entries));
      expectModel(entries, retryModel);
      const persisted = entries.length;
      await persistToolResultProjections(state, appendTo(entries));
      expect(entries).toHaveLength(persisted);

      loadModel(state, createModel());
      await persistToolResultProjections(state, appendTo(entries));
      expectModel(entries, createModel());
    },
  );

  it.each([
    { label: "delta", data: { cacheTtlDelta: { prunedToolResults: "damaged" } } },
    { label: "checkpoint", data: { prunedToolResults: "damaged" } },
    { label: "null checkpoint", data: null },
    { label: "non-object checkpoint", data: "damaged" },
  ])("stops replay at a damaged $label", async ({ data }) => {
    const model = createModel();
    model.marks.set("retained", { mode: "soft" });
    model.frozen.set("retained", { sourceHash: "original" });
    const state = createToolResultPromptProjectionState();
    const entries: Entry[] = [];
    const persist = async () => {
      loadModel(state, model);
      await persistToolResultProjections(state, appendTo(entries));
    };
    await persist();
    model.frozen.set("retained", { sourceHash: "valid-prefix" });
    await persist();
    const validPrefix = structuredClone(model);
    model.marks.set("retained", { mode: "hard", placeholder: "[cleared]" });
    await persist();
    model.marks.set("dependent", { mode: "soft" });
    model.frozen.set("dependent", { sourceHash: "later" });
    await persist();

    expectModel(entries.slice(1), createModel());
    expectModel([entries[0]!, { type: "reset" }, ...entries.slice(1)], createModel());
    entries[2]!.data = data;
    expectModel(entries, validPrefix);
    const recovered = restore(entries);
    loadModel(recovered, model);
    await persistToolResultProjections(recovered, appendTo(entries));
    expectModel(entries, model);
  });

  it("writes at least ten times fewer bytes for 1,000 changes to a retained 22 KB projection", async () => {
    const model = createModel();
    for (let index = 0; index < 144; index++) {
      const key = `tool:result-${index}:42`;
      model.marks.set(key, { mode: "soft" });
      model.frozen.set(key, { sourceHash: "0".repeat(64) });
    }
    const initialBytes = Buffer.byteLength(JSON.stringify(cumulativeSnapshot(model)));
    expect(initialBytes).toBeGreaterThan(20_000);
    expect(initialBytes).toBeLessThan(25_000);
    const state = createToolResultPromptProjectionState();
    const entries: Entry[] = [];
    let cumulativeBytes = 0;
    for (let step = 1; step <= 1_000; step++) {
      model.frozen.set(`tool:result-${step % 144}:42`, {
        sourceHash: step.toString(16).padStart(64, "0"),
      });
      loadModel(state, model);
      cumulativeBytes += Buffer.byteLength(JSON.stringify(cumulativeSnapshot(model)));
      await persistToolResultProjections(state, appendTo(entries));
    }
    const writtenBytes = entries.reduce(
      (bytes, entry) => bytes + Buffer.byteLength(JSON.stringify(entry.data)),
      0,
    );
    expect(writtenBytes).toBeLessThan(cumulativeBytes / 10);
    expect(checkpointBounds(entries)).toBeGreaterThan(1);
    expectModel(entries, model);
  });

  it("bounds replay bytes when a few changes contain long ordinary projected text", async () => {
    const model = createModel();
    const state = createToolResultPromptProjectionState();
    const entries: Entry[] = [];
    for (let step = 0; step < 20; step++) {
      model.frozen.set("ordinary", {
        sourceHash: `source-${step}`,
        texts: [`${step}:${"text".repeat(2_000)}`],
      });
      loadModel(state, model);
      await persistToolResultProjections(state, appendTo(entries));
      expectModel(entries, model);
    }
    expect(checkpointBounds(entries)).toBeGreaterThan(1);
  });
});
