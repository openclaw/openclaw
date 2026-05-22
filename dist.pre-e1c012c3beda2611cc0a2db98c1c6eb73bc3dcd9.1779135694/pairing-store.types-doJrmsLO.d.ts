import { t as ChannelId } from "./channel-id.types-6_tqDvH3.js";
import { t as ChannelPairingAdapter } from "./pairing.types-vAQB3Wrm.js";

//#region src/pairing/pairing-store.types.d.ts
type PairingChannel = ChannelId;
type ReadChannelAllowFromStoreForAccount = (params: {
  channel: PairingChannel;
  accountId: string;
  env?: NodeJS.ProcessEnv;
}) => Promise<string[]>;
type UpsertChannelPairingRequestForAccount = (params: {
  channel: PairingChannel;
  id: string | number;
  accountId: string;
  meta?: Record<string, string | undefined | null>;
  env?: NodeJS.ProcessEnv;
  pairingAdapter?: ChannelPairingAdapter;
}) => Promise<{
  code: string;
  created: boolean;
}>;
//#endregion
export { ReadChannelAllowFromStoreForAccount as n, UpsertChannelPairingRequestForAccount as r, PairingChannel as t };