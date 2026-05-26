import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { n as RuntimeEnv } from "./runtime-Bxifh4bY.js";

//#region src/channels/plugins/pairing.types.d.ts
type ChannelPairingAdapter = {
  idLabel: string;
  normalizeAllowEntry?: (entry: string) => string;
  notifyApproval?: (params: {
    cfg: OpenClawConfig;
    id: string;
    accountId?: string;
    runtime?: RuntimeEnv;
  }) => Promise<void>;
};
//#endregion
export { ChannelPairingAdapter as t };