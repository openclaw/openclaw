---
summary: "插件内部：能力模型、所有权、契约、加载流程和运行时助手"
read_when:
  - 构建或调试原生 OpenClaw 插件
  - 理解插件能力模型或所有权边界
  - 处理插件加载流程或注册表
  - 实现提供商运行时钩子或通道插件
title: "插件内部"
sidebarTitle: "内部"
---

# 插件内部

<Info>
  这是**深度架构参考**。对于实用指南，请参阅：
  - [安装和使用插件](/tools/plugin) — 用户指南
  - [入门](/plugins/building-plugins) — 第一个插件教程
  - [通道插件](/plugins/sdk-channel-plugins) — 构建消息通道
  - [提供商插件](/plugins/sdk-provider-plugins) — 构建模型提供商
  - [SDK 概览](/plugins/sdk-overview) — 导入映射和注册 API
</Info>

本页面涵盖 OpenClaw 插件系统的内部架构。

## 公共能力模型

能力是 OpenClaw 内部的公共**原生插件**模型。每个
原生 OpenClaw 插件都针对一个或多个能力类型进行注册：

| 能力            | 注册方法                                         | 示例插件                             |
| --------------- | ------------------------------------------------ | ------------------------------------ |
| 文本推理        | `api.registerProvider(...)`                      | `openai`, `anthropic`                |
| CLI 推理后端    | `api.registerCliBackend(...)`                    | `openai`, `anthropic`                |
| 语音            | `api.registerSpeechProvider(...)`                | `elevenlabs`, `microsoft`            |
| 实时转录        | `api.registerRealtimeTranscriptionProvider(...)` | `openai`                             |
| 实时语音        | `api.registerRealtimeVoiceProvider(...)`         | `openai`                             |
| 媒体理解        | `api.registerMediaUnderstandingProvider(...)`    | `openai`, `google`                   |
| 图像生成        | `api.registerImageGenerationProvider(...)`       | `openai`, `google`, `fal`, `minimax` |
| 音乐生成        | `api.registerMusicGenerationProvider(...)`       | `google`, `minimax`                  |
| 视频生成        | `api.registerVideoGenerationProvider(...)`       | `qwen`                               |
| Web 获取        | `api.registerWebFetchProvider(...)`              | `firecrawl`                          |
| Web 搜索        | `api.registerWebSearchProvider(...)`             | `google`                             |
| 通道 / 消息传递 | `api.registerChannel(...)`                       | `msteams`, `matrix`                  |

注册零个能力但提供钩子、工具或
服务的插件是**仅钩子的遗留**插件。该模式仍然完全受支持。

### 外部兼容性立场

能力模型已在核心中落地，并且今天被捆绑/原生插件使用，
但外部插件兼容性仍然需要比"它已导出，因此它被冻结"更严格的标准。

当前指导：

- **现有的外部插件**：保持基于钩子的集成正常工作；将此视为兼容性基线
- **新的捆绑/原生插件**：优先选择显式能力注册，而不是
  供应商特定的访问或新的仅钩子设计
- **采用能力注册的外部插件**：允许，但将
  特定于能力的助手表面视为不断发展的，除非文档明确标记
  契约为稳定

实用规则：

- 能力注册 API 是预期的方向
- 遗留钩子在过渡期仍然是外部插件最安全的无中断路径
- 导出的助手子路径并不都相等；优先选择狭窄的文档化
  契约，而不是附带的助手导出

### 插件形状

OpenClaw 根据插件的实际注册行为（不仅仅是静态元数据）将每个加载的插件分类为一种形状：

- **纯能力** — 仅注册一种能力类型（例如仅提供商插件，如 `mistral`）
- **混合能力** — 注册多种能力类型（例如
  `openai` 拥有文本推理、语音、媒体理解和图像
  生成）
- **仅钩子** — 仅注册钩子（类型化或自定义），无能力、
  工具、命令或服务
- **非能力** — 注册工具、命令、服务或路由，但无
  能力

