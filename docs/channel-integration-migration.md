# Channel 生态集成迁移方案

> 目标：在独立 TS Agent 工程中复用 OpenClaw 全套 channel 插件（注册/加载/收信/发信），同时让重构工作量最小。

---

## 一、整体架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                    独立 Agent 工程                               │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                  你实现的 Host 层                         │   │
│  │                                                         │   │
│  │  ChannelHost                                            │   │
│  │    ├── loadPlugins()        ← 插件注册/加载              │   │
│  │    ├── startChannel()       ← 启动 channel 监听          │   │
│  │    ├── sendMessage()        ← 发送消息                   │   │
│  │    └── PluginRuntime impl   ← 将 channel 消息接入你的 AI  │   │
│  └────────────────────────┬────────────────────────────────┘   │
│                           │ openclaw/plugin-sdk                 │
│  ┌────────────────────────▼────────────────────────────────┐   │
│  │              OpenClaw channel 插件（零改动）              │   │
│  │  extensions/matrix  extensions/discord  extensions/...  │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

**核心原则**：channel 插件侧零改动，只需在 Host 层实现两套接口。

---

## 二、需要搬迁的代码清单

以下文件**直接 copy**，内部逻辑不需要修改，只需替换 import 路径前缀。

### 2.1 插件注册/加载层（Plugin Management）

| 文件                               | 行数 | 作用                                         | 依赖的外部 import                                              |
| ---------------------------------- | ---- | -------------------------------------------- | -------------------------------------------------------------- |
| `src/plugins/discovery.ts`         | 711  | 扫描目录，发现插件 entry 文件                | `node:fs/path`、`./manifest`、`./path-safety`、`./bundled-dir` |
| `src/plugins/manifest.ts`          | 198  | 解析 `openclaw.plugin.json` / `package.json` | `node:fs/path`                                                 |
| `src/plugins/manifest-registry.ts` | 261  | 合并 manifest 信息，去重                     | `./discovery`、`./manifest`                                    |
| `src/plugins/path-safety.ts`       | 32   | 路径安全检查工具函数                         | `node:fs/path`                                                 |
| `src/plugins/bundled-dir.ts`       | 41   | 定位 bundled 插件目录                        | `node:path`                                                    |
| `src/plugins/schema-validator.ts`  | 150  | JSON Schema 验证插件 config                  | `ajv`（需 install）                                            |
| `src/plugins/registry.ts`          | 624  | 注册表，存储 channel/hook/tool 等            | 见下方说明                                                     |
| `src/plugins/loader.ts`            | 828  | 主入口：discovery→load→register              | 见下方说明                                                     |
| `src/infra/boundary-file-read.ts`  | 202  | 安全读取文件（防止 path escape）             | `node:fs/path`                                                 |
| `src/infra/openclaw-root.ts`       | 133  | 定位 openclaw package 根目录                 | `node:fs/path`                                                 |

**搬迁后需修改的地方**（仅改 import 路径，不改逻辑）：

- `loader.ts`：移除 `hook-runner-global`、`commands`、`runtime.ts`（`setActivePluginRegistry`）这三个 openclaw 特有依赖，见第三节
- `registry.ts`：移除 `context-engine/registry`、`hooks/internal-hooks`，见第三节

### 2.2 Channel 类型定义层（零修改搬迁）

| 文件                                     | 行数 | 作用                                            |
| ---------------------------------------- | ---- | ----------------------------------------------- |
| `src/channels/plugins/types.plugin.ts`   | 85   | `ChannelPlugin` 主接口                          |
| `src/channels/plugins/types.adapters.ts` | 383  | 所有 Adapter 接口（Gateway/Outbound/Config 等） |
| `src/channels/plugins/types.core.ts`     | 402  | Channel 基础类型（Meta/Capabilities/Id 等）     |

这三个文件**纯类型定义**，除了 `types.adapters.ts` 引用了 `PluginRuntime["channel"]`（可在你的工程里 forward 声明），其余无运行时依赖，可直接 copy。

