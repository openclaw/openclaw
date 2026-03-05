---
read_when:
  - 定义或重构插件架构
  - 将渠道连接器迁移到插件 SDK/运行时
summary: 计划：为所有消息连接器提供一套统一的插件 SDK + 运行时
title: 插件 SDK 重构
x-i18n:
  generated_at: "2026-02-01T21:36:45Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: d1964e2e47a19ee1d42ddaaa9cf1293c80bb0be463b049dc8468962f35bb6cb0
  source_path: refactor/plugin-sdk.md
  workflow: 15
---

# 插件 SDK + 运行时重构计划

目标：每个消息连接器都是一个插件（内置或外部），使用统一稳定的 API。
插件不直接从 `src/**` 导入任何内容。所有依赖项均通过 SDK 或运行时获取。

## 为什么现在做

- 当前连接器混用多种模式：直接导入核心模块、仅 dist 的桥接方式以及自定义辅助函数。
- 这使得升级变得脆弱，并阻碍了干净的外部插件接口。

## 目标架构（两层）

### 1）插件 SDK（编译时，稳定，可发布）

范围：类型、辅助函数和配置工具。无运行时状态，无副作用。

内容（示例）：

- 类型：`ChannelPlugin`、适配器、`ChannelMeta`、`ChannelCapabilities`、`ChannelDirectoryEntry`。
- 配置辅助函数：`buildChannelConfigSchema`、`setAccountEnabledInConfigSection`、`deleteAccountFromConfigSection`、
  `applyAccountNameToChannelSection`。
- 配对辅助函数：`PAIRING_APPROVED_MESSAGE`、`formatPairingApproveHint`。
- 新手引导辅助函数：`promptChannelAccessConfig`、`addWildcardAllowFrom`、新手引导类型。
- 工具参数辅助函数：`createActionGate`、`readStringParam`、`readNumberParam`、`readReactionParams`、`jsonResult`。
- 文档链接辅助函数：`formatDocsLink`。

交付方式：

- 以 `openclaw/plugin-sdk` 发布（或从核心以 `openclaw/plugin-sdk` 导出）。
- 使用语义化版本控制，提供明确的稳定性保证。

### 2）插件运行时（执行层，注入式）

范围：所有涉及核心运行时行为的内容。
通过 `OpenClawPluginApi.runtime` 访问，确保插件永远不会导入 `src/**`。

建议的接口（最小但完整）：

```ts
export type PluginRuntime = {
  channel: {
    text: {
      chunkMarkdownText(text: string, limit: number): string[];
      resolveTextChunkLimit(cfg: OpenClawConfig, channel: string, accountId?: string): number;
      hasControlCommand(text: string, cfg: OpenClawConfig): boolean;
    };
    reply: {
      dispatchReplyWithBufferedBlockDispatcher(params: {
        ctx: unknown;
        cfg: unknown;
        dispatcherOptions: {
          deliver: (payload: {
            text?: string;
            mediaUrls?: string[];
            mediaUrl?: string;
          }) => void | Promise<void>;
          onError?: (err: unknown, info: { kind: string }) => void;
        };
      }): Promise<void>;
      createReplyDispatcherWithTyping?: unknown; // adapter for Teams-style flows
    };
    routing: {
      resolveAgentRoute(params: {
        cfg: unknown;
        channel: string;
        accountId: string;
        peer: { kind: RoutePeerKind; id: string };
      }): { sessionKey: string; accountId: string };
    };
    pairing: {
      buildPairingReply(params: { channel: string; idLine: string; code: string }): string;
      readAllowFromStore(channel: string): Promise<string[]>;
      upsertPairingRequest(params: {
        channel: string;
        id: string;
        meta?: { name?: string };
      }): Promise<{ code: string; created: boolean }>;
    };
    media: {
      fetchRemoteMedia(params: { url: string }): Promise<{ buffer: Buffer; contentType?: string }>;
      saveMediaBuffer(
        buffer: Uint8Array,
        contentType: string | undefined,
        direction: "inbound" | "outbound",
        maxBytes: number,
      ): Promise<{ path: string; contentType?: string }>;
    };
    mentions: {
      buildMentionRegexes(cfg: OpenClawConfig, agentId?: string): RegExp[];
      matchesMentionPatterns(text: string, regexes: RegExp[]): boolean;
    };
    groups: {
      resolveGroupPolicy(
        cfg: OpenClawConfig,
        channel: string,
        accountId: string,
        groupId: string,
      ): {
        allowlistEnabled: boolean;
        allowed: boolean;
        groupConfig?: unknown;
        defaultConfig?: unknown;
      };
      resolveRequireMention(
        cfg: OpenClawConfig,
        channel: string,
        accountId: string,
        groupId: string,
        override?: boolean,
      ): boolean;
    };
    debounce: {
      createInboundDebouncer<T>(opts: {
        debounceMs: number;
        buildKey: (v: T) => string | null;
        shouldDebounce: (v: T) => boolean;
        onFlush: (entries: T[]) => Promise<void>;
        onError?: (err: unknown) => void;
      }): { push: (v: T) => void; flush: () => Promise<void> };
      resolveInboundDebounceMs(cfg: OpenClawConfig, channel: string): number;
    };
    commands: {
      resolveCommandAuthorizedFromAuthorizers(params: {
        useAccessGroups: boolean;
        authorizers: Array<{ configured: boolean; allowed: boolean }>;
      }): boolean;
    };
  };
  logging: {
    shouldLogVerbose(): boolean;
    getChildLogger(name: string): PluginLogger;
  };
  state: {
    resolveStateDir(cfg: OpenClawConfig): string;
  };
};
```

