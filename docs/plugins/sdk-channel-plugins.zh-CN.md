---
title: "构建通道插件"
sidebarTitle: "通道插件"
summary: "为 OpenClaw 构建消息通道插件的分步指南"
read_when:
  - 你正在构建新的消息通道插件
  - 你想将 OpenClaw 连接到消息平台
  - 你需要了解 ChannelPlugin 适配器表面
---

# 构建通道插件

本指南将引导你构建一个将 OpenClaw 连接到消息平台的通道插件。完成后，你将拥有一个具有 DM 安全、配对、回复线程和出站消息功能的工作通道。

<Info>
  如果你之前从未构建过 OpenClaw 插件，请先阅读 [入门指南](/plugins/building-plugins)，了解基本的包结构和清单设置。
</Info>

## 通道插件如何工作

通道插件不需要自己的发送/编辑/反应工具。OpenClaw 在核心中保持一个共享的 `message` 工具。你的插件拥有：

- **配置** — 账户解析和设置向导
- **安全性** — DM 策略和允许列表
- **配对** — DM 批准流程
- **会话语法** — 提供商特定的对话 ID 如何映射到基础聊天、线程 ID 和父级回退
- **出站** — 向平台发送文本、媒体和投票
- **线程** — 回复如何被线程化

核心拥有共享消息工具、提示接线、外部会话密钥形状、通用 `:thread:` 记账和调度。

如果你的通道添加了携带媒体源的消息工具参数，请通过 `describeMessageTool(...).mediaSourceParams` 公开这些参数名称。核心使用该显式列表进行沙箱路径规范化和出站媒体访问策略，因此插件不需要针对提供商特定的头像、附件或封面图像参数的共享核心特殊情况。

偏好返回一个动作键映射，例如 `{ "set-profile": ["avatarUrl", "avatarPath"] }`，这样不相关的动作就不会继承另一个动作的媒体参数。对于有意在每个公开动作之间共享的参数，扁平数组仍然有效。

如果你的平台在对话 ID 中存储额外的范围，请通过 `messaging.resolveSessionConversation(...)` 在插件中保留该解析。这是将 `rawId` 映射到基础对话 ID、可选线程 ID、显式 `baseConversationId` 和任何 `parentConversationCandidates` 的规范钩子。当你返回 `parentConversationCandidates` 时，将它们从最窄的父级排序到最宽/基础对话。

需要在通道注册表启动之前进行相同解析的捆绑插件还可以公开一个顶级 `session-key-api.ts` 文件，其中包含匹配的 `resolveSessionConversation(...)` 导出。核心仅在运行时插件注册表尚不可用时使用该引导安全表面。

`messaging.resolveParentConversationCandidates(...)` 仍然可用作遗留兼容性回退，当插件仅需要在通用/原始 ID 之上的父级回退时。如果两个钩子都存在，核心首先使用 `resolveSessionConversation(...).parentConversationCandidates`，仅当规范钩子省略它们时才回退到 `resolveParentConversationCandidates(...)`。

## 批准和通道能力

大多数通道插件不需要批准特定的代码。

