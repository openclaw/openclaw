/**
 * Plugin Registry — 最小注册表
 *
 * 对应 openclaw: src/plugins/registry.ts（精简版）
 * openclaw 原版 624 行，本工程只保留 channels 注册功能。
 *
 * 命名对齐：
 *   createPluginRegistry()          ← openclaw registry.ts:185
 *   PluginChannelRegistration        ← openclaw registry.ts:134
 *   PluginRegistry（return 类型）    ← openclaw registry.ts:155
 */

import type { ChannelPlugin } from "../types.js";

/** openclaw: PluginChannelRegistration (registry.ts:134) */
export type PluginChannelRegistration = {
  pluginId: string;
  plugin: ChannelPlugin;
  /** 插件入口文件路径 */
  source: string;
};

/** openclaw: PluginRegistry (registry.ts:155) — 精简版，只保留 channels */
export type PluginRegistry = {
  channels: PluginChannelRegistration[];
  /** 注册一个 channel 插件（对应 registry.ts 内部的 registerChannel 函数） */
  registerChannel: (pluginId: string, plugin: ChannelPlugin, source: string) => void;
  /** 摘要信息，用于启动日志 */
  summary: () => string;
};

/**
 * 创建空的插件注册表
 * openclaw: createPluginRegistry() in registry.ts:185
 */
export function createPluginRegistry(): PluginRegistry {
  const channels: PluginChannelRegistration[] = [];

  const registerChannel = (pluginId: string, plugin: ChannelPlugin, source: string): void => {
    const existing = channels.find((r) => r.plugin.id === plugin.id);
    if (existing) {
      console.warn(
        `[registry] channel "${plugin.id}" already registered by "${existing.pluginId}", skipping duplicate from "${pluginId}"`,
      );
      return;
    }
    channels.push({ pluginId, plugin, source });
    console.log(`[registry] registered channel: ${plugin.id} (from plugin: ${pluginId})`);
  };

  const summary = (): string => {
    const ids = channels.map((r) => r.plugin.id).join(", ");
    return `${channels.length} channel(s): [${ids}]`;
  };

  return { channels, registerChannel, summary };
}