### 2.3 PluginRuntime 类型定义（需裁剪）

| 文件                                   | 行数 | 搬迁策略                                                                                |
| -------------------------------------- | ---- | --------------------------------------------------------------------------------------- |
| `src/plugins/runtime/types.ts`         | 63   | **裁剪搬迁**：保留 `PluginRuntime` 骨架，移除 `subagent` 部分                           |
| `src/plugins/runtime/types-channel.ts` | 165  | **直接搬迁**：`PluginRuntimeChannel` 接口定义，全是 typeof import，你实现时只需对号入座 |
| `src/plugins/runtime/types-core.ts`    | 67   | **按需搬迁**：`PluginRuntimeCore` 中大多数字段不需要，仅保留 `version`、`logging` 两个  |

---

## 三、需要重构的代码清单

这些文件**不能直接 copy**，因为它们耦合了 openclaw 特有的子系统。重构策略是：提取有用部分，其余替换为 stub 或删除。

### 3.1 `loader.ts` 中需移除的 openclaw 特有依赖

| 依赖                                                    | 作用                                   | 替换方案                                               |
| ------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------ |
| `./hook-runner-global` → `initializeGlobalHookRunner()` | 初始化全局 hook 执行器                 | 在 `activatePluginRegistry()` 中移除这行，或换成 no-op |
| `./commands` → `clearPluginCommands()`                  | 清空 CLI 命令注册                      | 移除，你不需要 CLI 命令                                |
| `./runtime.ts` → `setActivePluginRegistry()`            | 设置全局单例 registry                  | 改为你自己的全局 context 存储（见 3.3）                |
| `./config-state` → `normalizePluginsConfig()`           | 解析 openclaw config 中的 plugins 配置 | 重构为接收你自己的 `PluginHostConfig`（见 3.4）        |
| `../logging/subsystem` → `createSubsystemLogger()`      | 日志                                   | 换成你的 logger，或 `console`                          |
| `../gateway/server-methods/types`                       | HTTP gateway 类型                      | 类型可以 stub 为 `Record<string, unknown>`             |

**重构工作量评估**：约 50-80 行改动，主要是替换这几处函数调用。

### 3.2 `registry.ts` 中需移除的 openclaw 特有依赖

| 依赖                                                     | 作用                 | 替换方案                            |
| -------------------------------------------------------- | -------------------- | ----------------------------------- |
| `../context-engine/registry` → `registerContextEngine()` | 注册上下文引擎       | 移除，或换成 no-op                  |
| `../hooks/internal-hooks` → `registerInternalHook()`     | 注册内部 hook 执行器 | 移除，你的 hook 系统与此无关        |
| `../hooks/types`                                         | Hook 类型            | 可用 `unknown` 替代或自定义简化类型 |
| `../agents/tools/common`                                 | Agent tool 类型      | 可以用 `unknown` stub               |
| `../channels/dock`                                       | ChannelDock 类型     | 直接搬迁（纯类型，见 2.2）          |

**重构工作量评估**：约 30-50 行，主要是删除和 stub 替换。

### 3.3 全局 Registry 访问（`src/plugins/runtime.ts`，49行）

openclaw 用 `setActivePluginRegistry()`/`requireActivePluginRegistry()` 存全局 registry 单例。

**替换方案**：在你的工程里建一个简单的 context 对象：

```typescript
// src/plugin-host/context.ts
let _registry: PluginRegistry | null = null;
export const setRegistry = (r: PluginRegistry) => {
  _registry = r;
};
export const getRegistry = (): PluginRegistry => {
  if (!_registry) throw new Error("PluginRegistry not initialized");
  return _registry;
};
```

### 3.4 配置结构（`src/plugins/config-state.ts`，286行）

openclaw 的 `normalizePluginsConfig()` 解析的是 `OpenClawConfig.plugins` 这个嵌套结构，与 openclaw 的完整 config schema 深度耦合。

**替换方案**：定义你自己的最小 config 接口：

