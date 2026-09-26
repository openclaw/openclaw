import { setTimeout as sleep } from "node:timers/promises";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { discardIgnoredResponseBody } from "./ignored-response-body.js";

export async function waitForQaHttpReady(
  url: string,
  timeoutMs: number,
  pollIntervalMs: number,
  auditContext: string,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { response, release } = await fetchWithSsrFGuard({
        url,
        policy: { allowPrivateNetwork: true },
        timeoutMs: Math.max(1, deadline - Date.now()),
        auditContext,
      });
      try {
        const ready = response.ok;
        await discardIgnoredResponseBody(response);
        if (ready) {
          return true;
        }
      } finally {
        await release();
      }
    } catch {
      // A release failure also retries, even after a healthy response.
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await sleep(Math.min(pollIntervalMs, remainingMs));
    }
  }
  return false;
}
