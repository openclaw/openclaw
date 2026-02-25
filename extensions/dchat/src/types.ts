/**
 * D-Chat/nMobile wire format types.
 * Matches the MessageData envelope sent over NKN relay for full interop
 * with D-Chat Desktop and nMobile.
 */

export type MessageContentType =
  | "text"
  | "textExtension"
  | "image"
  | "audio"
  | "video"
  | "file"
  | "ipfs"
  | "piece"
  | "receipt"
  | "contact"
  | "contactOptions"
  | "deviceInfo"
  | "deviceRequest"
  | "topic:subscribe"
  | "topic:unsubscribe"
  | "privateGroup:invitation"
  | "privateGroup:accept"
  | "privateGroup:subscribe"
  | "privateGroup:quit"
  | "privateGroup:optionRequest"
  | "privateGroup:optionResponse"
  | "privateGroup:memberRequest"
  | "privateGroup:memberResponse"
  | "read"
  | "discovery:broadcast";

/** Control content types that should not be forwarded to the agent. */
export const CONTROL_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "receipt",
  "read",
  "contact",
  "contactOptions",
  "deviceInfo",
  "deviceRequest",
  "topic:subscribe",
  "topic:unsubscribe",
  "privateGroup:invitation",
  "privateGroup:accept",
  "privateGroup:subscribe",
  "privateGroup:quit",
  "privateGroup:optionRequest",
  "privateGroup:optionResponse",
  "privateGroup:memberRequest",
  "privateGroup:memberResponse",
  "discovery:broadcast",
]);

/** Content types that carry displayable message content. */
export const DISPLAYABLE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "text",
  "textExtension",
  "image",
  "audio",
  "video",
  "file",
  "ipfs",
]);

export interface MessageOptions {
  deleteAfterSeconds?: number;
  updateBurnAfterAt?: number;
  profileVersion?: string;

  // Full image IPFS (nMobile format)
  ipfsHash?: string;
  ipfsIp?: string;
  ipfsEncrypt?: number;
  ipfsEncryptAlgorithm?: string; // "AES/GCM/NoPadding"
  ipfsEncryptKeyBytes?: number[]; // byte array (16 bytes for AES-128)
  ipfsEncryptNonceSize?: number; // 12 — nonce prepended to ciphertext

  // Thumbnail IPFS (nMobile format)
  ipfsThumbnailHash?: string;
  ipfsThumbnailIp?: string;
  ipfsThumbnailEncrypt?: number;
  ipfsThumbnailEncryptAlgorithm?: string;
  ipfsThumbnailEncryptKeyBytes?: number[];
  ipfsThumbnailEncryptNonceSize?: number;

  // File info
  fileType?: number | string; // 0=file, 1=image, 2=audio, 3=video
  fileName?: string;
  fileExt?: string;
  fileMimeType?: string;
  fileSize?: number;
  mediaWidth?: number;
  mediaHeight?: number;
  mediaDuration?: number; // seconds (float), used for audio/video
}

/** Wire format message envelope sent over NKN relay. */
export interface MessageData {
  id: string;
  contentType: MessageContentType;
  content?: string;
  options?: MessageOptions;
  topic?: string;
  groupId?: string;
  targetID?: string; // receipt: references original message ID
  readIds?: string[]; // read receipt: array of message IDs
  timestamp: number;
}

export type NknConnectionState = "disconnected" | "connecting" | "connected";

export interface DchatAccountConfig {
  seed?: string; // hex wallet seed (64 chars)
  keystoreJson?: string; // alternative: nkn-sdk keystore JSON
  keystorePassword?: string;
  numSubClients?: number; // default: 4
  ipfsGateway?: string; // default: "64.225.88.71:80"
  enabled?: boolean;
  name?: string;
  dm?: {
    allowFrom?: Array<string | number>;
    policy?: string;
  };
}

export interface ResolvedDchatAccount {
  accountId: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  seed?: string;
  numSubClients: number;
  ipfsGateway: string;
  config: DchatAccountConfig;
}

/** NKN seed RPC servers for client bootstrap. */
export const NKN_SEED_RPC_SERVERS = [
  "http://seed.nkn.org:30003",
  "http://mainnet-seed-0001.nkn.org:30003",
  "http://mainnet-seed-0002.nkn.org:30003",
  "http://mainnet-seed-0003.nkn.org:30003",
];