- 核心拥有同聊 `/approve`、共享批准按钮有效负载和通用回退传递。
- 当通道需要批准特定行为时，偏好通道插件上的一个 `approvalCapability` 对象。
- `ChannelPlugin.approvals` 已被移除。将批准传递/原生/渲染/认证事实放在 `approvalCapability` 上。
- `plugin.auth` 仅用于登录/注销；核心不再从该对象读取批准认证钩子。
- `approvalCapability.authorizeActorAction` 和 `approvalCapability.getActionAvailabilityState` 是规范的批准认证接缝。
- 使用 `approvalCapability.getActionAvailabilityState` 进行同聊批准认证可用性。
- 如果你的通道公开原生 exec 批准，当发起表面/原生客户端状态与同聊批准认证不同时，使用 `approvalCapability.getExecInitiatingSurfaceState` 作为发起表面/原生客户端状态。核心使用该 exec 特定钩子来区分 `enabled` 与 `disabled`，决定发起通道是否支持原生 exec 批准，并在原生客户端回退指导中包含该通道。`createApproverRestrictedNativeApprovalCapability(...)` 为常见情况填充此信息。
- 使用 `outbound.shouldSuppressLocalPayloadPrompt` 或 `outbound.beforeDeliverPayload` 用于通道特定的有效负载生命周期行为，例如隐藏重复的本地批准提示或在传递前发送打字指示器。
- 仅在需要原生批准路由或回退抑制时使用 `approvalCapability.delivery`。
- 使用 `approvalCapability.nativeRuntime` 用于通道拥有的原生批准事实。在热通道入口点上使用 `createLazyChannelApprovalNativeRuntimeAdapter(...)` 使其延迟，该适配器可以按需导入你的运行时模块，同时仍允许核心组装批准生命周期。
- 仅当通道确实需要自定义批准有效负载而不是共享渲染器时，才使用 `approvalCapability.render`。
- 当通道希望禁用路径回复解释启用原生 exec 批准所需的确切配置旋钮时，使用 `approvalCapability.describeExecApprovalSetup`。该钩子接收 `{ channel, channelLabel, accountId }`；命名账户通道应渲染账户范围的路径，例如 `channels.<channel>.accounts.<id>.execApprovals.*` 而不是顶级默认值。
- 如果通道可以从现有配置推断稳定的所有者类 DM 身份，使用 `openclaw/plugin-sdk/approval-runtime` 中的 `createResolvedApproverActionAuthAdapter` 来限制同聊 `/approve`，而无需添加批准特定的核心逻辑。
- 如果通道需要原生批准传递，保持通道代码专注于目标规范化加上传输/表示事实。使用 `openclaw/plugin-sdk/approval-runtime` 中的 `createChannelExecApprovalProfile`、`createChannelNativeOriginTargetResolver`、`createChannelApproverDmTargetResolver` 和 `createApproverRestrictedNativeApprovalCapability`。将通道特定事实放在 `approvalCapability.nativeRuntime` 后面，理想情况下通过 `createChannelApprovalNativeRuntimeAdapter(...)` 或 `createLazyChannelApprovalNativeRuntimeAdapter(...)`，以便核心可以组装处理程序并拥有请求过滤、路由、去重、过期、网关订阅和路由到其他地方的通知。`nativeRuntime` 分为几个较小的接缝：
- `availability` — 账户是否已配置以及请求是否应被处理
- `presentation` — 将共享批准视图模型映射到待处理/已解决/已过期的原生有效负载或最终动作
- `transport` — 准备目标以及发送/更新/删除原生批准消息
- `interactions` — 用于原生按钮或反应的可选绑定/解绑/清除动作钩子
- `observe` — 可选的传递诊断钩子
- 如果通道需要运行时拥有的对象，例如客户端、令牌、Bolt 应用或 webhook 接收器，通过 `openclaw/plugin-sdk/channel-runtime-context` 注册它们。通用运行时上下文注册表让核心从通道启动状态引导能力驱动的处理程序，而无需添加批准特定的包装胶水。
- 仅当能力驱动的接缝表达力不足时，才使用较低级别的 `createChannelApprovalHandler` 或 `createChannelNativeApprovalRuntime`。
- 原生批准通道必须通过这些助手路由 `accountId` 和 `approvalKind`。`accountId` 保持多账户批准策略范围到正确的机器人账户，`approvalKind` 保持 exec 与插件批准行为对通道可用，而无需在核心中硬编码分支。
- 核心现在也拥有批准重新路由通知。通道插件不应从 `createChannelNativeApprovalRuntime` 发送自己的"批准进入 DM / 另一个通道"后续消息；相反，通过共享批准能力助手暴露准确的起源 + 批准者-DM 路由，让核心在发布任何通知回发起聊天之前聚合实际传递。
- 端到端保留传递的批准 ID 类型。原生客户端不应从通道本地状态猜测或重写 exec 与插件批准路由。
- 不同的批准类型可以有意暴露不同的原生表面。当前捆绑示例：
  - Slack 保持原生批准路由可用于 exec 和插件 ID。
  - Matrix 为 exec 和插件批准保持相同的原生 DM/通道路由和反应 UX，同时仍允许认证因批准类型而异。
- `createApproverRestrictedNativeApprovalAdapter` 仍然作为兼容性包装器存在，但新代码应偏好能力构建器并在插件上暴露 `approvalCapability`。

对于热通道入口点，当你只需要该系列的一部分时，偏好较窄的运行时子路径：

- `openclaw/plugin-sdk/approval-auth-runtime`
- `openclaw/plugin-sdk/approval-client-runtime`
- `openclaw/plugin-sdk/approval-delivery-runtime`
- `openclaw/plugin-sdk/approval-gateway-runtime`
- `openclaw/plugin-sdk/approval-handler-adapter-runtime`
- `openclaw/plugin-sdk/approval-handler-runtime`
- `openclaw/plugin-sdk/approval-native-runtime`
- `openclaw/plugin-sdk/approval-reply-runtime`
- `openclaw/plugin-sdk/channel-runtime-context`

