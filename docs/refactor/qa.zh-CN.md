# QA 重构

状态：基础迁移已完成。

## 目标

将 OpenClaw QA 从拆分定义模型迁移到单一事实来源：

- 场景元数据
- 发送给模型的提示
- 设置和拆卸
- 测试框架逻辑
- 断言和成功标准
- 工件和报告提示

期望的最终状态是一个通用 QA 测试框架，它加载强大的场景定义文件，而不是在 TypeScript 中硬编码大多数行为。

## 当前状态

主要事实来源现在位于 `qa/scenarios/index.md` 以及 `qa/scenarios/<theme>/*.md` 下的每个场景文件。

已实现：

- `qa/scenarios/index.md`
  - 规范 QA 包元数据
  - 操作员身份
  - 启动任务
- `qa/scenarios/<theme>/*.md`
  - 每个场景一个 markdown 文件
  - 场景元数据
  - 处理程序绑定
  - 场景特定的执行配置
- `extensions/qa-lab/src/scenario-catalog.ts`
  - markdown 包解析器 + zod 验证
- `extensions/qa-lab/src/qa-agent-bootstrap.ts`
  - 从 markdown 包渲染计划
- `extensions/qa-lab/src/qa-agent-workspace.ts`
  - 生成兼容性文件以及 `QA_SCENARIOS.md`
- `extensions/qa-lab/src/suite.ts`
  - 通过 markdown 定义的处理程序绑定选择可执行场景
- QA 总线协议 + UI
  - 用于图像/视频/音频/文件渲染的通用内联附件

剩余的拆分表面：

- `extensions/qa-lab/src/suite.ts`
  - 仍然拥有大多数可执行的自定义处理程序逻辑
- `extensions/qa-lab/src/report.ts`
  - 仍然从运行时输出派生报告结构

因此，事实来源的拆分已修复，但执行仍然主要由处理程序支持，而不是完全声明式的。

## 真实场景表面看起来像什么

阅读当前套件显示几个不同的场景类别。

### 简单交互

- 频道基线
- DM 基线
- 线程跟进
- 模型切换
- 批准跟进
- 反应/编辑/删除

### 配置和运行时变更

- 配置补丁技能禁用
- 配置应用重启唤醒
- 配置重启能力翻转
- 运行时清单漂移检查

### 文件系统和仓库断言

- 源/文档发现报告
- 构建 Lobster Invaders
- 生成的图像工件查找

### 内存编排

- 内存召回
- 频道上下文中的内存工具
- 内存失败回退
- 会话内存排名
- 线程内存隔离
- 内存做梦扫描

### 工具和插件集成

- MCP 插件工具调用
- 技能可见性
- 技能热安装
- 原生图像生成
- 图像往返
- 附件的图像理解

### 多轮和多参与者

- 子代理交接
- 子代理扇出合成
- 重启恢复样式流程

这些类别很重要，因为它们驱动 DSL 要求。提示 + 预期文本的扁平列表是不够的。

## 方向

### 单一事实来源

使用 `qa/scenarios/index.md` 加上 `qa/scenarios/<theme>/*.md` 作为创作的事实来源。

该包应保持：

- 审查时人类可读
- 机器可解析
- 足够丰富以驱动：
  - 套件执行
  - QA 工作区引导
  - QA Lab UI 元数据
  - 文档/发现提示
  - 报告生成

### 首选创作格式

使用 markdown 作为顶层格式，内部使用结构化 YAML。

推荐形状：

- YAML 前置元数据
  - id
  - title
  - surface
  - tags
  - docs refs
  - code refs
  - model/provider 覆盖
  - 先决条件
- 散文部分
  - objective
  - notes
  - debugging hints
- 围栏 YAML 块
  - setup
  - steps
  - assertions
  - cleanup

这提供：

- 比巨大的 JSON 更好的 PR 可读性
- 比纯 YAML 更丰富的上下文
- 严格的解析和 zod 验证

原始 JSON 仅作为中间生成形式是可接受的。

## 提议的场景文件形状

示例：

````md
---
id: image-generation-roundtrip
title: Image generation roundtrip
surface: image
tags: [media, image, roundtrip]
models:
  primary: openai/gpt-5.4
requires:
  tools: [image_generate]
  plugins: [openai, qa-channel]
docsRefs:
  - docs/help/testing.md
  - docs/concepts/model-providers.md
