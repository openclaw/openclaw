import type { BaseProbeResult } from "openclaw/plugin-sdk/lanxin";
import { getLanxinValidToken } from "./token.js";
import type { ResolvedLanxinAccount } from "./types.js";

export type ProbeLanxinResult = BaseProbeResult<string> & {
  appId?: string;
};

/**
 * Probe Lanxin account connectivity.
 * Stub: not implemented yet.
 */
export async function probeLanxin(account: ResolvedLanxinAccount): Promise<ProbeLanxinResult> {
  if (!account.configured) {
    return { ok: false, error: "missing credentials (appId, appSecret)" };
  }
  try {
    await getLanxinValidToken(account);
    return { ok: true, appId: account.appId };
  } catch (err) {
    return { ok: false, appId: account.appId, error: String(err) };
  }
}
