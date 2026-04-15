/**
 * System callback dispatch center
 *
 * 纯粹的注册表 + 分发器，不持有任何业务状态。
 * 各业务处理器（如Recall）在其所在模块中自行调用 registerSystemCallback 完成注册。
 *
 * 扩展方式：在对应业务模块中调用 registerSystemCallback 注册新的 callback_command 即可，
 * 无需修改 handleInboundMessage 或本文件。
 */

import type { YuanbaoInboundMessage } from "../../types.js";
import { handleC2CRecall, handleGroupRecall } from "./callbacks/recall.js";
import type { MessageHandlerContext } from "./context.js";

// ============ 类型 ============

export type SystemCallbackParams = {
  ctx: MessageHandlerContext;
  msg: YuanbaoInboundMessage;
  isGroup: boolean;
};

export type SystemCallbackHandler = (params: SystemCallbackParams) => void;

// ============ 注册表 ============

/** callback_command → handler 映射表 */
const systemCallbackRegistry = new Map<string, SystemCallbackHandler>();

/**
 * Register a system callback handler.
 *
 * 同一 `command` 多次注册时，后者覆盖前者，便于业务模块在加载时自注册而无需改集中分发代码。
 *
 * @param command - IM 下发的 `callback_command` 字符串（如 Group/C2C Recall回调名）
 * @param handler - 收到匹配命令时调用的处理器，入参为上下文与消息
 * @returns 无
 */
export function registerSystemCallback(command: string, handler: SystemCallbackHandler): void {
  systemCallbackRegistry.set(command, handler);
}

/**
 * Attempt to dispatch system callback.
 *
 * 根据 `msg.callback_command` 查找注册表；命中则执行对应 handler 并视为已消费该条系统消息。
 *
 * @param params - 含 `ctx`、`msg` 与 `isGroup`，供各系统回调与路由逻辑使用
 * @returns `true` 表示命中注册表已处理，调用方应直接返回；
 *          `false` 表示非系统回调或命令未注册，调用方按正常消息流程继续处理
 */
export function dispatchSystemCallback(params: SystemCallbackParams): boolean {
  const command = params.msg.callback_command;
  if (!command) {
    return false;
  }

  const handler = systemCallbackRegistry.get(command);
  if (!handler) {
    return false;
  }

  handler(params);
  return true;
}

// ============ 注册 ============

registerSystemCallback("Group.CallbackAfterRecallMsg", ({ ctx, msg }) =>
  handleGroupRecall(ctx, msg),
);
registerSystemCallback("C2C.CallbackAfterMsgWithDraw", ({ ctx, msg }) => handleC2CRecall(ctx, msg));