codeRefs:
  - extensions/qa-lab/src/suite.ts
  - src/gateway/chat-attachments.ts
---

# Objective

Verify generated media is reattached on the follow-up turn.

# Setup

```yaml scenario.setup
- action: config.patch
  patch:
    agents:
      defaults:
        imageGenerationModel:
          primary: openai/gpt-image-1
- action: session.create
  key: agent:qa:image-roundtrip
```

# Steps

```yaml scenario.steps
- action: agent.send
  session: agent:qa:image-roundtrip
  message: |
    Image generation check: generate a QA lighthouse image and summarize it in one short sentence.
- action: artifact.capture
  kind: generated-image
  promptSnippet: Image generation check
  saveAs: lighthouseImage
- action: agent.send
  session: agent:qa:image-roundtrip
  message: |
    Roundtrip image inspection check: describe the generated lighthouse attachment in one short sentence.
  attachments:
    - fromArtifact: lighthouseImage
```

# Expect

```yaml scenario.expect
- assert: outbound.textIncludes
  value: lighthouse
- assert: requestLog.matches
  where:
    promptIncludes: Roundtrip image inspection check
  imageInputCountGte: 1
- assert: artifact.exists
  ref: lighthouseImage
```
````

## DSL 必须覆盖的运行器能力

基于当前套件，通用运行器需要的不仅仅是提示执行。

### 环境和设置操作

- `bus.reset`
- `gateway.waitHealthy`
- `channel.waitReady`
- `session.create`
- `thread.create`
- `workspace.writeSkill`

### 代理轮次操作

- `agent.send`
- `agent.wait`
- `bus.injectInbound`
- `bus.injectOutbound`

### 配置和运行时操作

- `config.get`
- `config.patch`
- `config.apply`
- `gateway.restart`
- `tools.effective`
- `skills.status`

### 文件和工件操作

- `file.write`
- `file.read`
- `file.delete`
- `file.touchTime`
- `artifact.captureGeneratedImage`
- `artifact.capturePath`

### 内存和定时任务操作

- `memory.indexForce`
- `memory.searchCli`
- `doctor.memory.status`
- `cron.list`
- `cron.run`
- `cron.waitCompletion`
- `sessionTranscript.write`

### MCP 操作

- `mcp.callTool`

### 断言

- `outbound.textIncludes`
- `outbound.inThread`
- `outbound.notInRoot`
- `tool.called`
- `tool.notPresent`
- `skill.visible`
- `skill.disabled`
- `file.contains`
- `memory.contains`
- `requestLog.matches`
- `sessionStore.matches`
- `cron.managedPresent`
- `artifact.exists`

## 变量和工件引用

DSL 必须支持保存的输出和后续引用。

当前套件的示例：

- 创建线程，然后重用 `threadId`
- 创建会话，然后重用 `sessionKey`
- 生成图像，然后在下一轮附加文件
- 生成唤醒标记字符串，然后断言它稍后出现

所需能力：

- `saveAs`
- `${vars.name}`
- `${artifacts.name}`
- 路径、会话键、线程 ID、标记、工具输出的类型化引用

没有变量支持，测试框架将继续将场景逻辑泄漏回 TypeScript。

## 应该保留为逃生舱口的内容

在第 1 阶段，完全纯声明式运行器是不现实的。

有些场景本质上是重编排的：

- 内存做梦扫描
- 配置应用重启唤醒
- 配置重启能力翻转
- 按时间戳/路径生成图像工件解析
- 发现报告评估

这些现在应该使用显式自定义处理程序。

推荐规则：

- 85-90% 声明式
- 硬剩余部分使用显式 `customHandler` 步骤
- 仅命名和记录的自定义处理程序
- 场景文件中没有匿名内联代码

这保持了通用引擎的清洁，同时仍然允许进展。

## 架构变更

### 当前

场景 markdown 已经是以下内容的事实来源：

- 套件执行
- 工作区引导文件
- QA Lab UI 场景目录
- 报告元数据
- 发现提示

生成的兼容性：

- 种子工作区仍然包括 `QA_KICKOFF_TASK.md`
- 种子工作区仍然包括 `QA_SCENARIO_PLAN.md`
- 种子工作区现在还包括 `QA_SCENARIOS.md`

## 重构计划

### 阶段 1：加载器和模式

已完成。

