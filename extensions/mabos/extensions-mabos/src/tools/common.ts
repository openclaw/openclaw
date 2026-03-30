/**
 * Shared helpers for all MABOS tool modules.
 */

import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

/**
 * Plugin config shape used by MABOS tools.
 */
export interface MabosPluginConfig {
  agents?: { defaults?: { workspace?: string } };
  workspaceDir?: string;
  ontologyDir?: string;
  cbrMaxCases?: number;
  stakeholderApprovalThresholdUsd?: number;
  bdiCycleIntervalMinutes?: number;
  cacheAwareLayoutEnabled?: boolean;
  cognitiveContextEnabled?: boolean;
  financialToolGuardEnabled?: boolean;
  llmMetricsEnabled?: boolean;
  preCompactionObserverEnabled?: boolean;
  autoRecallEnabled?: boolean;
  directiveRoutingEnabled?: boolean;
  inboxContextEnabled?: boolean;
  inboxWakeUpEnabled?: boolean;
  inboxWakeUpCooldownMinutes?: number;
  securityEnabled?: boolean;
  security?: import("../security/types.js").SecurityConfig;
  governanceEnabled?: boolean;
  governance?: import("../governance/types.js").GovernanceConfig;
  modelRouterEnabled?: boolean;
  modelRouter?: import("../model-router/types.js").ModelRouterConfig;
  sessionIntelEnabled?: boolean;
  sessionIntel?: import("../session-intel/types.js").SessionIntelConfig;
  sandboxEnabled?: boolean;
  sandbox?: import("../execution-sandbox/types.js").ExecutionSandboxConfig;
  skillLoopEnabled?: boolean;
  skillLoop?: import("../skill-loop/types.js").SkillLoopConfig;
}

/**
 * Generate a prefixed unique ID using crypto.randomUUID().
 */
export function generatePrefixedId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/** Status codes that are retryable. */
const RETRYABLE_STATUSES = new Set([0, 429, 502, 503, 504]);

/**
 * Make an HTTP request using built-in fetch with AbortController timeout.
 * Returns `{ status: 0, data: { error } }` on network or timeout errors.
 * Retries on network errors and 429/5xx with exponential backoff.
 */
export async function httpRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: unknown,
  timeoutMs = 5000,
  retries = 2,
): Promise<{ status: number; data: unknown }> {
  let lastResult: { status: number; data: unknown } = { status: 0, data: { error: "No attempts" } };

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 500ms, 1500ms
      const delay = attempt === 1 ? 500 : 1500;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", ...headers },
        body: body != null ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const data = await resp.json().catch(() => resp.text());
      lastResult = { status: resp.status, data };

      if (!RETRYABLE_STATUSES.has(resp.status)) {
        return lastResult;
      }
    } catch (err: unknown) {
      const msg =
        err instanceof Error && err.name === "AbortError" ? "Request timed out" : String(err);
      lastResult = {
        status: 0,
        data: { error: msg, url, method },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return lastResult;
}

/**
 * Create an AgentToolResult with text content.
 * Includes the required `details` field for pi-agent-core compatibility.
 */
export function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

/**
 * Resolve the workspace directory from the OpenClaw plugin API.
 * Falls back to process.cwd() if not available.
 */
export function resolveWorkspaceDir(api: OpenClawPluginApi): string {
  const config = api.config as MabosPluginConfig;
  return config?.agents?.defaults?.workspace || config?.workspaceDir || process.cwd();
}

/**
 * Get typed plugin config from the API.
 */
export function getPluginConfig(api: OpenClawPluginApi): MabosPluginConfig {
  return (api.pluginConfig ?? api.config ?? {}) as MabosPluginConfig;
}

export type ResolvedIntegrationEntry = {
  entry: Record<string, unknown>;
  sourcePath: string;
  businessId: string | null;
};

function isSafePathSegment(value: string): boolean {
  return !!value && !value.includes("..") && !value.includes("/") && !value.includes("\\");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export async function listWorkspaceBusinessIds(workspaceDir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(workspaceDir, "businesses"), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && isSafePathSegment(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export async function resolveWorkspaceIntegrationEntry(
  api: OpenClawPluginApi,
  integrationId: string,
  preferredBusinessId?: string,
): Promise<ResolvedIntegrationEntry | null> {
  const workspaceDir = resolveWorkspaceDir(api);
  const orderedBusinessIds = new Set<string>();

  if (preferredBusinessId && isSafePathSegment(preferredBusinessId)) {
    orderedBusinessIds.add(preferredBusinessId);
  }

  for (const businessId of await listWorkspaceBusinessIds(workspaceDir)) {
    orderedBusinessIds.add(businessId);
  }

  const candidateSources = [
    ...Array.from(orderedBusinessIds, (businessId) => ({
      sourcePath: join(workspaceDir, "businesses", businessId, "integrations.json"),
      businessId,
    })),
    {
      sourcePath: join(workspaceDir, "integrations.json"),
      businessId: null,
    },
  ];

  for (const source of candidateSources) {
    try {
      const parsed = JSON.parse(await readFile(source.sourcePath, "utf-8")) as unknown;
      const store = asRecord(parsed);
      const integrations = store && Array.isArray(store.integrations) ? store.integrations : [];
      for (const integration of integrations) {
        const entry = asRecord(integration);
        if (!entry) {
          continue;
        }
        if (entry.id !== integrationId) {
          continue;
        }
        if (entry.enabled === false) {
          continue;
        }
        return {
          entry,
          sourcePath: source.sourcePath,
          businessId: source.businessId,
        };
      }
    } catch {
      // Skip unreadable files; continue scanning remaining business scopes.
    }
  }

  return null;
}
