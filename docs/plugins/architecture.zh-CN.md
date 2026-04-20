---
summary: "插件内部结构：能力模型、所有权、契约、加载流程和运行时助手"
read_when:
  - 构建或调试原生 OpenClaw 插件
  - 理解插件能力模型或所有权边界
  - 处理插件加载流程或注册表
  - 实现提供者运行时钩子或通道插件
title: "插件内部结构"
sidebarTitle: "内部结构"
---

# 插件内部结构

<Info>
  这是**深度架构参考**。对于实用指南，请参阅：
  - [安装和使用插件](/tools/plugin) — 用户指南
  - [入门](/plugins/building-plugins) — 第一个插件教程
  - [通道插件](/plugins/sdk-channel-plugins) — 构建消息通道
  - [提供者插件](/plugins/sdk-provider-plugins) — 构建模型提供者
  - [SDK 概述](/plugins/sdk-overview) — 导入映射和注册 API
</Info>

本页面介绍 OpenClaw 插件系统的内部架构。

## 公共能力模型

能力是 OpenClaw 内部的公共**原生插件**模型。每个
原生 OpenClaw 插件都会针对一个或多个能力类型进行注册：

| 能力 | 注册方法 | 示例插件 |

|------------ | ------------------------------------------------ | ------------------------------------|

| 文本推理 |`api.registerProvider(...)`|`openai`、`anthropic`|

| CLI 推理后端 |`api.registerCliBackend(...)`|`openai`、`anthropic`|

| 语音 |`api.registerSpeechProvider(...)`|`elevenlabs`、`microsoft`|

| 实时转录 |`api.registerRealtimeTranscriptionProvider(...)`|`openai`|

| 实时语音 |`api.registerRealtimeVoiceProvider(...)`|`openai`|

| 媒体理解 |`api.registerMediaUnderstandingProvider(...)`|`openai`、`google`|

| 图像生成 |`api.registerImageGenerationProvider(...)`|`openai`、`google`、`fal`、`minimax`|

| 音乐生成 |`api.registerMusicGenerationProvider(...)`|`google`、`minimax`|

| 视频生成 |`api.registerVideoGenerationProvider(...)`|`qwen`|

| 网络获取 |`api.registerWebFetchProvider(...)`|`firecrawl`|

| 网络搜索 |`api.registerWebSearchProvider(...)`|`google`|

| 通道/消息 |`api.registerChannel(...)`|`msteams`、`matrix`|

注册零个能力但提供钩子、工具或
服务的插件是**仅遗留钩子**插件。这种模式仍然完全受支持。

### 外部兼容性立场

能力模型已在核心中落地并被捆绑/原生插件使用
今天，但外部插件兼容性仍然需要比"它被导出，因此它被冻结"更严格的标准。

当前指导：

- **现有的外部插件**：保持基于钩子的集成正常工作；将此视为兼容性基线
- **新的捆绑/原生插件**：优先选择显式能力注册，而不是
  供应商特定的侵入或新的仅钩子设计
- **采用能力注册的外部插件**：允许，但将
  能力特定的助手表面视为正在发展，除非文档明确将契约标记为稳定

实用规则：

- 能力注册 API 是预期方向
- 遗留钩子在过渡期间仍然是外部插件最安全的无中断路径
- 导出的助手子路径并不都是平等的；优先选择狭窄的文档化契约，而不是附带的助手导出

### 插件形状

OpenClaw 根据插件的实际注册行为（而不仅仅是静态元数据）将每个加载的插件分类为一种形状：

- **纯能力** -- 注册恰好一种能力类型（例如仅限提供者的插件，如`mistral`）
- **混合能力** -- 注册多种能力类型（例如`openai`拥有文本推理、语音、媒体理解和图像生成）
- **仅钩子** -- 仅注册钩子（类型化或自定义），无能力、工具、命令或服务
- **非能力** -- 注册工具、命令、服务或路由，但无能力

