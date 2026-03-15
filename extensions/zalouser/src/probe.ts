import type { BaseProbeResult } from "openclaw/plugin-sdk/zalouser";
import type { ZcaUserInfo } from "./types.js";
import { getZaloUserInfo } from "./zalo-js.js";

export type ZalouserProbeResult = BaseProbeResult<string> & {
  user?: ZcaUserInfo;
};

export async function probeZalouser(
  profile: string,
  timeoutMs?: number,
): Promise<ZalouserProbeResult> {
  try {
    let user: ZcaUserInfo | null;
    if (timeoutMs) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        user = await Promise.race([
          getZaloUserInfo(profile),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), Math.max(timeoutMs, 1000));
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    } else {
      user = await getZaloUserInfo(profile);
    }

    if (!user) {
      return { ok: false, error: "Not authenticated" };
    }

    return { ok: true, user };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
