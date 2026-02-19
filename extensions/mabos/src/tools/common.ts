/**
 * Shared helpers for all MABOS tool modules.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

/**
 * Make an HTTP request using built-in fetch with AbortController timeout.
 * Returns `{ status: 0, data: { error } }` on network or timeout errors.
 */
export async function httpRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: any,
  timeoutMs = 5000,
): Promise<{ status: number; data: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = await resp.json().catch(() => resp.text());
    return { status: resp.status, data };
  } catch (err: any) {
    const msg = err?.name === "AbortError" ? "Request timed out" : String(err);
    return { status: 0, data: { error: msg } };
  } finally {
    clearTimeout(timer);
  }
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
  // The config object has agents.defaults.workspace at runtime
  const config = api.config as any;
  return config?.agents?.defaults?.workspace || config?.workspaceDir || process.cwd();
}
