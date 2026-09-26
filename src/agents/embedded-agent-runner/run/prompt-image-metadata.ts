import { asSafeIntegerInRange } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentMessage } from "../../runtime/index.js";

export type ImageFactIndex = number | null;

export type MediaImageLayout = {
  slots: Array<{ kind: "inline" | "offloaded"; factIndex?: number }>;
  suppressedFactIndexes?: number[];
};

export function readPersistedImageBlockFactIndexes(
  message: AgentMessage,
): ImageFactIndex[] | undefined {
  const value = asOptionalRecord(Reflect.get(message, "__openclaw"))?.mediaImageBlockFactIndexes;
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((entry) => asSafeIntegerInRange(entry, { min: 0 }) ?? null);
}

export function readPersistedMediaImageLayout(message: AgentMessage): MediaImageLayout | undefined {
  const record = asOptionalRecord(
    asOptionalRecord(Reflect.get(message, "__openclaw"))?.mediaImageLayout,
  );
  if (!record) {
    return undefined;
  }
  const slots = Array.isArray(record.slots)
    ? record.slots.flatMap((entry) => {
        const slot = asOptionalRecord(entry);
        if (slot?.kind !== "inline" && slot?.kind !== "offloaded") {
          return [];
        }
        const kind: MediaImageLayout["slots"][number]["kind"] = slot.kind;
        const factIndex = asSafeIntegerInRange(slot.factIndex, { min: 0 });
        return [
          {
            kind,
            ...(factIndex !== undefined ? { factIndex } : {}),
          },
        ];
      })
    : [];
  const suppressedFactIndexes = Array.isArray(record.suppressedFactIndexes)
    ? record.suppressedFactIndexes.filter(
        (entry): entry is number => asSafeIntegerInRange(entry, { min: 0 }) !== undefined,
      )
    : [];
  return slots.length > 0 || suppressedFactIndexes.length > 0
    ? { slots, suppressedFactIndexes }
    : undefined;
}