同样，当你不需要更广泛的伞形表面时，偏好 `openclaw/plugin-sdk/setup-runtime`、`openclaw/plugin-sdk/setup-adapter-runtime`、`openclaw/plugin-sdk/reply-runtime`、`openclaw/plugin-sdk/reply-dispatch-runtime`、`openclaw/plugin-sdk/reply-reference` 和 `openclaw/plugin-sdk/reply-chunking`。

对于特定设置：

- `openclaw/plugin-sdk/setup-runtime` 涵盖运行时安全的设置助手：导入安全的设置补丁适配器（`createPatchedAccountSetupAdapter`、`createEnvPatchedAccountSetupAdapter`、`createSetupInputPresenceValidator`）、查找注释输出、`promptResolvedAllowFrom`、`splitSetupEntries` 和委托的设置代理构建器
- `openclaw/plugin-sdk/setup-adapter-runtime` 是 `createEnvPatchedAccountSetupAdapter` 的窄环境感知适配器接缝
- `openclaw/plugin-sdk/channel-setup` 涵盖可选安装设置构建器以及一些设置安全原语：`createOptionalChannelSetupSurface`、`createOptionalChannelSetupAdapter`、

如果你的通道支持环境驱动的设置或认证，并且通用启动/配置流程应在运行时加载之前知道这些环境名称，请在插件清单中使用 `channelEnvVars` 声明它们。仅为操作员面向的副本保留通道运行时 `envVars` 或本地常量。
`createOptionalChannelSetupWizard`、`DEFAULT_ACCOUNT_ID`、`createTopLevelChannelDmPolicy`、`setSetupChannelEnabled` 和 `splitSetupEntries`

- 仅当你还需要更重的共享设置/配置助手时，才使用更广泛的 `openclaw/plugin-sdk/setup` 接缝，例如 `moveSingleAccountChannelSectionToDefaultAccount(...)`

如果你的通道只想在设置表面中宣传"首先安装此插件"，偏好 `createOptionalChannelSetupSurface(...)`。生成的适配器/向导在配置写入和完成时关闭失败，并且它们在验证、完成和文档链接副本中重用相同的安装要求消息。

对于其他热通道路径，偏好窄助手而不是更广泛的遗留表面：

- `openclaw/plugin-sdk/account-core`、`openclaw/plugin-sdk/account-id`、`openclaw/plugin-sdk/account-resolution` 和 `openclaw/plugin-sdk/account-helpers` 用于多账户配置和默认账户回退
- `openclaw/plugin-sdk/inbound-envelope` 和 `openclaw/plugin-sdk/inbound-reply-dispatch` 用于入站路由/信封和记录并调度接线
- `openclaw/plugin-sdk/messaging-targets` 用于目标解析/匹配
- `openclaw/plugin-sdk/outbound-media` 和 `openclaw/plugin-sdk/outbound-runtime` 用于媒体加载加上出站身份/发送委托
- `openclaw/plugin-sdk/thread-bindings-runtime` 用于线程绑定生命周期和适配器注册
- `openclaw/plugin-sdk/agent-media-payload` 仅当仍然需要遗留代理/媒体有效负载字段布局时
- `openclaw/plugin-sdk/telegram-command-config` 用于 Telegram 自定义命令规范化、重复/冲突验证和回退稳定命令配置契约

仅认证通道通常可以停留在默认路径：核心处理批准，插件只需暴露出站/认证能力。原生批准通道（如 Matrix、Slack、Telegram 和自定义聊天传输）应使用共享的原生助手，而不是滚动自己的批准生命周期。

## 入站提及策略

保持入站提及处理分为两层：

- 插件拥有的证据收集
- 共享策略评估

使用 `openclaw/plugin-sdk/channel-mention-gating` 进行提及策略决策。仅当你需要更广泛的入站助手桶时，才使用 `openclaw/plugin-sdk/channel-inbound`。

插件本地逻辑的良好 fit：

- 回复机器人检测
- 引用机器人检测
- 线程参与检查
- 服务/系统消息排除
- 证明机器人参与所需的平台原生缓存

共享助手的良好 fit：

- `requireMention`
- 显式提及结果
- 隐式提及允许列表
- 命令绕过
- 最终跳过决策

首选流程：

