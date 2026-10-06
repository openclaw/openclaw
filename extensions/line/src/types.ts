// Line type declarations define plugin contracts.
import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import type { MessageReceipt } from "openclaw/plugin-sdk/channel-outbound";
import type { MediaKind } from "openclaw/plugin-sdk/media-runtime";
import type { Static } from "typebox";
import type { z } from "zod";
import type { LineAccountConfigSchema, LineConfigSchema } from "./config-schema.js";
import type { lineChannelDataSchema } from "./rich-message-schema.js";

export type LineTokenSource = "config" | "env" | "file" | "none";
export type LineCredentialStatus = "available" | "configured_unavailable" | "missing";
export type LineCredentialUnavailableDiagnostic = Extract<
  ReturnType<typeof import("openclaw/plugin-sdk/secret-file-runtime").tryReadSecretFileSync>,
  { status: "configured_unavailable" }
>["diagnostic"];

export type LineConfig = z.input<typeof LineConfigSchema>;
export type LineAccountConfig = z.input<typeof LineAccountConfigSchema>;

export interface ResolvedLineAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  channelAccessToken: string;
  channelSecret: string;
  tokenSource: LineTokenSource;
  signingSecretSource?: LineTokenSource;
  tokenStatus?: LineCredentialStatus;
  signingSecretStatus?: LineCredentialStatus;
  credentialDiagnostics?: LineCredentialUnavailableDiagnostic[];
  config: LineConfig & LineAccountConfig;
}

export interface LineSendResult {
  messageId: string;
  chatId: string;
  receipt: MessageReceipt;
}

/** Console-side webhook state, which decides whether LINE delivers anything at all. */
export type LineProbeWebhookState = { status: "active" | "disabled" | "unset" };

/**
 * LINE's own view of an account's monthly message allowance.
 *
 * The plan decides whether a limit exists at all, so the two cases stay separate
 * shapes instead of encoding "unlimited" as a sentinel number that every caller
 * would have to remember to special-case.
 */
export type LineMessageQuota =
  | { kind: "unlimited" }
  | { kind: "limited"; limit: number; used: number };

export type LineProbeResult = BaseProbeResult<string> & {
  elapsedMs?: number;
  bot?: {
    displayName?: string;
    userId?: string;
    basicId?: string;
    pictureUrl?: string;
  };
  /** Absent when LINE did not answer, which stays "unknown" rather than "fine". */
  webhook?: LineProbeWebhookState;
  quota?: LineMessageQuota;
};

type LineFlexMessagePayload = {
  altText: string;
  contents: unknown;
};

export type LineQuickReplyItem = {
  label: string;
  action: { type: "command"; command: string } | { type: "callback"; value: string };
};

export type LineTemplateActionPayload = {
  type: "message" | "uri" | "postback";
  label: string;
  data?: string;
  uri?: string;
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
      title?: string;
      text: string;
      actions: LineTemplateActionPayload[];
      thumbnailImageUrl?: string;
      altText?: string;
    }
  | {
      type: "carousel";
      columns: Array<{
        title?: string;
        text: string;
        thumbnailImageUrl?: string;
        actions: LineTemplateActionPayload[];
      }>;
      altText?: string;
    };

export type LineChannelData = Static<typeof lineChannelDataSchema>["line"] & {
  quickReplies?: string[];
  quickReplyItems?: LineQuickReplyItem[];
  flexMessage?: LineFlexMessagePayload;
  templateMessage?: LineTemplateMessagePayload;
};

export type LineOutboundMediaKind = Extract<MediaKind, "image" | "video" | "audio">;
