import { runZca, parseJsonOutput } from "./zca.js";
import type { ZcaUserInfo } from "./types.js";

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
    timeout: timeoutMs ?? 10000,
  });

  if (!result.ok) {
    return { ok: false, error: result.stderr || "Failed to probe" };
  }

  try {
    const user = parseJsonOutput<ZcaUserInfo>(result.stdout);
    return { ok: true, user: user ?? undefined };
  } catch {
    return { ok: false, error: "Failed to parse user info" };
  }
}