1. 计算本地提及事实。
2. 将这些事实传递到 `resolveInboundMentionDecision({ facts, policy })`。
3. 在你的入站门中使用 `decision.effectiveWasMentioned`、`decision.shouldBypassMention` 和 `decision.shouldSkip`。

```typescript
import {
  implicitMentionKindWhen,
  matchesMentionWithExplicit,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-inbound";

const mentionMatch = matchesMentionWithExplicit(text, {
  mentionRegexes,
  mentionPatterns,
});

const facts = {
  canDetectMention: true,
  wasMentioned: mentionMatch.matched,
  hasAnyMention: mentionMatch.hasExplicitMention,
  implicitMentionKinds: [
    ...implicitMentionKindWhen("reply_to_bot", isReplyToBot),
    ...implicitMentionKindWhen("quoted_bot", isQuoteOfBot),
  ],
};

const decision = resolveInboundMentionDecision({
  facts,
  policy: {
    isGroup,
    requireMention,
    allowedImplicitMentionKinds: requireExplicitMention ? [] : ["reply_to_bot", "quoted_bot"],
    allowTextCommands,
    hasControlCommand,
    commandAuthorized,
  },
});

if (decision.shouldSkip) return;
```

`api.runtime.channel.mentions` 为已经依赖于运行时注入的捆绑通道插件暴露相同的共享提及助手：

- `buildMentionRegexes`
- `matchesMentionPatterns`
- `matchesMentionWithExplicit`
- `implicitMentionKindWhen`
- `resolveInboundMentionDecision`

如果你只需要 `implicitMentionKindWhen` 和 `resolveInboundMentionDecision`，从 `openclaw/plugin-sdk/channel-mention-gating` 导入以避免加载无关的入站运行时助手。

较旧的 `resolveMentionGating*` 助手仍然作为兼容性导出保留在 `openclaw/plugin-sdk/channel-inbound` 上。新代码应使用 `resolveInboundMentionDecision({ facts, policy })`。

## 演练

