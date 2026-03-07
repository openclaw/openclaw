import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";

export type IMessageAttachment = {
  original_path?: string | null;
  mime_type?: string | null;
  missing?: boolean | null;
};

export type IMessagePayload = {
  id?: number | null;
  chat_id?: number | null;
  sender?: string | null;
  is_from_me?: boolean | null;
  text?: string | null;
  reply_to_id?: number | string | null;
  reply_to_text?: string | null;
  reply_to_sender?: string | null;
  created_at?: string | null;
  attachments?: IMessageAttachment[] | null;
  chat_identifier?: string | null;
  chat_guid?: string | null;
  chat_name?: string | null;
  participants?: string[] | null;
  is_group?: boolean | null;
};

export type IMessageReactionPayload = {
  /** Message id being reacted to. */
  target_id?: number | null;
  /** Chat row id. */
  chat_id?: number | null;
  /** Sender handle (phone/email). */
  sender?: string | null;
  /** True when the reaction is from the local user. */
  is_from_me?: boolean | null;
  /** Tapback type name. */
  reaction_type?: string | null;
  /** True when the tapback was added; false when removed. */
  added?: boolean | null;
  /** Text of the message being reacted to. */
  target_text?: string | null;
  /** Timestamp string. */
  created_at?: string | null;
  /** Chat identifier (e.g. iMessage;-;+1234567890). */
  chat_identifier?: string | null;
  chat_guid?: string | null;
  chat_name?: string | null;
  participants?: string[] | null;
  is_group?: boolean | null;
};

export type MonitorIMessageOpts = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  cliPath?: string;
  dbPath?: string;
  accountId?: string;
  config?: OpenClawConfig;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  includeAttachments?: boolean;
  mediaMaxMb?: number;
  requireMention?: boolean;
  includeReactions?: boolean;
};
