/**
 * 消息发送基础模块
 * 支持 Markdown、文本、链接等消息类型
 */

import type { DingtalkConfig } from '../../types/index.ts';
import { DINGTALK_API, getAccessToken } from '../../utils/token.ts';
import { dingtalkHttp } from '../../utils/http-client.ts';

/** 消息类型枚举 */
export type DingTalkMsgType = 'text' | 'markdown' | 'link' | 'actionCard' | 'image';

/** 主动发送消息的结果 */
export interface SendResult {
  ok: boolean;
  processQueryKey?: string;
  cardInstanceId?: string;
  error?: string;
  usedAICard?: boolean;
}

/** 主动发送选项 */
export interface ProactiveSendOptions {
  msgType?: DingTalkMsgType;
  replyToId?: string;
  title?: string;
  log?: any;
  useAICard?: boolean;
  fallbackToNormal?: boolean;
}

/**
 * 发送 Markdown 消息
 */
export async function sendMarkdownMessage(
  config: DingtalkConfig,
  sessionWebhook: string,
  title: string,
  markdown: string,
  options: any = {},
): Promise<any> {
  const token = await getAccessToken(config);
  let text = markdown;
  if (options.atUserId) text = `${text} @${options.atUserId}`;

  const body: any = {
    msgtype: 'markdown',
    markdown: {
      title,
      text: text,
    },
  };

  if (options.atUserId) {
    body.at = {
      userIds: [options.atUserId],
      isAtAll: false,
    };
  }

  const resp = await dingtalkHttp.post(sessionWebhook, body, {
    headers: {
      'x-acs-dingtalk-access-token': token,
      'Content-Type': 'application/json',
    },
  });

  return resp.data;
}

/**
 * 发送文本消息
 */
export async function sendTextMessage(
  config: DingtalkConfig,
  sessionWebhook: string,
  content: string,
  options: any = {},
): Promise<any> {
  const token = await getAccessToken(config);
  let text = content;
  if (options.atUserId) text = `${text} @${options.atUserId}`;

  const body: any = {
    msgtype: 'text',
    text: {
      content: text,
    },
  };

  if (options.atUserId) {
    body.at = {
      userIds: [options.atUserId],
      isAtAll: false,
    };
  }

  const resp = await dingtalkHttp.post(sessionWebhook, body, {
    headers: {
      'x-acs-dingtalk-access-token': token,
      'Content-Type': 'application/json',
    },
  });

  return resp.data;
}

/**
 * 发送链接消息
 */
export async function sendLinkMessage(
  config: DingtalkConfig,
  sessionWebhook: string,
  params: {
    title: string;
    text: string;
    picUrl?: string;
    messageUrl: string;
  },
): Promise<any> {
  const token = await getAccessToken(config);

  const body = {
    msgtype: 'link',
    link: {
      title: params.title,
      text: params.text,
      picUrl: params.picUrl,
      messageUrl: params.messageUrl,
    },
  };

  const resp = await dingtalkHttp.post(sessionWebhook, body, {
    headers: {
      'x-acs-dingtalk-access-token': token,
      'Content-Type': 'application/json',
    },
  });

  return resp.data;
}
