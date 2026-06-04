import { createHash } from "node:crypto";

type StableHashState = {
  circularPaths: string[];
  unreadablePaths: string[];
  seen: WeakSet<object>;
};

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function childPath(path: string, key: string | number) {
  return `${path}[${JSON.stringify(key)}]`;
}

function normalizeForStableHash(value: unknown, state: StableHashState, path: string): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (state.seen.has(value)) {
    state.circularPaths.push(path);
    return null;
  }

  state.seen.add(value);
  if (Array.isArray(value)) {
    const entries: unknown[] = [];
    let length: number;
    try {
      length = value.length;
    } catch {
      state.seen.delete(value);
      state.unreadablePaths.push(path);
      return null;
    }
    for (let index = 0; index < length; index += 1) {
      let entry: unknown;
      try {
        entry = Reflect.get(value, index);
      } catch {
        state.unreadablePaths.push(childPath(path, index));
        entry = null;
      }
      entries.push(normalizeForStableHash(entry, state, childPath(path, index)));
    }
    state.seen.delete(value);
    return entries;
  }

  let keys: string[];
  try {
    keys = Object.keys(value).toSorted((left, right) => left.localeCompare(right));
  } catch {
    state.seen.delete(value);
    state.unreadablePaths.push(path);
    return null;
  }

  const record = value as Record<string, unknown>;
  const entries = keys.map((key) => {
    let entry: unknown;
    try {
      entry = Reflect.get(record, key);
    } catch {
      state.unreadablePaths.push(childPath(path, key));
      entry = null;
    }
    return [key, normalizeForStableHash(entry, state, childPath(path, key))] as const;
  });
  state.seen.delete(value);
  return Object.fromEntries(entries);
}

export function stableHash(value: unknown) {
  const state: StableHashState = {
    circularPaths: [],
    unreadablePaths: [],
    seen: new WeakSet<object>(),
  };
  const normalized = normalizeForStableHash(value, state, "$");
  const payload =
    state.circularPaths.length || state.unreadablePaths.length
      ? {
          normalized,
          circularPaths: state.circularPaths,
          unreadablePaths: state.unreadablePaths,
        }
      : normalized;
  return sha256(JSON.stringify(payload) ?? "null");
}
