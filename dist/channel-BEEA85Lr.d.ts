import { n as ChannelPlugin } from "./types.public-B2Ho5PN_.js";
//#region extensions/tlon/src/types.d.ts
type TlonResolvedAccount = {
  accountId: string;
  name: string | null;
  enabled: boolean;
  configured: boolean;
  ship: string | null;
  url: string | null;
  code: string | null;
  dangerouslyAllowPrivateNetwork: boolean | null;
  groupChannels: string[];
  dmAllowlist: string[]; /** Ships allowed to invite us to groups (security: prevent malicious group invites) */
  groupInviteAllowlist: string[];
  autoDiscoverChannels: boolean | null;
  showModelSignature: boolean | null;
  autoAcceptDmInvites: boolean | null;
  autoAcceptGroupInvites: boolean | null;
  defaultAuthorizedShips: string[]; /** Ship that receives approval requests for DMs, channel mentions, and group invites */
  ownerShip: string | null;
};
//#endregion
//#region extensions/tlon/src/channel.d.ts
declare const tlonPlugin: ChannelPlugin<TlonResolvedAccount, unknown, unknown>;
//#endregion
export { tlonPlugin as t };