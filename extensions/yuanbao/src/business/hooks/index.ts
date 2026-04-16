/**
 * Yuanbao hook 统一注册入口
 *
 * 所有 hook 注册（api.on / registerInternalHook）集中在此管理，
 * index.ts 只需调用 registerYuanbaoHooks(api) 即可。
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import { registerBootstrapPrivacyGuard } from "./bootstrap-privacy-guard.js";
import { registerInstallGuard } from "./install-guard.js";

/**
 * 统一注册 yuanbao 插件的所有生命周期 hook
 */
export function registerYuanbaoHooks(api: OpenClawPluginApi): void {
  // skill / plugin 安装前检查
  registerInstallGuard(api);

  // 群聊隐私守卫：agent:bootstrap 时移除 USER.md
  registerBootstrapPrivacyGuard();
}
