import type { ZcaUserInfo } from "./types.js";
import { runZca, parseJsonOutput } from "./zca.js";

export interface ZalouserProbeResult {
  ok: boolean;
  user?: ZcaUserInfo;
  error?: string;
}

export async function probeZalouser(
  profile: string,
  timeoutMs?: number,
): Promise<ZalouserProbeResult> {
  const result = await runZca(["me", "info", "-j"], {
    profile,
    timeout: timeoutMs,
  });

  if (!result.ok) {
    return { ok: false, error: result.stderr || "Failed to probe" };
  }

  const user = parseJsonOutput<ZcaUserInfo>(result.stdout);
  if (!user) {
    return { ok: false, error: "Failed to parse user info" };
  }
  return { ok: true, user };
}
