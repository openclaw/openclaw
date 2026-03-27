# 外部 Agent 内嵌接入 OpenClaw Channel 生态 — 完整方案

## 背景与目标

OpenClaw 是一个 AI Gateway，核心是通过 **Channel Plugin** 接入各种 IM 平台（Feishu/Discord/Telegram/Slack 等）。外部 Agent 有三个核心需求：

1. **下载/安装** Channel Plugin
2. **注册** Plugin 到 OpenClaw 运行时
3. **收发消息** — 通过 channelRuntime 接管消息调度，接入自己的 Agent 逻辑

---

## 架构概览

```
外部 Agent
    │
    │  同进程，直接 import
    ▼
OpenClaw Channel 传输层
    │
    ├── Channel Plugin A (Feishu)   ──▶ 飞书平台
    ├── Channel Plugin B (Discord)  ──▶ Discord 平台
    └── Channel Plugin C (自定义)   ──▶ 任意平台
```

**关键结论**：Plugin 以代码模块形式直接加载进外部 Agent 进程（同一 Node.js 进程，无独立进程，无 IPC）。唯一需要替换的是 `channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher`，其余传输层全部复用。

---

## Part 1：依赖与模块

### 需要从 OpenClaw 导入的模块

```typescript
// ── 插件注册 ───────────────────────────────────────────
import {
  createPluginRegistry,
  createEmptyPluginRegistry,
  type PluginRegistry,
} from "openclaw/src/plugins/registry.js";
// src/plugins/registry.ts:168

import { setActivePluginRegistry, getActivePluginRegistry } from "openclaw/src/plugins/runtime.js";
// src/plugins/runtime.ts:25 (全局单例 globalThis[Symbol.for("openclaw.pluginRegistryState")])

// ── Channel 管理 ───────────────────────────────────────
import { createChannelManager, type ChannelManager } from "openclaw/src/gateway/server-channels.js";
// src/gateway/server-channels.ts:111

import { getChannelPlugin, listChannelPlugins } from "openclaw/src/channels/plugins/index.js";

// ── 类型 ───────────────────────────────────────────────
import type { PluginRuntimeChannel } from "openclaw/src/plugins/runtime/types-channel.js";
// src/plugins/runtime/types-channel.ts:16 (完整 channelRuntime 类型)

import type { ChannelGatewayContext } from "openclaw/src/channels/plugins/types.adapters.js";
// src/channels/plugins/types.adapters.ts:168

import type { MsgContext, FinalizedMsgContext } from "openclaw/src/auto-reply/templating.js";
```

---

## Part 2：插件加载

### 2.1 直接 import 已知 Channel Plugin

无需动态扫描目录，直接 import 你选定的 ChannelPlugin 对象：

```typescript
// 直接 import 你想用的 Channel Plugin 对象
import { feishuPlugin } from "openclaw/extensions/feishu/src/channel.js";
import { createSynologyChatPlugin } from "openclaw/extensions/synology-chat/src/channel.js";
// import { discordPlugin }          from "openclaw/extensions/discord/src/channel.js";
```

### 2.2 注册到 PluginRegistry

```typescript
import { createPluginRegistry } from "./src/plugins/registry.js";
import { setActivePluginRegistry } from "./src/plugins/runtime.js";
import type { PluginRuntime } from "./src/plugins/runtime/types.js";

const { registry, createApi } = createPluginRegistry({
  logger: console,
  runtime: minimalRuntime, // 见 Part 3
});

// 注册每个 Channel Plugin
for (const [id, plugin] of [
  ["feishu", feishuPlugin],
  ["synology-chat", createSynologyChatPlugin()],
] as const) {
  const record = makeRecord(id);
  const api = createApi(record, { config: myConfig, pluginConfig: {} });
  api.registerChannel({ plugin });
  registry.plugins.push(record);
}

// 写入全局单例，getChannelPlugin() 等依赖此
setActivePluginRegistry(registry);
```

`makeRecord` 结构（参考 `src/plugins/loader.ts:219`）：

```typescript
function makeRecord(id: string) {
  return {
    id,
    name: id,
    source: id,
    origin: "config" as const,
    enabled: true,
    status: "loaded" as const,
    toolNames: [],
    hookNames: [],
    channelIds: [],
    providerIds: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    commands: [],
    httpRoutes: 0,
    hookCount: 0,
    configSchema: false,
  };
}
```