备注：

- 运行时是访问核心行为的唯一方式。
- SDK 故意保持小巧和稳定。
- 每个运行时方法都映射到现有的核心实现（无重复代码）。

## 迁移计划（分阶段，安全）

### 阶段 0：基础搭建

- 引入 `openclaw/plugin-sdk`。
- 在 `OpenClawPluginApi` 中添加带有上述接口的 `api.runtime`。
- 在过渡期内保留现有导入方式（添加弃用警告）。

### 阶段 1：桥接清理（低风险）

- 用 `api.runtime` 替换每个扩展中的 `core-bridge.ts`。
- 优先迁移 BlueBubbles、Zalo、Zalo Personal（已经接近完成）。
- 移除重复的桥接代码。

### 阶段 2：轻度直接导入的插件

- 将 Matrix 迁移到 SDK + 运行时。
- 验证新手引导、目录、群组提及逻辑。

### 阶段 3：重度直接导入的插件

- 迁移 Microsoft Teams（使用运行时辅助函数最多的插件）。
- 确保回复/正在输入的语义与当前行为一致。

### 阶段 4：iMessage 插件化

- 将 iMessage 移入 `extensions/imessage`。
- 用 `api.runtime` 替换直接的核心调用。
- 保持配置键、CLI 行为和文档不变。

### 阶段 5：强制执行

- 添加 lint 规则 / CI 检查：禁止 `extensions/**` 从 `src/**` 导入。
- 添加插件 SDK/版本兼容性检查（运行时 + SDK 语义化版本）。

## 兼容性与版本控制

- SDK：语义化版本控制，已发布，变更有文档记录。
- 运行时：按核心版本进行版本控制。添加 `api.runtime.version`。
- 插件声明所需的运行时版本范围（例如 `openclawRuntime: ">=2026.2.0"`）。

## 测试策略

- 适配器级单元测试（使用真实核心实现验证运行时函数）。
- 每个插件的黄金测试：确保行为无偏差（路由、配对、允许列表、提及过滤）。
- CI 中使用单个端到端插件示例（安装 + 运行 + 冒烟测试）。

## 待解决问题

- SDK 类型托管在哪里：独立包还是核心导出？
- 运行时类型分发：在 SDK 中（仅类型）还是在核心中？
- 如何为内置插件与外部插件暴露文档链接？
- 过渡期间是否允许仓库内插件有限地直接导入核心模块？

## 成功标准

- 所有渠道连接器都是使用 SDK + 运行时的插件。
- `extensions/**` 不再从 `src/**` 导入。
- 新连接器模板仅依赖 SDK + 运行时。
- 外部插件可以在无需访问核心源码的情况下进行开发和更新。

相关文档：[插件](/tools/plugin)、[渠道](/channels/index)、[配置](/gateway/configuration)。
