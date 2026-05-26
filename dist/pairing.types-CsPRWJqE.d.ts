import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { n as RuntimeEnv } from "./runtime-CZFxIuHh.js";

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