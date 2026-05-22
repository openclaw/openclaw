import { i as OpenClawConfig } from "./types.openclaw-C58U02FA.js";
import { n as RuntimeEnv } from "./runtime-lEKWbTQa.js";

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