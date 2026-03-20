---
summary: "插件架构内部原理：能力模型、所有权、合约、加载管道、运行时辅助"
read_when:
  - 构建或调试原生 OpenClaw 插件
  - 理解插件能力模型或所有权边界
  - 从事插件加载管道或注册表工作
  - 实现 Provider 运行时钩子或 Channel 插件
title: "插件架构"
---

# 插件架构

本页面涵盖 OpenClaw 插件系统的内部架构。关于用户侧安装、发现和配置，见 [Plugins](/zh-CN/tools/plugin)。

## 公开能力模型
注册零能力但提供钩子、工具或服务的插件是 **传统纯钩子** 插件。该模式仍然完全支持。
能力是 OpenClaw 内部的公开 **原生插件** 模型。每个原生 OpenClaw 插件注册到一种或多种能力类型：

| 能力           | 注册方法                                      | 示例插件                  |
| -------------- | --------------------------------------------- | ------------------------- |
| 文本推理       | `api.registerProvider(...)`                   | `openai`, `anthropic`     |
| 语音           | `api.registerSpeechProvider(...)`             | `elevenlabs`, `microsoft` |
| 媒体理解       | `api.registerMediaUnderstandingProvider(...)` | `openai`, `google`        |
| 图片生成       | `api.registerImageGenerationProvider(...)`    | `openai`, `google`        |
| 网页搜索       | `api.registerWebSearchProvider(...)`          | `google`                  |
| Channel / 消息 | `api.registerChannel(...)`                    | `msteams`, `matrix`       |

注册零能力但提供钩子、工具或服务的插件是 **纯钩子** 插件。该模式仍然完全支持。

### 外部兼容性立场

能力模型已在核心落地并被捆绑/原生插件使用，但外部插件兼容性仍需比"它被导出就是冻结的"更严格的门槛。

当前指导：

- **现有外部插件**：保持基于钩子的集成工作；将其作为兼容性基线
- **新捆绑/原生插件**：优先使用显式能力注册，而非供应商特定的 reach-in 或新的纯钩子设计
- **采用能力注册的外部插件**：允许，但将能力特定的辅助面视为在演进，除非文档明确标记某合约为稳定

实际规则：

- 能力注册 API 是预期方向
- 传统钩子在过渡期仍是外部插件最安全的不破坏路径
- 导出的辅助子路径并不等价；优先使用窄文档化合约，而非偶发的辅助导出

### 插件形状

OpenClaw 根据插件的实际注册行为（而非静态元数据）将每个已加载插件分类为一种形状：

- **plain-capability** — 仅注册一种能力类型（如仅 Provider 插件 `mistral`）
- **hybrid-capability** — 注册多种能力类型（如 `openai` 拥有文本推理、语音、媒体理解和图片生成）
- **hook-only** — 仅注册钩子（类型化或自定义），无能力、工具、命令或服务
- **non-capability** — 注册工具、命令、服务或路由，但无能力

使用 `openclaw plugins inspect <id>` 查看插件的形状和能力细分。

### 传统钩子

`before_agent_start` 钩子仍然作为兼容性路径得到支持，用于纯钩子插件。传统真实世界插件仍依赖它。

方向：

- 保持其工作
- 标记为传统
- 对于 model/provider 覆盖工作，优先使用 `before_model_resolve`
- 对于 prompt 变更工作，优先使用 `before_prompt_build`
- 仅在实际使用量下降且 fixture 覆盖证明迁移安全性后删除

### 兼容性信号

运行 `openclaw doctor` 或 `openclaw plugins inspect <id>` 时，可能看到以下标签之一：

| 信号                       | 含义                                       |
| -------------------------- | ------------------------------------------ |
| **config valid**           | Config 解析正常，插件解析成功              |
| **compatibility advisory** | 插件使用支持但较旧的模式（如 `hook-only`） |
| **legacy warning**         | 插件使用 `before_agent_start`，已弃用      |
| **hard error**             | Config 无效或插件加载失败                  |

`hook-only` 和 `before_agent_start` 今天都不会导致插件中断 — `hook-only` 是建议性的，`before_agent_start` 仅触发警告。这些信号也出现在 `openclaw status --all` 和 `openclaw plugins doctor` 中。

## 架构概述

OpenClaw 插件系统有四层：

