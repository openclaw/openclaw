/**
 * HTTP client for calling the B-FIA Python backend.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveBackendUrl } from "./config.js";

const TIMEOUT_MS = 30_000;

export async function callBfiaBackend(
  endpoint: string,
  body: Record<string, unknown>,
  cfg?: OpenClawConfig,
): Promise<Record<string, unknown>> {
  const baseUrl = resolveBackendUrl(cfg);
  const url = `${baseUrl}${endpoint}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "unknown error");
    throw new Error(`B-FIA backend error ${response.status}: ${detail}`);
  }

  return response.json() as Promise<Record<string, unknown>>;
}

export async function checkBfiaHealth(cfg?: OpenClawConfig): Promise<boolean> {
  const baseUrl = resolveBackendUrl(cfg);
  try {
    const resp = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}
