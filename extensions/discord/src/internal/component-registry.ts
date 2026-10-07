import { parseCustomId } from "./components.base.js";

export class ComponentRegistry<
  T extends { customId: string; customIdParser?: typeof parseCustomId; type?: number },
> {
  private entries = new Map<string, T[]>();
  private wildcardEntries: T[] = [];

  register(entry: T): void {
    const key = (entry.customIdParser ?? parseCustomId)(entry.customId).key;
    if (key === "*") {
      if (!this.wildcardEntries.includes(entry)) {
        this.wildcardEntries.push(entry);
      }
      return;
    }
    const entries = this.entries.get(key) ?? [];
    if (!entries.includes(entry)) {
      entries.push(entry);
      this.entries.set(key, entries);
    }
  }

  resolve(customId: string, options?: { componentType?: number }): T | undefined {
    for (const entries of this.entries.values()) {
      const match = entries.find((entry) => {
        if (options?.componentType !== undefined && entry.type !== options.componentType) {
          return false;
        }
        const parser = entry.customIdParser ?? parseCustomId;
        return parser(entry.customId).key === parser(customId).key;
      });
      if (match) {
        return match;
      }
    }
    return this.wildcardEntries.find(
      (entry) => options?.componentType === undefined || entry.type === options.componentType,
    );
  }
}
