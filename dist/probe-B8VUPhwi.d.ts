import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { n as RuntimeEnv } from "./runtime-Bxifh4bY.js";
import { t as BaseProbeResult } from "./types.core-BkmTlRzr.js";
//#region extensions/imessage/src/account-types.d.ts
type IMessageAccountConfig = Omit<NonNullable<NonNullable<OpenClawConfig["channels"]>["imessage"]>, "accounts" | "defaultAccount">;
//#endregion
//#region extensions/imessage/src/accounts.d.ts
type ResolvedIMessageAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  config: IMessageAccountConfig;
  configured: boolean;
};
declare const listIMessageAccountIds: (cfg: OpenClawConfig) => string[];
declare const resolveDefaultIMessageAccountId: (cfg: OpenClawConfig) => string;
declare function resolveIMessageAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedIMessageAccount;
declare function listEnabledIMessageAccounts(cfg: OpenClawConfig): ResolvedIMessageAccount[];
//#endregion
//#region extensions/imessage/src/normalize.d.ts
declare function normalizeIMessageMessagingTarget(raw: string): string | undefined;
declare function looksLikeIMessageTargetId(raw: string): boolean;
//#endregion
//#region extensions/imessage/src/private-api-status.d.ts
type IMessagePrivateApiStatus = {
  available: boolean;
  v2Ready: boolean;
  selectors: Record<string, boolean>;
  rpcMethods: string[];
  cliCapabilities?: {
    sendRichSupportsAttachment?: boolean;
  };
  error?: string;
};
//#endregion
//#region extensions/imessage/src/constants.d.ts
/** Default timeout for iMessage probe/RPC operations (10 seconds). */
declare const DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS = 10000;
//#endregion
//#region extensions/imessage/src/probe.d.ts
type IMessageProbe = BaseProbeResult & {
  fatal?: boolean;
  privateApi?: IMessagePrivateApiStatus;
};
type IMessageProbeOptions = {
  cliPath?: string;
  dbPath?: string;
  platform?: NodeJS.Platform;
  runtime?: RuntimeEnv;
};
/**
 * Probe iMessage RPC availability.
 * @param timeoutMs - Explicit timeout in ms. If undefined, uses config or default.
 * @param opts - Additional options (cliPath, dbPath, runtime).
 */
declare function probeIMessage(timeoutMs?: number, opts?: IMessageProbeOptions): Promise<IMessageProbe>;
//#endregion
export { looksLikeIMessageTargetId as a, listEnabledIMessageAccounts as c, resolveIMessageAccount as d, DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS as i, listIMessageAccountIds as l, IMessageProbeOptions as n, normalizeIMessageMessagingTarget as o, probeIMessage as r, ResolvedIMessageAccount as s, IMessageProbe as t, resolveDefaultIMessageAccountId as u };