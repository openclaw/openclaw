import JSON5 from "json5";
import fs from "node:fs";
import { resolveStorePath } from "../config/sessions/paths.js";
import { getSubagentDepth, parseAgentSessionKey } from "../sessions/session-key-utils.js";

function normalizeSpawnDepth(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const numeric = Number(trimmed);
    return Number.isInteger(numeric) && numeric >= 0 ? numeric : undefined;
  }
  return undefined;
}

function readSessionStore(storePath: string): Record<string, { spawnDepth?: unknown }> {
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    const parsed = JSON5.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, { spawnDepth?: unknown }>;
    }
  } catch {
    // ignore missing/invalid stores
  }
  return {};
}

export function getSubagentDepthFromSessionStore(
  sessionKey: string | undefined | null,
  opts?: {
    cfg?: { session?: { store?: string } };
    store?: Record<string, { spawnDepth?: unknown }>;
  },
): number {
  const raw = (sessionKey ?? "").trim();
  const fallbackDepth = getSubagentDepth(raw);
  if (!raw) {
    return fallbackDepth;
  }

  const parsed = parseAgentSessionKey(raw);
  if (!parsed?.agentId) {
    return fallbackDepth;
  }

  const store = (() => {
    if (opts?.store) {
      return opts.store;
    }
    if (!opts?.cfg) {
      return undefined;
    }
    const storePath = resolveStorePath(opts.cfg.session?.store, { agentId: parsed.agentId });
    return readSessionStore(storePath);
  })();

  const storedDepth = normalizeSpawnDepth(store?.[raw]?.spawnDepth);
  return storedDepth ?? fallbackDepth;
}
