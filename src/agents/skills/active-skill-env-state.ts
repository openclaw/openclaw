/**
 * Shared mutable state tracking which env vars are currently injected by skill overrides.
 * Extracted into its own module to avoid a circular dependency between config.ts and env-overrides.ts.
 * @see https://github.com/openclaw/openclaw/issues/36280
 */

export type ActiveSkillEnvEntry = {
  baseline: string | undefined;
  value: string;
  count: number;
};

const activeSkillEnvEntries = new Map<string, ActiveSkillEnvEntry>();

/** Returns a snapshot of env var keys currently injected by skill overrides. */
export function getActiveSkillEnvKeys(): ReadonlySet<string> {
  return new Set(activeSkillEnvEntries.keys());
}

export function getActiveSkillEnvEntry(key: string): ActiveSkillEnvEntry | undefined {
  return activeSkillEnvEntries.get(key);
}

export function setActiveSkillEnvEntry(key: string, entry: ActiveSkillEnvEntry): void {
  activeSkillEnvEntries.set(key, entry);
}

export function deleteActiveSkillEnvEntry(key: string): void {
  activeSkillEnvEntries.delete(key);
}

export function hasActiveSkillEnvEntry(key: string): boolean {
  return activeSkillEnvEntries.has(key);
}
