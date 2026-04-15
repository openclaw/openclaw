/**
 * Tools 注册工厂
 *
 * 集中管理所有工具的注册逻辑，按功能类别分组。
 * 插件入口只需调用 registerTools(api) 即可完成全部工具注册。
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { registerGroupTools } from "./group.js";
import { registerMemberTools } from "./member.js";
import { registerRemindTools } from "./remind.js";

/**
 * Register all tools.
 *
 * Call each registration function by category in order; to add a new category, simply append here.
 *
 * @param api - OpenClaw 插件 API
 */
export function registerTools(api: OpenClawPluginApi): void {
  // —— 成员相关 ——
  registerMemberTools(api);

  // —— 群信息相关 ——
  registerGroupTools(api);

  // —— 定时提醒相关 ——
  registerRemindTools(api);

  // —— 未来新增类别在此追加 ——
  // registerXxxTools(api);
}
