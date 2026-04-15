/**
 * Actions 适配层 — 统一入口
 *
 * 将 OpenClaw Agent 发出的 Action 请求路由到对应的处理器。
 * 本文件只负责组装并导出 yuanbaoMessageActions 适配对象。
 *
 * Actual processing logic is in:
 * - handler.ts：action 分发与执行（直接调用 createMessageSender，不走 pipeline）
 * - resolve-target.ts：目标解析与类型定义
 */

import { handleAction } from "./handler.js";

export { handleAction };

const SUPPORTED_ACTIONS = ["sticker-search", "sticker", "react", "send"];

/**
 * Description所有支持的 Action（供 Agent 选择工具时参考）。
 */
function describeMessageTool() {
  return { actions: SUPPORTED_ACTIONS };
}

/**
 * 兼容旧版 API
 * @returns 支持的 Action 列表
 */
function listActions() {
  return SUPPORTED_ACTIONS;
}

// ============ 导出适配对象 ============

/**
 * yuanbaoMessageActions — 注册到 yuanbaoPlugin.actions 的适配对象。
 *
 * 由于 openclaw-plugin-sdk.d.ts 将 ChannelPlugin 和 ChannelMessageActionAdapter 声明为 any，
 * 此处使用 Record 兼容类型，实际Runtime OpenClaw 框架会按约定调用各方法。
 */
export const yuanbaoMessageActions: Record<string, unknown> = {
  describeMessageTool,
  handleAction,
  listActions,
  supportsAction: ({ action }: { action: string }) => SUPPORTED_ACTIONS.includes(action),
  // 元宝频道的 send/sticker 等 action 不需要 trusted sender 身份校验，
  // 显式返回 false 避免框架 dispatchChannelMessageAction 拦截。
  requiresTrustedRequesterSender: () => false,
};
