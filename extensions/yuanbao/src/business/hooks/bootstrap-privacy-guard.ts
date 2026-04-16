/**
 * Bootstrap 隐私守卫钩子
 *
 * 在群聊场景下，从 bootstrap 文件列表中移除 USER.md，
 * 防止私人信息通过 prompt injection 被泄露。
 */

import {
  registerInternalHook,
  isAgentBootstrapEvent,
  type AgentBootstrapHookContext,
} from "openclaw/plugin-sdk/hook-runtime";

/** 群聊 sessionKey 中的标识片段 */
const GROUP_SESSION_KEY_MARKER = ":group:";

/** 需要在群聊中排除的 bootstrap 文件名（包含用户私人信息或 AI 记忆） */
const GROUP_EXCLUDED_FILENAMES = new Set(["USER.md", "MEMORY.md", "memory.md"]);

/**
 * 注册 agent:bootstrap 内部钩子 —— 群聊隐私守卫
 *
 * 由 {@link registerYuanbaoHooks} 统一调用，不再依赖 side-effect import。
 */
export function registerBootstrapPrivacyGuard(): void {
  registerInternalHook("agent:bootstrap", (event) => {
    // 类型守卫：确认是 agent:bootstrap 事件
    if (!isAgentBootstrapEvent(event)) {
      return;
    }

    const context = event.context as AgentBootstrapHookContext;
    const sessionKey = context.sessionKey ?? "";

    // 仅对群聊 session 生效
    if (!sessionKey.includes(GROUP_SESSION_KEY_MARKER)) {
      return;
    }

    // 从 bootstrapFiles 中移除敏感文件
    context.bootstrapFiles = context.bootstrapFiles.filter(
      (file) => !GROUP_EXCLUDED_FILENAMES.has(file.name),
    );
  });
}