1. **清单 + 发现**
   OpenClaw 从配置的路径、工作区根、全局扩展根和捆绑扩展中发现候选插件。发现首先读取原生 `openclaw.plugin.json` 清单和支持的 bundle 清单。
2. **启用 + 验证**
   核心决定已发现插件是启用、禁用、阻止，还是选中某个独占插槽（如 memory）。
3. **运行时加载**
   原生 OpenClaw 插件通过 jiti 进程内加载，并注册能力到中央注册表。兼容 bundle 被规范化为注册表记录，但不导入运行时代码。
4. **面消费**
   OpenClaw 其余部分读取注册表以暴露工具、Channel、Provider 设置、钩子、HTTP 路由、CLI 命令和服务。

重要的设计边界：

- 发现 + 配置验证应从 **清单/schema 元数据** 工作，**无需执行插件代码**
- 原生运行时行为来自插件模块的 `register(api)` 路径

这种分离使 OpenClaw 能够在完整运行时激活之前验证配置、解释缺失/禁用插件并构建 UI/schema 提示。

### Channel 插件和共享消息工具

Channel 插件不需要为普通聊天操作注册单独的 send/edit/react 工具。OpenClaw 在核心保持一个共享的 `message` 工具，Channel 插件拥有其背后的 Channel 特定发现和执行。

当前边界：

- 核心拥有共享 `message` 工具宿主、prompt 接线、session/thread 记账和执行调度
- Channel 插件拥有作用域内的操作发现、能力发现和任何 Channel 特定的 schema 片段
- Channel 插件通过其操作适配器执行最终操作

对于 Channel 插件，SDK 面是 `ChannelMessageActionAdapter.describeMessageTool(...)`。该统一发现调用让插件返回其可见操作、能力，一起返回 schema 贡献，这样各部分不会漂移分离。

核心将运行时作用域传递到该发现步骤。重要字段包括：

- `accountId`
- `currentChannelId`
- `currentThreadTs`
- `currentMessageId`
- `sessionKey`
- `sessionId`
- `agentId`
- 受信任的入站 `requesterSenderId`

这对上下文敏感插件很重要。Channel 可以根据活动账号、当前 room/thread/message 或受信任的请求者身份隐藏或暴露消息操作，而无需在核心 `message` 工具中硬编码 Channel 特定分支。

这就是为什么 embedded-runner 路由变更仍然是插件工作：runner 负责将当前聊天/session 身份转发到插件发现边界，以便共享 `message` 工具为当前轮次暴露正确的 Channel 所有表面。

对于 Channel 所有执行辅助，捆绑插件应将执行运行时保留在其自己的扩展模块内部。核心不再拥有 Discord、Slack、Telegram 或 WhatsApp 的消息操作运行时在 `src/agents/tools` 下。我们不发布单独的 `plugin-sdk/*-action-runtime` 子路径，捆绑插件应直接从其扩展所有的模块导入自己的本地运行时代码。

对于 polls，有两条执行路径：

- `outbound.sendPoll` 是适合通用 poll 模型的共享基线
- `actions.handleAction("poll")` 是 Channel 特定 poll 语义或额外 poll 参数的首选路径

核心现在将共享 poll 解析延迟到插件 poll 分发拒绝之后，因此插件所有的 poll 处理器可以接受 Channel 特定的 poll 字段，而不会被通用 poll 解析器首先阻塞。

