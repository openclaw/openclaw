import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import type { CoreConfig } from "../../types.js";
import { resolveMatrixAccountAllowlistConfig } from "../account-config.js";
import {
  resolveMatrixMonitorLiveUserAllowlist,
  type MatrixResolvedAllowlistEntry,
} from "./config.js";

/**
 * Builds the verification-transfer authorization reader. It reuses the startup
 * allowlist preparation owner so an opted-in name entry keeps resolving through
 * its startup-resolved id instead of falling back to the raw display name.
 */
export function createMatrixVerificationLiveAuthorizationResolver(params: {
  getConfig: () => CoreConfig;
  accountId: string;
  allowFromResolvedEntries: readonly MatrixResolvedAllowlistEntry[];
  runtime: RuntimeEnv;
}): () => Promise<{ cfg: CoreConfig; allowFrom: string[] }> {
  return async () => {
    const cfg = params.getConfig();
    return {
      cfg,
      allowFrom: await resolveMatrixMonitorLiveUserAllowlist({
        cfg,
        accountId: params.accountId,
        entries: resolveMatrixAccountAllowlistConfig({
          cfg,
          accountId: params.accountId,
        }).dmAllowFrom,
        startupResolvedEntries: params.allowFromResolvedEntries,
        runtime: params.runtime,
      }),
    };
  };
}
