/**
 * Shared helpers for all MABOS tool modules.
 */

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