```typescript
// 你的 PluginHostConfig
export type PluginHostConfig = {
  plugins?: {
    enabled?: boolean;
    allow?: string[]; // 白名单插件 id
    loadPaths?: string[]; // 额外扫描目录
    entries?: Record<string, { config?: unknown }>; // 每个插件的 config
  };
};
```

`config-state.ts` 中的 `normalizePluginsConfig()` 重构为接收此结构，约 40 行改动。

---

## 四、你需要自己实现的接口（Host 层）

这部分是**你的工程特有的**，需要自己写，但接口契约已定死。

### 4.1 PluginRuntime["channel"] — 最小实现

channel 插件通过 `ctx.channelRuntime` 调用以下两个**必须**实现的方法：

```typescript
// 文件：your-project/src/channel-host/runtime.ts

import type { PluginRuntimeChannel } from "./types-channel.js"; // 搬迁过来的

export function createChannelRuntime(agentHandler: AgentHandler): PluginRuntimeChannel {
  return {
    // ① 路由：决定把消息交给哪个 agent session
    routing: {
      resolveAgentRoute: ({ channel, accountId, peer }) => {
        // 你的路由逻辑，返回 agentId + sessionKey
        return {
          agentId: "default",
          sessionKey: `default:${channel}:${accountId}:${peer?.id}`,
          mainSessionKey: `default:${channel}:${accountId}:main`,
          channel,
          accountId: accountId ?? "default",
          matchedBy: "default",
          lastRoutePolicy: "main",
        };
      },
      buildAgentSessionKey: ({ agentId, channel, peer }) =>
        `${agentId}:${channel}:${peer?.id ?? "main"}`,
    },

    // ② 回复分派：调你的 AI，把输出发回 channel
    reply: {
      dispatchReplyFromConfig: async ({ ctx, dispatcherOptions }) => {
        const output = await agentHandler.process({
          content: ctx.content,
          sessionKey: ctx.sessionKey,
        });
        await dispatcherOptions.deliver({ text: output });
        return { dispatched: true };
      },
      // 其余 reply 方法按需实现，初期可 stub
      dispatchReplyWithBufferedBlockDispatcher: async () => {},
      createReplyDispatcherWithTyping: () => ({ deliver: async () => {} }),
      finalizeInboundContext: (ctx) => ctx,
      formatAgentEnvelope: () => "",
      formatInboundEnvelope: () => "",
      resolveEnvelopeFormatOptions: () => ({}),
      resolveEffectiveMessagesConfig: () => ({}),
      resolveHumanDelayConfig: () => ({}),
      withReplyDispatcher: async (_ctx, fn) => fn({} as any),
    },

    // ③ 文本工具：直接搬迁 openclaw 实现
    text: {
      /* 直接 import/copy src/auto-reply/chunk.ts 等纯函数 */
    },

    // ④ Session 存储：你的存储，或 no-op
    session: {
      recordInboundSession: async () => {},
      updateLastRoute: async () => {},
      resolveStorePath: () => "",
      readSessionUpdatedAt: async () => null,
      recordSessionMetaFromInbound: async () => {},
    },

    // ⑤ 以下初期全部 stub
    pairing: {
      buildPairingReply: () => "",
      readAllowFromStore: async () => [],
      upsertPairingRequest: async () => {},
    },
    media: { fetchRemoteMedia: async () => null, saveMediaBuffer: async () => "" },
    activity: { record: async () => {}, get: async () => null },
    mentions: {
      buildMentionRegexes: () => [],
      matchesMentionPatterns: () => false,
      matchesMentionWithExplicit: () => false,
    },
    reactions: { shouldAckReaction: () => false, removeAckReactionAfterReply: async () => {} },
    groups: { resolveGroupPolicy: () => null, resolveRequireMention: () => false },
    debounce: {
      createInboundDebouncer: () => ({ schedule: (fn) => fn() }),
      resolveInboundDebounceMs: () => 0,
    },
    commands: {
      resolveCommandAuthorizedFromAuthorizers: () => false,
      isControlCommandMessage: () => false,
      shouldComputeCommandAuthorized: () => false,
      shouldHandleTextCommands: () => false,
    },
    // channel-specific stubs: discord/slack/telegram/signal/imessage/whatsapp/line
    // 这些只有对应 channel 插件才会用到，初期全部 stub {}
    discord: {} as any,
    slack: {} as any,
    telegram: {} as any,
    signal: {} as any,
    imessage: {} as any,
    whatsapp: {} as any,
    line: {} as any,
  };
}
```

