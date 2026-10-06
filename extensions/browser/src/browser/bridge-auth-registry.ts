/**
 * Ephemeral auth registry for loopback browser bridge servers.
 *
 * Dynamic sandbox/host ports need auth lookup without persisting tokens in
 * config files, so callers store credentials only for the current process.
 */
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { BrowserControlAuth } from "./control-auth.js";

const authByPort = new Map<number, BrowserControlAuth>();

export function setBridgeAuthForPort(port: number, auth: BrowserControlAuth): void {
  if (!Number.isFinite(port) || port <= 0) {
    return;
  }
  authByPort.set(port, {
    token: normalizeOptionalString(auth.token),
    password: normalizeOptionalString(auth.password),
  });
}

export function getBridgeAuthForPort(port: number): BrowserControlAuth | undefined {
  return authByPort.get(port);
}

export function deleteBridgeAuthForPort(port: number): void {
  authByPort.delete(port);
}
