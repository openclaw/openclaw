export type ConfigDraft = Record<string, unknown>;

const STORAGE_KEY = "openclaw.config-builder.v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneDraft(input: ConfigDraft): ConfigDraft {
  if (typeof structuredClone === "function") {
    return structuredClone(input);
  }
  return JSON.parse(JSON.stringify(input)) as ConfigDraft;
}

function normalizePath(path: string): string[] {
  return path
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
}

function pruneEmptyObjects(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const next: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    const cleaned = pruneEmptyObjects(nested);
    if (cleaned === undefined) {
      continue;
    }
    if (isRecord(cleaned) && Object.keys(cleaned).length === 0) {
      continue;
    }
    next[key] = cleaned;
  }
  return Object.keys(next).length === 0 ? undefined : next;
}

export function getFieldValue(config: ConfigDraft, path: string): unknown {
  const segments = normalizePath(path);
  let current: unknown = config;
  for (const segment of segments) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

export function setFieldValue(config: ConfigDraft, path: string, value: unknown): ConfigDraft {
  const segments = normalizePath(path);
  if (segments.length === 0) {
    return config;
  }

  const next = cloneDraft(config);
  let cursor: Record<string, unknown> = next;

  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (!segment) {
      continue;
    }
    const existing = cursor[segment];
    if (isRecord(existing)) {
      cursor = existing;
      continue;
    }
    const child: Record<string, unknown> = {};
    cursor[segment] = child;
    cursor = child;
  }

  const leaf = segments.at(-1);
  if (!leaf) {
    return next;
  }

  cursor[leaf] = value;
  return next;
}

export function clearFieldValue(config: ConfigDraft, path: string): ConfigDraft {
  const segments = normalizePath(path);
  if (segments.length === 0) {
    return config;
  }

  const next = cloneDraft(config);
  const parents: Array<Record<string, unknown>> = [];
  let cursor: unknown = next;

  for (let index = 0; index < segments.length - 1; index += 1) {
    if (!isRecord(cursor)) {
      return next;
    }
    const segment = segments[index];
    if (!segment) {
      return next;
    }
    parents.push(cursor);
    cursor = cursor[segment];
  }

  if (!isRecord(cursor)) {
    return next;
  }

  const leaf = segments.at(-1);
  if (!leaf) {
    return next;
  }

  delete cursor[leaf];

  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const parent = parents[index];
    const key = segments[index];
    if (!parent || !key) {
      continue;
    }
    const child = parent[key];
    if (!isRecord(child)) {
      continue;
    }
    if (Object.keys(child).length === 0) {
      delete parent[key];
    }
  }

  const cleaned = pruneEmptyObjects(next);
  return isRecord(cleaned) ? cleaned : {};
}

export function resetDraft(): ConfigDraft {
  return {};
}

export function loadPersistedDraft(storage: Storage | null = globalThis.localStorage ?? null): ConfigDraft {
  if (!storage) {
    return {};
  }
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function persistDraft(
  config: ConfigDraft,
  storage: Storage | null = globalThis.localStorage ?? null,
): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // best-effort persistence only
  }
}