---

## Part 3：构建自定义 channelRuntime（核心替换点）

`channelRuntime` 是 Plugin 收消息时调用的 SDK 注入对象，类型定义在 `src/plugins/runtime/types-channel.ts:16`（`PluginRuntimeChannel`）。

**只需要替换 `reply.dispatchReplyWithBufferedBlockDispatcher`**，其余方法直接 import OpenClaw 原始实现。

```typescript
import { finalizeInboundContext } from "./src/auto-reply/reply/inbound-context.js";
import type { PluginRuntimeChannel } from "./src/plugins/runtime/types-channel.js";

type MyAgentFn = (input: {
  text: string;
  sessionKey: string;
  channel: string;
  peerId: string;
}) => Promise<string>;

function buildCustomChannelRuntime(myAgent: MyAgentFn): PluginRuntimeChannel {
  return {
    reply: {
      finalizeInboundContext,

      // ★ 唯一需要替换的函数：不调用 getReplyFromConfig，改为调用你的 Agent
      dispatchReplyWithBufferedBlockDispatcher: async (params) => {
        const ctx = finalizeInboundContext(params.ctx);
        const text = (ctx.Body ?? ctx.CommandBody ?? ctx.RawBody ?? "") as string;
        const sessionKey = (ctx.SessionKey ?? "") as string;
        const channel = (ctx.Surface ?? ctx.Provider ?? "unknown") as string;
        const peerId = (ctx.From ?? ctx.PeerId ?? "") as string;

        let agentReply = "";
        try {
          agentReply = await myAgent({ text, sessionKey, channel, peerId });
        } catch (err) {
          params.dispatcherOptions.onError?.(err, { kind: "final" });
          return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
        }

        if (agentReply) {
          await params.dispatcherOptions.deliver({ text: agentReply }, { kind: "final" });
        }
        return { queuedFinal: Boolean(agentReply), counts: { tool: 0, block: 0, final: 1 } };
      },

      // 其余直接使用 OpenClaw 原版（Plugin 内部可能用到）
      dispatchReplyFromConfig: (await import("./src/auto-reply/reply/dispatch-from-config.js"))
        .dispatchReplyFromConfig,
      withReplyDispatcher: (await import("./src/auto-reply/dispatch.js")).withReplyDispatcher,
      createReplyDispatcherWithTyping: (await import("./src/auto-reply/reply/reply-dispatcher.js"))
        .createReplyDispatcherWithTyping,
      resolveEffectiveMessagesConfig: (await import("./src/agents/identity.js"))
        .resolveEffectiveMessagesConfig,
      resolveHumanDelayConfig: (await import("./src/agents/identity.js")).resolveHumanDelayConfig,
      formatAgentEnvelope: (await import("./src/auto-reply/envelope.js")).formatAgentEnvelope,
      formatInboundEnvelope: (await import("./src/auto-reply/envelope.js")).formatInboundEnvelope,
      resolveEnvelopeFormatOptions: (await import("./src/auto-reply/envelope.js"))
        .resolveEnvelopeFormatOptions,
    },

    // 以下直接使用 OpenClaw 原版
    routing: {
      resolveAgentRoute: (await import("./src/routing/resolve-route.js")).resolveAgentRoute,
      buildAgentSessionKey: (await import("./src/routing/resolve-route.js")).buildAgentSessionKey,
    },
    text: {
      chunkMarkdownText: (await import("./src/auto-reply/chunk.js")).chunkMarkdownText,
      chunkByNewline: (await import("./src/auto-reply/chunk.js")).chunkByNewline,
      chunkMarkdownTextWithMode: (await import("./src/auto-reply/chunk.js"))
        .chunkMarkdownTextWithMode,
      chunkText: (await import("./src/auto-reply/chunk.js")).chunkText,
      chunkTextWithMode: (await import("./src/auto-reply/chunk.js")).chunkTextWithMode,
      resolveChunkMode: (await import("./src/auto-reply/chunk.js")).resolveChunkMode,
      resolveTextChunkLimit: (await import("./src/auto-reply/chunk.js")).resolveTextChunkLimit,
      hasControlCommand: (await import("./src/auto-reply/command-detection.js")).hasControlCommand,
      resolveMarkdownTableMode: (await import("./src/config/markdown-tables.js"))
        .resolveMarkdownTableMode,
      convertMarkdownTables: (await import("./src/markdown/tables.js")).convertMarkdownTables,
    },
    pairing: {
      buildPairingReply: (await import("./src/pairing/pairing-messages.js")).buildPairingReply,
      readAllowFromStore: (params) => {
        return import("./src/pairing/pairing-store.js").then((m) =>
          m.readChannelAllowFromStore(
            { channel: params.channel, accountId: params.accountId },
            params.env,
          ),
        );
      },
      upsertPairingRequest: (await import("./src/pairing/pairing-store.js"))
        .upsertChannelPairingRequest,
    },
    session: {
      resolveStorePath: (await import("./src/config/sessions.js")).resolveStorePath,
      readSessionUpdatedAt: (await import("./src/config/sessions.js")).readSessionUpdatedAt,
      recordSessionMetaFromInbound: (await import("./src/config/sessions.js"))
        .recordSessionMetaFromInbound,
      recordInboundSession: (await import("./src/channels/session.js")).recordInboundSession,
      updateLastRoute: (await import("./src/config/sessions.js")).updateLastRoute,
    },
    media: {
      fetchRemoteMedia: (await import("./src/media/fetch.js")).fetchRemoteMedia,
      saveMediaBuffer: (await import("./src/media/store.js")).saveMediaBuffer,
    },
    activity: {
      record: (await import("./src/infra/channel-activity.js")).recordChannelActivity,
      get: (await import("./src/infra/channel-activity.js")).getChannelActivity,
    },
    mentions: {
      buildMentionRegexes: (await import("./src/auto-reply/reply/mentions.js")).buildMentionRegexes,
      matchesMentionPatterns: (await import("./src/auto-reply/reply/mentions.js"))
        .matchesMentionPatterns,
      matchesMentionWithExplicit: (await import("./src/auto-reply/reply/mentions.js"))
        .matchesMentionWithExplicit,
    },
    reactions: {
      shouldAckReaction: (await import("./src/channels/ack-reactions.js")).shouldAckReaction,
      removeAckReactionAfterReply: (await import("./src/channels/ack-reactions.js"))
        .removeAckReactionAfterReply,
    },
    groups: {
      resolveGroupPolicy: (await import("./src/config/group-policy.js")).resolveChannelGroupPolicy,
      resolveRequireMention: (await import("./src/config/group-policy.js"))
        .resolveChannelGroupRequireMention,
    },
    debounce: {
      createInboundDebouncer: (await import("./src/auto-reply/inbound-debounce.js"))
        .createInboundDebouncer,
      resolveInboundDebounceMs: (await import("./src/auto-reply/inbound-debounce.js"))
        .resolveInboundDebounceMs,
    },
    commands: {
      resolveCommandAuthorizedFromAuthorizers: (await import("./src/channels/command-gating.js"))
        .resolveCommandAuthorizedFromAuthorizers,
      isControlCommandMessage: (await import("./src/auto-reply/command-detection.js"))
        .isControlCommandMessage,
      shouldComputeCommandAuthorized: (await import("./src/auto-reply/command-detection.js"))
        .shouldComputeCommandAuthorized,
      shouldHandleTextCommands: (await import("./src/auto-reply/commands-registry.js"))
        .shouldHandleTextCommands,
    },
    // 内置 channel 专用方法，外部 plugin 不会调用，空实现占位
    discord: {} as any,
    slack: {} as any,
    telegram: {} as any,
    signal: {} as any,
    line: {} as any,
  };
}
```

