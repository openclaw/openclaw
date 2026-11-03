import { chromium } from "playwright-core";
import { vi } from "vitest";

export const reattachRelayPage = vi.fn(
  async (_browser: unknown, _targetId: string, _timeout: number) => false,
);
export class RelayPageRecoveryTimeoutError extends Error {}

export class UnresponsiveCdpTargetError extends Error {
  constructor(targetIds: string[]) {
    super(targetIds.join(", "));
  }
}

/** Test transport that preserves the existing Playwright connection spies. */
export function connectOverCdpTransport(
  connectionUrl: string,
  opts: { timeout: number; headers: Record<string, string> },
) {
  return chromium.connectOverCDP(connectionUrl, {
    timeout: opts.timeout,
    headers: opts.headers,
  });
}
