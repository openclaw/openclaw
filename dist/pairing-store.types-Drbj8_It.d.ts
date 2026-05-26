import { t as ChannelId } from "./channel-id.types-ClK6B_QE.js";
import { t as ChannelPairingAdapter } from "./pairing.types-DRe9rMoD.js";

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