---

## Part 4：启动 Channel（createChannelManager）

**关键源码**：`src/gateway/server-channels.ts:59`（`ChannelManagerOptions`）、`src/gateway/server-channels.ts:111`（`createChannelManager`）

```typescript
import { createChannelManager } from "./src/gateway/server-channels.js";
import { loadConfig } from "./src/config/config.js";
import { createSubsystemLogger } from "./src/logging/subsystem.js";
import { listChannelPlugins } from "./src/channels/plugins/index.js";
import { defaultRuntime } from "./src/runtime.js";

const myAgent: MyAgentFn = async ({ text, sessionKey }) => {
  return `Echo: ${text}`;
};

const channelRuntime = buildCustomChannelRuntime(myAgent);

const channelPlugins = listChannelPlugins();
const channelLogs = Object.fromEntries(
  channelPlugins.map((p) => [p.id, createSubsystemLogger(`channel:${p.id}`)]),
);
const channelRuntimeEnvs = Object.fromEntries(channelPlugins.map((p) => [p.id, defaultRuntime]));

const channelManager = createChannelManager({
  loadConfig,
  channelLogs,
  channelRuntimeEnvs,
  channelRuntime, // ★ 注入自定义 runtime
});

await channelManager.startChannels();
```

内部每个账号启动时调用（`src/gateway/server-channels.ts:227`）：