> **注意**：`discord/slack/telegram` 等 channel-specific 字段（如 `sendMessageDiscord`）是内置 channel 直接 import 使用的，外置插件（matrix、msteams 等）**不会**用到这些。因此初期全部 stub 即可。

### 4.2 Channel 生命周期管理

参考 `src/gateway/server-channels.ts` 实现以下三个方法：

```typescript
// your-project/src/channel-host/lifecycle.ts

export class ChannelHost {
  private registry: PluginRegistry;
  private runtime: PluginRuntimeChannel;
  private running = new Map<string, { abort: AbortController }>();

  async startChannel(channelId: string, cfg: PluginHostConfig) {
    const channelReg = this.registry.channels.find((c) => c.plugin.id === channelId);
    if (!channelReg) throw new Error(`Channel not registered: ${channelId}`);
    const plugin = channelReg.plugin;

    // 获取所有 accountId
    const accountIds = plugin.config.listAccountIds(cfg as any);
    for (const accountId of accountIds) {
      await this.startAccount(plugin, accountId, cfg);
    }
  }

  private async startAccount(plugin: ChannelPlugin, accountId: string, cfg: any) {
    const account = plugin.config.resolveAccount(cfg, accountId);
    if (!plugin.gateway?.startAccount) return;

    const abort = new AbortController();
    const status = { accountId, enabled: true, configured: true };

    plugin.gateway.startAccount({
      cfg,
      accountId,
      account,
      runtime: { logger: console } as any,
      abortSignal: abort.signal,
      getStatus: () => status,
      setStatus: (next) => Object.assign(status, next),
      channelRuntime: this.runtime, // ← 关键注入点
    });

    this.running.set(`${plugin.id}:${accountId}`, { abort });
  }

  async stopChannel(channelId: string, accountId: string) {
    const key = `${channelId}:${accountId}`;
    this.running.get(key)?.abort.abort();
    this.running.delete(key);
  }

  // 主动发送消息（你的 AI 输出后调用）
  async sendMessage(
    channelId: string,
    params: { to: string; text: string; accountId?: string; cfg: any },
  ) {
    const channelReg = this.registry.channels.find((c) => c.plugin.id === channelId);
    const outbound = channelReg?.plugin.outbound;
    if (!outbound?.sendText) throw new Error(`Channel ${channelId} has no outbound`);
    return outbound.sendText({ ...params, cfg: params.cfg });
  }
}
```

---

## 五、OpenClawConfig 的处理方案

channel 插件接口里到处是 `cfg: OpenClawConfig`，这个类型是 openclaw 的完整配置结构，有几十个字段。

**处理策略**：

1. **类型层**：搬迁 `src/config/types.openclaw.ts`（约 200 行），但这会带入大量 openclaw 特有的 config 子类型
2. **推荐方案**：用 `unknown` / `Record<string, unknown>` 替代，因为 channel 插件里 `cfg` 的使用主要是读 `cfg.telegram`、`cfg.matrix` 等 channel-specific 字段，这些字段你不需要在 Host 层解析，交给插件自己处理即可

```typescript
// 在你的工程里
type ChannelCfgProxy = Record<string, unknown>;

// channel 插件里的 plugin.config.resolveAccount(cfg, accountId)
// cfg 实际是你的 config 文件的 JSON，channel 插件会自己读取对应字段
```

实际上 channel 插件的 config adapter 期望的 `cfg` 结构**由插件自己定义**（如 `CoreConfig` in matrix），你只需要把你的 config JSON 原样传进去，插件会自己提取它需要的字段。

