const DEFAULT_PERSIST_DEBOUNCE_MS = 250;
const BEFORE_EXIT_FLUSHERS_KEY = Symbol.for("openclaw.wemp.feature-storage.before-exit-flushers");

type BeforeExitFlushRegistry = {
  installed: boolean;
  flushers: Map<string, () => void>;
};

export function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

export function resolvePersistDebounceMs(...candidates: Array<unknown>): number {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    const text = String(candidate).trim();
    if (!text) continue;
    const parsed = Number(text);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return DEFAULT_PERSIST_DEBOUNCE_MS;
}

function getBeforeExitFlushRegistry(): BeforeExitFlushRegistry {
  const scopedGlobal = globalThis as typeof globalThis & {
    [BEFORE_EXIT_FLUSHERS_KEY]?: BeforeExitFlushRegistry;
  };
  const existing = scopedGlobal[BEFORE_EXIT_FLUSHERS_KEY];
  if (existing) return existing;
  const created: BeforeExitFlushRegistry = { installed: false, flushers: new Map() };
  scopedGlobal[BEFORE_EXIT_FLUSHERS_KEY] = created;
  return created;
}

export function registerBeforeExitFlusher(name: string, flusher: () => void): void {
  const registry = getBeforeExitFlushRegistry();
  registry.flushers.set(name, flusher);
  if (registry.installed) return;
  registry.installed = true;
  // 全局只注册一个监听，避免模块热重载时重复绑定。
  process.on("beforeExit", () => {
    for (const flush of registry.flushers.values()) flush();
  });
}
