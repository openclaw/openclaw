---
title: "构建插件"
sidebarTitle: "入门指南"
summary: "在几分钟内创建你的第一个 OpenClaw 插件"
read_when:
  - 你想要创建一个新的 OpenClaw 插件
  - 你需要插件开发的快速入门指南
  - 你正在为 OpenClaw 添加新的通道、提供商、工具或其他功能
---

# 构建插件

插件为 OpenClaw 扩展新功能：通道、模型提供商、语音、实时转录、实时语音、媒体理解、图像生成、视频生成、网络获取、网络搜索、代理工具，或它们的任意组合。

你不需要将插件添加到 OpenClaw 仓库中。发布到 [ClawHub](/tools/clawhub) 或 npm，用户可以使用 `openclaw plugins install <package-name>` 进行安装。OpenClaw 会先尝试 ClawHub，然后自动回退到 npm。

## 前提条件

- Node >= 22 和包管理器（npm 或 pnpm）
- 熟悉 TypeScript（ESM）
- 对于仓库内插件：已克隆仓库并执行 `pnpm install`

## 插件类型

<CardGroup cols={3}>
  <Card title="通道插件" icon="messages-square" href="/plugins/sdk-channel-plugins">
    将 OpenClaw 连接到消息平台（Discord、IRC 等）
  </Card>
  <Card title="提供商插件" icon="cpu" href="/plugins/sdk-provider-plugins">
    添加模型提供商（LLM、代理或自定义端点）
  </Card>
  <Card title="工具 / 钩子插件" icon="wrench">
    注册代理工具、事件钩子或服务 — 继续阅读
  </Card>
</CardGroup>

如果通道插件是可选的，且在引导/设置运行时可能未安装，请使用 `openclaw/plugin-sdk/channel-setup` 中的 `createOptionalChannelSetupSurface(...)`。它会生成一个设置适配器 + 向导对，用于宣传安装要求，并在插件安装前禁止实际的配置写入。

## 快速开始：工具插件