<Steps>
  <a id="step-1-package-and-manifest"></a>
  <Step title="包和清单">
    创建标准插件文件。`package.json` 中的 `channel` 字段使这成为通道插件。有关完整的包元数据表面，请参阅 [插件设置和配置](/plugins/sdk-setup#openclaw-channel)：

    <CodeGroup>
    ```json package.json
    {
      "name": "@myorg/openclaw-acme-chat",
      "version": "1.0.0",
      "type": "module",
      "openclaw": {
        "extensions": ["./index.ts"],
        "setupEntry": "./setup-entry.ts",
        "channel": {
          "id": "acme-chat",
          "label": "Acme Chat",
          "blurb": "将 OpenClaw 连接到 Acme Chat。"
        }
      }
    }
    ```

    ```json openclaw.plugin.json
    {
      "id": "acme-chat",
      "kind": "channel",
      "channels": ["acme-chat"],
      "name": "Acme Chat",
      "description": "Acme Chat 通道插件",
      "configSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "acme-chat": {
            "type": "object",
            "properties": {
              "token": { "type": "string" },
              "allowFrom": {
                "type": "array",
                "items": { "type": "string" }
              }
            }
          }
        }
      }
    }
    ```
    </CodeGroup>

  </Step>

  <Step title="构建通道插件对象">
    `ChannelPlugin` 接口有许多可选的适配器表面。从最小的开始 — `id` 和 `setup` — 并根据需要添加适配器。

    创建 `src/channel.ts`：

    ```typescript src/channel.ts
    import {
      createChatChannelPlugin,
      createChannelPluginBase,
    } from "openclaw/plugin-sdk/channel-core";
    import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
    import { acmeChatApi } from "./client.js"; // 你的平台 API 客户端

    type ResolvedAccount = {
      accountId: string | null;
      token: string;
      allowFrom: string[];
      dmPolicy: string | undefined;
    };

    function resolveAccount(
      cfg: OpenClawConfig,
      accountId?: string | null,
    ): ResolvedAccount {
      const section = (cfg.channels as Record<string, any>)?.["acme-chat"];
      const token = section?.token;
      if (!token) throw new Error("acme-chat: token is required");
      return {
        accountId: accountId ?? null,
        token,
        allowFrom: section?.allowFrom ?? [],
        dmPolicy: section?.dmSecurity,
      };
    }

    export const acmeChatPlugin = createChatChannelPlugin<ResolvedAccount>({
      base: createChannelPluginBase({
        id: "acme-chat",
        setup: {
          resolveAccount,
          inspectAccount(cfg, accountId) {
            const section =
              (cfg.channels as Record<string, any>)?.["acme-chat"];
            return {
              enabled: Boolean(section?.token),
              configured: Boolean(section?.token),
              tokenStatus: section?.token ? "available" : "missing",
            };
          },
        },
      }),

      // DM 安全：谁可以向机器人发送消息
      security: {
        dm: {
          channelKey: "acme-chat",
          resolvePolicy: (account) => account.dmPolicy,
          resolveAllowFrom: (account) => account.allowFrom,
          defaultPolicy: "allowlist",
        },
      },

      // 配对：新 DM 联系人的批准流程
      pairing: {
        text: {
          idLabel: "Acme Chat 用户名",
          message: "发送此代码以验证你的身份：",
          notify: async ({ target, code }) => {
            await acmeChatApi.sendDm(target, `配对代码：${code}`);
          },
        },
      },

      // 线程：回复如何传递
      threading: { topLevelReplyToMode: "reply" },

      // 出站：向平台发送消息
      outbound: {
        attachedResults: {
          sendText: async (params) => {
            const result = await acmeChatApi.sendMessage(
              params.to,
              params.text,
            );
            return { messageId: result.id };
          },
        },
        base: {
          sendMedia: async (params) => {
            await acmeChatApi.sendFile(params.to, params.filePath);
          },
        },
      },
    });
    ```

    <Accordion title="createChatChannelPlugin 为你做什么">
      你不需要手动实现低级适配器接口，而是传递声明性选项，构建器会组合它们：

      | 选项 | 它接线什么 |
      | --- | --- |
      | `security.dm` | 从配置字段解析的作用域 DM 安全解析器 |
      | `pairing.text` | 带有代码交换的基于文本的 DM 配对流程 |
      | `threading` | 回复模式解析器（固定、账户作用域或自定义） |
      | `outbound.attachedResults` | 返回结果元数据（消息 ID）的发送函数 |

      如果你需要完全控制，也可以传递原始适配器对象而不是声明性选项。
    </Accordion>

  </Step>

  <Step title="接线入口点">
    创建 `index.ts`：

    ```typescript index.ts
    import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
    import { acmeChatPlugin } from "./src/channel.js";

    export default defineChannelPluginEntry({
      id: "acme-chat",
      name: "Acme Chat",
      description: "Acme Chat 通道插件",
      plugin: acmeChatPlugin,
      registerCliMetadata(api) {
        api.registerCli(
          ({ program }) => {
            program
              .command("acme-chat")
              .description("Acme Chat 管理");
          },
          {
            descriptors: [
              {
                name: "acme-chat",
                description: "Acme Chat 管理",
                hasSubcommands: false,
              },
            ],
          },
        );
      },
      registerFull(api) {
        api.registerGatewayMethod(/* ... */);
      },
    });
    ```

    将通道拥有的 CLI 描述符放在 `registerCliMetadata(...)` 中，这样 OpenClaw 可以在根帮助中显示它们而无需激活完整的通道运行时，同时正常的完整加载仍然为实际命令注册获取相同的描述符。将 `registerFull(...)` 用于仅运行时工作。
    如果 `registerFull(...)` 注册网关 RPC 方法，请使用插件特定的前缀。核心管理命名空间（`config.*`、`exec.approvals.*`、`wizard.*`、`update.*`）保持保留，并且始终解析为 `operator.admin`。
    `defineChannelPluginEntry` 自动处理注册模式拆分。有关所有选项，请参阅 [入口点](/plugins/sdk-entrypoints#definechannelpluginentry)。

  </Step>

  <Step title="添加设置入口">
    创建 `setup-entry.ts` 用于引导期间的轻量级加载：

    ```typescript setup-entry.ts
    import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
    import { acmeChatPlugin } from "./src/channel.js";

    export default defineSetupPluginEntry(acmeChatPlugin);
    ```

    当通道被禁用或未配置时，OpenClaw 加载此文件而不是完整入口。它避免在设置流程中拉入沉重的运行时代码。有关详细信息，请参阅 [设置和配置](/plugins/sdk-setup#setup-entry)。

    将设置安全导出拆分为侧边模块的捆绑工作区通道可以使用 `openclaw/plugin-sdk/channel-entry-contract` 中的 `defineBundledChannelSetupEntry(...)`，当它们还需要显式的设置时运行时设置器。

  </Step>

  <Step title="处理入站消息">
    你的插件需要从平台接收消息并将它们转发到 OpenClaw。典型模式是一个 webhook，它验证请求并通过你的通道的入站处理程序调度它：

    ```typescript
    registerFull(api) {
      api.registerHttpRoute({
        path: "/acme-chat/webhook",
        auth: "plugin", // 插件管理的认证（自己验证签名）
        handler: async (req, res) => {
          const event = parseWebhookPayload(req);

          // 你的入站处理程序将消息调度到 OpenClaw。
          // 确切的接线取决于你的平台 SDK —
          // 在捆绑的 Microsoft Teams 或 Google Chat 插件包中查看真实示例。
          await handleAcmeChatInbound(api, event);

          res.statusCode = 200;
          res.end("ok");
          return true;
        },
      });
    }
    ```

    <Note>
      入站消息处理是通道特定的。每个通道插件拥有自己的入站管道。查看捆绑的通道插件（例如 Microsoft Teams 或 Google Chat 插件包）了解真实模式。
    </Note>

  </Step>

<a id="step-6-test"></a>
<Step title="测试">
在 `src/channel.test.ts` 中编写相邻测试：

    ```typescript src/channel.test.ts
    import { describe, it, expect } from "vitest";
    import { acmeChatPlugin } from "./channel.js";

    describe("acme-chat 插件", () => {
      it("从配置解析账户", () => {
        const cfg = {
          channels: {
            "acme-chat": { token: "test-token", allowFrom: ["user1"] },
          },
        } as any;
        const account = acmeChatPlugin.setup!.resolveAccount(cfg, undefined);
        expect(account.token).toBe("test-token");
      });

      it("检查账户而不具体化秘密", () => {
        const cfg = { channels: { "acme-chat": { token: "test-token" } } } as any;
        const result = acmeChatPlugin.setup!.inspectAccount!(cfg, undefined);
        expect(result.configured).toBe(true);
        expect(result.tokenStatus).toBe("available");
      });

      it("报告缺少的配置", () => {
        const cfg = { channels: {} } as any;
        const result = acmeChatPlugin.setup!.inspectAccount!(cfg, undefined);
        expect(result.configured).toBe(false);
      });
    });
    ```

    ```bash
    pnpm test -- <bundled-plugin-root>/acme-chat/
    ```

    有关共享测试助手，请参阅 [测试](/plugins/sdk-testing)。

  </Step>
</Steps>

## 文件结构

```
<bundled-plugin-root>/acme-chat/
├── package.json              # openclaw.channel 元数据
├── openclaw.plugin.json      # 带配置模式的清单
├── index.ts                  # defineChannelPluginEntry
├── setup-entry.ts            # defineSetupPluginEntry
├── api.ts                    # 公共导出（可选）
├── runtime-api.ts            # 内部运行时导出（可选）
└── src/
    ├── channel.ts            # 通过 createChatChannelPlugin 的 ChannelPlugin
    ├── channel.test.ts       # 测试
    ├── client.ts             # 平台 API 客户端
    └── runtime.ts            # 运行时存储（如果需要）
```

## 高级主题

<CardGroup cols={2}>
  <Card title="线程选项" icon="git-branch" href="/plugins/sdk-entrypoints#registration-mode">
    固定、账户作用域或自定义回复模式
  </Card>
  <Card title="消息工具集成" icon="puzzle" href="/plugins/architecture#channel-plugins-and-the-shared-message-tool">
    describeMessageTool 和动作发现
  </Card>
  <Card title="目标解析" icon="crosshair" href="/plugins/architecture#channel-target-resolution">
    inferTargetChatType, looksLikeId, resolveTarget
  </Card>
  <Card title="运行时助手" icon="settings" href="/plugins/sdk-runtime">
    通过 api.runtime 使用 TTS、STT、媒体、子代理
  </Card>
</CardGroup>

<Note>
一些捆绑的助手接缝仍然存在用于捆绑插件维护和兼容性。它们不是新通道插件的推荐模式；除非你直接维护该捆绑插件系列，否则偏好来自通用 SDK 表面的通用通道/设置/回复/运行时子路径。
</Note>

## 下一步

- [提供商插件](/plugins/sdk-provider-plugins) — 如果你的插件也提供模型
- [SDK 概览](/plugins/sdk-overview) — 完整的子路径导入参考
- [SDK 测试](/plugins/sdk-testing) — 测试实用程序和契约测试
- [插件清单](/plugins/manifest) — 完整的清单模式