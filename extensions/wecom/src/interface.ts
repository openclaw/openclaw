/**
 * 企业微信渠道类型定义
 */

import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { WeComCommand } from "./const.ts";
import type { ResolvedWeComAccount } from "./utils.ts";

// ============================================================================
// 运行时类型
// ============================================================================

/**
 * Monitor 配置选项
 */
export type WeComMonitorOptions = {
  account: ResolvedWeComAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
};

// ============================================================================
// 内部状态类型
// ============================================================================

/**
 * 消息状态
 */
export interface MessageState {
  accumulatedText: string;
  /** 流式回复的 streamId，用于保持同一个流式回复使用相同的 streamId */
  streamId?: string;
}

// ============================================================================
// WebSocket 消息类型
// ============================================================================

/**
 * WebSocket 请求消息基础格式
 */
export interface WeComRequest {
  cmd: string;
  headers: {
    req_id: string;
  };
  body: any;
}

/**
 * WebSocket 响应消息格式
 */
export interface WeComResponse {
  headers: {
    req_id: string;
  };
  errcode: number;
  errmsg: string;
}

/**
 * 企业微信认证请求
 */
export interface WeComSubscribeRequest extends WeComRequest {
  cmd: WeComCommand.SUBSCRIBE;
  body: {
    secret: string;
    bot_id: string;
  };
}

/**
 * 企业微信推送消息格式
 */
export interface WeComCallbackMessage {
  cmd: WeComCommand.AIBOT_CALLBACK;
  headers: {
    req_id: string;
  };
  body: {
    msgid: string;
    aibotid: string;
    chatid: string;
    chattype: "single" | "group";
    from: {
      userid: string;
    };
    response_url: string;
    msgtype: "text" | "image" | "voice" | "video" | "file" | "stream" | "mixed";
    text?: {
      content: string;
    };
    image?: {
      /** 图片 URL（通过 URL 方式接收图片时） */
      url?: string;
      /** 图片 base64 数据（直接传输时） */
      base64?: string;
      md5?: string;
    };
    /** 图文混排消息 */
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
  };
}

/**
 * 企业微信响应消息格式
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