见 [加载管道](#加载管道) 获取完整启动序列。

## 能力所有权模型

OpenClaw 将原生插件视为 **公司** 或 **功能** 的所有权边界，而非无关集成的杂烩袋。

这意味着：

- 一个公司插件通常应拥有该公司在 OpenClaw 的所有面
- 一个功能插件通常应拥有其引入的完整功能面
- Channel 应消费共享核心能力，而非临时重新实现 Provider 行为

示例：

- 捆绑的 `openai` 插件拥有 OpenAI 模型 Provider 行为以及 OpenAI 语音 + 媒体理解 + 图片生成行为
- 捆绑的 `elevenlabs` 插件拥有 ElevenLabs 语音行为
- 捆绑的 `microsoft` 插件拥有 Microsoft 语音行为
- 捆绑的 `google` 插件拥有 Google 模型 Provider 行为以及 Google 媒体理解 + 图片生成 + 网页搜索行为
- `voice-call` 插件是一个功能插件：它拥有通话传输、工具、CLI、路由和运行时，但它消费核心 TTS/STT 能力而非发明第二个语音栈

预期最终状态：

- OpenAI 作为一个插件存在，即使它横跨文本模型、语音、图像和未来视频
- 另一个供应商也可以为其自己的面做同样的事
- Channel 不关心哪个 Provider 插件拥有该 Provider；它们消费核心暴露的共享能力合约

关键区别：

- **插件** = 所有权边界
- **能力** = 多个插件可以实现或消费的核心合约

所以如果 OpenClaw 添加新领域（如视频），第一个问题不是"哪个 Provider 应该硬编码视频处理？"第一个问题是"核心视频能力合约是什么？"一旦该合约存在，供应商插件可以注册到它，Channel/功能插件可以消费它。

如果能力还不存在，正确做法通常是：

1. 在核心定义缺失的能力
2. 以类型化方式通过插件 API/运行时暴露
3. 将 Channel/功能接线到该能力
4. 让供应商插件注册实现

这保持所有权显式，同时避免核心行为依赖于单一供应商或临时插件特定代码路径。

### 能力分层

决定代码属于哪里时，使用此心智模型：

- **核心能力层**：共享编排、策略、fallback、配置合并规则、传递语义和类型化合约
- **供应商插件层**：供应商特定 API、auth、模型目录、语音合成、图片生成、未来视频后端
- **Channel/功能插件层**：Slack/Discord/voice-call 等集成，消费核心能力并在其上呈现

例如，TTS 遵循此形状：

- 核心拥有回复时 TTS 策略、fallback 顺序、prefs 和 Channel 传递
- `openai`、`elevenlabs` 和 `microsoft` 拥有合成实现
- `voice-call` 消费电话 TTS 运行时辅助

未来能力应优先采用相同模式。

### 多能力公司插件示例

从外部看，公司插件应感觉是一个整体。如果 OpenClaw 拥有模型、语音、媒体理解和网页搜索的共享合约，供应商可以在一处拥有其所有面：

```ts
import type { OpenClawPluginDefinition } from "openclaw/plugin-sdk";
import {
  buildOpenAISpeechProvider,
  createPluginBackedWebSearchProvider,
  describeImageWithModel,
  transcribeOpenAiCompatibleAudio,
} from "openclaw/plugin-sdk";

const plugin: OpenClawPluginDefinition = {
  id: "exampleai",
  name: "ExampleAI",
  register(api) {
    api.registerProvider({
      id: "exampleai",
      // auth/model catalog/runtime hooks
    });

    api.registerSpeechProvider(
      buildOpenAISpeechProvider({
        id: "exampleai",
        // vendor speech config
      }),
    );

    api.registerMediaUnderstandingProvider({
      id: "exampleai",
      capabilities: ["image", "audio", "video"],
      async describeImage(req) {
        return describeImageWithModel({
          provider: "exampleai",
          model: req.model,
          input: req.input,
        });
      },
      async transcribeAudio(req) {
        return transcribeOpenAiCompatibleAudio({
          provider: "exampleai",
          model: req.model,
          input: req.input,
        });
      },
    });

    api.registerWebSearchProvider(
      createPluginBackedWebSearchProvider({
        id: "exampleai-search",
        // credential + fetch logic
      }),
    );
  },
};

export default plugin;
```

重要的是形状而非确切辅助名称：

- 一个插件拥有供应商面
- 核心仍然拥有能力合约
- Channel 和功能插件消费 `api.runtime.*` 辅助，而非供应商代码
- 契约测试可以断言插件注册了它声称拥有的能力

## 合约和强制

插件 API 面在 `OpenClawPluginApi` 中有意类型化并集中。该合约定义了支持的注册点和插件可以依赖的运行时辅助。

为什么这很重要：

- 插件作者获得一个稳定的内部标准
- 核心可以拒绝重复所有权（如两个插件注册相同 Provider id）
- 启动可以为主动 malformed 注册产生可操作的诊断
- 契约测试可以强制捆绑插件所有权并防止静默漂移

有两层强制：

1. **运行时注册强制**
   插件注册表在插件加载时验证注册。例如：重复 Provider id、重复语音 Provider id 和 malformed 注册会产生插件诊断，而非未定义行为。
2. **契约测试**
   捆绑插件在测试运行期间被捕获到契约注册表中，以便 OpenClaw 可以显式断言所有权。今天这用于模型 Provider、语音 Provider、网页搜索 Provider 和捆绑注册所有权。

实际效果是 OpenClaw 预先知道哪个插件拥有哪个面。这让核心和 Channel 可以无缝组合，因为所有权是声明的、类型化的和可测试的，而非隐式的。

## 执行模型

原生 OpenClaw 插件与 Gateway **进程内**运行。它们未沙箱化。已加载原生插件与核心代码具有相同的进程级信任边界。

含义：

- 原生插件可以注册工具、网络处理器、钩子和服务
- 原生插件 bug 可能崩溃或破坏 gateway
- 恶意原生插件相当于在 OpenClaw 进程内任意代码执行

兼容 bundle 默认更安全，因为 OpenClaw 目前将其视为元数据/内容包。当前版本中，这主要是捆绑 skills。

默认使用 allowlist 和显式安装/加载路径处理非捆绑插件。将工作区插件视为开发时代码，而非生产默认值。

信任重要提示：

- `plugins.allow` 信任 **插件 id**，而非来源。
- 具有与捆绑插件相同 id 的工作区插件在启用/allowlist 时有意遮蔽捆绑副本。
- 这对本地开发、补丁测试和热修复是正常且有用的。

## 导出边界

OpenClaw 导出能力，而非实现便利。

保持能力注册公开。削减非合约辅助导出：

- 捆绑插件特定辅助子路径
- 不打算作为公开 API 的运行时管道子路径
- 供应商特定便利辅助
- 实现细节的 setup/onboarding 辅助

## 加载管道

启动时，OpenClaw 大致这样做：

1. 发现候选插件根
2. 读取原生或兼容 bundle 清单和包元数据
3. 拒绝不安全候选
4. 规范化插件配置（`plugins.enabled`、`allow`、`deny`、`entries`、`slots`、`load.paths`）
5. 决定每个候选的启用状态
6. 通过 jiti 加载启用的原生模块
7. 调用原生 `register(api)` 钩子并将注册收集到插件注册表
8. 向命令/运行时面暴露注册表

安全门发生在 **运行时执行之前**。候选在条目逃离插件根、路径全局可写或非捆绑插件的路径所有权看起来可疑时被阻止。

### 清单优先行为

清单是控制平面真相来源。OpenClaw 用它来：

- 识别插件
- 发现声明的 channels/skills/config schema 或 bundle 能力
- 验证 `plugins.entries.<id>.config`
- 增强 Control UI 标签/占位符
- 显示安装/目录元数据

对于原生插件，运行时模块是数据平面部分。它注册实际行为，如钩子、工具、命令或 Provider 流程。

## 注册表模型

已加载插件不直接改变随机核心全局。它们注册到中央插件注册表。

注册表跟踪：

- 插件记录（身份、来源、origin、状态、诊断）
- 工具
- 传统钩子和类型化钩子
- Channels
- Providers
- Gateway RPC 处理器
- HTTP 路由
- CLI 注册器
- 后台服务
- 插件所有命令

核心功能然后从注册表读取，而非直接与插件模块对话。这保持加载单向：

- 插件模块 -> 注册表注册
- 核心运行时 -> 注册表消费

这种分离对可维护性很重要。它意味着大多数核心面只需一个集成点："读取注册表"，而非"特殊处理每个插件模块"。

## Channel 目标解析

Channel 插件应拥有 Channel 特定目标语义。保持共享出站主机通用，并使用消息适配器面获取供应商规则：

- `messaging.inferTargetChatType({ to })` 决定在目录查找之前是否将规范化目标视为 `direct`、`group` 或 `channel`
- `messaging.targetResolver.looksLikeId(raw, normalized)` 告诉核心输入是否应跳过直接进行 id 类解析
- `messaging.targetResolver.resolveTarget(...)` 是核心在规范化后或目录未命中后需要供应商所有的最终解析时的插件 fallback
- `messaging.resolveOutboundSessionRoute(...)` 在目标解析后拥有供应商特定 session 路由构建

推荐拆分：

- 使用 `inferTargetChatType` 进行应在搜索 peer/group 之前发生的类别决策
- 使用 `looksLikeId` 进行"将此作为显式/原生目标 id 处理"的检查
- 使用 `resolveTarget` 进行供应商特定规范化 fallback，而非广泛目录搜索
- 将供应商原生 id（如 chat id、thread id、JID、handle 和 room id）保留在 `target` 值或供应商特定参数内，而非通用 SDK 字段中

## 配置备份目录

从配置派生目录条目的插件应将逻辑保留在插件内，并复用 `openclaw/plugin-sdk/directory-runtime` 中的共享辅助。

在 Channel 需要配置备份的 peer/group（如 allowlist 驱动的 DM peer、配置的 channel/group 映射、账号作用域静态目录 fallback）时使用。

`directory-runtime` 中的共享辅助仅处理通用操作：

- 查询过滤
- limit 应用
- 去重/规范化辅助
- 构建 `ChannelDirectoryEntry[]`

Channel 特定的账号检查和 id 规范化应保留在插件实现中。

## Channel 目录元数据

Channel 插件可以通过 `openclaw.channel` 和 `openclaw.install` 广告 setup/发现元数据。这保持核心目录数据无数据。

```json
{
  "name": "@openclaw/nextcloud-talk",
  "openclaw": {
    "extensions": ["./index.ts"],
    "channel": {
      "id": "nextcloud-talk",
      "label": "Nextcloud Talk",
      "selectionLabel": "Nextcloud Talk（自托管）",
      "docsPath": "/channels/nextcloud-talk",
      "docsLabel": "nextcloud-talk",
      "blurb": "通过 Nextcloud Talk webhook 机器人进行自托管聊天。",
      "order": 65,
      "aliases": ["nc-talk", "nc"]
    },
    "install": {
      "npmSpec": "@openclaw/nextcloud-talk",
      "localPath": "extensions/nextcloud-talk",
      "defaultChoice": "npm"
    }
  }
}
```

## Provider 运行时钩子

Provider 插件现在有两层：

- 清单元数据：`providerAuthEnvVars` 用于运行时加载前便宜的 env-auth 查找，`providerAuthChoices` 用于运行时加载前便宜的 onboarding/auth-choice 标签和 CLI 标志元数据
- 配置时钩子：`catalog` / 传统 `discovery`
- 运行时钩子：`resolveDynamicModel`、`prepareDynamicModel`、`normalizeResolvedModel`、`capabilities`、`prepareExtraParams`、`wrapStreamFn`、`formatApiKey`、`refreshOAuth`、`buildAuthDoctorHint`、`isCacheTtlEligible`、`buildMissingAuthMessage`、`suppressBuiltInModel`、`augmentModelCatalog`、`isBinaryThinking`、`supportsXHighThinking`、`resolveDefaultThinkingLevel`、`isModernModelRef`、`prepareRuntimeAuth`、`resolveUsageAuth`、`fetchUsageSnapshot`

## 运行时辅助

插件可以通过 `api.runtime` 访问选定的核心辅助。对于 TTS：

```ts
const clip = await api.runtime.tts.textToSpeech({
  text: "Hello from OpenClaw",
  cfg: api.config,
});

const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});

const voices = await api.runtime.tts.listVoices({
  provider: "elevenlabs",
  cfg: api.config,
});
```

对于图片/音频/视频理解，插件注册一个类型化媒体理解 Provider：

```ts
api.registerMediaUnderstandingProvider({
  id: "google",
  capabilities: ["image", "audio", "video"],
  describeImage: async (req) => ({ text: "..." }),
  transcribeAudio: async (req) => ({ text: "..." }),
  describeVideo: async (req) => ({ text: "..." }),
});
```

## 添加新能力

当插件需要当前 API 中不存在的行为时，不要用私有 reach-in 绕过插件系统。添加缺失的能力。

推荐顺序：

1. **定义核心合约** — 决定核心应拥有什么共享行为：策略、fallback、配置合并、生命周期、Channel 面语义和运行时辅助形状
2. **添加类型化插件注册/运行时面** — 用最小有用的类型化能力面扩展 `OpenClawPluginApi` 和/或 `api.runtime`
3. **接线核心 + Channel/功能消费者** — Channel 和功能插件应通过核心消费新能力，而非直接导入供应商实现
4. **注册供应商实现** — 供应商插件然后向能力注册其后端
5. **添加契约覆盖** — 添加测试以随时间保持所有权和注册形状显式

具体清单见 [Capability Cookbook](/tools/capability-cookbook)。
