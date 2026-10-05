import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import type { ToolResultPromptProjectionState } from "./session-prompt-state.js";

const prunedResult = z.union([
  z.object({ key: z.string(), mode: z.literal("soft") }),
  z.object({ key: z.string(), mode: z.literal("hard"), placeholder: z.string() }),
]);
const frozenResult = z.object({
  key: z.string(),
  sourceHash: z.string(),
  texts: z.array(z.string()).optional(),
});
const snapshotSchema = z.object({
  prunedToolResults: z.array(prunedResult),
  ambiguousToolResultBaseKeys: z.array(z.string()).default([]),
  frozenToolResults: z.array(frozenResult).default([]),
});
function changesSchema<T extends z.ZodType>(value: T) {
  return z.object({ set: z.array(value), remove: z.array(z.string()) });
}
const deltaSchema = z.object({
  cacheTtlDelta: z.object({
    prunedToolResults: changesSchema(prunedResult),
    ambiguousToolResultBaseKeys: changesSchema(z.string()),
    frozenToolResults: changesSchema(frozenResult),
  }),
});

type CacheTtlSnapshot = z.infer<typeof snapshotSchema>;
export type CacheTtlCheckpoint = { snapshot: CacheTtlSnapshot; deltas: number; bytes: number };
type Delta = z.infer<typeof deltaSchema>;

// About four checkpoints per 127-change session; cap replay payload at three median snapshots.
const MAX_DELTAS = 31;
const MAX_DELTA_BYTES = 64 * 1024;

const projectionFields = [...Object.keys(snapshotSchema.shape), ...Object.keys(deltaSchema.shape)];

export function isCacheTtlTouch(data: unknown): boolean {
  return (
    isRecord(data) &&
    typeof data.timestamp === "number" &&
    Number.isFinite(data.timestamp) &&
    !projectionFields.some((key) => key in data)
  );
}

function changes<T>(before: T[], after: T[], key: (value: T) => string) {
  const previous = new Map(before.map((value) => [key(value), value]));
  const set = after.filter((value) => {
    const old = previous.get(key(value));
    previous.delete(key(value));
    return JSON.stringify(old) !== JSON.stringify(value);
  });
  return { set, remove: [...previous.keys()] };
}

export function prepareCacheTtlCheckpoint(
  snapshot: CacheTtlSnapshot,
  previous: CacheTtlCheckpoint | undefined,
): { marker?: CacheTtlSnapshot | Delta; checkpoint: CacheTtlCheckpoint } {
  if (previous) {
    const keyed = (value: { key: string }) => value.key;
    const delta: Delta = {
      cacheTtlDelta: {
        prunedToolResults: changes(
          previous.snapshot.prunedToolResults,
          snapshot.prunedToolResults,
          keyed,
        ),
        ambiguousToolResultBaseKeys: changes(
          previous.snapshot.ambiguousToolResultBaseKeys,
          snapshot.ambiguousToolResultBaseKeys,
          (key) => key,
        ),
        frozenToolResults: changes(
          previous.snapshot.frozenToolResults,
          snapshot.frozenToolResults,
          keyed,
        ),
      },
    };
    if (
      Object.values(delta.cacheTtlDelta).every(({ set, remove }) => !set.length && !remove.length)
    ) {
      return { checkpoint: previous };
    }
    const bytes = previous.bytes + Buffer.byteLength(JSON.stringify(delta));
    if (previous.deltas < MAX_DELTAS && bytes < MAX_DELTA_BYTES) {
      return { marker: delta, checkpoint: { snapshot, deltas: previous.deltas + 1, bytes } };
    }
  }
  return { marker: snapshot, checkpoint: { snapshot, deltas: 0, bytes: 0 } };
}

function applyChanges<T>(
  values: Map<string, T>,
  patch: { set: T[]; remove: string[] },
  key: (value: T) => string,
) {
  for (const removed of patch.remove) {
    values.delete(removed);
  }
  for (const value of patch.set) {
    values.set(key(value), value);
  }
}

/** Only the supplied active branch participates; legacy full snapshots are checkpoints. */
export function readCacheTtlCheckpoint(
  entries: readonly { type?: unknown; customType?: unknown; data?: unknown }[],
): CacheTtlCheckpoint | undefined {
  const deltas: Delta[] = [];
  let damaged = false;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type === "reset") {
      return undefined;
    }
    if (entry?.type !== "custom" || entry.customType !== "openclaw.cache-ttl") {
      continue;
    }
    const data = entry.data;
    if (isRecord(data) && "cacheTtlDelta" in data) {
      const delta = deltaSchema.safeParse(data);
      if (delta.success) {
        deltas.push(delta.data);
      } else {
        // A damaged patch also invalidates later patches that depended on it.
        deltas.length = 0;
        damaged = true;
      }
      continue;
    }
    const parsed = snapshotSchema.safeParse(data);
    if (!parsed.success) {
      if (!isCacheTtlTouch(data)) {
        deltas.length = 0;
        damaged = true;
      }
      continue;
    }
    if (!deltas.length) {
      return { snapshot: parsed.data, deltas: damaged ? MAX_DELTAS : 0, bytes: 0 };
    }
    const keyed = (value: { key: string }) => value.key;
    const pruned = new Map(parsed.data.prunedToolResults.map((value) => [value.key, value]));
    const ambiguous = new Map(parsed.data.ambiguousToolResultBaseKeys.map((key) => [key, key]));
    const frozen = new Map(parsed.data.frozenToolResults.map((value) => [value.key, value]));
    let bytes = 0;
    for (const delta of deltas.toReversed()) {
      applyChanges(pruned, delta.cacheTtlDelta.prunedToolResults, keyed);
      applyChanges(ambiguous, delta.cacheTtlDelta.ambiguousToolResultBaseKeys, (key) => key);
      applyChanges(frozen, delta.cacheTtlDelta.frozenToolResults, keyed);
      bytes += Buffer.byteLength(JSON.stringify(delta));
    }
    return {
      snapshot: {
        prunedToolResults: [...pruned.values()],
        ambiguousToolResultBaseKeys: [...ambiguous.values()],
        frozenToolResults: [...frozen.values()],
      },
      deltas: damaged ? MAX_DELTAS : deltas.length,
      bytes,
    };
  }
  return undefined;
}

/** TTL trims are re-derived; ordinary trims retain only text, never images or tool metadata. */
export function serializeCacheTtlToolResultProjections(state: ToolResultPromptProjectionState) {
  const marks = new Map(state.restoredCacheTtl);
  for (const [key, projection] of state.replacements) {
    if (projection.cacheTtl === "soft") {
      marks.set(key, { mode: "soft" });
    } else if (projection.cacheTtl === "hard") {
      const placeholder = projection.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n");
      marks.set(key, { mode: "hard", placeholder });
    }
  }
  return {
    prunedToolResults: [...marks].map(([key, mark]) => Object.assign({ key }, mark)),
    ambiguousToolResultBaseKeys: [...state.ambiguousBaseKeys],
    frozenToolResults: [...state.sourceHashByKey].flatMap(([key, sourceHash]) => {
      if (!state.frozen.has(key)) {
        return [];
      }
      const projection = state.replacements.get(key);
      return [
        {
          key,
          sourceHash,
          ...(!projection?.cacheTtl && projection
            ? {
                texts: projection.content.flatMap((block) =>
                  block.type === "text" ? [block.text] : [],
                ),
              }
            : {}),
        },
      ];
    }),
  };
}