使用`openclaw plugins inspect <id>`查看插件的形状和能力细分。有关详细信息，请参阅 [CLI 参考](/cli/plugins#inspect)。

### 遗留钩子`before_agent_start`钩子作为仅钩子插件的兼容路径仍然受支持。遗留的真实世界插件仍然依赖它。

方向：

- 保持它正常工作
- 将其记录为遗留
- 优先使用`before_model_resolve`进行模型/提供者覆盖工作
- 优先使用`before_prompt_build`进行提示突变工作
- 仅在实际使用下降且夹具覆盖证明迁移安全性后才移除

### 兼容性信号

当您运行`openclaw doctor`或`openclaw plugins inspect <id>`时，您可能会看到以下标签之一：

| 信号 | 含义 |

|-------------------------- | ----------------------------------------------|

| **config valid** | 配置解析良好且插件解析成功 |

| **compatibility advisory** | 插件使用受支持但较旧的模式（例如`hook-only`） |

| **legacy warning** | 插件使用已弃用的`before_agent_start`|

| **hard error** | 配置无效或插件加载失败 |

今天，`hook-only`和`before_agent_start`都不会破坏您的插件 --`hook-only`是 advisory，而`before_agent_start`只会触发警告。这些信号也会出现在`openclaw status --all`和`openclaw plugins doctor`中。

## 架构概述

OpenClaw 的插件系统有四个层次：

1. **清单 + 发现**
   OpenClaw 从配置路径、工作区根目录、
   全局扩展根目录和捆绑扩展中查找候选插件。发现首先读取原生`openclaw.plugin.json`清单以及支持的捆绑清单。
2. **启用 + 验证**
   核心决定发现的插件是启用、禁用、阻塞还是
   为独占插槽（如内存）选择。
3. **运行时加载**
   原生 OpenClaw 插件通过 jiti 进程内加载并注册
   能力到中央注册表中。兼容的捆绑包被规范化为
   注册表记录，而不导入运行时代码。
4. **表面消费**
   OpenClaw 的其余部分读取注册表以公开工具、通道、提供者
   设置、钩子、HTTP 路由、CLI 命令和服务。

对于插件 CLI 具体而言，根命令发现分为两个阶段：

- 解析时元数据来自`registerCli(..., { descriptors: [...] })`- 真正的插件 CLI 模块可以保持惰性并在首次调用时注册

这样可以将插件拥有的 CLI 代码保留在插件内部，同时仍允许 OpenClaw
在解析之前保留根命令名称。

重要的设计边界：

- 发现 + 配置验证应该从**清单/模式元数据**工作
  无需执行插件代码
- 原生运行时行为来自插件模块的`register(api)`路径

这种分离让 OpenClaw 可以在完整运行时激活之前验证配置、解释缺失/禁用的插件并构建 UI/模式提示。

### 通道插件和共享消息工具

通道插件不需要为正常的聊天操作注册单独的发送/编辑/反应工具。OpenClaw 在核心中保留一个共享的`message`工具，而
通道插件拥有其背后的通道特定发现和执行。

当前边界是：

- 核心拥有共享的`message`工具主机、提示接线、会话/线程
  记账和执行调度
- 通道插件拥有作用域操作发现、能力发现以及任何
  通道特定的模式片段
- 通道插件拥有提供者特定的会话对话语法，例如
  对话 ID 如何编码线程 ID 或从父对话继承
- 通道插件通过其动作适配器执行最终动作

对于通道插件，SDK 表面是`ChannelMessageActionAdapter.describeMessageTool(...)`。这个统一的发现
调用允许插件一起返回其可见的动作、能力和模式
贡献，这样这些部分就不会脱节。

当特定于通道的消息工具参数携带媒体源（如
本地路径或远程媒体 URL）时，插件还应从`describeMessageTool(...)`返回`mediaSourceParams`。核心使用这个明确的
列表来应用沙盒路径规范化和出站媒体访问提示
而无需硬编码插件拥有的参数名称。
优先使用那里的动作作用域映射，而不是一个通道范围的平面列表，这样
仅配置文件的媒体参数就不会在`send`等无关动作上被规范化。

核心将运行时作用域传递到该发现步骤中。重要字段包括：

-`accountId`-`currentChannelId`-`currentThreadTs`-`currentMessageId`-`sessionKey`-`sessionId`-`agentId`- 受信任的入站`requesterSenderId`这对于上下文敏感的插件很重要。通道可以根据活动账户、当前房间/线程/消息或
受信任的请求者身份来隐藏或公开
消息动作，而无需在
核心`message`工具中硬编码通道特定的分支。

这就是为什么嵌入式运行器路由更改仍然是插件工作的原因：运行器负责
将当前聊天/会话身份转发到插件
发现边界，以便共享的`message`工具为当前回合公开正确的通道拥有的
表面。

对于通道拥有的执行助手，捆绑插件应将执行
运行时保持在其自己的扩展模块内。核心不再拥有 Discord、
Slack、Telegram 或 WhatsApp 消息动作运行时，它们位于`src/agents/tools`下。
我们不发布单独的`plugin-sdk/*-action-runtime`子路径，捆绑
插件应直接从其
扩展拥有的模块导入自己的本地运行时代码。

同样的边界也适用于一般的提供者命名 SDK 接缝：核心不应导入 Slack、Discord、Signal、
WhatsApp 或类似扩展的通道特定便利桶。如果核心需要某种行为，要么消费
捆绑插件自己的`api.ts`/`runtime-api.ts`桶，要么将需求提升
为共享 SDK 中的狭窄通用能力。

对于轮询，有两条执行路径：

-`outbound.sendPoll`是适合常见轮询模型的通道的共享基线 -`actions.handleAction("poll")`是通道特定轮询语义或额外轮询参数的首选路径

核心现在会推迟共享轮询解析，直到插件轮询调度拒绝该动作，这样插件拥有的轮询处理程序就可以接受通道特定的轮询
字段，而不会首先被通用轮询解析器阻止。

有关完整的启动序列，请参阅[加载流程](#加载流程)。

## 能力所有权模型

OpenClaw 将原生插件视为**公司**或**功能**的所有权边界，而不是无关集成的集合。

这意味着：

- 公司插件通常应拥有该公司所有面向 OpenClaw 的
  表面
- 功能插件通常应拥有它引入的完整功能表面
- 通道应消费共享核心能力，而不是临时重新实现
  提供者行为

示例：

- 捆绑的`openai`插件拥有 OpenAI 模型提供者行为和 OpenAI
  语音 + 实时语音 + 媒体理解 + 图像生成行为
- 捆绑的`elevenlabs`插件拥有 ElevenLabs 语音行为
- 捆绑的`microsoft`插件拥有 Microsoft 语音行为
- 捆绑的`google`插件拥有 Google 模型提供者行为以及 Google
  媒体理解 + 图像生成 + 网络搜索行为
- 捆绑的`firecrawl`插件拥有 Firecrawl 网络获取行为
- 捆绑的`minimax`、`mistral`、`moonshot`和`zai`插件拥有它们的
  媒体理解后端
- 捆绑的`qwen`插件拥有 Qwen 文本提供者行为以及
  媒体理解和视频生成行为 -`voice-call`插件是一个功能插件：它拥有呼叫传输、工具、
  CLI、路由和 Twilio 媒体流桥接，但它消费共享语音
  加上实时转录和实时语音能力，而不是直接导入供应商插件

预期的最终状态是：

- OpenAI 生活在一个插件中，即使它跨越文本模型、语音、图像和
  未来的视频
- 另一个供应商可以为自己的表面积做同样的事情
- 通道不关心哪个供应商插件拥有提供者；它们消费核心公开的共享能力契约

这是关键区别：

- **插件** = 所有权边界
- **能力** = 多个插件可以实现或消费的核心契约

因此，如果 OpenClaw 添加新领域（如视频），第一个问题不是
"哪个提供者应该硬编码视频处理？"第一个问题是"核心视频能力契约是什么？"一旦该契约存在，供应商插件
可以针对它注册，通道/功能插件可以消费它。

如果能力尚不存在，通常正确的做法是：

1. 在核心中定义缺失的能力
2. 通过插件 API/运行时以类型化方式公开它
3. 针对该能力连接通道/功能
4. 让供应商插件注册实现

这在保持所有权明确的同时，避免了依赖于单个供应商或一次性插件特定代码路径的核心行为。

### 能力分层

在决定代码所属位置时使用此心智模型：

- **核心能力层**：共享编排、策略、回退、配置
  合并规则、传递语义和类型化契约
- **供应商插件层**：供应商特定的 API、认证、模型目录、语音
  合成、图像生成、未来视频后端、使用端点
- **通道/功能插件层**：Slack/Discord/voice-call/etc. 集成
  消费核心能力并在表面上呈现它们

例如，TTS 遵循这种形状：

- 核心拥有回复时间 TTS 策略、回退顺序、首选项和通道传递 -`openai`、`elevenlabs`和`microsoft`拥有合成实现 -`voice-call`消费电话 TTS 运行时助手

未来能力应优先采用相同的模式。

### 多能力公司插件示例

从外部看，公司插件应该感觉连贯。如果 OpenClaw 对模型、语音、实时转录、实时语音、媒体
理解、图像生成、视频生成、网络获取和网络搜索有共享
契约，供应商可以在一个地方拥有其所有表面：```ts
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

export default plugin;```重要的不是确切的助手名称。形状很重要：

- 一个插件拥有供应商表面
- 核心仍然拥有能力契约
- 通道和功能插件消费`api.runtime.*`助手，而不是供应商代码
- 契约测试可以断言插件注册了它声称拥有的能力

### 能力示例：视频理解

OpenClaw 已经将图像/音频/视频理解视为一个共享
能力。同样的所有权模型也适用于此：

1. 核心定义媒体理解契约
2. 供应商插件注册`describeImage`、`transcribeAudio`和`describeVideo`（如适用）
3. 通道和功能插件消费共享核心行为，而不是
   直接连接到供应商代码

这避免了将一个提供者的视频假设烘焙到核心中。插件拥有
供应商表面；核心拥有能力契约和回退行为。

视频生成已经使用相同的序列：核心拥有类型化
能力契约和运行时助手，供应商插件针对它注册`api.registerVideoGenerationProvider(...)`实现。

需要具体的推出清单？请参阅
[能力 cookbook](/tools/capability-cookbook)。

## 契约和强制执行

插件 API 表面在`OpenClawPluginApi`中有意类型化和集中化。该契约定义了支持的注册点和
插件可以依赖的运行时助手。

为什么这很重要：

- 插件作者获得一个稳定的内部标准
- 核心可以拒绝重复所有权，例如两个插件注册相同的
  提供者 ID
- 启动可以为格式错误的注册显示可操作的诊断
- 契约测试可以强制执行捆绑插件所有权并防止静默漂移

有两层强制执行：

1. **运行时注册强制执行**
   插件注册表在插件加载时验证注册。例如：
   重复的提供者 ID、重复的语音提供者 ID 和格式错误的
   注册会产生插件诊断，而不是未定义的行为。
2. **契约测试**
   捆绑插件在测试运行期间被捕获在契约注册表中，因此
   OpenClaw 可以明确断言所有权。今天，这用于模型
   提供者、语音提供者、网络搜索提供者和捆绑注册
   所有权。

实际效果是，OpenClaw 预先知道哪个插件拥有哪个
表面。这让核心和通道无缝组合，因为所有权是
声明的、类型化的和可测试的，而不是隐式的。

### 契约中应包含什么

好的插件契约是：

- 类型化的
- 小的
- 能力特定的
- 由核心拥有
- 可被多个插件重用
- 可被通道/功能消费，无需供应商知识

坏的插件契约是：

- 隐藏在核心中的供应商特定策略
- 绕过注册表的一次性插件逃生舱口
- 直接进入供应商实现的通道代码
- 不是`OpenClawPluginApi`或`api.runtime`一部分的临时运行时对象

如有疑问，提高抽象级别：首先定义能力，然后
让插件插入其中。

## 执行模型

原生 OpenClaw 插件与网关**进程内**运行。它们不是
沙盒化的。加载的原生插件与核心代码具有相同的进程级信任边界。

含义：

- 原生插件可以注册工具、网络处理程序、钩子和服务
- 原生插件错误可能会崩溃或使网关不稳定
- 恶意原生插件等同于 OpenClaw 进程内的任意代码执行

兼容的捆绑包默认更安全，因为 OpenClaw 目前将它们视为元数据/内容包。在当前版本中，这主要意味着捆绑的技能。

对非捆绑插件使用允许列表和显式安装/加载路径。将工作区插件视为开发时代码，而不是生产默认值。

对于捆绑工作区包名称，保持插件 ID 锚定在 npm
名称中：默认情况下为`@openclaw/<id>`，或当
包有意暴露更窄的插件角色时，使用批准的类型化后缀，如`-provider`、`-plugin`、`-speech`、`-sandbox`或`-media-understanding`。

重要的信任说明：

-`plugins.allow`信任**插件 ID**，而不是源来源。

- 与捆绑插件具有相同 ID 的工作区插件在该工作区插件启用/允许时会有意遮蔽
  捆绑副本。
- 这对于本地开发、补丁测试和热修复是正常且有用的。

## 导出边界

OpenClaw 导出能力，而不是实现便利。

保持能力注册公开。修剪非契约助手导出：

- 捆绑插件特定的助手子路径
- 不旨在作为公共 API 的运行时管道子路径
- 供应商特定的便利助手
- 作为实现细节的设置/入职助手

一些捆绑插件助手子路径仍然保留在生成的 SDK 导出
映射中，以保持兼容性和捆绑插件维护。当前示例包括`plugin-sdk/feishu`、`plugin-sdk/feishu-setup`、`plugin-sdk/zalo`、`plugin-sdk/zalo-setup`和几个`plugin-sdk/matrix*`接缝。将这些视为
保留的实现细节导出，而不是新第三方插件的推荐 SDK 模式。

## 加载流程

在启动时，OpenClaw 大致执行以下操作：

1. 发现候选插件根目录
2. 读取原生或兼容的捆绑清单和包元数据
3. 拒绝不安全的候选
4. 规范化插件配置（`plugins.enabled`、`allow`、`deny`、`entries`、`slots`、`load.paths`）
5. 决定每个候选的启用
6. 通过 jiti 加载启用的原生模块
7. 调用原生`register(api)`（或`activate(api)`— 遗留别名）钩子并将注册收集到插件注册表中
8. 向命令/运行时表面公开注册表

<Note>`activate`是`register`的遗留别名 — 加载器解析存在的任何一个（`def.register ?? def.activate`）并在同一点调用它。所有捆绑插件都使用`register`；新插件首选`register`。
</Note>

安全门在**运行时执行之前**发生。当入口逃离插件根目录、路径是世界可写的，或非捆绑插件的路径所有权看起来可疑时，候选会被阻止。

### 清单优先行为

清单是控制平面的事实来源。OpenClaw 使用它来：

- 识别插件
- 发现声明的通道/技能/配置模式或捆绑能力
- 验证`plugins.entries.<id>.config`- 增强 Control UI 标签/占位符
- 显示安装/目录元数据
- 保留廉价的激活和设置描述符，无需加载插件运行时

对于原生插件，运行时模块是数据平面部分。它注册
实际行为，如钩子、工具、命令或提供者流程。

可选的清单`activation`和`setup`块保留在控制平面上。
它们是激活规划和设置发现的仅元数据描述符；
它们不会替换运行时注册、`register(...)`或`setupEntry`。
第一批实时激活消费者现在使用清单命令、通道和提供者提示
在更广泛的注册表具体化之前缩小插件加载范围：

- CLI 加载缩小到拥有请求的主要命令的插件
- 通道设置/插件解析缩小到拥有请求的
  通道 ID 的插件
- 显式提供者设置/运行时解析缩小到拥有请求的
  提供者 ID 的插件

设置发现现在首选描述符拥有的 ID，如`setup.providers`和`setup.cliBackends`来缩小候选插件，然后才回退到`setup-api`用于仍然需要设置时运行时钩子的插件。如果多个发现的插件声称相同的规范化设置提供者或 CLI 后端
ID，设置查找会拒绝模糊的所有者，而不是依赖发现
顺序。

### 加载器缓存什么

OpenClaw 保留短时间的进程内缓存：

- 发现结果
- 清单注册表数据
- 加载的插件注册表

这些缓存减少了突发启动和重复命令开销。它们可以安全地视为短期性能缓存，而不是持久性。

性能说明：

- 设置`OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE=1`或`OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE=1`禁用这些缓存。
- 使用`OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS`和`OPENCLAW_PLUGIN_MANIFEST_CACHE_MS`调整缓存窗口。

## 注册表模型

加载的插件不会直接改变随机核心全局变量。它们注册到中央插件注册表中。

注册表跟踪：

- 插件记录（身份、源、来源、状态、诊断）
- 工具
- 遗留钩子和类型化钩子
- 通道
- 提供者
- 网关 RPC 处理程序
- HTTP 路由
- CLI 注册商
- 后台服务
- 插件拥有的命令

然后核心功能从该注册表读取，而不是直接与插件模块通信。这保持加载单向：

- 插件模块 -> 注册表注册
- 核心运行时 -> 注册表消费

这种分离对可维护性很重要。这意味着大多数核心表面只需要一个集成点："读取注册表"，而不是"为每个插件模块设置特殊情况"。

## 对话绑定回调

绑定对话的插件可以在批准解决时做出反应。

使用`api.onConversationBindingResolved(...)`在绑定
请求被批准或拒绝后接收回调：```ts
export default {
id: "my-plugin",
register(api) {
api.onConversationBindingResolved(async (event) => {
if (event.status === "approved") {
// A binding now exists for this plugin + conversation.
console.log(event.binding?.conversationId);
return;
}

      // The request was denied; clear any local pending state.
      console.log(event.request.conversation.conversationId);
    });

},
};```回调有效载荷字段：

-`status`：`"approved"`或`"denied"`-`decision`：`"allow-once"`、`"allow-always"`或`"deny"`-`binding`：已批准请求的已解决绑定 -`request`：原始请求摘要、分离提示、发送者 ID 和
对话元数据

此回调仅用于通知。它不会改变谁被允许绑定
对话，并且在核心批准处理完成后运行。

## 提供者运行时钩子

提供者插件现在有两层：

- 清单元数据：`providerAuthEnvVars`用于在运行时加载之前进行廉价的提供者环境认证查找，`providerAuthAliases`用于共享
  认证的提供者变体，`channelEnvVars`用于在运行时
  加载之前进行廉价的通道环境/设置查找，以及`providerAuthChoices`用于在运行时加载之前进行廉价的入职/认证选择标签和
  CLI 标志元数据
- 配置时钩子：`catalog`/ 遗留`discovery`加上`applyConfigDefaults`- 运行时钩子：`normalizeModelId`、`normalizeTransport`、`normalizeConfig`、`applyNativeStreamingUsageCompat`、`resolveConfigApiKey`、`resolveSyntheticAuth`、`resolveExternalAuthProfiles`、`shouldDeferSyntheticProfileAuth`、`resolveDynamicModel`、`prepareDynamicModel`、`normalizeResolvedModel`、`contributeResolvedModelCompat`、`capabilities`、`normalizeToolSchemas`、`inspectToolSchemas`、`resolveReasoningOutputMode`、`prepareExtraParams`、`createStreamFn`、`wrapStreamFn`、`resolveTransportTurnState`、`resolveWebSocketSessionPolicy`、`formatApiKey`、`refreshOAuth`、`buildAuthDoctorHint`、`matchesContextOverflowError`、`classifyFailoverReason`、`isCacheTtlEligible`、`buildMissingAuthMessage`、`suppressBuiltInModel`、`augmentModelCatalog`、`isBinaryThinking`、`supportsXHighThinking`、`resolveDefaultThinkingLevel`、`isModernModelRef`、`prepareRuntimeAuth`、`resolveUsageAuth`、`fetchUsageSnapshot`、`createEmbeddingProvider`、`buildReplayPolicy`、`sanitizeReplayHistory`、`validateReplayTurns`、`onModelSelected`OpenClaw 仍然拥有通用代理循环、故障转移、转录处理和
  工具策略。这些钩子是提供者特定行为的扩展表面，无需
  整个自定义推理传输。

当提供者具有基于环境的凭据时使用清单`providerAuthEnvVars`，这些凭据
通用认证/状态/模型选择器路径应该看到，无需加载插件
运行时。当一个提供者 ID 应该重用
另一个提供者 ID 的环境变量、认证配置文件、基于配置的认证和 API 密钥
入职选择时，使用清单`providerAuthAliases`。当入职/认证选择
CLI 表面应该知道提供者的选择 ID、组标签和简单
单标志认证接线，无需加载提供者运行时，使用清单`providerAuthChoices`。保持提供者运行时`envVars`用于操作员面向的提示，如入职标签或 OAuth
客户端 ID/客户端密钥设置变量。

当通道具有环境驱动的认证或设置时使用清单`channelEnvVars`，这些
通用 shell 环境回退、配置/状态检查或设置提示应该看到
无需加载通道运行时。

### 钩子顺序和使用

对于模型/提供者插件，OpenClaw 按此大致顺序调用钩子。
"何时使用"列是快速决策指南。

| # | 钩子 | 它做什么 | 何时使用 |

|--- | --------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------|

| 1 |`catalog`| 在`models.json`生成期间将提供者配置发布到`models.providers`| 提供者拥有目录或基本 URL 默认值 |

| 2 |`applyConfigDefaults`| 在配置具体化期间应用提供者拥有的全局配置默认值 | 默认值取决于认证模式、环境或提供者模型系列语义 |

| -- | _(built-in model lookup)_ | OpenClaw 首先尝试正常的注册表/目录路径 | _(not a plugin hook)_ |

| 3 |`normalizeModelId`| 在查找之前规范化遗留或预览模型 ID 别名 | 提供者拥有别名清理，然后进行规范模型解析 |

| 4 |`normalizeTransport`| 在通用模型组装之前规范化提供者系列`api`/`baseUrl`| 提供者拥有同一传输系列中自定义提供者 ID 的传输清理 |

| 5 |`normalizeConfig`| 在运行时/提供者解析之前规范化`models.providers.<id>`| 提供者需要应该与插件一起存在的配置清理；捆绑的 Google 系列助手也支持支持的 Google 配置条目 |

| 6 |`applyNativeStreamingUsageCompat`| 对配置提供者应用原生流式使用兼容性重写 | 提供者需要端点驱动的原生流式使用元数据修复 |

| 7 |`resolveConfigApiKey`| 在运行时认证加载之前解析配置提供者的环境标记认证 | 提供者具有提供者拥有的环境标记 API 密钥解析；`amazon-bedrock`在此处也有内置的 AWS 环境标记解析器 |

| 8 |`resolveSyntheticAuth`| 显示本地/自托管或基于配置的认证，而不持久化明文 | 提供者可以使用合成/本地凭证标记操作 |

| 9 |`resolveExternalAuthProfiles`| 覆盖提供者拥有的外部认证配置文件；默认`persistence`为 CLI/应用拥有凭证的`runtime-only`| 提供者重用外部认证凭证，而不持久化复制的刷新令牌 |

| 10 |`shouldDeferSyntheticProfileAuth`| 将存储的合成配置文件占位符置于环境/配置支持的认证之后 | 提供者存储不应该优先的合成占位符配置文件 |

| 11 |`resolveDynamicModel`| 对尚未在本地注册表中的提供者拥有的模型 ID 进行同步回退 | 提供者接受任意上游模型 ID |

| 12 |`prepareDynamicModel`| 异步预热，然后`resolveDynamicModel`再次运行 | 提供者需要网络元数据才能解析未知 ID |

| 13 |`normalizeResolvedModel`| 在嵌入式运行器使用解析的模型之前进行最终重写 | 提供者需要传输重写但仍使用核心传输 |

| 14 |`contributeResolvedModelCompat`| 为另一个兼容传输后面的供应商模型贡献兼容标志 | 提供者在代理传输上识别自己的模型，而不接管提供者 |

| 15 |`capabilities`| 提供者拥有的转录/工具元数据，由共享核心逻辑使用 | 提供者需要转录/提供者系列怪癖 |

| 16 |`normalizeToolSchemas`| 在嵌入式运行器看到工具模式之前对其进行规范化 | 提供者需要传输系列模式清理 |

| 17 |`inspectToolSchemas`| 在规范化后显示提供者拥有的模式诊断 | 提供者希望在不教授核心提供者特定规则的情况下发出关键字警告 |

| 18 |`resolveReasoningOutputMode`| 选择原生与标记推理输出契约 | 提供者需要标记推理/最终输出而不是原生字段 |

| 19 |`prepareExtraParams`| 在通用流选项包装器之前请求参数规范化 | 提供者需要默认请求参数或每个提供者参数清理 |

| 20 |`createStreamFn`| 用自定义传输完全替换正常的流路径 | 提供者需要自定义有线协议，而不仅仅是包装器 |

| 21 |`wrapStreamFn`| 在应用通用包装器后进行流包装 | 提供者需要请求头/体/模型兼容包装器，无需自定义传输 |

| 22 |`resolveTransportTurnState`| 附加原生每回合传输头或元数据 | 提供者希望通用传输发送提供者原生回合身份 |

| 23 |`resolveWebSocketSessionPolicy`| 附加原生 WebSocket 头或会话冷却策略 | 提供者希望通用 WS 传输调整会话头或回退策略 |

| 24 |`formatApiKey`| 认证配置文件格式化器：存储的配置文件成为运行时`apiKey`字符串 | 提供者存储额外的认证元数据并需要自定义运行时令牌形状 |

| 25 |`refreshOAuth`| 用于自定义刷新端点或刷新失败策略的 OAuth 刷新覆盖 | 提供者不适合共享的`pi-ai`刷新器 |

| 26 |`buildAuthDoctorHint`| 当 OAuth 刷新失败时附加的修复提示 | 提供者需要提供者拥有的认证修复指导，在刷新失败后 |

| 27 |`matchesContextOverflowError`| 提供者拥有的上下文窗口溢出匹配器 | 提供者有原始溢出错误，通用启发式会错过 |

| 28 |`classifyFailoverReason`| 提供者拥有的故障转移原因分类 | 提供者可以将原始 API/传输错误映射到速率限制/过载等 |

| 29 |`isCacheTtlEligible`| 代理/回程提供者的提示缓存策略 | 提供者需要代理特定的缓存 TTL 门控 |

| 30 |`buildMissingAuthMessage`| 通用缺失认证恢复消息的替代品 | 提供者需要提供者特定的缺失认证恢复提示 |

| 31 |`suppressBuiltInModel`| 过时的上游模型抑制加上可选的用户面向错误提示 | 提供者需要隐藏过时的上游行或用供应商提示替换它们 |

| 32 |`augmentModelCatalog`| 发现后附加的合成/最终目录行 | 提供者需要`models list`和选择器中的合成前向兼容行 |

| 33 |`isBinaryThinking`| 二元思考提供者的开/关推理切换 | 提供者仅暴露二元思考开/关 |

| 34 |`supportsXHighThinking`| 所选模型的`xhigh`推理支持 | 提供者希望仅在模型子集上启用`xhigh`|

| 35 |`resolveDefaultThinkingLevel`| 特定模型系列的默认`/think`级别 | 提供者拥有模型系列的默认`/think`策略 |

| 36 |`isModernModelRef`| 实时配置文件过滤器和烟雾选择的现代模型匹配器 | 提供者拥有实时/烟雾首选模型匹配 |

| 37 |`prepareRuntimeAuth`| 在推理之前将配置的凭证交换为实际的运行时令牌/密钥 | 提供者需要令牌交换或短期请求凭证 |

| 38 |`resolveUsageAuth`| 为`/usage`和相关状态表面解析使用/计费凭证 | 提供者需要自定义使用/配额令牌解析或不同的使用凭证 |

| 39 |`fetchUsageSnapshot`| 在认证解析后获取并规范化提供者特定的使用/配额快照 | 提供者需要提供者特定的使用端点或有效负载解析器 |

| 40 |`createEmbeddingProvider`| 为内存/搜索构建提供者拥有的嵌入适配器 | 内存嵌入行为属于提供者插件 |

| 41 |`buildReplayPolicy`| 返回控制提供者转录处理的重放策略 | 提供者需要自定义转录策略（例如，思维块剥离） |

| 42 |`sanitizeReplayHistory`| 在通用转录清理后重写重放历史 | 提供者需要提供者特定的重放重写，超出共享压缩助手 |

| 43 |`validateReplayTurns`| 在嵌入式运行器之前进行最终重放回合验证或重塑 | 提供者传输需要在通用卫生后进行更严格的回合验证 |
| 44 |`onModelSelected`| 运行提供者拥有的选择后副作用 | 当模型变为活动时，提供者需要遥测或提供者拥有的状态 |`normalizeModelId`、`normalizeTransport`和`normalizeConfig`首先检查
匹配的提供者插件，然后通过其他具有钩子能力的提供者插件，直到一个实际更改模型 ID 或传输/配置。这保持
别名/兼容提供者垫片工作，而不需要调用者知道哪个
捆绑插件拥有重写。如果没有提供者钩子重写支持的
Google 系列配置条目，捆绑的 Google 配置规范化器仍然应用
该兼容性清理。

如果提供者需要完全自定义的有线协议或自定义请求执行器，
那是不同类别的扩展。这些钩子用于提供者行为
仍在 OpenClaw 的正常推理循环上运行。

### 提供者示例```ts

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
baseUrl: "<https://proxy.example.com/v1>",
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
baseUrl: "<https://proxy.example.com/v1>",
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
});```### 内置示例

- Anthropic 使用`resolveDynamicModel`、`capabilities`、`buildAuthDoctorHint`、`resolveUsageAuth`、`fetchUsageSnapshot`、`isCacheTtlEligible`、`resolveDefaultThinkingLevel`、`applyConfigDefaults`、`isModernModelRef`和`wrapStreamFn`，因为它拥有 Claude 4.6 前向兼容、
  提供者系列提示、认证修复指导、使用端点集成、
  提示缓存资格、认证感知配置默认值、Claude
  默认/自适应思维策略，以及 Anthropic 特定的流塑造，用于
  测试版头、`/fast`/`serviceTier`和`context1m`。
- Anthropic 的 Claude 特定流助手暂时保留在捆绑插件自己的
  公共`api.ts`/`contract-api.ts`接缝中。该包表面
  导出`wrapAnthropicProviderStream`、`resolveAnthropicBetas`、`resolveAnthropicFastMode`、`resolveAnthropicServiceTier`以及更低级别的
  Anthropic 包装器构建器，而不是围绕一个
  提供者的测试版头规则扩大通用 SDK。
- OpenAI 使用`resolveDynamicModel`、`normalizeResolvedModel`和`capabilities`以及`buildMissingAuthMessage`、`suppressBuiltInModel`、`augmentModelCatalog`、`supportsXHighThinking`和`isModernModelRef`因为它拥有 GPT-5.4 前向兼容、直接 OpenAI`openai-completions`->`openai-responses`规范化、Codex 感知认证
  提示、Spark 抑制、合成 OpenAI 列表行，以及 GPT-5 思维 /
  实时模型策略；`openai-responses-defaults`流系列拥有
  共享的原生 OpenAI Responses 包装器，用于归因头、`/fast`/`serviceTier`、文本详细程度、原生 Codex 网络搜索、
  推理兼容有效载荷塑造，以及 Responses 上下文管理。
- OpenRouter 使用`catalog`以及`resolveDynamicModel`和`prepareDynamicModel`，因为提供者是传递的，可能会在 OpenClaw 的静态目录更新之前公开新的
  模型 ID；它还使用`capabilities`、`wrapStreamFn`和`isCacheTtlEligible`来保持
  提供者特定的请求头、路由元数据、推理补丁和
  提示缓存策略不在核心中。其重放策略来自`passthrough-gemini`系列，而`openrouter-thinking`流系列
  拥有代理推理注入和不支持的模型 /`auto`跳过。
- GitHub Copilot 使用`catalog`、`auth`、`resolveDynamicModel`和`capabilities`以及`prepareRuntimeAuth`和`fetchUsageSnapshot`，因为它
  需要提供者拥有的设备登录、模型回退行为、Claude 转录
  怪癖、GitHub 令牌 -> Copilot 令牌交换，以及提供者拥有的使用
  端点。
- OpenAI Codex 使用`catalog`、`resolveDynamicModel`、`normalizeResolvedModel`、`refreshOAuth`和`augmentModelCatalog`以及`prepareExtraParams`、`resolveUsageAuth`和`fetchUsageSnapshot`，因为它
  仍在核心 OpenAI 传输上运行，但拥有其传输/基本 URL
  规范化、OAuth 刷新回退策略、默认传输选择、
  合成 Codex 目录行，以及 ChatGPT 使用端点集成；它
  与直接 OpenAI 共享相同的`openai-responses-defaults`流系列。
- Google AI Studio 和 Gemini CLI OAuth 使用`resolveDynamicModel`、`buildReplayPolicy`、`sanitizeReplayHistory`、`resolveReasoningOutputMode`、`wrapStreamFn`和`isModernModelRef`，因为`google-gemini`重放系列拥有 Gemini 3.1 前向兼容回退、
  原生 Gemini 重放验证、引导重放卫生、标记
  推理输出模式，以及现代模型匹配，而`google-thinking`流系列拥有 Gemini 思维有效载荷规范化；
  Gemini CLI OAuth 还使用`formatApiKey`、`resolveUsageAuth`和`fetchUsageSnapshot`进行令牌格式化、令牌解析和配额端点
  接线。
- Anthropic Vertex 通过`anthropic-by-model`重放系列使用`buildReplayPolicy`，因此 Claude 特定的重放清理保持
  范围限定为 Claude ID，而不是每个`anthropic-messages`传输。
- Amazon Bedrock 使用`buildReplayPolicy`、`matchesContextOverflowError`、`classifyFailoverReason`和`resolveDefaultThinkingLevel`，因为它拥有
  Bedrock 特定的节流/未就绪/上下文溢出错误分类
  用于 Bedrock 上的 Anthropic 流量；其重放策略仍共享相同的
  仅限 Claude 的`anthropic-by-model`保护。
- OpenRouter、Kilocode、Opencode 和 Opencode Go 通过`passthrough-gemini`重放系列使用`buildReplayPolicy`，因为它们通过 OpenAI 兼容的传输代理 Gemini
  模型，并且需要 Gemini
  思维签名卫生，无需原生 Gemini 重放验证或
  引导重写。
- MiniMax 通过`hybrid-anthropic-openai`重放系列使用`buildReplayPolicy`，因为一个提供者拥有 Anthropic 消息和 OpenAI 兼容语义；它在 Anthropic 侧保持 Claude 专用
  思维块删除，同时将推理
  输出模式覆盖回原生，而`minimax-fast-mode`流系列拥有
  共享流路径上的快速模式模型重写。
- Moonshot 使用`catalog`加上`wrapStreamFn`，因为它仍使用共享
  OpenAI 传输，但需要提供者拥有的思维有效载荷规范化；`moonshot-thinking`流系列将配置加上`/think`状态映射到其
  原生二元思维有效载荷。
- Kilocode 使用`catalog`、`capabilities`、`wrapStreamFn`和`isCacheTtlEligible`，因为它需要提供者拥有的请求头、
  推理有效载荷规范化、Gemini 转录提示，以及 Anthropic
  缓存 TTL 门控；`kilocode-thinking`流系列在共享代理流路径上保持 Kilo 思维
  注入，同时跳过`kilo/auto`和
  其他不支持显式推理有效载荷的代理模型 ID。
- Z.AI 使用`resolveDynamicModel`、`prepareExtraParams`、`wrapStreamFn`、`isCacheTtlEligible`、`isBinaryThinking`、`isModernModelRef`、`resolveUsageAuth`和`fetchUsageSnapshot`，因为它拥有 GLM-5 回退、`tool_stream`默认值、二元思维 UX、现代模型匹配，以及两者
