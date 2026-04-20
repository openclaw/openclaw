---
title: "构建插件"
sidebarTitle: "入门"
summary: "在几分钟内创建您的第一个 OpenClaw 插件"
read_when:
  - 您想要创建一个新的 OpenClaw 插件
  - 您需要插件开发的快速入门
  - 您正在向 OpenClaw 添加新的通道、提供者、工具或其他能力
---

# 构建插件

插件为 OpenClaw 扩展新能力：通道、模型提供者、
语音、实时转录、实时语音、媒体理解、图像
生成、视频生成、网络获取、网络搜索、代理工具，或任何
组合。

您不需要将插件添加到 OpenClaw 仓库。发布到
[ClawHub](/tools/clawhub) 或 npm，用户可以通过
`openclaw plugins install <package-name>` 安装。OpenClaw 首先尝试 ClawHub，然后
自动回退到 npm。

## 先决条件

- Node >= 22 和包管理器（npm 或 pnpm）
- 熟悉 TypeScript（ESM）
- 对于仓库内插件：已克隆仓库并执行 `pnpm install`

## 什么类型的插件？

<CardGroup cols={3}>
  <Card title="通道插件" icon="messages-square" href="/plugins/sdk-channel-plugins">
    将 OpenClaw 连接到消息平台（Discord、IRC 等）
  </Card>
  <Card title="提供者插件" icon="cpu" href="/plugins/sdk-provider-plugins">
    添加模型提供者（LLM、代理或自定义端点）
  </Card>
  <Card title="工具 / 钩子插件" icon="wrench">
    注册代理工具、事件钩子或服务 — 继续阅读
  </Card>
</CardGroup>

如果通道插件是可选的，并且在入职/设置
运行时可能未安装，请使用 `openclaw/plugin-sdk/channel-setup` 中的 `createOptionalChannelSetupSurface(...)`。它会生成一个设置适配器 + 向导对，
在插件安装之前，会宣传安装要求并在实际配置写入时失败关闭。

## 快速入门：工具插件

本指南创建一个最小化的插件，用于注册代理工具。通道
和提供者插件有上面链接的专用指南。

<Steps>
  <Step title="创建包和清单">
    <CodeGroup>
    ```json package.json
    {
      "name": "@myorg/openclaw-my-plugin",
      "version": "1.0.0",
      "type": "module",
      "openclaw": {
        "extensions": ["./index.ts"],
        "compat": {
          "pluginApi": ">=2026.3.24-beta.2",
          "minGatewayVersion": "2026.3.24-beta.2"
        },
        "build": {
          "openclawVersion": "2026.3.24-beta.2",
          "pluginSdkVersion": "2026.3.24-beta.2"
        }
      }
    }
    ```

    ```json openclaw.plugin.json
    {
      "id": "my-plugin",
      "name": "My Plugin",
      "description": "Adds a custom tool to OpenClaw",
      "configSchema": {
        "type": "object",
        "additionalProperties": false
      }
    }
    ```
    </CodeGroup>

    每个插件都需要一个清单，即使没有配置。有关完整模式，请参阅
    [清单](/plugins/manifest)。ClawHub 发布的规范片段位于 `docs/snippets/plugin-publish/`。

  </Step>

  <Step title="编写入口点">

    ```typescript
    // index.ts
    import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
    import { Type } from "@sinclair/typebox";

    export default definePluginEntry({
      id: "my-plugin",
      name: "My Plugin",
      description: "Adds a custom tool to OpenClaw",
      register(api) {
        api.registerTool({
          name: "my_tool",
          description: "Do a thing",
          parameters: Type.Object({ input: Type.String() }),
          async execute(_id, params) {
            return { content: [{ type: "text", text: `Got: ${params.input}` }] };
          },
        });
      },
    });
    ```

    `definePluginEntry` 用于非通道插件。对于通道，使用
    `defineChannelPluginEntry` — 请参阅 [通道插件](/plugins/sdk-channel-plugins)。
    有关完整的入口点选项，请参阅 [入口点](/plugins/sdk-entrypoints)。

  </Step>

  <Step title="测试和发布">

    **外部插件：** 使用 ClawHub 验证和发布，然后安装：

    ```bash
    clawhub package publish your-org/your-plugin --dry-run
    clawhub package publish your-org/your-plugin
    openclaw plugins install clawhub:@myorg/openclaw-my-plugin
    ```

    OpenClaw 还会在 npm 之前检查 ClawHub，以获取像
    `@myorg/openclaw-my-plugin` 这样的裸包规范。

    **仓库内插件：** 放置在捆绑插件工作区树下 — 自动发现。

    ```bash
    pnpm test -- <bundled-plugin-root>/my-plugin/
    ```

  </Step>
</Steps>

## 插件能力

单个插件可以通过 `api` 对象注册任意数量的能力：