```typescript
startAccount({
  cfg, accountId, account,
  runtime: channelRuntimeEnvs[channelId],
  abortSignal: abort.signal,
  log,
  getStatus: () => ...,
  setStatus: (next) => ...,
  channelRuntime,     // ← 你的自定义 runtime 从这里注入 Plugin
})
```

---

## Part 5：主动发消息

```typescript
import { loadChannelOutboundAdapter } from "./src/channels/plugins/outbound/load.js";
import type { ChannelOutboundContext } from "./src/channels/plugins/types.adapters.js";

async function sendMessageToChannel(params: {
  channel: string;
  to: string;
  text: string;
  accountId?: string;
}) {
  const cfg = loadConfig();
  const outbound = await loadChannelOutboundAdapter(params.channel);
  if (!outbound?.sendText) throw new Error(`${params.channel} does not support sendText`);

  return await outbound.sendText({
    cfg,
    to: params.to,
    text: params.text,
    accountId: params.accountId ?? "default",
  } satisfies ChannelOutboundContext);
  // 返回: { channel, messageId, chatId }
}
```

---

## Part 6：完整启动顺序

```typescript
async function bootstrap(myAgentFn: MyAgentFn) {
  const cfg = loadConfig();
  const channelRuntime = buildCustomChannelRuntime(myAgentFn);
  const minimalRuntime = buildMinimalPluginRuntime(channelRuntime); // 见注意事项4

  // 1. 注册插件（直接 import，无需 jiti/discover）
  const { registry, createApi } = createPluginRegistry({
    logger: console,
    runtime: minimalRuntime,
  });
  for (const [id, plugin] of channelPluginEntries) {
    const record = makeRecord(id);
    const api = createApi(record, { config: cfg, pluginConfig: {} });
    api.registerChannel({ plugin });
    registry.plugins.push(record);
  }
  setActivePluginRegistry(registry);

  // 2. 启动
  const plugins = listChannelPlugins();
  const channelManager = createChannelManager({
    loadConfig,
    channelLogs: Object.fromEntries(plugins.map((p) => [p.id, createSubsystemLogger(p.id)])),
    channelRuntimeEnvs: Object.fromEntries(plugins.map((p) => [p.id, defaultRuntime])),
    channelRuntime,
  });
  await channelManager.startChannels();

  return { channelManager, sendMessage: sendMessageToChannel };
}
```

---

## 注意事项

1. **`setActivePluginRegistry` 使用 `globalThis` 单例**（`Symbol.for("openclaw.pluginRegistryState")`），`getChannelPlugin()` 等函数依赖它，必须在 `startChannels()` 之前调用。

2. **`gateway.startAccount()` 的 Promise 必须保持 pending**：这个 Promise 相当于"连接的生命周期"，Gateway 会在需要停止时触发 `abortSignal`。

3. **`deliveryMode` 影响 sendText 调用时机**：
   - `"direct"` — Agent 回复经由 deliver 回调直接发回，不走 `outbound.sendText`
   - `"gateway"` — 所有出站消息都走 `outbound.sendText`
   - `"hybrid"` — 两者都用

4. **最小 PluginRuntime 包装**：`createPluginRegistry` 需要完整 `PluginRuntime` 对象，但 Channel Plugin 只用 `channel` 字段，其他字段可空实现：

