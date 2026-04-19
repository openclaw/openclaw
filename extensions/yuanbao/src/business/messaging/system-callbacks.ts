/**
 * System callback dispatch center.
 *
 * Pure registry + dispatcher, holds no business state.
 * Each business handler (e.g. Recall) self-registers by calling registerSystemCallback in its own module.
 *
 * To extend: call registerSystemCallback in the corresponding business module to register a new callback_command.
 * No need to modify handleInboundMessage or this file.
 */

import type { YuanbaoInboundMessage } from "../../types.js";
import { handleC2CRecall, handleGroupRecall } from "./callbacks/recall.js";
import type { MessageHandlerContext } from "./context.js";

// ============ Types ============

export type SystemCallbackParams = {
  ctx: MessageHandlerContext;
  msg: YuanbaoInboundMessage;
  isGroup: boolean;
};

export type SystemCallbackHandler = (params: SystemCallbackParams) => void;

// ============ Registry ============

/** callback_command → handler mapping */
const systemCallbackRegistry = new Map<string, SystemCallbackHandler>();

/**
 * Register a system callback handler.
 * When the same `command` is registered multiple times, the latter overwrites the former,
 * allowing business modules to self-register at load time without modifying centralized dispatch code.
 */
export function registerSystemCallback(command: string, handler: SystemCallbackHandler): void {
  systemCallbackRegistry.set(command, handler);
}

/**
 * Attempt to dispatch system callback.
 * Looks up registry by `msg.callback_command`; if matched, executes handler and considers the system message consumed.
 *
 * @returns `true` if matched and handled (caller should return immediately);
 *          `false` if not a system callback or command not registered (caller continues normal flow)
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

// ============ Registration ============

registerSystemCallback("Group.CallbackAfterRecallMsg", ({ ctx, msg }) =>
  handleGroupRecall(ctx, msg),
);
registerSystemCallback("C2C.CallbackAfterMsgWithDraw", ({ ctx, msg }) => handleC2CRecall(ctx, msg));
