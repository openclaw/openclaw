import type { SubagentRunRecord } from "./subagent-registry.types.js";

let subagentRegistryMemoryVersion = 0;

export function getSubagentRegistryMemoryVersion(): number {
  return subagentRegistryMemoryVersion;
}

export function bumpSubagentRegistryMemoryVersion(): number {
  subagentRegistryMemoryVersion =
    subagentRegistryMemoryVersion >= Number.MAX_SAFE_INTEGER
      ? 1
      : subagentRegistryMemoryVersion + 1;
  return subagentRegistryMemoryVersion;
}

class VersionedSubagentRunMap extends Map<string, SubagentRunRecord> {
  override set(runId: string, entry: SubagentRunRecord): this {
    super.set(runId, entry);
    bumpSubagentRegistryMemoryVersion();
    return this;
  }

  override delete(runId: string): boolean {
    const deleted = super.delete(runId);
    if (deleted) {
      bumpSubagentRegistryMemoryVersion();
    }
    return deleted;
  }

  override clear(): void {
    if (this.size === 0) {
      super.clear();
      return;
    }
    super.clear();
    bumpSubagentRegistryMemoryVersion();
  }
}

export const subagentRuns = new VersionedSubagentRunMap();
