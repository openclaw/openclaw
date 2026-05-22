import { n as ChannelPlugin } from "../../types.public-D_xOTs5v.js";
//#region extensions/nostr/src/channel.setup.d.ts
type NostrAccountConfig = {
  enabled?: boolean;
  name?: string;
  defaultAccount?: string;
  privateKey?: unknown;
  relays?: string[];
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: Array<string | number>;
  profile?: unknown;
};
type ResolvedNostrSetupAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  privateKey: string;
  publicKey: string;
  relays: string[];
  profile?: unknown;
  config: NostrAccountConfig;
};
declare const nostrSetupPlugin: ChannelPlugin<ResolvedNostrSetupAccount>;
//#endregion
export { nostrSetupPlugin };