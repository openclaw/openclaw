// Line type declarations define plugin contracts.
import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import type { MessageReceipt } from "openclaw/plugin-sdk/channel-outbound";

export type LineTokenSource = "config" | "env" | "file" | "none";

interface LineThreadBindingsConfig {
  enabled?: boolean;
  idleHours?: number;
  maxAgeHours?: number;
  spawnSessions?: boolean;
  defaultSpawnContext?: "isolated" | "fork";
  /** @deprecated Use spawnSessions instead. */
  spawnSubagentSessions?: boolean;
  /** @deprecated Use spawnSessions instead. */
  spawnAcpSessions?: boolean;
}

interface LineAccountBaseConfig {
  enabled?: boolean;
  channelAccessToken?: string;
  channelSecret?: string;
  tokenFile?: string;
  secretFile?: string;
  name?: string;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
  groupPolicy?: "open" | "allowlist" | "disabled";
  responsePrefix?: string;
  mediaMaxMb?: number;
  webhookPath?: string;
  threadBindings?: LineThreadBindingsConfig;
  groups?: Record<string, LineGroupConfig>;
}

export interface LineConfig extends LineAccountBaseConfig {
  accounts?: Record<string, LineAccountConfig>;
  defaultAccount?: string;
}

export interface LineAccountConfig extends LineAccountBaseConfig {}

export interface LineGroupConfig {
  enabled?: boolean;
  allowFrom?: Array<string | number>;
  requireMention?: boolean;
  /**
   * When true (and requireMention is also true for this group), non-text
   * messages (image/video/audio/file/sticker/location) participate in the
   * mention gate instead of always bypassing it. Opt-in; default false.
   */
  requireMentionForNonText?: boolean;
  /**
   * Max number of skipped photo/video/audio/file messages retained per group
   * while waiting for a later @mention. Defaults to 3 when unset.
   */
  pendingMediaLimit?: number;
  systemPrompt?: string;
  skills?: string[];
}

export interface ResolvedLineAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  channelAccessToken: string;
  channelSecret: string;
  tokenSource: LineTokenSource;
  config: LineConfig & LineAccountConfig;
}

export interface LineSendResult {
  messageId: string;
  chatId: string;
  receipt: MessageReceipt;
}

export type LineProbeResult = BaseProbeResult<string> & {
  bot?: {
    displayName?: string;
    userId?: string;
    basicId?: string;
    pictureUrl?: string;
  };
};

type LineFlexMessagePayload = {
  altText: string;
  contents: unknown;
};

export type LineTemplateMessagePayload =
  | {
      type: "confirm";
      text: string;
      confirmLabel: string;
      confirmData: string;
      cancelLabel: string;
      cancelData: string;
      altText?: string;
    }
  | {
      type: "buttons";
      title: string;
      text: string;
      actions: Array<{
        type: "message" | "uri" | "postback";
        label: string;
        data?: string;
        uri?: string;
      }>;
      thumbnailImageUrl?: string;
      altText?: string;
    }
  | {
      type: "carousel";
      columns: Array<{
        title?: string;
        text: string;
        thumbnailImageUrl?: string;
        actions: Array<{
          type: "message" | "uri" | "postback";
          label: string;
          data?: string;
          uri?: string;
        }>;
      }>;
      altText?: string;
    };

export type LineChannelData = {
  quickReplies?: string[];
  location?: {
    title: string;
    address: string;
    latitude: number;
    longitude: number;
  };
  flexMessage?: LineFlexMessagePayload;
  templateMessage?: LineTemplateMessagePayload;
};
