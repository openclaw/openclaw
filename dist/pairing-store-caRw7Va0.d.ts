import { t as ChannelPairingAdapter } from "./pairing.types-DRe9rMoD.js";
import { t as PairingChannel } from "./pairing-store.types-Drbj8_It.js";

//#region src/pairing/pairing-challenge.d.ts
type PairingMeta = Record<string, string | undefined>;
type PairingChallengeParams = {
  channel: string;
  senderId: string;
  senderIdLine: string;
  meta?: PairingMeta;
  upsertPairingRequest: (params: {
    id: string;
    meta?: PairingMeta;
  }) => Promise<{
    code: string;
    created: boolean;
  }>;
  sendPairingReply: (text: string) => Promise<void>;
  buildReplyText?: (params: {
    code: string;
    senderIdLine: string;
  }) => string;
  onCreated?: (params: {
    code: string;
  }) => void;
  onReplyError?: (err: unknown) => void;
};
/**
 * Shared pairing challenge issuance for DM pairing policy pathways.
 * Ensures every channel follows the same create-if-missing + reply flow.
 */
declare function issuePairingChallenge(params: PairingChallengeParams): Promise<{
  created: boolean;
  code?: string;
}>;
//#endregion
//#region src/pairing/pairing-store.d.ts
type PairingRequest = {
  id: string;
  code: string;
  createdAt: string;
  lastSeenAt: string;
  meta?: Record<string, string>;
};
declare function resolveChannelAllowFromPath(channel: PairingChannel, env?: NodeJS.ProcessEnv, accountId?: string): string;
declare function readLegacyChannelAllowFromStore(channel: PairingChannel, env?: NodeJS.ProcessEnv): Promise<string[]>;
declare function readChannelAllowFromStore(channel: PairingChannel, env?: NodeJS.ProcessEnv, accountId?: string): Promise<string[]>;
declare function readLegacyChannelAllowFromStoreSync(channel: PairingChannel, env?: NodeJS.ProcessEnv): string[];
declare function readChannelAllowFromStoreSync(channel: PairingChannel, env?: NodeJS.ProcessEnv, accountId?: string): string[];
declare function clearPairingAllowFromReadCacheForTest(): void;
type AllowFromStoreEntryUpdateParams = {
  channel: PairingChannel;
  entry: string | number;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
};
declare function addChannelAllowFromStoreEntry(params: AllowFromStoreEntryUpdateParams): Promise<{
  changed: boolean;
  allowFrom: string[];
}>;
declare function removeChannelAllowFromStoreEntry(params: AllowFromStoreEntryUpdateParams): Promise<{
  changed: boolean;
  allowFrom: string[];
}>;
declare function listChannelPairingRequests(channel: PairingChannel, env?: NodeJS.ProcessEnv, accountId?: string): Promise<PairingRequest[]>;
declare function upsertChannelPairingRequest(params: {
  channel: PairingChannel;
  id: string | number;
  accountId: string;
  meta?: Record<string, string | undefined | null>;
  env?: NodeJS.ProcessEnv; /** Extension channels can pass their adapter directly to bypass registry lookup. */
  pairingAdapter?: ChannelPairingAdapter;
}): Promise<{
  code: string;
  created: boolean;
}>;
declare function approveChannelPairingCode(params: {
  channel: PairingChannel;
  code: string;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  id: string;
  entry?: PairingRequest;
} | null>;
//#endregion
export { listChannelPairingRequests as a, readLegacyChannelAllowFromStore as c, resolveChannelAllowFromPath as d, upsertChannelPairingRequest as f, clearPairingAllowFromReadCacheForTest as i, readLegacyChannelAllowFromStoreSync as l, issuePairingChallenge as m, addChannelAllowFromStoreEntry as n, readChannelAllowFromStore as o, PairingChallengeParams as p, approveChannelPairingCode as r, readChannelAllowFromStoreSync as s, PairingRequest as t, removeChannelAllowFromStoreEntry as u };