---

## 六、jiti 别名机制的处理

`loader.ts` 里用 jiti 创建别名，让插件里的 `import { xxx } from "openclaw/plugin-sdk/matrix"` 能解析到你工程里的实现：

```typescript
// loader.ts 的核心别名逻辑（需搬迁）
const aliasMap = {
  "openclaw/plugin-sdk": resolvePluginSdkAlias(), // root alias
  "openclaw/plugin-sdk/matrix": "your-sdk/matrix.ts", // per-subpath alias
  // ... 每个 sdk 子路径
};
const jiti = createJiti(import.meta.url, { alias: aliasMap });
```

**你需要提供的 plugin-sdk 实现文件**：

每个 channel 插件会 import 对应的 `openclaw/plugin-sdk/<channel>` 子路径（如 `openclaw/plugin-sdk/matrix`）获取共享工具函数。这些文件在 openclaw 里位于 `src/plugin-sdk/` 目录。

**搬迁策略**：

- 将 `src/plugin-sdk/` 目录整体搬迁到你的工程
- 在 jiti alias 中指向你的目录
- 其中引用了 openclaw 内部模块的函数，用 stub 替换（这些主要是 `compat.ts` 里的高级工具函数，外部 channel 插件通常只用基础 SDK 函数）

---

## 七、依赖清单（需要 install 的 npm 包）

| 包名   | 用途                        | 从哪个文件引入        |
| ------ | --------------------------- | --------------------- |
| `jiti` | TypeScript 动态加载插件文件 | `loader.ts`           |
| `ajv`  | JSON Schema 验证插件 config | `schema-validator.ts` |

openclaw 本身已有这两个包，你只需要在你的工程里 `npm install jiti ajv`。

---

## 八、迁移工作量总结

| 类别                                     | 文件数 | 总行数 | 工作量 | 说明                                                    |
| ---------------------------------------- | ------ | ------ | ------ | ------------------------------------------------------- |
| **直接搬迁（零改动）**                   | 8      | ~2000  | 低     | channel 类型定义 + discovery + manifest + path-safety   |
| **轻度重构（改 import + 移除几个函数）** | 2      | ~1400  | 中     | `loader.ts`、`registry.ts`                              |
| **配置层重构**                           | 1      | ~286   | 中     | `config-state.ts` → 换成你的 `PluginHostConfig`         |
| **新增实现（Host 层）**                  | 3      | ~200   | 中     | `channel-host/runtime.ts`、`lifecycle.ts`、`context.ts` |
| **plugin-sdk 目录搬迁**                  | ~20    | ~1500  | 低-中  | 大部分是纯工具函数，少数需 stub                         |

**预计核心代码量**：搬迁约 3500 行（改动量<20%），新增约 200 行。

---

## 九、推荐目录结构

```
your-project/src/
├── channel-host/
│   ├── context.ts          # 全局 registry 存取（新增 ~15 行）
│   ├── runtime.ts          # PluginRuntimeChannel 实现（新增 ~100 行）
│   ├── lifecycle.ts        # ChannelHost 启动/停止/发送（新增 ~80 行）
│   └── index.ts            # 对外导出
├── plugins/                # 从 openclaw src/plugins/ 搬迁
│   ├── discovery.ts        # 直接搬迁
│   ├── manifest.ts         # 直接搬迁
│   ├── manifest-registry.ts# 直接搬迁
│   ├── path-safety.ts      # 直接搬迁
│   ├── bundled-dir.ts      # 直接搬迁（或删除，你不需要 bundled 插件）
│   ├── schema-validator.ts # 直接搬迁
│   ├── registry.ts         # 轻度重构（移除 hook/context-engine 依赖）
│   ├── loader.ts           # 轻度重构（移除 hook-runner/commands/setActive）
│   └── config-state.ts     # 重构（换成 PluginHostConfig）
├── channels/
│   └── plugins/
│       ├── types.plugin.ts # 直接搬迁
│       ├── types.adapters.ts# 直接搬迁
│       └── types.core.ts   # 直接搬迁
├── plugin-sdk/             # 从 openclaw src/plugin-sdk/ 搬迁
│   ├── compat.ts
│   ├── matrix.ts
│   └── ...
└── infra/
    ├── boundary-file-read.ts # 直接搬迁
    └── openclaw-root.ts      # 直接搬迁
```

