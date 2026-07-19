// Zalouser plugin module implements probe behavior.
import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import type { ZcaUserInfo } from "./types.js";
import { getZaloUserInfo } from "./zalo-js.js";

export type ZalouserProbeResult = BaseProbeResult<string> & {
  user?: ZcaUserInfo;
};

type ProbeLookupOutcome = { kind: "user"; user: ZcaUserInfo | null } | { kind: "timeout" };

export async function probeZalouser(
  profile: string,
  timeoutMs?: number,
): Promise<ZalouserProbeResult> {
  try {
    let outcome: ProbeLookupOutcome;
    if (timeoutMs) {
      const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, 1000, 1000);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        // Discriminate timeout from a real null user so channel status.probe
        // does not report "Not authenticated" when the lookup merely stalled.
        // getZaloUserInfo is not abortable yet; the race still ends the probe.
        outcome = await Promise.race([
          getZaloUserInfo(profile).then((user): ProbeLookupOutcome => ({ kind: "user", user })),
          new Promise<ProbeLookupOutcome>((resolve) => {
            timeout = setTimeout(() => resolve({ kind: "timeout" }), resolvedTimeoutMs);
          }),
        ]);
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }
    } else {
      outcome = { kind: "user", user: await getZaloUserInfo(profile) };
    }

    if (outcome.kind === "timeout") {
      return { ok: false, error: "timed out" };
    }
    if (!outcome.user) {
      return { ok: false, error: "Not authenticated" };
    }

    return { ok: true, user: outcome.user };
  } catch (error) {
    return {
      ok: false,
      error: formatErrorMessage(error),
    };
  }
}
