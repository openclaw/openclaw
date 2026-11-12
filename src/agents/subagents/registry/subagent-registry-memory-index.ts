import type { SubagentRunRecord } from "./subagent-registry.types.js";

export class SubagentRunIndex extends Map<string, SubagentRunRecord[]> {
  constructor(private readonly keyFor: (entry: SubagentRunRecord) => string | undefined) {
    super();
  }

  update(previous?: SubagentRunRecord, entry?: SubagentRunRecord): void {
    const previousKey = previous && this.keyFor(previous);
    const key = entry && this.keyFor(entry);
    if (previousKey && previousKey !== key) {
      const bucket = this.get(previousKey);
      const position = bucket && previous ? bucket.indexOf(previous) : -1;
      if (bucket && position >= 0) {
        bucket.splice(position, 1);
        if (bucket.length === 0) {
          this.delete(previousKey);
        }
      }
    }
    if (!key || !entry) {
      return;
    }
    const bucket = this.get(key);
    if (bucket?.length === 1 && bucket[0] === previous) {
      bucket[0] = entry;
    } else if (bucket) {
      // Replacement moves to the end, preserving the collector's last-published lookup.
      const position = previous ? bucket.indexOf(previous) : -1;
      if (position >= 0) {
        bucket.splice(position, 1);
      }
      bucket.push(entry);
    } else {
      this.set(key, [entry]);
    }
  }

  getLatest(key: string): SubagentRunRecord | undefined {
    return this.get(key)?.at(-1);
  }
}