```typescript
function buildMinimalPluginRuntime(channel: PluginRuntimeChannel): PluginRuntime {
  return {
    version: "1.0.0",
    channel,
    config: { loadConfig: () => ({}), watchConfig: () => () => {} } as any,
    system: {} as any,
    media: {} as any,
    tts: {} as any,
    stt: {} as any,
    logging: {} as any,
    tools: {} as any,
    subagent: {
      run: () => {
        throw new Error("not implemented");
      },
      waitForRun: () => {
        throw new Error("not implemented");
      },
      getSessionMessages: () => {
        throw new Error("not implemented");
      },
      getSession: () => {
        throw new Error("not implemented");
      },
      deleteSession: () => {
        throw new Error("not implemented");
      },
    },
  };
}
```

5. **自动重启**：`createChannelManager` 内置指数退避重启策略（最多 10 次，`src/gateway/server-channels.ts:13`），不需要自己实现。

---

## 关键文件速查

| 关注点                                   | 文件                                          | 关键行  |
| ---------------------------------------- | --------------------------------------------- | ------- |
| ChannelPlugin 接口定义                   | `src/channels/plugins/types.plugin.ts`        | 全文    |
| Adapter 类型（收/发消息 ctx）            | `src/channels/plugins/types.adapters.ts`      | 89、168 |
| PluginRuntimeChannel 类型                | `src/plugins/runtime/types-channel.ts`        | 16      |
| PluginRuntimeChannel 原始实现            | `src/plugins/runtime/runtime-channel.ts`      | 全文    |
| createPluginRegistry                     | `src/plugins/registry.ts`                     | 185     |
| setActivePluginRegistry                  | `src/plugins/runtime.ts`                      | 25      |
| createChannelManager 参数                | `src/gateway/server-channels.ts`              | 59      |
| dispatchReplyWithBufferedBlockDispatcher | `src/auto-reply/reply/provider-dispatcher.ts` | 14      |
| deliver 回调类型                         | `src/auto-reply/reply/reply-dispatcher.ts`    | 19      |
| FinalizedMsgContext（ctx 字段）          | `src/auto-reply/templating.ts`                | 全文    |
| 简单参考实现                             | `extensions/synology-chat/src/channel.ts`     | 全文    |

---

## 分层架构（高内聚低耦合）

外部 Agent 项目按以下四层组织，每层只依赖下层，Channel 相关逻辑全部收敛在传输层和契约层：

```
┌────────────────────────────────────────────────────────────┐
│  Layer 4 · Agent 推理层                                     │
│  你的 AI 逻辑，接收标准化 InboundMessage，返回 string       │
│  只知道"消息进来了，要返回什么"，不感知 Channel 细节         │
│  src: agent.ts                                             │
└──────────────────────────┬─────────────────────────────────┘
                           │ 调用
┌──────────────────────────▼─────────────────────────────────┐
│  Layer 3 · 调度/胶水层                                      │
│  替换 dispatchReplyWithBufferedBlockDispatcher              │
│  负责：标准化 ctx → 调 Agent → 调 deliver()                 │
│  src: channel-runtime.ts                                   │
│  ─────────────────────────────────────────────────────     │
│  此层是唯一修改点，上层不感知 Channel，下层不感知 Agent      │
└──────────────────────────┬─────────────────────────────────┘
                           │ 注入 channelRuntime
┌──────────────────────────▼─────────────────────────────────┐
│  Layer 2 · Channel 传输层                  【全部 import】   │
│  Plugin 注册、Channel 生命周期、消息收发、路由、会话         │
│  src: channels.ts（注册）、main.ts（启动）                  │
│  import: createPluginRegistry、createChannelManager        │
│          listChannelPlugins、loadChannelOutboundAdapter     │
│  ─────────────────────────────────────────────────────     │
│  Channel 相关逻辑全部收敛在此层，不泄漏到上层               │
└──────────────────────────┬─────────────────────────────────┘
                           │ 实现
┌──────────────────────────▼─────────────────────────────────┐
│  Layer 1 · Channel 契约层（接口/类型）      【全部 import】   │
│  ChannelPlugin、ChannelGatewayContext、ChannelOutboundContext│
│  PluginRuntimeChannel、PluginRegistry、ReplyDispatcher      │
│  import: types.plugin.ts、types.adapters.ts、types-channel.ts│
└────────────────────────────────────────────────────────────┘
```

**层间规则**：

- Layer 4（Agent）→ 只输入/输出纯文本，不 import 任何 Channel 类型
- Layer 3（胶水）→ 是唯一同时 import Layer 4 和 Layer 1 类型的地方
- Layer 2（传输）→ 只 import Layer 1 契约，不知道 Agent 存在
- Layer 1（契约）→ 纯类型，无运行时依赖