---

## 十、实施顺序建议

```
Step 1：搬迁类型定义
  └── channels/plugins/types.*.ts（零改动，建立类型基础）
  └── plugins/runtime/types*.ts（裁剪搬迁）

Step 2：搬迁插件发现/加载基础
  └── infra/boundary-file-read.ts、openclaw-root.ts
  └── plugins/path-safety.ts、bundled-dir.ts、manifest.ts

Step 3：重构加载主流程
  └── plugins/discovery.ts（直接搬迁）
  └── plugins/manifest-registry.ts（直接搬迁）
  └── plugins/config-state.ts（重构 → PluginHostConfig）
  └── plugins/registry.ts（移除 hook/context-engine 依赖）
  └── plugins/loader.ts（移除 hook-runner/commands）

Step 4：实现 Host 层
  └── channel-host/context.ts
  └── channel-host/runtime.ts（routing + reply 核心）
  └── channel-host/lifecycle.ts

Step 5：搬迁 plugin-sdk
  └── plugin-sdk/ 目录（让 jiti alias 指向这里）

Step 6：验证一个 channel 插件（如 extensions/matrix）
  └── 在你的工程里加载、启动、收发消息
```

---

## 十一、关键文件位置速查

| 接口                        | 定义位置                                 | 行号                       |
| --------------------------- | ---------------------------------------- | -------------------------- |
| `ChannelPlugin`             | `src/channels/plugins/types.plugin.ts`   | 49                         |
| `ChannelGatewayAdapter`     | `src/channels/plugins/types.adapters.ts` | 275                        |
| `ChannelGatewayContext`     | `src/channels/plugins/types.adapters.ts` | 168                        |
| `ChannelOutboundAdapter`    | `src/channels/plugins/types.adapters.ts` | 108                        |
| `ChannelOutboundContext`    | `src/channels/plugins/types.adapters.ts` | 89                         |
| `ChannelConfigAdapter`      | `src/channels/plugins/types.adapters.ts` | 52                         |
| `PluginRuntime`             | `src/plugins/runtime/types.ts`           | 51                         |
| `PluginRuntimeChannel`      | `src/plugins/runtime/types-channel.ts`   | 16                         |
| `OpenClawPluginApi`         | `src/plugins/types.ts`                   | ~580（createApi 返回类型） |
| `loadOpenClawPlugins()`     | `src/plugins/loader.ts`                  | 447                        |
| `discoverOpenClawPlugins()` | `src/plugins/discovery.ts`               | 618                        |
| `createPluginRegistry()`    | `src/plugins/registry.ts`                | 185                        |

---

## 十二、现有 Channel 插件从 openclaw gateway 迁移到自定义 Agent

> 适用场景：已有一个按 openclaw `clawdbot/plugin-sdk` 或旧版 SDK 编写的 channel 插件（`plugin.ts`），想将其 AI 调用从 openclaw gateway 改为自定义 Agent 函数调用，同时保留所有 channel 平台相关代码。

### 12.1 典型插件架构模式

现有 openclaw 生态中的 channel 插件通常遵循以下模式：

```
用户消息（平台 SDK 接收）
    ↓
handleMessage()          ← 核心消息处理函数
    ↓
streamFromGateway()      ← AI 调用函数，唯一与 openclaw 耦合的地方
    ↓
http://127.0.0.1:<port>/v1/chat/completions   ← openclaw gateway HTTP SSE
    ↓
openclaw 内置 AI 处理
```

**与 AI 无关、可原样保留的部分**（通常占插件代码 90% 以上）：