- 添加了 `qa/scenarios/index.md`
- 将场景拆分为 `qa/scenarios/<theme>/*.md`
- 添加了命名 markdown YAML 包内容的解析器
- 用 zod 验证
- 将消费者切换到解析的包
- 删除了仓库级 `qa/seed-scenarios.json` 和 `qa/QA_KICKOFF_TASK.md`

### 阶段 2：通用引擎

- 将 `extensions/qa-lab/src/suite.ts` 拆分为：
  - 加载器
  - 引擎
  - 操作注册表
  - 断言注册表
  - 自定义处理程序
- 将现有辅助函数保留为引擎操作

可交付成果：

- 引擎执行简单的声明式场景

从主要是提示 + 等待 + 断言的场景开始：

- 线程跟进
- 附件的图像理解
- 技能可见性和调用
- 频道基线

可交付成果：

- 第一个真正的 markdown 定义的场景通过通用引擎交付

### 阶段 4：迁移中等场景

- 图像生成往返
- 频道上下文中的内存工具
- 会话内存排名
- 子代理交接
- 子代理扇出合成

可交付成果：

- 变量、工件、工具断言、请求日志断言得到证明

### 阶段 5：将硬场景保持在自定义处理程序上

- 内存做梦扫描
- 配置应用重启唤醒
- 配置重启能力翻转
- 运行时清单漂移

可交付成果：

- 相同的创作格式，但在需要时使用显式自定义步骤块

### 阶段 6：删除硬编码场景映射

一旦包覆盖足够好：

- 从 `extensions/qa-lab/src/suite.ts` 中移除大多数场景特定的 TypeScript 分支

## 假 Slack / 富媒体支持

当前的 QA 总线是文本优先的。

相关文件：

- `extensions/qa-channel/src/protocol.ts`
- `extensions/qa-lab/src/bus-state.ts`
- `extensions/qa-lab/src/bus-queries.ts`
- `extensions/qa-lab/src/bus-server.ts`
- `extensions/qa-lab/web/src/ui-render.ts`

今天 QA 总线支持：

- 文本
- 反应
- 线程

它尚未建模内联媒体附件。

### 所需的传输契约

添加通用 QA 总线附件模型：

```ts
type QaBusAttachment = {
  id: string;
  kind: "image" | "video" | "audio" | "file";
  mimeType: string;
  fileName?: string;
  inline?: boolean;
  url?: string;
  contentBase64?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  altText?: string;
  transcript?: string;
};
```

然后将 `attachments?: QaBusAttachment[]` 添加到：

- `QaBusMessage`
- `QaBusInboundMessageInput`
- `QaBusOutboundMessageInput`

### 为什么首先是通用

不要构建仅 Slack 的媒体模型。

相反：

- 一个通用 QA 传输模型
- 多个渲染器在其上
  - 当前 QA Lab 聊天
  - 未来的假 Slack 网页
  - 任何其他假传输视图

这可以防止重复逻辑，并让媒体场景保持传输无关。

### 需要的 UI 工作

更新 QA UI 以渲染：

- 内联图像预览
- 内联音频播放器
- 内联视频播放器
- 文件附件芯片

当前 UI 已经可以渲染线程和反应，因此附件渲染应该层叠到相同的消息卡片模型上。

### 媒体传输启用的场景工作

一旦附件通过 QA 总线流动，我们可以添加更丰富的假聊天场景：

- 在假 Slack 中内联图像回复
- 音频附件理解
- 视频附件理解
- 混合附件排序
- 保留媒体的线程回复

## 建议

下一个实现块应该是：

1. 添加 markdown 场景加载器 + zod 模式
2. 从 markdown 生成当前目录
3. 首先迁移一些简单场景
4. 添加通用 QA 总线附件支持
5. 在 QA UI 中渲染内联图像
6. 然后扩展到音频和视频

这是证明两个目标的最小路径：

- 通用 markdown 定义的 QA
- 更丰富的假消息表面

## 开放问题

- 场景文件是否应该允许带有变量插值的嵌入式 markdown 提示模板
- 设置/清理是否应该是命名部分或只是有序操作列表
- 工件引用是否应该在模式中强类型化或基于字符串
- 自定义处理程序是否应该位于一个注册表或每个表面注册表中
- 在迁移期间，生成的 JSON 兼容性文件是否应该保持签入