使用 `openclaw plugins inspect <id>` 查看插件的形状和能力
分解。有关详细信息，请参阅 [CLI 参考](/cli/plugins#inspect)。

### 遗留钩子

`before_agent_start` 钩子作为仅钩子插件的兼容性路径仍然受支持。遗留的实际插件仍然依赖它。

方向：

- 保持其工作
- 将其记录为遗留
- 对于模型/提供商覆盖工作，优先选择 `before_model_resolve`
- 对于提示突变工作，优先选择 `before_prompt_build`
- 仅在实际使用减少且夹具覆盖证明迁移安全性后移除

### 兼容性信号

当你运行 `openclaw doctor` 或 `openclaw plugins inspect <id>` 时，你可能会看到
这些标签之一：

| 信号                       | 含义                                           |
| -------------------------- | ---------------------------------------------- |
| **config valid**           | 配置解析良好且插件解析                         |
| **compatibility advisory** | 插件使用受支持但较旧的模式（例如 `hook-only`） |
| **legacy warning**         | 插件使用已弃用的 `before_agent_start`          |
| **hard error**             | 配置无效或插件加载失败                         |

今天，`hook-only` 和 `before_agent_start` 都不会破坏你的插件 —
`hook-only` 是建议性的，而 `before_agent_start` 只会触发警告。这些
信号也出现在 `openclaw status --all` 和 `openclaw plugins doctor` 中。

## 架构概览

OpenClaw 的插件系统有四个层：

1. **清单 + 发现**
   OpenClaw 从配置的路径、工作区根、
   全局扩展根和捆绑扩展中查找候选插件。发现首先读取原生
   `openclaw.plugin.json` 清单以及支持的捆绑清单。
2. **启用 + 验证**
   核心决定发现的插件是启用、禁用、阻止还是
   选择用于独占槽位，例如内存。
3. **运行时加载**
   原生 OpenClaw 插件通过 jiti 在进程内加载并注册
   能力到中央注册表。兼容的捆绑包被标准化为
   注册表记录，无需导入运行时代码。
4. **表面消费**
   OpenClaw 的其余部分读取注册表以公开工具、通道、提供商
   设置、钩子、HTTP 路由、CLI 命令和服务。

对于插件 CLI 特别而言，根命令发现分为两个阶段：

- 解析时元数据来自 `registerCli(..., { descriptors: [...] })`
- 真正的插件 CLI 模块可以保持惰性并在首次调用时注册

这将插件拥有的 CLI 代码保留在插件内部，同时仍允许 OpenClaw
在解析前保留根命令名称。

重要的设计边界：

- 发现 + 配置验证应该从**清单/模式元数据**工作
  无需执行插件代码
- 原生运行时行为来自插件模块的 `register(api)` 路径

这种分离让 OpenClaw 在完整运行时激活之前验证配置、解释缺失/禁用的插件并
构建 UI/模式提示。

### 通道插件和共享消息工具

通道插件不需要为
正常的聊天操作注册单独的发送/编辑/反应工具。OpenClaw 在核心中保持一个共享的 `message` 工具，而
通道插件拥有其背后的通道特定发现和执行。

当前边界是：

- 核心拥有共享的 `message` 工具主机、提示接线、会话/线程
  记账和执行调度
- 通道插件拥有作用域动作发现、能力发现和任何
  通道特定的模式片段
- 通道插件拥有提供商特定的会话对话语法，例如
  对话 ID 如何编码线程 ID 或从父对话继承
- 通道插件通过其动作适配器执行最终动作

对于通道插件，SDK 表面是
`ChannelMessageActionAdapter.describeMessageTool(...)`。那个统一的发现
调用让插件返回其可见动作、能力和模式
一起贡献，这样这些部分就不会脱节。

当特定于通道的消息工具参数携带媒体源（如
本地路径或远程媒体 URL）时，插件还应从 `describeMessageTool(...)` 返回
`mediaSourceParams`。核心使用该显式
列表应用沙盒路径规范化和出站媒体访问提示
无需硬编码插件拥有的参数名称。
那里优先使用作用域动作映射，而不是一个通道范围的扁平列表，这样
仅配置文件的媒体参数就不会在 `send` 等不相关的动作上被规范化。

核心将运行时作用域传递到该发现步骤。重要字段包括：

- `accountId`
- `currentChannelId`
- `currentThreadTs`
- `currentMessageId`
- `sessionKey`
- `sessionId`
- `agentId`
- 可信入站 `requesterSenderId`

这对上下文敏感的插件很重要。通道可以基于活动账户、当前房间/线程/消息或
可信请求者身份隐藏或暴露
消息动作，而无需在
核心 `message` 工具中硬编码特定于通道的分支。

这就是为什么嵌入式运行器路由更改仍然是插件工作的原因：运行器负责将当前聊天/会话标识转发到插件
发现边界，以便共享的 `message` 工具为当前轮次公开正确的通道拥有
表面。

对于通道拥有的执行助手，捆绑插件应将执行
运行时保持在其自己的扩展模块内。核心不再拥有 Discord、
Slack、Telegram 或 WhatsApp 消息动作运行时在 `src/agents/tools` 下。
我们不发布单独的 `plugin-sdk/*-action-runtime` 子路径，并且捆绑
插件应直接从其
扩展拥有的模块导入其自己的本地运行时代码。

相同的边界适用于一般的提供商命名 SDK 接缝：核心不应导入 Slack、Discord、Signal、
WhatsApp 或类似扩展的通道特定便利桶。如果核心需要某种行为，要么使用捆绑
插件自己的 `api.ts` / `runtime-api.ts` 桶，要么将需求提升
到共享 SDK 中的狭窄通用能力。

对于轮询特别而言，有两个执行路径：

- `outbound.sendPoll` 是适合通用
  轮询模型的通道的共享基线
- `actions.handleAction("poll")` 是通道特定
  轮询语义或额外轮询参数的首选路径

核心现在将共享轮询解析推迟到插件轮询调度拒绝
动作之后，因此插件拥有的轮询处理程序可以接受通道特定的轮询
字段，而不会首先被通用轮询解析器阻止。

有关完整的启动序列，请参阅 [加载流程](#load-pipeline)。

## 能力所有权模型

OpenClaw 将原生插件视为**公司**或
**功能**的所有权边界，而不是不相关集成的抓取袋。

这意味着：

- 公司插件通常应该拥有该公司所有面向 OpenClaw 的
  表面
- 功能插件通常应该拥有它引入的完整功能表面
- 通道应该使用共享核心能力，而不是重新实现
  提供商行为

示例：

- 捆绑的 `openai` 插件拥有 OpenAI 模型提供商行为和 OpenAI
  语音 + 实时语音 + 媒体理解 + 图像生成行为
- 捆绑的 `elevenlabs` 插件拥有 ElevenLabs 语音行为
- 捆绑的 `microsoft` 插件拥有 Microsoft 语音行为
- 捆绑的 `google` 插件拥有 Google 模型提供商行为以及 Google
  媒体理解 + 图像生成 + 网络搜索行为
- 捆绑的 `firecrawl` 插件拥有 Firecrawl 网络获取行为
- 捆绑的 `minimax`、`mistral`、`moonshot` 和 `zai` 插件拥有它们
  媒体理解后端
- 捆绑的 `qwen` 插件拥有 Qwen 文本提供商行为以及
  媒体理解和视频生成行为
- `voice-call` 插件是一个功能插件：它拥有呼叫传输、工具、
  CLI、路由和 Twilio 媒体流桥接，但它使用共享语音
  加上实时转录和实时语音能力，而不是
  直接导入供应商插件

预期的最终状态是：

- OpenAI 生活在一个插件中，即使它跨越文本模型、语音、图像和
  未来的视频
- 另一个供应商可以为其自己的表面区域做同样的事情
- 通道不关心哪个供应商插件拥有提供商；它们消费核心暴露的共享能力契约

这是关键区别：

- **插件** = 所有权边界
- **能力** = 核心契约，多个插件可以实现或消费

因此，如果 OpenClaw 添加一个新领域，如视频，第一个问题不是
"哪个提供商应该硬编码视频处理？" 第一个问题是 "核心视频能力契约是什么？" 一旦该契约存在，供应商插件
可以针对它注册，通道/功能插件可以消费它。

如果能力尚不存在，正确的做法通常是：

1. 在核心中定义缺失的能力
2. 通过插件 API/运行时以类型化方式暴露它
3. 针对该能力连接通道/功能
4. 让供应商插件注册实现

这在避免依赖于
单个供应商或一次性插件特定代码路径的核心行为的同时，保持所有权明确。

### 能力分层

在决定代码所属位置时使用此思维模型：

- **核心能力层**：共享编排、策略、回退、配置
  合并规则、传递语义和类型化契约
- **供应商插件层**：供应商特定的 API、认证、模型目录、语音
  合成、图像生成、未来视频后端、使用端点
- **通道/功能插件层**：Slack/Discord/voice-call 等集成
  消费核心能力并在表面上呈现它们

例如，TTS 遵循这种形状：

- 核心拥有回复时 TTS 策略、回退顺序、首选项和通道传递
- `openai`、`elevenlabs` 和 `microsoft` 拥有合成实现
- `voice-call` 消费电话 TTS 运行时助手

未来的能力应该优先采用相同的模式。

### 多能力公司插件示例

从外部看，公司插件应该感觉连贯。如果 OpenClaw 对模型、语音、实时转录、实时语音、媒体
理解、图像生成、视频生成、网络获取和网络搜索有共享
契约，供应商可以在一个地方拥有其所有表面：

```ts
import type { OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";
import {
  describeImageWithModel,
  transcribeOpenAiCompatibleAudio,
} from "openclaw/plugin-sdk/media-understanding";

const plugin: OpenClawPluginDefinition = {
  id: "exampleai",
  name: "ExampleAI",
  register(api) {
    api.registerProvider({
      id: "exampleai",
      // auth/model catalog/runtime hooks
    });

    api.registerSpeechProvider({
      id: "exampleai",
      // vendor speech config — implement the SpeechProviderPlugin interface directly
    });

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

重要的不是确切的助手名称。形状很重要：

- 一个插件拥有供应商表面
- 核心仍然拥有能力契约
- 通道和功能插件消费 `api.runtime.*` 助手，而不是供应商代码
- 契约测试可以断言插件注册了它
  声称拥有的能力

### 能力示例：视频理解

OpenClaw 已经将图像/音频/视频理解视为一个共享
能力。相同的所有权模型适用于那里：

1. 核心定义媒体理解契约
2. 供应商插件注册 `describeImage`、`transcribeAudio` 和
   适用的 `describeVideo`
3. 通道和功能插件消费共享核心行为，而不是
   直接连接到供应商代码

这避免了将一个提供商的视频假设烘焙到核心中。插件拥有
供应商表面；核心拥有能力契约和回退行为。

视频生成已经使用相同的序列：核心拥有类型化
能力契约和运行时助手，供应商插件注册
`api.registerVideoGenerationProvider(...)` 实现。

需要具体的推出清单？请参阅
[能力手册](/tools/capability-cookbook)。

## 契约和强制执行

插件 API 表面在
`OpenClawPluginApi` 中有意类型化和集中化。该契约定义了支持的注册点和
插件可能依赖的运行时助手。

为什么这很重要：

- 插件作者获得一个稳定的内部标准
- 核心可以拒绝重复所有权，例如两个插件注册相同的
  提供商 ID
- 启动可以显示可操作的诊断信息，用于格式错误的注册
- 契约测试可以强制执行捆绑插件所有权并防止静默漂移

有两层强制执行：

1. **运行时注册强制执行**
   插件注册表在插件加载时验证注册。示例：
   重复的提供商 ID、重复的语音提供商 ID 和格式错误的
   注册产生插件诊断，而不是未定义的行为。
2. **契约测试**
   捆绑插件在测试运行期间被捕获在契约注册表中，因此
   OpenClaw 可以明确断言所有权。今天这用于模型
   提供商、语音提供商、网络搜索提供商和捆绑注册
   所有权。

实际效果是，OpenClaw 预先知道哪个插件拥有哪个
表面。这让核心和通道无缝组合，因为所有权是
声明的、类型化的和可测试的，而不是隐式的。

### 契约中应包含什么

好的插件契约是：

- 类型化的
- 小的
- 特定于能力的
- 由核心拥有
- 可被多个插件重用
- 可被通道/功能消费，无需供应商知识

坏的插件契约是：

- 隐藏在核心中的供应商特定策略
- 绕过注册表的一次性插件逃生舱口
- 直接进入供应商实现的通道代码
- 不是 `OpenClawPluginApi` 或
  `api.runtime` 一部分的临时运行时对象

如果有疑问，提高抽象级别：首先定义能力，然后
让插件插入其中。

## 执行模型

原生 OpenClaw 插件与 Gateway **在进程内**运行。它们不是
沙盒化的。加载的原生插件与
核心代码具有相同的进程级信任边界。

含义：

- 原生插件可以注册工具、网络处理程序、钩子和服务
- 原生插件错误可能会崩溃或不稳定网关
- 恶意原生插件等同于 OpenClaw 进程内的任意代码执行

兼容的捆绑包默认更安全，因为 OpenClaw 当前将它们
视为元数据/内容包。在当前版本中，这主要意味着捆绑
技能。

对非捆绑插件使用允许列表和显式安装/加载路径。将
工作区插件视为开发时代码，而不是生产默认值。

对于捆绑工作区包名称，保持插件 ID 锚定在 npm
名称中：默认情况下为 `@openclaw/<id>`，或当
包有意暴露更窄的插件角色时，使用批准的类型化后缀，如
`-provider`、`-plugin`、`-speech`、`-sandbox` 或 `-media-understanding`。

重要的信任注意事项：

- `plugins.allow` 信任**插件 ID**，而不是源来源。
- 与捆绑插件具有相同 ID 的工作区插件在该工作区插件被启用/允许列出时有意遮蔽
  捆绑副本。
- 这对于本地开发、补丁测试和热修复是正常且有用的。

## 导出边界

OpenClaw 导出能力，而不是实现便利性。

保持能力注册公开。修剪非契约助手导出：

- 特定于捆绑插件的助手子路径
- 并非旨在作为公共 API 的运行时管道子路径
- 供应商特定的便利助手
- 作为实现细节的设置/引导助手

一些捆绑插件助手子路径仍然保留在生成的 SDK 导出
映射中，用于兼容性和捆绑插件维护。当前示例包括
`plugin-sdk/feishu`、`plugin-sdk/feishu-setup`、`plugin-sdk/zalo`、
`plugin-sdk/zalo-setup` 和几个 `plugin-sdk/matrix*` 接缝。将这些视为
保留的实现细节导出，而不是新第三方插件的推荐 SDK 模式。

## 加载流程

启动时，OpenClaw 大致执行以下操作：

1. 发现候选插件根
2. 读取原生或兼容的捆绑清单和包元数据
3. 拒绝不安全的候选
4. 标准化插件配置（`plugins.enabled`、`allow`、`deny`、`entries`、
   `slots`、`load.paths`）
5. 决定每个候选的启用状态
6. 通过 jiti 加载启用的原生模块
7. 调用原生 `register(api)`（或 `activate(api)` — 遗留别名）钩子并将注册收集到插件注册表中
8. 向命令/运行时表面公开注册表

<Note>
`activate` 是 `register` 的遗留别名 — 加载器解析存在的那个（`def.register ?? def.activate`）并在同一点调用它。所有捆绑插件都使用 `register`；新插件首选 `register`。
</Note>

安全门在**运行时执行之前**发生。当条目逃离插件根、路径是世界可写的或路径
所有权对非捆绑插件看起来可疑时，候选会被阻止。

### 清单优先行为

清单是控制平面的真实来源。OpenClaw 使用它来：

- 识别插件
- 发现声明的通道/技能/配置模式或捆绑能力
- 验证 `plugins.entries.<id>.config`
- 增强控制 UI 标签/占位符
- 显示安装/目录元数据
- 保留廉价的激活和设置描述符，无需加载插件运行时

对于原生插件，运行时模块是数据平面部分。它注册
实际行为，如钩子、工具、命令或提供商流程。

可选的清单 `activation` 和 `setup` 块保持在控制平面上。
它们是用于激活规划和设置发现的仅元数据描述符；
它们不替换运行时注册、`register(...)` 或 `setupEntry`。
第一个实时激活消费者现在使用清单命令、通道和提供商提示
在更广泛的注册表具体化之前缩小插件加载：

- CLI 加载缩小到拥有请求的主命令的插件
- 通道设置/插件解析缩小到拥有请求的
  通道 ID 的插件
- 显式提供商设置/运行时解析缩小到拥有请求的
  提供商 ID 的插件

设置发现现在更喜欢描述符拥有的 ID，如 `setup.providers` 和
`setup.cliBackends`，以在回退到
`setup-api` 之前缩小候选插件，用于仍然需要设置时运行时钩子的插件。如果多个发现的插件声明相同的标准化设置提供商或 CLI 后端
ID，设置查找拒绝模糊的所有者，而不是依赖发现
顺序。

### 加载器缓存什么

OpenClaw 保持短的进程内缓存用于：

- 发现结果
- 清单注册表数据
- 加载的插件注册表

这些缓存减少了突发启动和重复命令开销。将它们视为短期性能缓存是安全的，而不是持久性。

性能注意事项：

- 设置 `OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE=1` 或
  `OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE=1` 以禁用这些缓存。
- 使用 `OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS` 和
  `OPENCLAW_PLUGIN_MANIFEST_CACHE_MS` 调整缓存窗口。

## 注册表模型

加载的插件不会直接改变随机核心全局变量。它们注册到一个
中央插件注册表。

注册表跟踪：

- 插件记录（标识、源、起源、状态、诊断）
- 工具
- 遗留钩子和类型化钩子
- 通道
- 提供商
- 网关 RPC 处理程序
- HTTP 路由
- CLI 注册器
- 后台服务
- 插件拥有的命令

核心功能然后从该注册表读取，而不是直接与插件模块
对话。这保持加载单向：

- 插件模块 -> 注册表注册
- 核心运行时 -> 注册表消费

这种分离对可维护性很重要。这意味着大多数核心表面只需要一个集成点："读取注册表"，而不是"为每个插件
模块添加特殊情况"。

## 会话绑定回调

绑定会话的插件可以在批准解决时做出反应。

使用 `api.onConversationBindingResolved(...)` 在绑定
请求被批准或拒绝后接收回调：

```ts
export default {
  id: "my-plugin",
  register(api) {
    api.onConversationBindingResolved(async (event) => {
      if (event.status === "approved") {
        // 此插件 + 会话的绑定现在存在。
        console.log(event.binding?.conversationId);
        return;
      }

      // 请求被拒绝；清除任何本地待处理状态。
      console.log(event.request.conversation.conversationId);
    });
  },
};
```

回调有效负载字段：

- `status`：`"approved"` 或 `"denied"`
- `decision`：`"allow-once"`、`"allow-always"` 或 `"deny"`
- `binding`：已批准请求的已解决绑定
- `request`：原始请求摘要、分离提示、发送者 ID 和
  会话元数据

此回调仅用于通知。它不会改变谁被允许绑定
会话，并且它在核心批准处理完成后运行。

## 提供商运行时钩子

提供商插件现在有两层：

- 清单元数据：`providerAuthEnvVars` 用于在运行时加载之前进行廉价的提供商环境认证查找，`providerAuthAliases` 用于共享
  认证的提供商变体，`channelEnvVars` 用于在运行时
  加载之前进行廉价的通道环境/设置查找，以及 `providerAuthChoices` 用于在运行时加载之前进行廉价的引导/认证选择标签和
  CLI 标志元数据
- 配置时钩子：`catalog` / 遗留 `discovery` 加上 `applyConfigDefaults`
- 运行时钩子：`normalizeModelId`、`normalizeTransport`、
  `normalizeConfig`、
  `applyNativeStreamingUsageCompat`、`resolveConfigApiKey`、
  `resolveSyntheticAuth`、`resolveExternalAuthProfiles`、
  `shouldDeferSyntheticProfileAuth`、
  `resolveDynamicModel`、`prepareDynamicModel`、`normalizeResolvedModel`、
  `contributeResolvedModelCompat`、`capabilities`、
  `normalizeToolSchemas`、`inspectToolSchemas`、
  `resolveReasoningOutputMode`、`prepareExtraParams`、`createStreamFn`、
  `wrapStreamFn`、`resolveTransportTurnState`、
  `resolveWebSocketSessionPolicy`、`formatApiKey`、`refreshOAuth`、
  `buildAuthDoctorHint`、`matchesContextOverflowError`、
  `classifyFailoverReason`、`isCacheTtlEligible`、
  `buildMissingAuthMessage`、`suppressBuiltInModel`、`augmentModelCatalog`、
  `isBinaryThinking`、`supportsXHighThinking`、
  `resolveDefaultThinkingLevel`、`isModernModelRef`、`prepareRuntimeAuth`、
  `resolveUsageAuth`、`fetchUsageSnapshot`、`createEmbeddingProvider`、
  `buildReplayPolicy`、
  `sanitizeReplayHistory`、`validateReplayTurns`、`onModelSelected`

OpenClaw 仍然拥有通用代理循环、故障转移、 transcript 处理和
工具策略。这些钩子是提供商特定行为的扩展表面，无需
完整的自定义推理传输。

当提供商有基于环境的凭证时使用清单 `providerAuthEnvVars`，这些凭证
通用认证/状态/模型选择器路径应该在不加载插件
运行时的情况下看到。当一个提供商 ID 应该重用
另一个提供商 ID 的环境变量、认证配置文件、基于配置的认证和 API 密钥
引导选择时，使用清单 `providerAuthAliases`。当引导/认证选择
CLI 表面应该知道提供商的选择 ID、组标签和简单
单标志认证接线而无需加载提供商运行时，使用清单 `providerAuthChoices`。保持提供商运行时
`envVars` 用于操作员面向的提示，如引导标签或 OAuth
客户端 ID/客户端密钥设置变量。

当通道有环境驱动的认证或设置时，使用清单 `channelEnvVars`，这些
通用 shell-env 回退、配置/状态检查或设置提示应该在不加载通道运行时的情况下看到。

### 钩子顺序和使用

对于模型/提供商插件，OpenClaw 按此大致顺序调用钩子。
"何时使用"列是快速决策指南。

| #   | 钩子                              | 它做什么                                                                                  | 何时使用                                                                                          |
| --- | --------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | `catalog`                         | 在 `models.json` 生成期间将提供商配置发布到 `models.providers`                            | 提供商拥有目录或基础 URL 默认值                                                                   |
| 2   | `applyConfigDefaults`             | 在配置具体化期间应用提供商拥有的全局配置默认值                                            | 默认值取决于认证模式、环境或提供商模型系列语义                                                    |
| --  | _(内置模型查找)_                  | OpenClaw 首先尝试正常的注册表/目录路径                                                    | _(不是插件钩子)_                                                                                  |
| 3   | `normalizeModelId`                | 在查找之前规范化遗留或预览模型 ID 别名                                                    | 提供商在规范模型解析之前拥有别名清理                                                              |
| 4   | `normalizeTransport`              | 在通用模型组装之前规范化提供商系列 `api` / `baseUrl`                                      | 提供商拥有同一传输系列中自定义提供商 ID 的传输清理                                                |
| 5   | `normalizeConfig`                 | 在运行时/提供商解析之前规范化 `models.providers.<id>`                                     | 提供商需要应与插件一起存在的配置清理；捆绑的 Google 系列助手也支持支持的 Google 配置条目          |
| 6   | `applyNativeStreamingUsageCompat` | 对配置提供商应用原生流式使用兼容性重写                                                    | 提供商需要端点驱动的原生流式使用元数据修复                                                        |
| 7   | `resolveConfigApiKey`             | 在运行时认证加载之前解析配置提供商的环境标记认证                                          | 提供商拥有提供商拥有的环境标记 API 密钥解析；`amazon-bedrock` 在这里也有内置的 AWS 环境标记解析器 |
| 8   | `resolveSyntheticAuth`            | 表面本地/自托管或基于配置的认证，无需持久化明文                                           | 提供商可以使用合成/本地凭证标记运行                                                               |
| 9   | `resolveExternalAuthProfiles`     | 覆盖提供商拥有的外部认证配置文件；默认 `persistence` 是 CLI/应用拥有凭证的 `runtime-only` | 提供商重用外部认证凭证，无需持久化复制的刷新令牌                                                  |
| 10  | `shouldDeferSyntheticProfileAuth` | 在环境/基于配置的认证后面降低存储的合成配置文件占位符                                     | 提供商存储不应优先的合成占位符配置文件                                                            |
| 11  | `resolveDynamicModel`             | 对提供商拥有的模型 ID 尚未在本地注册表中的同步回退                                        | 提供商接受任意上游模型 ID                                                                         |
| 12  | `prepareDynamicModel`             | 异步预热，然后 `resolveDynamicModel` 再次运行                                             | 提供商需要网络元数据才能解析未知 ID                                                               |
| 13  | `normalizeResolvedModel`          | 在嵌入式运行器使用解析的模型之前的最终重写                                                | 提供商需要传输重写但仍使用核心传输                                                                |
| 14  | `contributeResolvedModelCompat`   | 为兼容传输后面的供应商模型贡献兼容标志                                                    | 提供商在代理传输上识别自己的模型，而不接管提供商                                                  |
| 15  | `capabilities`                    | 提供商拥有的 transcript/工具元数据，由共享核心逻辑使用                                    | 提供商需要 transcript/提供商系列怪癖                                                              |
| 16  | `normalizeToolSchemas`            | 在嵌入式运行器看到工具模式之前对其进行规范化                                              | 提供商需要传输系列模式清理                                                                        |
| 17  | `inspectToolSchemas`              | 规范化后表面提供商拥有的模式诊断                                                          | 提供商希望在不教授核心提供商特定规则的情况下发出关键字警告                                        |
| 18  | `resolveReasoningOutputMode`      | 选择原生 vs 标记的推理输出契约                                                            | 提供商需要标记的推理/最终输出，而不是原生字段                                                     |
| 19  | `prepareExtraParams`              | 在通用流选项包装器之前进行请求参数规范化                                                  | 提供商需要默认请求参数或每个提供商参数清理                                                        |
| 20  | `createStreamFn`                  | 用自定义传输完全替换正常流路径                                                            | 提供商需要自定义有线协议，而不仅仅是包装器                                                        |
| 21  | `wrapStreamFn`                    | 应用通用包装器后的流包装器                                                                | 提供商需要请求头/正文/模型兼容包装器，无需自定义传输                                              |
| 22  | `resolveTransportTurnState`       | 附加原生每回合传输头或元数据                                                              | 提供商希望通用传输发送提供商原生回合标识                                                          |
| 23  | `resolveWebSocketSessionPolicy`   | 附加原生 WebSocket 头或会话冷却策略                                                       | 提供商希望通用 WS 传输调整会话头或回退策略                                                        |
| 24  | `formatApiKey`                    | 认证配置文件格式化程序：存储的配置文件成为运行时 `apiKey` 字符串                          | 提供商存储额外的认证元数据，需要自定义运行时令牌形状                                              |
| 25  | `refreshOAuth`                    | 用于自定义刷新端点或刷新失败策略的 OAuth 刷新覆盖                                         | 提供商不适合共享 `pi-ai` 刷新器                                                                   |
| 26  | `buildAuthDoctorHint`             | OAuth 刷新失败时附加的修复提示                                                            | 提供商在刷新失败后需要提供商拥有的认证修复指导                                                    |
| 27  | `matchesContextOverflowError`     | 提供商拥有的上下文窗口溢出匹配器                                                          | 提供商有通用启发式会错过的原始溢出错误                                                            |
| 28  | `classifyFailoverReason`          | 提供商拥有的故障转移原因分类                                                              | 提供商可以将原始 API/传输错误映射到速率限制/过载等                                                |
| 29  | `isCacheTtlEligible`              | 代理/回程提供商的提示缓存策略                                                             | 提供商需要代理特定的缓存 TTL 门控                                                                 |
| 30  | `buildMissingAuthMessage`         | 通用缺失认证恢复消息的替换                                                                | 提供商需要提供商特定的缺失认证恢复提示                                                            |
| 31  | `suppressBuiltInModel`            | 过时上游模型抑制加上可选的用户面向错误提示                                                | 提供商需要隐藏过时的上游行或用供应商提示替换它们                                                  |
| 32  | `augmentModelCatalog`             | 发现后附加的合成/最终目录行                                                               | 提供商需要 `models list` 和选择器中的合成前向兼容行                                               |
| 33  | `isBinaryThinking`                | 二进制思考提供商的开/关推理切换                                                           | 提供商仅公开二进制思考开/关                                                                       |
| 34  | `supportsXHighThinking`           | 选定模型的 `xhigh` 推理支持                                                               | 提供商希望仅在模型子集上使用 `xhigh`                                                              |
| 35  | `resolveDefaultThinkingLevel`     | 特定模型系列的默认 `/think` 级别                                                          | 提供商拥有模型系列的默认 `/think` 策略                                                            |
| 36  | `isModernModelRef`                | 现代模型匹配器，用于实时配置文件过滤器和烟雾选择                                          | 提供商拥有实时/烟雾首选模型匹配                                                                   |
| 37  | `prepareRuntimeAuth`              | 在推理前将配置的凭证交换为实际的运行时令牌/密钥                                           | 提供商需要令牌交换或短期请求凭证                                                                  |
| 38  | `resolveUsageAuth`                | 为 `/usage` 和相关状态表面解析使用/计费凭证                                               | 提供商需要自定义使用/配额令牌解析或不同的使用凭证                                                 |
| 39  | `fetchUsageSnapshot`              | 认证解析后获取并规范化提供商特定的使用/配额快照                                           | 提供商需要提供商特定的使用端点或有效负载解析器                                                    |
| 40  | `createEmbeddingProvider`         | 为内存/搜索构建提供商拥有的嵌入适配器                                                     | 内存嵌入行为属于提供商插件                                                                        |
| 41  | `buildReplayPolicy`               | 返回控制提供商 transcript 处理的重放策略                                                  | 提供商需要自定义 transcript 策略（例如，思考块剥离）                                              |
| 42  | `sanitizeReplayHistory`           | 通用 transcript 清理后的重写重放历史                                                      | 提供商需要超出共享压缩助手的提供商特定重放重写                                                    |
| 43  | `validateReplayTurns`             | 嵌入式运行器之前的最终重放回合验证或重塑                                                  | 提供商传输需要在通用清理后进行更严格的回合验证                                                    |
| 44  | `onModelSelected`                 | 运行提供商拥有的选择后副作用                                                              | 提供商在模型变为活动状态时需要遥测或提供商拥有的状态                                              |

`normalizeModelId`、`normalizeTransport` 和 `normalizeConfig` 首先检查
匹配的提供商插件，然后贯穿其他具有钩子能力的提供商插件
直到一个实际更改模型 ID 或传输/配置。这保持
别名/兼容提供商垫片工作，而不需要调用者知道哪个
捆绑插件拥有重写。如果没有提供商钩子重写支持的
Google 系列配置条目，捆绑的 Google 配置规范化器仍会应用
该兼容性清理。

如果提供商需要完全自定义的有线协议或自定义请求执行器，
那是不同类别的扩展。这些钩子适用于仍在 OpenClaw 的正常推理循环上运行的提供商行为。

### 提供商示例

```ts
api.registerProvider({
  id: "example-proxy",
  label: "Example Proxy",
  auth: [],
  catalog: {
    order: "simple",
    run: async (ctx) => {
      const apiKey = ctx.resolveProviderApiKey("example-proxy").apiKey;
      if (!apiKey) {
        return null;
      }
      return {
        provider: {
          baseUrl: "https://proxy.example.com/v1",
          apiKey,
          api: "openai-completions",
          models: [{ id: "auto", name: "Auto" }],
        },
      };
    },
  },
  resolveDynamicModel: (ctx) => ({
    id: ctx.modelId,
    name: ctx.modelId,
    provider: "example-proxy",
    api: "openai-completions",
    baseUrl: "https://proxy.example.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  }),
  prepareRuntimeAuth: async (ctx) => {
    const exchanged = await exchangeToken(ctx.apiKey);
    return {
      apiKey: exchanged.token,
      baseUrl: exchanged.baseUrl,
      expiresAt: exchanged.expiresAt,
    };
  },
  resolveUsageAuth: async (ctx) => {
    const auth = await ctx.resolveOAuthToken();
    return auth ? { token: auth.token } : null;
  },
  fetchUsageSnapshot: async (ctx) => {
    return await fetchExampleProxyUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn);
  },
});
```

### 内置示例

- Anthropic 使用 `resolveDynamicModel`、`capabilities`、`buildAuthDoctorHint`、
  `resolveUsageAuth`、`fetchUsageSnapshot`、`isCacheTtlEligible`、
  `resolveDefaultThinkingLevel`、`applyConfigDefaults`、`isModernModelRef` 和
  `wrapStreamFn`，因为它拥有 Claude 4.6 前向兼容、
  提供商系列提示、认证修复指导、使用端点集成、
  提示缓存资格、认证感知配置默认值、Claude
  默认/自适应思考策略，以及 Anthropic 特定的流塑造，用于
  测试版头、`/fast` / `serviceTier` 和 `context1m`。
- Anthropic 的 Claude 特定流助手暂时留在捆绑插件自己的
  公共 `api.ts` / `contract-api.ts` 接缝中。该包表面
  导出 `wrapAnthropicProviderStream`、`resolveAnthropicBetas`、
  `resolveAnthropicFastMode`、`resolveAnthropicServiceTier` 和更低级别的
  Anthropic 包装器构建器，而不是围绕一个
  提供商的测试版头规则扩大通用 SDK。
- OpenAI 使用 `resolveDynamicModel`、`normalizeResolvedModel` 和
  `capabilities` 加上 `buildMissingAuthMessage`、`suppressBuiltInModel`、
  `augmentModelCatalog`、`supportsXHighThinking` 和 `isModernModelRef`，
  因为它拥有 GPT-5.4 前向兼容、直接 OpenAI
  `openai-completions` -> `openai-responses` 规范化、Codex 感知认证
  提示、Spark 抑制、合成 OpenAI 列表行，以及 GPT-5 思考 /
  实时模型策略；`openai-responses-defaults` 流系列拥有
  共享原生 OpenAI Responses 包装器，用于归因头、
  `/fast`/`serviceTier`、文本详细程度、原生 Codex 网络搜索、
  推理兼容有效负载塑造和 Responses 上下文管理。
- OpenRouter 使用 `catalog` 加上 `resolveDynamicModel` 和
  `prepareDynamicModel`，因为提供商是传递的，可能会暴露新的
  模型 ID，在 OpenClaw 的静态目录更新之前；它还使用
  `capabilities`、`wrapStreamFn` 和 `isCacheTtlEligible` 来保持
  提供商特定的请求头、路由元数据、推理补丁和
  提示缓存策略不在核心中。其重放策略来自
  `passthrough-gemini` 系列，而 `openrouter-thinking` 流系列
  拥有代理推理注入和不支持的模型 / `auto` 跳过。
- GitHub Copilot 使用 `catalog`、`auth`、`resolveDynamicModel` 和
  `capabilities` 加上 `prepareRuntimeAuth` 和 `fetchUsageSnapshot`，因为它
  需要提供商拥有的设备登录、模型回退行为、Claude transcript
  怪癖、GitHub 令牌 -> Copilot 令牌交换，以及提供商拥有的使用
  端点。
- OpenAI Codex 使用 `catalog`、`resolveDynamicModel`、
  `normalizeResolvedModel`、`refreshOAuth` 和 `augmentModelCatalog` 加上
  `prepareExtraParams`、`resolveUsageAuth` 和 `fetchUsageSnapshot`，因为它
  仍在核心 OpenAI 传输上运行，但拥有其传输/基础 URL
  规范化、OAuth 刷新回退策略、默认传输选择、
  合成 Codex 目录行，以及 ChatGPT 使用端点集成；它
  与直接 OpenAI 共享相同的 `openai-responses-defaults` 流系列。
- Google AI Studio 和 Gemini CLI OAuth 使用 `resolveDynamicModel`、
  `buildReplayPolicy`、`sanitizeReplayHistory`、
  `resolveReasoningOutputMode`、`wrapStreamFn` 和 `isModernModelRef`，因为
  `google-gemini` 重放系列拥有 Gemini 3.1 前向兼容回退、
  原生 Gemini 重放验证、引导重放清理、标记
  推理输出模式和现代模型匹配，而
  `google-thinking` 流系列拥有 Gemini 思考有效负载规范化；
  Gemini CLI OAuth 还使用 `formatApiKey`、`resolveUsageAuth` 和
  `fetchUsageSnapshot` 用于令牌格式化、令牌解析和配额端点
  接线。
- Anthropic Vertex 通过
  `anthropic-by-model` 重放系列使用 `buildReplayPolicy`，因此 Claude 特定的重放清理保持
  范围到 Claude ID，而不是每个 `anthropic-messages` 传输。
- Amazon Bedrock 使用 `buildReplayPolicy`、`matchesContextOverflowError`、
  `classifyFailoverReason` 和 `resolveDefaultThinkingLevel`，因为它拥有
  Bedrock 特定的节流/未就绪/上下文溢出错误分类
  用于 Anthropic-on-Bedrock 流量；其重放策略仍然共享相同的
  Claude 专用 `anthropic-by-model` 守卫。
- OpenRouter、Kilocode、Opencode 和 Opencode Go 通过 `passthrough-gemini` 重放系列使用 `buildReplayPolicy`，因为它们通过 OpenAI 兼容传输代理 Gemini
  模型，需要 Gemini
  思考签名清理，无需原生 Gemini 重放验证或
  引导重写。
- MiniMax 通过
  `hybrid-anthropic-openai` 重放系列使用 `buildReplayPolicy`，因为一个提供商拥有
  Anthropic 消息和 OpenAI 兼容语义；它在 Anthropic 侧保持 Claude 专用
  思考块删除，同时将推理
  输出模式覆盖回原生，并且 `minimax-fast-mode` 流系列拥有
  共享流路径上的快速模式模型重写。
- Moonshot 使用 `catalog` 加上 `wrapStreamFn`，因为它仍使用共享
  OpenAI 传输，但需要提供商拥有的思考有效负载规范化；
  `moonshot-thinking` 流系列将配置加上 `/think` 状态映射到其
  原生二进制思考有效负载。
- Kilocode 使用 `catalog`、`capabilities`、`wrapStreamFn` 和
  `isCacheTtlEligible`，因为它需要提供商拥有的请求头、
  推理有效负载规范化、Gemini transcript 提示，以及 Anthropic
  缓存 TTL 门控；`kilocode-thinking` 流系列在共享代理流路径上保持 Kilo 思考
  注入，同时跳过 `kilo/auto` 和
  其他不支持显式推理有效负载的代理模型 ID。
- Z.AI 使用 `resolveDynamicModel`、`prepareExtraParams`、`wrapStreamFn`、
  `isCacheTtlEligible`、`isBinaryThinking`、`isModernModelRef`、
  `resolveUsageAuth` 和 `fetchUsageSnapshot`，因为它拥有 GLM-5 回退、
  `tool_stream` 默认值、二进制思考 UX、现代模型匹配，以及
  使用认证 + 配额获取；`tool-stream-default-on` 流系列保持
  默认开启的 `tool_stream` 包装器，远离每个提供商手写的胶水。
- xAI 使用 `normalizeResolvedModel`、`normalizeTransport`、
  `contributeResolvedModelCompat`、`prepareExtraParams`、`wrapStreamFn`、
  `resolveSyntheticAuth`、`resolveDynamicModel` 和 `isModernModelRef`，
  因为它拥有原生 xAI Responses 传输规范化、Grok 快速模式
  别名重写、默认 `tool_stream`、严格工具 / 推理有效负载
  清理、插件拥有工具的回退认证重用、前向兼容 Grok
  模型解析，以及提供商拥有的兼容补丁，如 xAI 工具模式
  配置文件、不支持的模式关键字、原生 `web_search` 和 HTML 实体
  工具调用参数解码。
- Mistral、OpenCode Zen 和 OpenCode Go 仅使用 `capabilities` 来保持
  transcript/工具怪癖不在核心中。
- 仅目录的捆绑提供商，如 `byteplus`、`cloudflare-ai-gateway`、
  `huggingface`、`kimi-coding`、`nvidia`、`qianfan`、
  `synthetic`、`together`、`venice`、`vercel-ai-gateway` 和 `volcengine` 仅使用
  `catalog`。
- Qwen 使用 `catalog` 用于其文本提供商，加上共享媒体理解和
  视频生成注册用于其多模态表面。
- MiniMax 和 Xiaomi 使用 `catalog` 加上使用钩子，因为它们的 `/usage`
  行为是插件拥有的，即使推理仍然通过共享
  传输运行。

## 运行时助手

插件可以通过 `api.runtime` 访问选定的核心助手。对于 TTS：

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

注意：

- `textToSpeech` 返回用于文件/语音笔记表面的正常核心 TTS 输出有效负载。
- 使用核心 `messages.tts` 配置和提供商选择。
- 返回 PCM 音频缓冲区 + 采样率。插件必须为提供商重新采样/编码。
- `listVoices` 对每个提供商是可选的。用于供应商拥有的语音选择器或设置流程。
- 语音列表可以包含更丰富的元数据，如区域设置、性别和个性标签，用于提供商感知的选择器。
- OpenAI 和 ElevenLabs 今天支持电话。Microsoft 不支持。

插件也可以通过 `api.registerSpeechProvider(...)` 注册语音提供商。

```ts
api.registerSpeechProvider({
  id: "acme-speech",
  label: "Acme Speech",
  isConfigured: ({ config }) => Boolean(config.messages?.tts),
  synthesize: async (req) => {
    return {
      audioBuffer: Buffer.from([]),
      outputFormat: "mp3",
      fileExtension: ".mp3",
      voiceCompatible: false,
    };
  },
});
```

注意：

- 保持 TTS 策略、回退和回复传递在核心中。
- 使用语音提供商进行供应商拥有的合成行为。
- 遗留 Microsoft `edge` 输入被规范化为 `microsoft` 提供商 ID。
- 首选的所有权模型是面向公司的：一个供应商插件可以拥有
  文本、语音、图像和未来的媒体提供商，当 OpenClaw 添加那些
  能力契约时。

对于图像/音频/视频理解，插件注册一个类型化的
媒体理解提供商，而不是通用的键/值包：

```ts
api.registerMediaUnderstandingProvider({
  id: "google",
  capabilities: ["image", "audio", "video"],
  describeImage: async (req) => ({ text: "..." }),
  transcribeAudio: async (req) => ({ text: "..." }),
  describeVideo: async (req) => ({ text: "..." }),
});
```

注意：

- 保持编排、回退、配置和通道接线在核心中。
- 保持供应商行为在提供商插件中。
- 附加扩展应该保持类型化：新的可选方法、新的可选
  结果字段、新的可选能力。
- 视频生成已经遵循相同的模式：
  - 核心拥有能力契约和运行时助手
  - 供应商插件注册 `api.registerVideoGenerationProvider(...)`
  - 功能/通道插件消费 `api.runtime.videoGeneration.*`

对于媒体理解运行时助手，插件可以调用：

```ts
const image = await api.runtime.mediaUnderstanding.describeImageFile({
  filePath: "/tmp/inbound-photo.jpg",
  cfg: api.config,
  agentDir: "/tmp/agent",
});

const video = await api.runtime.mediaUnderstanding.describeVideoFile({
  filePath: "/tmp/inbound-video.mp4",
  cfg: api.config,
});
```

对于音频转录，插件可以使用媒体理解运行时
或较旧的 STT 别名：

```ts
const { text } = await api.runtime.mediaUnderstanding.transcribeAudioFile({
  filePath: "/tmp/inbound-audio.ogg",
  cfg: api.config,
  // 当 MIME 无法可靠推断时可选：
  mime: "audio/ogg",
});
```

注意：

- `api.runtime.mediaUnderstanding.*` 是用于
  图像/音频/视频理解的首选共享表面。
- 使用核心媒体理解音频配置 (`tools.media.audio`) 和提供商回退顺序。
- 当没有产生转录输出时返回 `{ text: undefined }`（例如跳过/不支持的输入）。
- `api.runtime.stt.transcribeAudioFile(...)` 作为兼容性别名保留。

插件还可以通过 `api.runtime.subagent` 启动后台子代理运行：

```ts
const result = await api.runtime.subagent.run({
  sessionKey: "agent:main:subagent:search-helper",
  message: "将此查询扩展为重点后续搜索。",
  provider: "openai",
  model: "gpt-4.1-mini",
  deliver: false,
});
```

注意：

- `provider` 和 `model` 是每次运行的可选覆盖，不是持久会话更改。
- OpenClaw 仅为受信任的调用者尊重这些覆盖字段。
- 对于插件拥有的回退运行，操作员必须通过 `plugins.entries.<id>.subagent.allowModelOverride: true` 选择加入。
- 使用 `plugins.entries.<id>.subagent.allowedModels` 将受信任的插件限制为特定的规范 `provider/model` 目标，或使用 `"*"` 明确允许任何目标。
- 不受信任的插件子代理运行仍然有效，但覆盖请求被拒绝而不是静默回退。

对于网络搜索，插件可以消费共享运行时助手，而不是
进入代理工具接线：

```ts
const providers = api.runtime.webSearch.listProviders({
  config: api.config,
});

const result = await api.runtime.webSearch.search({
  config: api.config,
  args: {
    query: "OpenClaw plugin runtime helpers",
    count: 5,
  },
});
```

插件也可以通过
`api.registerWebSearchProvider(...)` 注册网络搜索提供商。

注意：

- 保持提供商选择、凭证解析和共享请求语义在核心中。
- 使用网络搜索提供商进行供应商特定的搜索传输。
- `api.runtime.webSearch.*` 是需要搜索行为而不依赖代理工具包装器的功能/通道插件的首选共享表面。

### `api.runtime.imageGeneration`

```ts
const result = await api.runtime.imageGeneration.generate({
  config: api.config,
  args: { prompt: "A friendly lobster mascot", size: "1024x1024" },
});

const providers = api.runtime.imageGeneration.listProviders({
  config: api.config,
});
```

- `generate(...)`：使用配置的图像生成提供商链生成图像。
- `listProviders(...)`：列出可用的图像生成提供商及其能力。

## 网关 HTTP 路由

插件可以使用 `api.registerHttpRoute(...)` 暴露 HTTP 端点。

```ts
api.registerHttpRoute({
  path: "/acme/webhook",
  auth: "plugin",
  match: "exact",
  handler: async (_req, res) => {
    res.statusCode = 200;
    res.end("ok");
    return true;
  },
});
```

路由字段：

- `path`：网关 HTTP 服务器下的路由路径。
- `auth`：必需。使用 `"gateway"` 要求正常的网关认证，或使用 `"plugin"` 用于插件管理的认证/ webhook 验证。
- `match`：可选。`"exact"`（默认）或 `"prefix"`。
- `replaceExisting`：可选。允许同一插件替换其自己现有的路由注册。
- `handler`：当路由处理请求时返回 `true`。

注意：

- `api.registerHttpHandler(...)` 已被移除，将导致插件加载错误。请使用 `api.registerHttpRoute(...)` 代替。
- 插件路由必须显式声明 `auth`。
- 精确的 `path + match` 冲突被拒绝，除非 `replaceExisting: true`，并且一个插件不能替换另一个插件的路由。
- 具有不同 `auth` 级别的重叠路由被拒绝。仅在同一认证级别上保持 `exact`/`prefix` 回退链。
- `auth: "plugin"` 路由**不会**自动接收操作员运行时作用域。它们用于插件管理的 webhook/签名验证，而不是特权网关助手调用。
- `auth: "gateway"` 路由在网关请求运行时作用域内运行，但该作用域有意保守：
  - 共享密钥承载认证（`gateway.auth.mode = "token"` / `"password"`）保持插件路由运行时作用域固定为 `operator.write`，即使调用者发送 `x-openclaw-scopes`
  - 可信的带身份的 HTTP 模式（例如 `trusted-proxy` 或 `gateway.auth.mode = "none"` 在私有入口上）仅在显式存在头时才尊重 `x-openclaw-scopes`
  - 如果这些带身份的插件路由请求上缺少 `x-openclaw-scopes`，运行时作用域回退到 `operator.write`
- 实用规则：不要假设网关认证插件路由是隐式管理表面。如果你的路由需要仅管理员行为，需要带身份的认证模式并记录显式 `x-openclaw-scopes` 头契约。

## 插件 SDK 导入路径

在编写插件时，使用 SDK 子路径而不是整体 `openclaw/plugin-sdk` 导入：

- `openclaw/plugin-sdk/plugin-entry` 用于插件注册原语。
- `openclaw/plugin-sdk/core` 用于通用共享插件面向契约。
- `openclaw/plugin-sdk/config-schema` 用于根 `openclaw.json` Zod 模式
  导出（`OpenClawSchema`）。
- 稳定通道原语，如 `openclaw/plugin-sdk/channel-setup`、
  `openclaw/plugin-sdk/setup-runtime`、
  `openclaw/plugin-sdk/setup-adapter-runtime`、
  `openclaw/plugin-sdk/setup-tools`、
  `openclaw/plugin-sdk/channel-pairing`、
  `openclaw/plugin-sdk/channel-contract`、
  `openclaw/plugin-sdk/channel-feedback`、
  `openclaw/plugin-sdk/channel-inbound`、
  `openclaw/plugin-sdk/channel-lifecycle`、
  `openclaw/plugin-sdk/channel-reply-pipeline`、
  `openclaw/plugin-sdk/command-auth`、
  `openclaw/plugin-sdk/secret-input` 和
  `openclaw/plugin-sdk/webhook-ingress`，用于共享设置/认证/回复/webhook
  接线。`channel-inbound` 是共享主页，用于去抖动、提及匹配、
  入站提及策略助手、信封格式化和入站信封
  上下文助手。
  `channel-setup` 是狭窄的可选安装设置接缝。
  `setup-runtime` 是 `setupEntry` /
  延迟启动使用的运行时安全设置表面，包括导入安全的设置补丁适配器。
  `setup-adapter-runtime` 是环境感知的账户设置适配器接缝。
  `setup-tools` 是小 CLI/存档/文档助手接缝（`formatCliCommand`、
  `detectBinary`、`extractArchive`、`resolveBrewExecutable`、`formatDocsLink`、
  `CONFIG_DIR`）。
- 域子路径，如 `openclaw/plugin-sdk/channel-config-helpers`、
  `openclaw/plugin-sdk/allow-from`、
  `openclaw/plugin-sdk/channel-config-schema`、
  `openclaw/plugin-sdk/telegram-command-config`、
  `openclaw/plugin-sdk/channel-policy`、
  `openclaw/plugin-sdk/approval-gateway-runtime`、
  `openclaw/plugin-sdk/approval-handler-adapter-runtime`、
  `openclaw/plugin-sdk/approval-handler-runtime`、
  `openclaw/plugin-sdk/approval-runtime`、
  `openclaw/plugin-sdk/config-runtime`、
  `openclaw/plugin-sdk/infra-runtime`、
  `openclaw/plugin-sdk/agent-runtime`、
  `openclaw/plugin-sdk/lazy-runtime`、
  `openclaw/plugin-sdk/reply-history`、
  `openclaw/plugin-sdk/routing`、
  `openclaw/plugin-sdk/status-helpers`、
  `openclaw/plugin-sdk/text-runtime`、
  `openclaw/plugin-sdk/runtime-store` 和
  `openclaw/plugin-sdk/directory-runtime`，用于共享运行时/配置助手。
  `telegram-command-config` 是 Telegram 自定义
  命令规范化/验证的狭窄公共接缝，即使捆绑的
  Telegram 契约表面暂时不可用，它也保持可用。
  `text-runtime` 是共享文本/Markdown/日志接缝，包括
  助手可见文本剥离、Markdown 渲染/分块助手、编辑
  助手、指令标签助手和安全文本实用程序。
- 特定于批准的通道接缝应在插件上首选一个 `approvalCapability`
  契约。核心然后通过该能力读取批准认证、传递、渲染、
  原生路由和惰性原生处理程序行为，而不是将批准行为混合到不相关的插件字段中。
- `openclaw/plugin-sdk/channel-runtime` 已弃用，仅作为
  较旧插件的兼容性垫片保留。新代码应导入更窄的
  通用原语，并且 repo 代码不应添加垫片的新导入。
- 捆绑扩展内部保持私有。外部插件应仅使用
  `openclaw/plugin-sdk/*` 子路径。OpenClaw 核心/测试代码可以使用插件包根下的 repo
  公共入口点，如 `index.js`、`api.js`、
  `runtime-api.js`、`setup-entry.js` 和狭窄范围的文件，如
  `login-qr-api.js`。永远不要从核心或从
  另一个扩展导入插件包的 `src/*`。
- Repo 入口点拆分：
  `<plugin-package-root>/api.js` 是助手/类型桶，
  `<plugin-package-root>/runtime-api.js` 是仅运行时桶，
  `<plugin-package-root>/index.js` 是捆绑插件入口，
  而 `<plugin-package-root>/setup-entry.js` 是设置插件入口。
- 当前捆绑提供商示例：
  - Anthropic 使用 `api.js` / `contract-api.js` 用于 Claude 流助手，如
    `wrapAnthropicProviderStream`、测试版头助手和 `service_tier`
    解析。
  - OpenAI 使用 `api.js` 用于提供商构建器、默认模型助手和
    实时提供商构建器。
  - OpenRouter 使用 `api.js` 用于其提供商构建器加上引导/配置
    助手，而 `register.runtime.js` 仍然可以重新导出通用
    `plugin-sdk/provider-stream` 助手用于 repo 本地使用。
- 外观加载的公共入口点在存在时首选活动运行时配置快照，
  然后当 OpenClaw 尚未提供运行时快照时回退到磁盘上解析的配置文件。
- 通用共享原语仍然是首选的公共 SDK 契约。一小
  保留的兼容性捆绑通道品牌助手接缝仍然
  存在。将这些视为捆绑维护/兼容性接缝，而不是新
  第三方导入目标；新的跨通道契约仍应落在
  通用 `plugin-sdk/*` 子路径或插件本地 `api.js` /
  `runtime-api.js` 桶上。
- 特定于能力的子路径，如 `image-generation`、
  `media-understanding` 和 `speech` 存在，因为捆绑/原生插件今天使用
  它们。它们的存在本身并不意味着每个导出的助手都是
  长期冻结的外部契约。

兼容性注意事项：

- 避免为新代码使用根 `openclaw/plugin-sdk` 桶。
- 优先选择狭窄的稳定原语。较新的设置/配对/回复/
  反馈/契约/入站/线程/命令/秘密输入/webhook/基础设施/
  允许列表/状态/消息工具子路径是新
  捆绑和外部插件工作的预期契约。
  目标解析/匹配属于 `openclaw/plugin-sdk/channel-targets`。
  消息动作门和反应消息 ID 助手属于
  `openclaw/plugin-sdk/channel-actions`。
- 捆绑扩展特定的助手桶默认不稳定。如果
  助手仅由捆绑扩展需要，将其保持在扩展的
  本地 `api.js` 或 `runtime-api.js` 接缝后面，而不是将其提升到
  `openclaw/plugin-sdk/<extension>`。
- 新的共享助手接缝应该是通用的，而不是通道品牌的。共享目标
  解析属于 `openclaw/plugin-sdk/channel-targets`；通道特定
  内部保持在拥有插件的本地 `api.js` 或 `runtime-api.js`
  接缝后面。
- 特定于能力的子路径，如 `image-generation`、
  `media-understanding` 和 `speech` 存在，因为捆绑/原生插件今天使用
  它们。它们的存在本身并不意味着每个导出的助手都是
  长期冻结的外部契约。

## 消息工具模式

插件应该拥有通道特定的 `describeMessageTool(...)` 模式
贡献。将提供商特定的字段保持在插件中，而不是在共享核心中。

对于共享的可移植模式片段，重用通过
`openclaw/plugin-sdk/channel-actions` 导出的通用助手：

- `createMessageToolButtonsSchema()` 用于按钮网格样式有效负载
- `createMessageToolCardSchema()` 用于结构化卡片有效负载

如果模式形状仅对一个提供商有意义，在该插件的
自己的源代码中定义它，而不是将其提升到共享 SDK 中。

## 通道目标解析

通道插件应该拥有通道特定的目标语义。保持共享
出站主机通用，并为提供商规则使用消息适配器表面：

- `messaging.inferTargetChatType({ to })` 决定在目录查找之前，标准化目标
  是应该被视为 `direct`、`group` 还是 `channel`。
- `messaging.targetResolver.looksLikeId(raw, normalized)` 告诉核心输入是否
  应该跳过直接到类似 ID 的解析，而不是目录搜索。
- `messaging.targetResolver.resolveTarget(...)` 是当
  核心在标准化后或目录
  未命中后需要最终的提供商拥有的解析时的插件回退。
- `messaging.resolveOutboundSessionRoute(...)` 一旦目标被解析，就拥有提供商特定的会话
  路由构建。

推荐的拆分：

- 使用 `inferTargetChatType` 用于应该在
  搜索对等方/组之前发生的类别决策。
- 使用 `looksLikeId` 用于 "将此视为显式/原生目标 ID" 检查。
- 使用 `resolveTarget` 用于提供商特定的标准化回退，而不是用于
  广泛的目录搜索。
- 将提供商原生 ID（如聊天 ID、线程 ID、JID、句柄和房间
  ID）保持在 `target` 值或提供商特定的参数内，而不是在通用 SDK
  字段中。

## 基于配置的目录

从配置派生目录条目的插件应将该逻辑保持在
插件中，并重用来自
`openclaw/plugin-sdk/directory-runtime` 的共享助手。

当通道需要基于配置的对等方/组时使用此功能，例如：

- 允许列表驱动的 DM 对等方
- 配置的通道/组映射
- 账户范围的静态目录回退

`directory-runtime` 中的共享助手仅处理通用操作：

- 查询过滤
- 限制应用
- 去重/标准化助手
- 构建 `ChannelDirectoryEntry[]`

通道特定的账户检查和 ID 规范化应保持在
插件实现中。

## 提供商目录

提供商插件可以使用
`registerProvider({ catalog: { run(...) { ... } } })` 为推理定义模型目录。

`catalog.run(...)` 返回 OpenClaw 写入
`models.providers` 的相同形状：

- `{ provider }` 用于一个提供商条目
- `{ providers }` 用于多个提供商条目

当插件拥有提供商特定的模型 ID、基础 URL
默认值或认证门控模型元数据时使用 `catalog`。

`catalog.order` 控制插件目录相对于 OpenClaw 的
内置隐式提供商的合并时间：

- `simple`：简单的 API 密钥或环境驱动的提供商
- `profile`：当认证配置文件存在时出现的提供商
- `paired`：合成多个相关提供商条目的提供商
- `late`：最后一遍，在其他隐式提供商之后

后来的提供商在键冲突时获胜，因此插件可以有意覆盖
具有相同提供商 ID 的内置提供商条目。

兼容性：

- `discovery` 仍然作为遗留别名工作
- 如果同时注册了 `catalog` 和 `discovery`，OpenClaw 使用 `catalog`

## 只读通道检查

如果你的插件注册了通道，首选实现
`plugin.config.inspectAccount(cfg, accountId)` 以及 `resolveAccount(...)`。

为什么：

- `resolveAccount(...)` 是运行时路径。它允许假设凭证
  完全具体化，并且当缺少必需的秘密时可以快速失败。
- 只读命令路径，如 `openclaw status`、`openclaw status --all`、
  `openclaw channels status`、`openclaw channels resolve` 和医生/配置
  修复流程不应需要具体化运行时凭证，只是为了
  描述配置。

推荐的 `inspectAccount(...)` 行为：

- 仅返回描述性账户状态。
- 保留 `enabled` 和 `configured`。
- 包括相关的凭证源/状态字段，例如：
  - `tokenSource`、`tokenStatus`
  - `botTokenSource`、`botTokenStatus`
  - `appTokenSource`、`appTokenStatus`
  - `signingSecretSource`、`signingSecretStatus`
- 你不需要返回原始令牌值，只是为了报告只读
  可用性。返回 `tokenStatus: "available"`（和匹配的源
  字段）对于状态样式命令足够。
- 当凭证通过 SecretRef 配置但
  在当前命令路径中不可用时，使用 `configured_unavailable`。

这让只读命令报告 "在该命令
路径中配置但不可用"，而不是崩溃或错误报告账户为未配置。

## 包包

插件目录可以包含带有 `openclaw.extensions` 的 `package.json`：

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"],
    "setupEntry": "./src/setup-entry.ts"
  }
}
```

每个条目成为一个插件。如果包列出多个扩展，插件 ID
变为 `name/<fileBase>`。

如果你的插件导入 npm 依赖项，在该目录中安装它们，以便
`node_modules` 可用（`npm install` / `pnpm install`）。

安全护栏：每个 `openclaw.extensions` 条目必须在符号链接解析后保持在插件
目录内。逃离包目录的条目被
拒绝。

安全注意事项：`openclaw plugins install` 安装插件依赖项，使用
`npm install --omit=dev --ignore-scripts`（无生命周期脚本，运行时无开发依赖）。保持插件依赖
树 "纯 JS/TS"，避免需要 `postinstall` 构建的包。

可选：`openclaw.setupEntry` 可以指向轻量级的仅设置模块。
当 OpenClaw 需要禁用通道插件的设置表面，或
当通道插件已启用但仍未配置时，它加载 `setupEntry`
而不是完整的插件条目。这保持启动和设置更轻
当你的主插件条目也连接工具、钩子或其他仅运行时
代码时。

可选：`openclaw.startup.deferConfiguredChannelFullLoadUntilAfterListen`
可以选择让通道插件在网关的
预监听启动阶段进入相同的 `setupEntry` 路径，即使通道已经配置。

仅当 `setupEntry` 完全覆盖必须存在的启动表面时才使用此功能
在网关开始监听之前。实际上，这意味着设置条目
必须注册启动依赖的每个通道拥有的能力，例如：

- 通道注册本身
- 必须在网关开始监听之前可用的任何 HTTP 路由
- 在同一窗口期间必须存在的任何网关方法、工具或服务

如果你的完整条目仍然拥有任何必需的启动能力，请不要启用
此标志。保持插件在默认行为上，让 OpenClaw 在启动期间加载
完整条目。

捆绑通道还可以发布仅设置的契约表面助手，核心
可以在加载完整通道运行时之前咨询。当前的设置
提升表面是：

- `singleAccountKeysToMove`
- `namedAccountPromotionKeys`
- `resolveSingleAccountPromotionTarget(...)`

当核心需要将遗留的单账户通道
配置提升到 `channels.<id>.accounts.*` 而不加载完整的插件条目时，核心使用该表面。
Matrix 是当前的捆绑示例：当命名账户已经存在时，它仅将认证/引导密钥移动到
命名的提升账户中，并且它可以保留
配置的非规范默认账户密钥，而不是总是创建
`accounts.default`。

那些设置补丁适配器保持捆绑契约表面发现惰性。导入
时间保持轻量；提升表面仅在首次使用时加载，而不是在模块导入时重新进入捆绑通道启动。

当那些启动表面包含网关 RPC 方法时，保持它们在
插件特定的前缀上。核心管理命名空间（`config.*`、
`exec.approvals.*`、`wizard.*`、`update.*`）仍然保留，并且始终解析为
`operator.admin`，即使插件请求更窄的作用域。

示例：

```json
{
  "name": "@scope/my-channel",
  "openclaw": {
    "extensions": ["./index.ts"],
    "setupEntry": "./setup-entry.ts",
    "startup": {
      "deferConfiguredChannelFullLoadUntilAfterListen": true
    }
  }
}
```

### 通道目录元数据

通道插件可以通过 `openclaw.channel` 宣传设置/发现元数据，并
通过 `openclaw.install` 安装提示。这保持核心目录无数据。

示例：

```json
{
  "name": "@openclaw/nextcloud-talk",
  "openclaw": {
    "extensions": ["./index.ts"],
    "channel": {
      "id": "nextcloud-talk",
      "label": "Nextcloud Talk",
      "selectionLabel": "Nextcloud Talk (self-hosted)",
      "docsPath": "/channels/nextcloud-talk",
      "docsLabel": "nextcloud-talk",
      "blurb": "Self-hosted chat via Nextcloud Talk webhook bots.",
      "order": 65,
      "aliases": ["nc-talk", "nc"]
    },
    "install": {
      "npmSpec": "@openclaw/nextcloud-talk",
      "localPath": "<bundled-plugin-local-path>",
      "defaultChoice": "npm"
    }
  }
}
```

除了最小示例之外的有用 `openclaw.channel` 字段：

- `detailLabel`：更丰富的目录/状态表面的次要标签
- `docsLabel`：覆盖文档链接的链接文本
- `preferOver`：此目录条目应超越的低优先级插件/通道 ID
- `selectionDocsPrefix`、`selectionDocsOmitLabel`、`selectionExtras`：选择表面副本控件
- `markdownCapable`：将通道标记为 markdown 可用于出站格式化决策
- `exposure.configured`：当设置为 `false` 时，从配置的通道列出表面中隐藏通道
- `exposure.setup`：当设置为 `false` 时，从交互式设置/配置选择器中隐藏通道
- `exposure.docs`：将通道标记为内部/私有，用于文档导航表面
- `showConfigured` / `showInSetup`：为兼容性仍然接受的遗留别名；首选 `exposure`
- `quickstartAllowFrom`：选择通道进入标准快速开始 `allowFrom` 流程
- `forceAccountBinding`：即使只存在一个账户，也需要显式账户绑定
- `preferSessionLookupForAnnounceTarget`：解析公告目标时首选会话查找

OpenClaw 还可以合并**外部通道目录**（例如，MPM
注册表导出）。在以下位置放置 JSON 文件：

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

或将 `OPENCLAW_PLUGIN_CATALOG_PATHS`（或 `OPENCLAW_MPM_CATALOG_PATHS`）指向
一个或多个 JSON 文件（逗号/分号/`PATH` 分隔）。每个文件应
包含 `{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }`。解析器还接受 `"packages"` 或 `"plugins"` 作为 `"entries"` 键的遗留别名。

## 上下文引擎插件

上下文引擎插件拥有会话上下文编排，用于摄取、组装和
压缩。使用
`api.registerContextEngine(id, factory)` 从你的插件注册它们，然后使用
`plugins.slots.contextEngine` 选择活动引擎。

当你的插件需要替换或扩展默认上下文
管道，而不仅仅是添加内存搜索或钩子时，使用此功能。

```ts
import { buildMemorySystemPromptAddition } from "openclaw/plugin-sdk/core";

export default function (api) {
  api.registerContextEngine("lossless-claw", () => ({
    info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
    async ingest() {
      return { ingested: true };
    },
    async assemble({ messages, availableTools, citationsMode }) {
      return {
        messages,
        estimatedTokens: 0,
        systemPromptAddition: buildMemorySystemPromptAddition({
          availableTools: availableTools ?? new Set(),
          citationsMode,
        }),
      };
    },
    async compact() {
      return { ok: true, compacted: false };
    },
  }));
}
```

如果你的引擎**不**拥有压缩算法，保持 `compact()`
实现并显式委托它：

```ts
import {
  buildMemorySystemPromptAddition,
  delegateCompactionToRuntime,
} from "openclaw/plugin-sdk/core";

export default function (api) {
  api.registerContextEngine("my-memory-engine", () => ({
    info: {
      id: "my-memory-engine",
      name: "My Memory Engine",
      ownsCompaction: false,
    },
    async ingest() {
      return { ingested: true };
    },
    async assemble({ messages, availableTools, citationsMode }) {
      return {
        messages,
        estimatedTokens: 0,
        systemPromptAddition: buildMemorySystemPromptAddition({
          availableTools: availableTools ?? new Set(),
          citationsMode,
        }),
      };
    },
    async compact(params) {
      return await delegateCompactionToRuntime(params);
    },
  }));
}
```

## 添加新能力

当插件需要不适合当前 API 的行为时，不要绕过
带有私人访问的插件系统。添加缺失的能力。

推荐的序列：

1. 定义核心契约
   决定核心应该拥有什么共享行为：策略、回退、配置合并、
   生命周期、面向通道的语义和运行时助手形状。
2. 添加类型化插件注册/运行时表面
   使用最小有用的
   类型化能力表面扩展 `OpenClawPluginApi` 和/或 `api.runtime`。
3. 连接核心 + 通道/功能消费者
   通道和功能插件应该通过核心消费新能力，
   而不是直接导入供应商实现。
4. 注册供应商实现
   供应商插件然后针对该能力注册其后端。
5. 添加契约覆盖
   添加测试，使所有权和注册形状随时间保持明确。

这就是 OpenClaw 保持固执己见而不变得硬编码到一个
提供商的世界观的方式。有关具体文件清单和工作示例，请参阅 [能力手册](/tools/capability-cookbook)。

### 能力清单

当你添加新能力时，实现通常应该一起触及这些
表面：

- `src/<capability>/types.ts` 中的核心契约类型
- `src/<capability>/runtime.ts` 中的核心运行器/运行时助手
- `src/plugins/types.ts` 中的插件 API 注册表面
- `src/plugins/registry.ts` 中的插件注册表接线
- 当功能/通道
  插件需要消费它时，`src/plugins/runtime/*` 中的插件运行时暴露
- `src/test-utils/plugin-registration.ts` 中的捕获/测试助手
- `src/plugins/contracts/registry.ts` 中的所有权/契约断言
- `docs/` 中的操作员/插件文档

如果这些表面之一缺失，通常表明能力尚未
完全集成。

### 能力模板

最小模式：

```ts
// core contract
export type VideoGenerationProviderPlugin = {
  id: string;
  label: string;
  generateVideo: (req: VideoGenerationRequest) => Promise<VideoGenerationResult>;
};

// plugin API
api.registerVideoGenerationProvider({
  id: "openai",
  label: "OpenAI",
  async generateVideo(req) {
    return await generateOpenAiVideo(req);
  },
});

// shared runtime helper for feature/channel plugins
const clip = await api.runtime.videoGeneration.generate({
  prompt: "Show the robot walking through the lab.",
  cfg,
});
```

契约测试模式：

```ts
expect(findVideoGenerationProviderIdsForPlugin("openai")).toEqual(["openai"]);
```

这保持规则简单：

- 核心拥有能力契约 + 编排
- 供应商插件拥有供应商实现
- 功能/通道插件消费运行时助手
- 契约测试保持所有权明确
