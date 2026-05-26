import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { t as BaseProbeResult } from "./types.core-BkmTlRzr.js";
//#region extensions/signal/src/client-adapter.d.ts
type SignalApiMode = "native" | "container" | "auto";
//#endregion
//#region extensions/signal/src/probe.d.ts
type SignalProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs: number;
  version?: string | null;
};
declare function probeSignal(baseUrl: string, timeoutMs: number, options?: {
  apiMode?: SignalApiMode;
}): Promise<SignalProbe>;
//#endregion
//#region extensions/signal/src/account-types.d.ts
type SignalAccountConfig = Omit<Exclude<NonNullable<OpenClawConfig["channels"]>["signal"], undefined>, "accounts">;
//#endregion
//#region extensions/signal/src/accounts.d.ts
type ResolvedSignalAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  baseUrl: string;
  configured: boolean;
  config: SignalAccountConfig;
};
declare const listSignalAccountIds: (cfg: OpenClawConfig) => string[];
declare const resolveDefaultSignalAccountId: (cfg: OpenClawConfig) => string;
declare function resolveSignalAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedSignalAccount;
declare function listEnabledSignalAccounts(cfg: OpenClawConfig): ResolvedSignalAccount[];
//#endregion
export { resolveSignalAccount as a, probeSignal as c, resolveDefaultSignalAccountId as i, listEnabledSignalAccounts as n, SignalAccountConfig as o, listSignalAccountIds as r, SignalProbe as s, ResolvedSignalAccount as t };