| 能力 | 注册方法 | 详细指南 |
| --- | --- | --- |
| 文本推理（LLM） | `api.registerProvider(...)` | [提供者插件](/plugins/sdk-provider-plugins) |
| CLI 推理后端 | `api.registerCliBackend(...)` | [CLI 后端](/gateway/cli-backends) |
| 通道 / 消息 | `api.registerChannel(...)` | [通道插件](/plugins/sdk-channel-plugins) |
| 语音（TTS/STT） | `api.registerSpeechProvider(...)` | [提供者插件](/plugins/sdk-provider-plugins#step-5-add-extra-capabilities) |
| 实时转录 | `api.registerRealtimeTranscriptionProvider(...)` | [提供者插件](/plugins/sdk-provider-plugins#step-5-add-extra-capabilities) |
| 实时语音 | `api.registerRealtimeVoiceProvider(...)` | [提供者插件](/plugins/sdk-provider-plugins#step-5-add-extra-capabilities) |
| 媒体理解 | `api.registerMediaUnderstandingProvider(...)` | [提供者插件](/plugins/sdk-provider-plugins#step-5-add-extra-capabilities) |
| 图像生成 | `api.registerImageGenerationProvider(...)` | [提供者插件](/plugins/sdk-provider-plugins#step-5-add-extra-capabilities) |
| 音乐生成 | `api.registerMusicGenerationProvider(...)` | [提供者插件](/plugins/sdk-provider-plugins#step-5-add-extra-capabilities) |
| 视频生成 | `api.registerVideoGenerationProvider(...)` | [提供者插件](/plugins/sdk-provider-plugins#step-5-add-extra-capabilities) |
| 网络获取 | `api.registerWebFetchProvider(...)` | [提供者插件](/plugins/sdk-provider-plugins#step-5-add-extra-capabilities) |
| 网络搜索 | `api.registerWebSearchProvider(...)` | [提供者插件](/plugins/sdk-provider-plugins#step-5-add-extra-capabilities) |
| 代理工具 | `api.registerTool(...)` | 下方 |
| 自定义命令 | `api.registerCommand(...)` | [入口点](/plugins/sdk-entrypoints) |
| 事件钩子 | `api.registerHook(...)` | [入口点](/plugins/sdk-entrypoints) |
| HTTP 路由 | `api.registerHttpRoute(...)` | [内部结构](/plugins/architecture#gateway-http-routes) |
| CLI 子命令 | `api.registerCli(...)` | [入口点](/plugins/sdk-entrypoints) |

有关完整的注册 API，请参阅 [SDK 概述](/plugins/sdk-overview#registration-api)。

如果您的插件注册自定义网关 RPC 方法，请将它们保持在
插件特定的前缀上。核心管理命名空间（`config.*`、
`exec.approvals.*`、`wizard.*`、`update.*`）保持保留，并且始终解析为
`operator.admin`，即使插件请求更窄的范围。

需要记住的钩子保护语义：

- `before_tool_call`：`{ block: true }` 是终端的，会停止较低优先级的处理程序。
- `before_tool_call`：`{ block: false }` 被视为无决策。
- `before_tool_call`：`{ requireApproval: true }` 暂停代理执行，并通过执行批准覆盖层、Telegram 按钮、Discord 交互或任何通道上的 `/approve` 命令提示用户批准。
- `before_install`：`{ block: true }` 是终端的，会停止较低优先级的处理程序。
- `before_install`：`{ block: false }` 被视为无决策。
- `message_sending`：`{ cancel: true }` 是终端的，会停止较低优先级的处理程序。
- `message_sending`：`{ cancel: false }` 被视为无决策。

`/approve` 命令处理执行和插件批准，带有有限的回退：当找不到执行批准 ID 时，OpenClaw 通过插件批准重试相同的 ID。插件批准转发可以通过配置中的 `approvals.plugin` 独立配置。

如果自定义批准管道需要检测相同的有限回退情况，
请使用 `openclaw/plugin-sdk/error-runtime` 中的 `isApprovalNotFoundError`，
而不是手动匹配批准过期字符串。

有关详细信息，请参阅 [SDK 概述钩子决策语义](/plugins/sdk-overview#hook-decision-semantics)。

## 注册代理工具

工具是 LLM 可以调用的类型化函数。它们可以是必需的（始终
可用）或可选的（用户选择加入）：

```typescript
register(api) {
  // 必需工具 — 始终可用
  api.registerTool({
    name: "my_tool",
    description: "Do a thing",
    parameters: Type.Object({ input: Type.String() }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: params.input }] };
    },
  });

  // 可选工具 — 用户必须添加到允许列表
  api.registerTool(
    {
      name: "workflow_tool",
      description: "Run a workflow",
      parameters: Type.Object({ pipeline: Type.String() }),
      async execute(_id, params) {
        return { content: [{ type: "text", text: params.pipeline }] };
      },
    },
    { optional: true },
  );
}
```

用户在配置中启用可选工具：

```json5
{
  tools: { allow: ["workflow_tool"] },
}
```

- 工具名称不得与核心工具冲突（冲突会被跳过）
- 对具有副作用或额外二进制要求的工具使用 `optional: true`
- 用户可以通过将插件 ID 添加到 `tools.allow` 来启用插件中的所有工具

## 导入约定

始终从集中的 `openclaw/plugin-sdk/<subpath>` 路径导入：

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

// 错误：整体根目录（已弃用，将被移除）
import { ... } from "openclaw/plugin-sdk";
```

有关完整的子路径参考，请参阅 [SDK 概述](/plugins/sdk-overview)。

在插件内，使用本地桶文件（`api.ts`、`runtime-api.ts`）进行
内部导入 — 永远不要通过其 SDK 路径导入自己的插件。

对于提供者插件，将提供者特定的助手保留在这些包根
桶中，除非接缝真正通用。当前捆绑示例：

- Anthropic：Claude 流包装器和 `service_tier` / 测试版助手
- OpenAI：提供者构建器、默认模型助手、实时提供者
- OpenRouter：提供者构建器以及入职/配置助手

如果助手仅在一个捆绑的提供者包内部有用，请将其保持在该
包根接缝上，而不是将其提升到 `openclaw/plugin-sdk/*` 中。

一些生成的 `openclaw/plugin-sdk/<bundled-id>` 助手接缝仍然存在，用于
捆绑插件维护和兼容性，例如
`plugin-sdk/feishu-setup` 或 `plugin-sdk/zalo-setup`。将这些视为保留
表面，而不是新第三方插件的默认模式。

## 提交前检查清单

<Check>**package.json** 具有正确的 `openclaw` 元数据</Check>
<Check>**openclaw.plugin.json** 清单存在且有效</Check>
<Check>入口点使用 `defineChannelPluginEntry` 或 `definePluginEntry`</Check>
<Check>所有导入使用集中的 `plugin-sdk/<subpath>` 路径</Check>
<Check>内部导入使用本地模块，而不是 SDK 自导入</Check>
<Check>测试通过（`pnpm test -- <bundled-plugin-root>/my-plugin/`）</Check>
<Check>`pnpm check` 通过（仓库内插件）</Check>

## 测试版发布测试

1. 关注 [openclaw/openclaw](https://github.com/openclaw/openclaw/releases) 上的 GitHub 发布标签，并通过 `Watch` > `Releases` 订阅。测试版标签看起来像 `v2026.3.N-beta.1`。您也可以开启官方 OpenClaw X 账户 [@openclaw](https://x.com/openclaw) 的通知以获取发布公告。
2. 测试版标签一出现就针对它测试您的插件。稳定版之前的窗口通常只有几个小时。
3. 测试后在 `plugin-forum` Discord 频道中您的插件线程中发布 `all good` 或什么坏了。如果您还没有线程，请创建一个。
4. 如果有什么坏了，打开或更新一个标题为 `Beta blocker: <plugin-name> - <summary>` 的问题，并应用 `beta-blocker` 标签。在您的线程中放置问题链接。
5. 打开一个标题为 `fix(<plugin-id>): beta blocker - <summary>` 的 PR 到 `main`，并在 PR 和 Discord 线程中链接问题。贡献者无法为 PR 添加标签，因此标题是 PR 端对维护者和自动化的信号。有 PR 的阻塞问题会被合并；没有 PR 的阻塞问题可能仍然发布。维护者在测试版测试期间会关注这些线程。
6. 沉默意味着绿色。如果您错过了窗口，您的修复可能会在下一个周期中落地。

## 后续步骤

<CardGroup cols={2}>
  <Card title="通道插件" icon="messages-square" href="/plugins/sdk-channel-plugins">
    构建消息通道插件
  </Card>
  <Card title="提供者插件" icon="cpu" href="/plugins/sdk-provider-plugins">
    构建模型提供者插件
  </Card>
  <Card title="SDK 概述" icon="book-open" href="/plugins/sdk-overview">
    导入映射和注册 API 参考
  </Card>
  <Card title="运行时助手" icon="settings" href="/plugins/sdk-runtime">
    通过 api.runtime 实现 TTS、搜索、子代理
  </Card>
  <Card title="测试" icon="test-tubes" href="/plugins/sdk-testing">
    测试实用程序和模式
  </Card>
  <Card title="插件清单" icon="file-json" href="/plugins/manifest">
    完整清单模式参考
  </Card>
</CardGroup>

## 相关

- [插件架构](/plugins/architecture) — 内部架构深度潜水
- [SDK 概述](/plugins/sdk-overview) — 插件 SDK 参考
- [清单](/plugins/manifest) — 插件清单格式
- [通道插件](/plugins/sdk-channel-plugins) — 构建通道插件
- [提供者插件](/plugins/sdk-provider-plugins) — 构建提供者插件