import { createHash } from "node:crypto";
import type { Entity, RedactResult, RedactStrategy } from "./types.js";

export function redact(
  text: string,
  entities: Entity[],
  strategy: RedactStrategy = "token",
): RedactResult {
  if (entities.length === 0) {
    return { redacted_text: text, mapping: {}, entities: [] };
  }

  // Sort by start position descending so we replace from end to start
  // without corrupting earlier offsets
  const sorted = [...entities].sort((a, b) => b.start - a.start);

  const counters: Record<string, number> = {};
  const mapping: Record<string, string> = {};
  let result = text;

  for (const entity of sorted) {
    const replacement = makeReplacement(entity, strategy, counters);
    mapping[replacement] = entity.text;
    result = result.slice(0, entity.start) + replacement + result.slice(entity.end);
  }

  return { redacted_text: result, mapping, entities };
}

function makeReplacement(
  entity: Entity,
  strategy: RedactStrategy,
  counters: Record<string, number>,
): string {
  switch (strategy) {
    case "token": {
      counters[entity.label] = (counters[entity.label] ?? 0) + 1;
      return `[${entity.label}_${counters[entity.label]}]`;
    }
    case "mask": {
      return "*".repeat(Math.max(entity.text.length, 1));
    }
    case "hash": {
      const digest = createHash("sha256")
        .update(entity.text)
        .digest("hex")
        .slice(0, 12);
      return `[${entity.label}_${digest}]`;
    }
  }
}
