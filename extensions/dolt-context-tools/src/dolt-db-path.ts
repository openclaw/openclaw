import type { OpenClawConfig } from "openclaw/plugin-sdk";
import os from "node:os";
import path from "node:path";

const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;

/**
 * Normalize agent IDs using the same canonicalization strategy as session routing.
 */
export function normalizeAgentId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return "main";
  }
  if (VALID_ID_RE.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return (
    trimmed
      .toLowerCase()
      .replace(INVALID_CHARS_RE, "-")
      .replace(LEADING_DASH_RE, "")
      .replace(TRAILING_DASH_RE, "")
      .slice(0, 64) || "main"
  );
}

/**
 * Resolve the Dolt DB path for an agent-scoped context.
 *
 * This mirrors DoltContextEngine.resolveDbPath semantics:
 * - no agent id => <stateDir>/dolt.db
 * - agent id + configured agentDir => dirname(agentDir)/dolt.db
 * - agent id fallback => <stateDir>/agents/<agentId>/dolt.db
 */
export function resolveDoltDbPath(params: {
  resolveStateDir: () => string;
  config?: OpenClawConfig;
  agentId?: string;
}): string {
  const agentId = normalizeOptionalString(params.agentId);
  if (!agentId) {
    return path.join(params.resolveStateDir(), "dolt.db");
  }

  const normalizedAgentId = normalizeAgentId(agentId);
  const configuredAgentDir = resolveConfiguredAgentDir({
    config: params.config,
    normalizedAgentId,
  });
  const agentRoot = configuredAgentDir
    ? path.dirname(configuredAgentDir)
    : path.join(params.resolveStateDir(), "agents", normalizedAgentId);

  return path.join(agentRoot, "dolt.db");
}

/**
 * Resolve an agentDir override from config, if present.
 */
function resolveConfiguredAgentDir(params: {
  config?: OpenClawConfig;
  normalizedAgentId: string;
}): string | null {
  const list = params.config?.agents?.list;
  if (!Array.isArray(list)) {
    return null;
  }

  for (const entry of list) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    if (normalizeAgentId(entry.id) !== params.normalizedAgentId) {
      continue;
    }
    const configured = normalizeOptionalString(entry.agentDir);
    if (!configured) {
      return null;
    }
    return resolveUserPath(configured);
  }
  return null;
}

/**
 * Expand a user path in the same spirit as core config path resolution.
 */
function resolveUserPath(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return path.resolve(input);
}

function normalizeOptionalString(value: string | undefined | null): string | null {
  const normalized = (value ?? "").trim();
  return normalized.length > 0 ? normalized : null;
}
