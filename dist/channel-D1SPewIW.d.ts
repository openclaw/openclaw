import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { l as SecretInput } from "./types.secrets-tbFW-hY6.js";
import { n as ChannelPlugin } from "./types.public-B2Ho5PN_.js";
//#region extensions/nostr/src/config-schema.d.ts
interface NostrProfile {
  name?: string;
  displayName?: string;
  about?: string;
  picture?: string;
  banner?: string;
  website?: string;
  nip05?: string;
  lud16?: string;
}
//#endregion
//#region extensions/nostr/src/types.d.ts
interface NostrAccountConfig {
  enabled?: boolean;
  name?: string;
  defaultAccount?: string;
  privateKey?: SecretInput;
  relays?: string[];
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: Array<string | number>;
  profile?: NostrProfile;
}
interface ResolvedNostrAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  privateKey: string;
  publicKey: string;
  relays: string[];
  profile?: NostrProfile;
  config: NostrAccountConfig;
}
/**
 * Resolve a Nostr account from config
 */
declare function resolveNostrAccount(opts: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedNostrAccount;
//#endregion
//#region extensions/nostr/src/channel.d.ts
declare const nostrPlugin: ChannelPlugin<ResolvedNostrAccount>;
//#endregion
export { NostrProfile as i, ResolvedNostrAccount as n, resolveNostrAccount as r, nostrPlugin as t };