- 平台 SDK 连接与消息接收（如 DingTalk DWClient、Slack WebSocket 等）
- 消息去重、Session 管理
- 富媒体处理（图片/文件/视频/音频上传下载）
- 流式展示组件（如 AI Card、进度消息等）
- `outbound.sendText` 等主动发消息函数
- 平台特有 API 封装

**需要替换的部分**：

- `streamFromGateway()`（或类似名称）这一个函数
- SDK import 中的 openclaw 类型引用
- `register(api)` 中的 openclaw 注册调用
- `rt.channel.activity.record()` 等 openclaw 内部 API 调用

### 12.2 通用改动清单（共 5 处）

#### 改动一：替换 SDK import

定位插件顶部的 openclaw SDK import，替换为自定义 Agent 的类型：

```typescript
// 旧：openclaw/clawdbot SDK 类型
import type { ClawdbotPluginApi, PluginRuntime, ClawdbotConfig } from "clawdbot/plugin-sdk";
// 或
import type { OpenClawPluginApi, PluginRuntime, OpenClawConfig } from "openclaw/plugin-sdk";

// 新：替换为自定义 Agent 类型（快速验证阶段可全部改为 any）
import type { YourAgentApi, YourConfig } from "../your-agent";
```

全局搜索替换 `ClawdbotConfig` / `OpenClawConfig`、`PluginRuntime`、`ClawdbotPluginApi` / `OpenClawPluginApi` 这几个类型名。

#### 改动二：替换 AI 调用函数（核心）

找到插件中调用 openclaw gateway 的函数（通常命名为 `streamFromGateway`、`callGateway`、`askAgent` 等），**保持函数名和签名不变，只替换函数体**，这样所有调用点无需改动。

关键约束：函数必须返回 `AsyncGenerator<string>`（逐 chunk yield 文本），以保持对流式展示组件（如 AI Card）的兼容。

```typescript
// 替换模板：保留原函数签名，只改函数体
async function* streamFromGateway(
  options: { userContent: string; systemPrompts: string[]; sessionKey: string /* ... */ },
  accountId: string,
): AsyncGenerator<string, void, unknown> {
  // TODO: 调用你的自定义 Agent
  // 要求：必须是 AsyncGenerator<string>，逐 chunk yield 文本
  //
  // 示例：
  // for await (const chunk of myAgent.stream({ ...options, accountId })) {
  //   yield chunk;
  // }
}
```

如果你的 Agent 不支持流式输出（只返回完整字符串），可包装为单 chunk generator：

```typescript
async function* streamFromGateway(options, accountId) {
  const result = await myAgent.call({ ...options, accountId });
  yield result; // 单次 yield 全量文本
}
```

#### 改动三：删除 openclaw 内部 API 调用

插件的 `gateway.startAccount` 里通常有 openclaw 内部的 activity 记录：

```typescript
// 删除或替换以下模式的调用（openclaw 内部 API）
const rt = getRuntime();
rt.channel.activity.record(channelId, accountId, "start");
rt.channel.activity.record(channelId, accountId, "stop");
```

如需保留活动记录，替换为自己的 logger/metrics 调用。

#### 改动四：改造插件注册函数

找到 `register(api)` 函数，替换 openclaw 特有的注册调用：

```typescript
// 旧：openclaw plugin API
register(api: ClawdbotPluginApi) {
  runtime = api.runtime;
  api.registerChannel({ plugin: myChannelPlugin });
  api.registerGatewayMethod('my-channel.sendToUser', ...);
}

// 新（根据你的框架二选一）：

// 方案 A：你的框架实现了 ChannelPlugin 协议（推荐）
myAgent.registerChannel(myChannelPlugin);

// 方案 B：直接驱动（框架未实现 ChannelPlugin 协议时）
myChannelPlugin.gateway.startAccount({
  account: resolvedAccount,
  cfg: myConfig,
  abortSignal: myAbortController.signal,
  log: myLogger,
  channelRuntime: myChannelRuntime,  // 见第四节 4.1
});
```

