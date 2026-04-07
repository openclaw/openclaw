/**
 * WeCom channel type definitions
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { WeComCommand } from "./const.js";
import type { ResolvedWeComAccount } from "./utils.js";

// ============================================================================
// Runtime types
// ============================================================================

/**
 * Monitor configuration options
 */
export type WeComMonitorOptions = {
  account: ResolvedWeComAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  /** Status update callback provided by the framework layer, used to mark channel as stopped in fatal error scenarios */
  setStatus?: (next: Record<string, unknown>) => void;
};

// ============================================================================
// Internal state types
// ============================================================================

/**
 * Message state
 */
export interface MessageState {
  accumulatedText: string;
  /** Stream ID for streaming replies, used to keep the same stream ID for one streaming reply */
  streamId?: string;
  // /** Whether there is user-visible text content (excluding <think>...</think> tags) */
  // hasText?: boolean;
  /** Whether a media file has been sent successfully */
  hasMedia?: boolean;
  /** Whether a media send failed (insufficient permissions, file too large, etc.) */
  hasMediaFailed?: boolean;
  /** Plain text error summary when media send fails (used to replace thinking stream for user display) */
  mediaErrorSummary?: string;
  // /** Whether the deliver callback has been called (used to distinguish "core has no reply" from "core replied with empty content") */
  // deliverCalled?: boolean;
  /** Whether the streaming reply has expired (errcode 846608, >6 minutes), requiring downgrade to proactive send */
  streamExpired?: boolean;
  /** Whether a template card has been sent successfully */
  hasTemplateCard?: boolean;
}

// ============================================================================
// Template card types
// ============================================================================

/** Template card extracted from text */
export interface ExtractedTemplateCard {
  /** Original JSON object (card_type has been validated) */
  cardJson: Record<string, unknown>;
  /** card_type value */
  cardType: string;
}

/** Return value of extractTemplateCards */
export interface TemplateCardExtractionResult {
  /** List of valid template cards extracted */
  cards: ExtractedTemplateCard[];
  /** Remaining text after removing card code blocks */
  remainingText: string;
}

// ============================================================================
// WebSocket message types
// ============================================================================

/**
 * WebSocket request message base format
 */
export interface WeComRequest {
  cmd: string;
  headers: {
    req_id: string;
  };
  body: unknown;
}

/**
 * WebSocket response message format
 */
export interface WeComResponse {
  headers: {
    req_id: string;
  };
  errcode: number;
  errmsg: string;
}

/**
 * WeCom auth request
 */
export interface WeComSubscribeRequest extends WeComRequest {
  cmd: WeComCommand.SUBSCRIBE;
  body: {
    secret: string;
    bot_id: string;
  };
}

/**
 * WeCom push message format
 */
export interface WeComCallbackMessage {
  cmd: WeComCommand.AIBOT_CALLBACK | "aibot_event_callback";
  headers: {
    req_id: string;
  };
  body: {
    msgid: string;
    aibotid: string;
    chatid?: string;
    chattype: "single" | "group";
    from: {
      userid: string;
    };
    response_url: string;
    msgtype: "text" | "image" | "voice" | "video" | "file" | "stream" | "mixed" | "event";
    text?: {
      content: string;
    };
    image?: {
      /** Image URL (when receiving images via URL) */
      url?: string;
      /** Image base64 data (when transmitted directly) */
      base64?: string;
      md5?: string;
    };
    /** Mixed content message (text + images) */
    mixed?: {
      msg_item: Array<{
        msgtype: "text" | "image";
        text?: {
          content: string;
        };
        image?: {
          url?: string;
          base64?: string;
          md5?: string;
        };
      }>;
    };
    quote?: {
      msgtype: string;
      text?: {
        content: string;
      };
      image?: {
        url?: string;
        aeskey?: string;
      };
      file?: {
        url?: string;
        aeskey?: string;
      };
    };
    stream?: {
      id: string;
    };
    event?: {
      eventtype: string;
      template_card_event?: {
        card_type?: string;
        event_key?: string;
        task_id?: string;
        selected_items?: {
          selected_item?: Array<{
            question_key?: string;
            option_ids?: {
              option_id?: string[];
            };
          }>;
        };
      };
    };
  };
}

/**
 * WeCom response message format
 */
export interface WeComResponseMessage extends WeComRequest {
  cmd: WeComCommand.AIBOT_RESPONSE;
  body: {
    msgtype: "stream" | "text" | "markdown";
    stream?: {
      id: string;
      finish: boolean;
      content: string;
      msg_item?: Array<{
        msgtype: "image" | "file";
        image?: {
          base64: string;
          md5: string;
        };
      }>;
      feedback?: {
        id: string;
      };
    };
    text?: {
      content: string;
    };
    markdown?: {
      content: string;
    };
  };
}
