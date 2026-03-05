import { createHmac } from "node:crypto";
import { resolveRelayAcceptedTokensForPort } from "./utils.js";

const RELAY_TOKEN_CONTEXT = "openclaw-extension-relay-v1";
const DEFAULT_RELAY_PROBE_TIMEOUT_MS = 500;
const OPENCLAW_RELAY_BROWSER = "OpenClaw/extension-relay";

import fs from "node:fs";
import path from "node:path";

export function resolveRelayAuthTokenForPort(port: number): string {
  return resolveRelayAcceptedTokensForPort(port)[0];
}

export async function probeAuthenticatedOpenClawRelay(params: {
  baseUrl: string;
  relayAuthHeader: string;
  relayAuthToken: string;
  timeoutMs?: number;
}): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), params.timeoutMs ?? DEFAULT_RELAY_PROBE_TIMEOUT_MS);
  try {
    const versionUrl = new URL("/json/version", `${params.baseUrl}/`).toString();
    const res = await fetch(versionUrl, {
      signal: ctrl.signal,
      headers: { [params.relayAuthHeader]: params.relayAuthToken },
    });
    if (!res.ok) {
      return false;
    }
    const body = (await res.json()) as { Browser?: unknown };
    const browserName = typeof body?.Browser === "string" ? body.Browser.trim() : "";
    return browserName === OPENCLAW_RELAY_BROWSER;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