#### 改动五：清理 gateway 认证配置（可选）

`configSchema` 里如有 `gatewayToken`、`gatewayPassword`、`gatewayUrl` 等字段，这些是 openclaw gateway 专用，迁移后可从 schema 和消息处理函数中删除。

### 12.3 改动量参考（以 DingTalk Connector 为例）

DingTalk Connector（`plugin.ts` 约 3400 行）实测改动量：

| 改动                                      | 行数     | 难度                      |
| ----------------------------------------- | -------- | ------------------------- |
| 替换 SDK import（改动一）                 | ~10 行   | 低                        |
| 替换 `streamFromGateway` 函数体（改动二） | ~80 行   | 中（依赖 Agent 接口确认） |
| 删除 activity 埋点（改动三）              | 3 行删除 | 低                        |
| 改造 `register` 函数（改动四）            | ~20 行   | 中                        |
| 删除 gateway 认证配置（改动五）           | 4 行删除 | 低                        |

**合计：约 110 行改动，其余 3300+ 行原样保留。**

其他规模插件可按比例估算：改动量基本恒定在 100–150 行，与插件总行数无关（因为耦合点固定为这 5 处）。

### 12.4 排期预估

| 阶段    | 内容                                                                   | 工作量 |
| ------- | ---------------------------------------------------------------------- | ------ |
| P0 核心 | 改动一～三：替换 import、实现 AI 调用函数、删除内部 API 依赖           | 0.5 天 |
| P0 核心 | 改动四：接入自定义框架注册，启动 `startAccount` 和 `outbound.sendText` | 0.5 天 |
| P1 验证 | 端到端联调：基础单聊收发、流式展示正常                                 | 0.5 天 |
| P2 补全 | 群聊、异步模式、富媒体（图片/文件）、降级消息等场景验证                | 1 天   |
| P3 收尾 | 删除无用配置项、清理代码、更新文档                                     | 0.5 天 |

**每个插件约 3 天**（前提：Agent 接口已确定，不需要同时开发 Agent）。多个插件并行改造时，P0/P3 阶段经验可复用，后续插件可缩短至 2 天。

### 12.5 风险点

| 风险                                          | 影响                 | 缓解方案                                                |
| --------------------------------------------- | -------------------- | ------------------------------------------------------- |
| Agent 接口不支持流式输出                      | 改动二需额外包装     | 用 Promise 结果模拟单 chunk generator（见 12.2 改动二） |
| 你的框架没有 ChannelPlugin 注册机制           | 改动四需手动驱动     | 直接调用 `plugin.gateway.startAccount(...)`             |
| `rt.channel.activity.record` 有业务监控依赖   | 删除后影响状态追踪   | 替换为自己的 logger 埋点，不影响消息收发                |
| 插件依赖 openclaw 特有的 `PluginRuntime` 字段 | 改动一类型替换后报错 | 先全部改为 `any` 跑通，再逐步补类型                     |

### 12.6 给执行 Agent 的通用操作步骤

```
1. 确认自定义 Agent 的调用签名
   - 流式：AsyncGenerator<string> 或可包装为此形式
   - 非流式：Promise<string>（包装为单 chunk generator）

2. 定位插件顶部的 openclaw SDK import，替换为自定义 Agent 类型（或 any）

3. 全局替换旧 SDK 的类型名（ClawdbotConfig/OpenClawConfig、PluginRuntime、ClawdbotPluginApi）

4. 找到 streamFromGateway（或类似命名）函数：
   - 保留函数名和签名不变
   - 只替换函数体为调用自定义 Agent 的实现

5. 删除 gateway.startAccount 里的 rt.channel.activity.record 调用
   （通常 2–3 行，搜索 activity.record 定位）

6. 修改 register(api) 函数，替换 api.registerChannel / api.registerGatewayMethod

7. （可选）从 configSchema 删除 gatewayToken / gatewayPassword / gatewayUrl 字段

8. 本地测试：发送消息 → Agent 返回 → 消息正常展示（含流式场景）
```