---

## 文件迁移分析

按照以上分层，将 OpenClaw 源文件分为三类：

### ① 必须迁移（契约层 — Layer 1）

这些文件定义接口契约，任何使用 Channel Plugin 的项目都需要：

| 文件                                       | 作用                                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `src/channels/plugins/types.plugin.ts`     | `ChannelPlugin<T>` 主接口                                                                       |
| `src/channels/plugins/types.adapters.ts`   | `ChannelGatewayContext`、`ChannelOutboundContext`、`ChannelOutboundAdapter` 等所有 Adapter 类型 |
| `src/channels/plugins/types.core.ts`       | `ChannelAccountSnapshot`、`ChannelMeta`、`ChannelCapabilities` 等核心类型                       |
| `src/channels/plugins/types.ts`            | 统一 re-export 入口                                                                             |
| `src/plugins/runtime/types-channel.ts`     | `PluginRuntimeChannel`（channelRuntime 的完整类型）                                             |
| `src/plugins/runtime/types.ts`             | `PluginRuntime`（createPluginRegistry 依赖）                                                    |
| `src/auto-reply/reply/reply-dispatcher.ts` | `ReplyDispatcher`、`ReplyDispatcherWithTypingOptions`、`deliver` 回调类型                       |
| `src/auto-reply/templating.ts`             | `MsgContext`、`FinalizedMsgContext`（dispatch 参数类型）                                        |

### ② 按需迁移（传输层 — Layer 2，可直接 import）

这些是运行时逻辑，如果 openclaw 作为 npm 依赖则直接 import，如果要独立部署则需要搬迁：

| 文件                                      | 作用                                        | 优先级                  |
| ----------------------------------------- | ------------------------------------------- | ----------------------- |
| `src/plugins/registry.ts`                 | `createPluginRegistry`、`PluginRegistry`    | 高（注册入口）          |
| `src/plugins/runtime.ts`                  | `setActivePluginRegistry` 全局单例          | 高（注册入口）          |
| `src/gateway/server-channels.ts`          | `createChannelManager`（含自动重启）        | 高（Channel 生命周期）  |
| `src/channels/plugins/index.ts`           | `listChannelPlugins`、`getChannelPlugin`    | 高（读取已注册 plugin） |
| `src/channels/plugins/outbound/load.ts`   | `loadChannelOutboundAdapter`（主动发消息）  | 高（出站）              |
| `src/auto-reply/reply/inbound-context.ts` | `finalizeInboundContext`（标准化 ctx）      | 高（调度层必用）        |
| `src/routing/resolve-route.ts`            | `resolveAgentRoute`、`buildAgentSessionKey` | 中（路由）              |
| `src/channels/session.ts`                 | `recordInboundSession`                      | 中（会话持久化）        |
| `src/auto-reply/chunk.ts`                 | `chunkMarkdownText` 等文本分块              | 中（Plugin 发消息时用） |
| `src/infra/backoff.ts`                    | `computeBackoff`（Channel 自动重启依赖）    | 中                      |
| `src/pairing/pairing-store.ts`            | `readChannelAllowFromStore`（白名单）       | 低（仅需要配对时）      |
| `src/media/fetch.ts`、`store.ts`          | 媒体下载/存储                               | 低（仅需要媒体时）      |

### ③ 不需要迁移（AI 推理层 — 替换掉的部分）

这些文件是 OpenClaw 的 AI 层，外部 Agent 用自己的替代：

| 文件                                           | 为什么不需要                                           |
| ---------------------------------------------- | ------------------------------------------------------ |
| `src/auto-reply/reply/get-reply.ts`            | 被你的 `myAgent()` 替代                                |
| `src/auto-reply/reply/agent-runner.ts`         | 同上                                                   |
| `src/auto-reply/reply/dispatch-from-config.ts` | 被你的 `dispatchReplyWithBufferedBlockDispatcher` 替代 |
| `src/agents/` 整个目录                         | OpenClaw AI 层，完全替换                               |
| `src/gateway/server.ts` 等 WS 服务             | 你不需要 Gateway WebSocket 服务端                      |
| `src/gateway/server-methods/`                  | 同上                                                   |