本教程创建一个最小的插件，用于注册代理工具。通道和提供商插件有上面链接的专门指南。

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
      "name": "我的插件",
      "description": "为 OpenClaw 添加自定义工具",
      "configSchema": {
        "type": "object",
        "additionalProperties": false
      }
    }
    ```
    </CodeGroup>

    每个插件都需要一个清单，即使没有配置。有关完整模式，请参阅 [清单](/plugins/manifest)。规范的 ClawHub 发布代码片段位于 `docs/snippets/plugin-publish/`。

  </Step>

  <Step title="编写入口点">

    ```typescript
    // index.ts
    import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
    import { Type } from "@sinclair/typebox";

    export default definePluginEntry({
      id: "my-plugin",
      name: "我的插件",
      description: "为 OpenClaw 添加自定义工具",
      register(api) {
        api.registerTool({
          name: "my_tool",
          description: "执行一个操作",
          parameters: Type.Object({ input: Type.String() }),
          async execute(_id, params) {
            return { content: [{ type: "text", text: `收到: ${params.input}` }] };
          },
        });
      },
    });
    ```

    `definePluginEntry` 用于非通道插件。对于通道，请使用 `defineChannelPluginEntry` — 请参阅 [通道插件](/plugins/sdk-channel-plugins)。有关完整的入口点选项，请参阅 [入口点](/plugins/sdk-entrypoints)。

  </Step>

  <Step title="测试和发布">

    **外部插件：** 使用 ClawHub 验证并发布，然后安装：

    ```bash
    clawhub package publish your-org/your-plugin --dry-run
    clawhub package publish your-org/your-plugin
    openclaw plugins install clawhub:@myorg/openclaw-my-plugin
    ```

    OpenClaw 也会在 npm 之前检查 ClawHub 以获取裸包规格，如 `@myorg/openclaw-my-plugin`。

    **仓库内插件：** 放置在捆绑插件工作区树下方 — 会被自动发现。

    ```bash
    pnpm test -- <bundled-plugin-root>/my-plugin/
    ```

  </Step>
</Steps>

## 插件功能

单个插件可以通过 `api` 对象注册任意数量的功能：

| 功能            | 注册方法                                         | 详细指南                                                                  |
| --------------- | ------------------------------------------------ | ------------------------------------------------------------------------- |
| 文本推理（LLM） | `api.registerProvider(...)`                      | [提供商插件](/plugins/sdk-provider-plugins)                               |
| CLI 推理后端    | `api.registerCliBackend(...)`                    | [CLI 后端](/gateway/cli-backends)                                         |
| 通道 / 消息传递 | `api.registerChannel(...)`                       | [通道插件](/plugins/sdk-channel-plugins)                                  |
| 语音（TTS/STT） | `api.registerSpeechProvider(...)`                | [提供商插件](/plugins/sdk-provider-plugins#step-5-add-extra-capabilities) |
| 实时转录        | `api.registerRealtimeTranscriptionProvider(...)` | [提供商插件](/plugins/sdk-provider-plugins#step-5-add-extra-capabilities) |
| 实时语音        | `api.registerRealtimeVoiceProvider(...)`         | [提供商插件](/plugins/sdk-provider-plugins#step-5-add-extra-capabilities) |
| 媒体理解        | `api.registerMediaUnderstandingProvider(...)`    | [提供商插件](/plugins/sdk-provider-plugins#step-5-add-extra-capabilities) |
| 图像生成        | `api.registerImageGenerationProvider(...)`       | [提供商插件](/plugins/sdk-provider-plugins#step-5-add-extra-capabilities) |
| 音乐生成        | `api.registerMusicGenerationProvider(...)`       | [提供商插件](/plugins/sdk-provider-plugins#step-5-add-extra-capabilities) |
| 视频生成        | `api.registerVideoGenerationProvider(...)`       | [提供商插件](/plugins/sdk-provider-plugins#step-5-add-extra-capabilities) |
| 网络获取        | `api.registerWebFetchProvider(...)`              | [提供商插件](/plugins/sdk-provider-plugins#step-5-add-extra-capabilities) |
| 网络搜索        | `api.registerWebSearchProvider(...)`             | [提供商插件](/plugins/sdk-provider-plugins#step-5-add-extra-capabilities) |
| 代理工具        | `api.registerTool(...)`                          | 如下                                                                      |
| 自定义命令      | `api.registerCommand(...)`                       | [入口点](/plugins/sdk-entrypoints)                                        |
| 事件钩子        | `api.registerHook(...)`                          | [入口点](/plugins/sdk-entrypoints)                                        |
| HTTP 路由       | `api.registerHttpRoute(...)`                     | [内部架构](/plugins/architecture#gateway-http-routes)                     |
| CLI 子命令      | `api.registerCli(...)`                           | [入口点](/plugins/sdk-entrypoints)                                        |

有关完整的注册 API，请参阅 [SDK 概览](/plugins/sdk-overview#registration-api)。

如果你的插件注册了自定义网关 RPC 方法，请将它们保持在插件特定的前缀上。核心管理命名空间（`config.*`、`exec.approvals.*`、`wizard.*`、`update.*`）保持保留，并且始终解析为 `operator.admin`，即使插件请求更窄的范围。

需要记住的钩子保护语义：

- `before_tool_call`：`{ block: true }` 是终端操作，会停止优先级较低的处理程序。
- `before_tool_call`：`{ block: false }` 被视为无决定。
- `before_tool_call`：`{ requireApproval: true }` 会暂停代理执行，并通过 exec 批准覆盖层、Telegram 按钮、Discord 交互或任何通道上的 `/approve` 命令提示用户批准。
- `before_install`：`{ block: true }` 是终端操作，会停止优先级较低的处理程序。
- `before_install`：`{ block: false }` 被视为无决定。
- `message_sending`：`{ cancel: true }` 是终端操作，会停止优先级较低的处理程序。
- `message_sending`：`{ cancel: false }` 被视为无决定。

`/approve` 命令处理 exec 和插件批准，具有有限的回退：当未找到 exec 批准 ID 时，OpenClaw 会通过插件批准重试相同的 ID。插件批准转发可以通过配置中的 `approvals.plugin` 独立配置。

如果自定义批准管道需要检测相同的有限回退情况，请使用 `openclaw/plugin-sdk/error-runtime` 中的 `isApprovalNotFoundError`，而不是手动匹配批准过期字符串。

有关详细信息，请参阅 [SDK 概览钩子决策语义](/plugins/sdk-overview#hook-decision-semantics)。

## 注册代理工具

工具是 LLM 可以调用的类型化函数。它们可以是必需的（始终可用）或可选的（用户选择加入）：

```typescript
register(api) {
  // 必需工具 — 始终可用
  api.registerTool({
    name: "my_tool",
    description: "执行一个操作",
    parameters: Type.Object({ input: Type.String() }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: params.input }] };
    },
  });

  // 可选工具 — 用户必须添加到允许列表
  api.registerTool(
    {
      name: "workflow_tool",
      description: "运行工作流",
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
- 对于具有副作用或额外二进制要求的工具，使用 `optional: true`
- 用户可以通过将插件 ID 添加到 `tools.allow` 来启用插件的所有工具

## 导入约定

始终从专注的 `openclaw/plugin-sdk/<subpath>` 路径导入：

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

// 错误：整体根路径（已弃用，将被移除）
import { ... } from "openclaw/plugin-sdk";
```

有关完整的子路径参考，请参阅 [SDK 概览](/plugins/sdk-overview)。

在插件内部，使用本地桶文件（`api.ts`、`runtime-api.ts`）进行内部导入 — 永远不要通过其 SDK 路径导入自己的插件。

对于提供商插件，将提供商特定的帮助程序保存在这些包根桶中，除非接缝真正通用。当前的捆绑示例：

- Anthropic：Claude 流包装器和 `service_tier` / beta 帮助程序
- OpenAI：提供商构建器、默认模型帮助程序、实时提供商
- OpenRouter：提供商构建器以及引导/配置帮助程序

如果帮助程序仅在一个捆绑提供商包中有用，请将其保留在该包根接缝上，而不是将其提升到 `openclaw/plugin-sdk/*` 中。

一些生成的 `openclaw/plugin-sdk/<bundled-id>` 帮助程序接缝仍然存在，用于捆绑插件维护和兼容性，例如 `plugin-sdk/feishu-setup` 或 `plugin-sdk/zalo-setup`。将这些视为保留表面，而不是新第三方插件的默认模式。

## 提交前检查清单

<Check>**package.json** 具有正确的 `openclaw` 元数据</Check>
<Check>**openclaw.plugin.json** 清单存在且有效</Check>
<Check>入口点使用 `defineChannelPluginEntry` 或 `definePluginEntry`</Check>
<Check>所有导入使用专注的 `plugin-sdk/<subpath>` 路径</Check>
<Check>内部导入使用本地模块，而不是 SDK 自导入</Check>
<Check>测试通过 (`pnpm test -- <bundled-plugin-root>/my-plugin/`)</Check>
<Check>`pnpm check` 通过（仓库内插件）</Check>

## Beta 版本测试

1. 关注 [openclaw/openclaw](https://github.com/openclaw/openclaw/releases) 上的 GitHub 发布标签，并通过 `Watch` > `Releases` 订阅。Beta 标签看起来像 `v2026.3.N-beta.1`。你也可以开启官方 OpenClaw X 账号 [@openclaw](https://x.com/openclaw) 的通知，以获取发布公告。
2. 测试版标签一出现就针对其测试你的插件。稳定版之前的窗口通常只有几个小时。
3. 测试后在 `plugin-forum` Discord 频道中你的插件线程中发布 `all good` 或什么坏了。如果你还没有线程，请创建一个。
4. 如果出现问题，打开或更新标题为 `Beta blocker: <plugin-name> - <summary>` 的 issue，并应用 `beta-blocker` 标签。将 issue 链接放在你的线程中。
5. 向 `main` 打开标题为 `fix(<plugin-id>): beta blocker - <summary>` 的 PR，并在 PR 和 Discord 线程中都链接 issue。贡献者无法标记 PR，因此标题是维护者和自动化的 PR 端信号。有 PR 的障碍会被合并；没有 PR 的障碍可能会照常发布。维护者在 beta 测试期间会关注这些线程。
6. 沉默意味着绿色。如果你错过了窗口，你的修复可能会在下一个周期中发布。

## 下一步

<CardGroup cols={2}>
  <Card title="通道插件" icon="messages-square" href="/plugins/sdk-channel-plugins">
    构建消息通道插件
  </Card>
  <Card title="提供商插件" icon="cpu" href="/plugins/sdk-provider-plugins">
    构建模型提供商插件
  </Card>
  <Card title="SDK 概览" icon="book-open" href="/plugins/sdk-overview">
    导入映射和注册 API 参考
  </Card>
  <Card title="运行时帮助程序" icon="settings" href="/plugins/sdk-runtime">
    通过 api.runtime 使用 TTS、搜索、子代理
  </Card>
  <Card title="测试" icon="test-tubes" href="/plugins/sdk-testing">
    测试实用程序和模式
  </Card>
  <Card title="插件清单" icon="file-json" href="/plugins/manifest">
    完整的清单模式参考
  </Card>
</CardGroup>

## 相关

- [插件架构](/plugins/architecture) — 内部架构深入探讨
- [SDK 概览](/plugins/sdk-overview) — 插件 SDK 参考
- [清单](/plugins/manifest) — 插件清单格式
- [通道插件](/plugins/sdk-channel-plugins) — 构建通道插件
- [提供商插件](/plugins/sdk-provider-plugins) — 构建提供商插件
