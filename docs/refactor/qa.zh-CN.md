# QA 重构

状态：基础迁移已落地。

## 目标

将 OpenClaw QA 从分裂定义模型移动到单一事实来源：

- 场景元数据
- 发送到模型的提示
- 设置和拆卸
- 工具逻辑
- 断言和成功标准
- 工件和报告提示

期望的最终状态是一个通用 QA 工具，它加载强大的场景定义文件，而不是在 TypeScript 中硬编码大多数行为。

## 当前状态

主要事实来源现在位于 `qa/scenarios/index.md` 以及 `qa/scenarios/<theme>/*.md` 下的每个场景文件。

已实现：

- `qa/scenarios/index.md`
  - 规范的 QA 包元数据
  - 操作者身份
  - 启动任务
- `qa/scenarios/<theme>/*.md`
  - 每个场景一个 Markdown 文件
  - 场景元数据
  - 处理器绑定
  - 场景特定的执行配置
- `extensions/qa-lab/src/scenario-catalog.ts`
  - Markdown 包解析器 + zod 验证
- `extensions/qa-lab/src/qa-agent-bootstrap.ts`
  - 从 Markdown 包渲染计划
- `extensions/qa-lab/src/qa-agent-workspace.ts`
  - 播种生成的兼容性文件 + `QA_SCENARIOS.md`
- `extensions/qa-lab/src/suite.ts`
  - 通过 Markdown 定义的处理器绑定选择可执行场景
- QA 总线协议 + UI
  - 用于图像/视频/音频/文件渲染的通用内联附件

剩余的分裂表面：

- `extensions/qa-lab/src/suite.ts`
  - 仍然拥有大多数可执行自定义处理器逻辑
- `extensions/qa-lab/src/report.ts`
  - 仍然从运行时输出生成报告结构

所以事实来源分裂已经修复，但执行仍然主要是处理器支持的，而不是完全声明式的。

## 真实场景表面的样子

阅读当前套件会显示一些不同的场景类别。

### 简单交互

- 频道基线
- DM 基线
- 线程跟进
- 模型切换
- 审批跟进
- 反应/编辑/删除

### 配置和运行时修改

- 配置补丁技能禁用
- 配置应用重启唤醒
- 配置重启功能切换
- 运行时库存漂移检查

### 文件系统和仓库断言

- 源/文档发现报告
- 构建龙虾入侵者
- 生成的图像工件查找

### 记忆编排

- 记忆回忆
- 频道上下文中的记忆工具
- 记忆失败回退
- 会话记忆排名
- 线程记忆隔离
- 记忆做梦扫描

### 工具和插件集成

- MCP 插件工具调用
- 技能可见性
- 技能热安装
- 本机图像生成
- 图像往返
- 从附件理解图像

### 多回合和多参与者

- 子代理移交
- 子代理扇出合成
- 重启恢复风格流程

这些类别很重要，因为它们驱动了 DSL 要求。一个简单的提示 + 预期文本列表是不够的。

## 方向

### 单一事实来源

使用 `qa/scenarios/index.md` 加上 `qa/scenarios/<theme>/*.md` 作为编写的事实来源。

包应该保持：

- 在审阅中人类可读
- 机器可解析
- 足够丰富以驱动：
  - 套件执行
  - QA 工作区引导
  - QA Lab UI 元数据
  - 文档/发现提示
  - 报告生成

### 首选编写格式

使用 Markdown 作为顶层格式，其中包含结构化 YAML。

推荐的形状：

- YAML 前置元数据
  - id
  - title
  - surface
  - tags
  - docs refs
  - code refs
  - 模型/提供者覆盖
  - 先决条件
- 散文部分
  - objective
  - notes
  - debugging hints
- 带围栏的 YAML 块
  - setup
  - steps
  - assertions
  - cleanup

这给出：

- 比巨大的 JSON 更好的 PR 可读性
- 比纯 YAML 更丰富的上下文
- 严格的解析和 zod 验证

原始 JSON 仅可作为中间生成形式。

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

验证生成的媒体在跟进回合中重新附加。

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

## DSL 必须覆盖的工具功能

基于当前套件，通用工具需要的不仅仅是提示执行。

### 环境和设置操作

- `bus.reset`
- `gateway.waitHealthy`
- `channel.waitReady`
- `session.create`
- `thread.create`
- `workspace.writeSkill`

### 代理回合操作

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

### 记忆和定时任务操作

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

当前套件中的示例：

- 创建线程，然后重用 `threadId`
- 创建会话，然后重用 `sessionKey`
- 生成图像，然后在下一回合附加文件
- 生成唤醒标记字符串，然后断言它稍后出现

需要的功能：

- `saveAs`
- `${vars.name}`
- `${artifacts.name}`
- 路径、会话键、线程 ID、标记、工具输出的类型化引用

没有变量支持，工具将继续将场景逻辑泄漏回 TypeScript。

## 应该保留为紧急出口的内容

在阶段 1 中，完全纯粹的声明式工具是不现实的。

一些场景本质上是编排密集型的：

- 记忆做梦扫描
- 配置应用重启唤醒
- 配置重启功能切换
- 按时间戳/路径生成的图像工件解析
- 发现报告评估

这些现在应该使用明确的自定义处理器。

推荐规则：

- 85-90% 声明式
- 困难剩余部分的显式 `customHandler` 步骤
- 仅命名和文档化的自定义处理器
- 场景文件中没有匿名内联代码

这保持通用引擎干净，同时仍然允许进步。

## 架构变更

### 当前

场景 Markdown 已经是以下内容的事实来源：

- 套件执行
- 工作区引导文件
- QA Lab UI 场景目录
- 报告元数据
- 发现提示

生成的兼容性：

- 播种的工作区仍包含 `QA_KICKOFF_TASK.md`
- 播种的工作区仍包含 `QA_SCENARIO_PLAN.md`
- 播种的工作区现在还包含 `QA_SCENARIOS.md`

## 重构计划

### 阶段 1：加载器和架构

已完成。

- 添加了 `qa/scenarios/index.md`
- 将场景拆分为 `qa/scenarios/<theme>/*.md`
- 添加了命名 Markdown YAML 包内容的解析器
- 用 zod 验证
- 将使用者切换到解析的包
- 删除了仓库级别的 `qa/seed-scenarios.json` 和 `qa/QA_KICKOFF_TASK.md`

### 阶段 2：通用引擎

- 将 `extensions/qa-lab/src/suite.ts` 拆分为：
  - loader
  - engine
  - action registry
  - assertion registry
  - custom handlers
- 保持现有的辅助函数作为引擎操作

可交付成果：

- 引擎执行简单的声明式场景

从主要是提示 + 等待 + 断言的场景开始：

- 线程跟进
- 从附件理解图像
- 技能可见性和调用
- 频道基线

可交付成果：

- 通过通用引擎交付的第一个真实的 Markdown 定义场景

### 阶段 4：迁移中等场景

- 图像生成往返
- 频道上下文中的记忆工具
- 会话记忆排名
- 子代理移交
- 子代理扇出合成

可交付成果：

- 变量、工件、工具断言、请求日志断言证明出来

### 阶段 5：将困难场景保留在自定义处理器上

- 记忆做梦扫描
- 配置应用重启唤醒
- 配置重启功能切换
- 运行时库存漂移

可交付成果：

- 相同的编写格式，但在需要时有明确的自定义步骤块

### 阶段 6：删除硬编码的场景映射

一旦包覆盖足够好：

- 从 `extensions/qa-lab/src/suite.ts` 中删除大多数特定于场景的 TypeScript 分支

## 假 Slack / 富媒体支持

当前 QA 总线是文本优先的。

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

### 需要的传输契约

添加一个通用的 QA 总线附件模型：

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

### 为什么首先是通用的

不要构建仅 Slack 的媒体模型。

而是：

- 一个通用的 QA 传输模型
- 在它上面有多个渲染器
  - 当前 QA Lab 聊天
  - 未来的假 Slack 网页
  - 任何其他假传输视图

这防止了重复逻辑，并使媒体场景保持传输无关。

### 需要的 UI 工作

更新 QA UI 以渲染：

- 内联图像预览
- 内联音频播放器
- 内联视频播放器
- 文件附件芯片

当前 UI 已经可以渲染线程和反应，所以附件渲染应该分层到相同的消息卡模型上。

### 通过媒体传输启用的场景工作

一旦附件通过 QA 总线流动，我们可以添加更丰富的假聊天场景：

- 假 Slack 中的内联图像回复
- 音频附件理解
- 视频附件理解
- 混合附件排序
- 保留媒体的线程回复

## 建议

下一个实现块应该是：

1. 添加 Markdown 场景加载器 + zod 架构
2. 从 Markdown 生成当前目录
3. 首先迁移几个简单场景
4. 添加通用 QA 总线附件支持
5. 在 QA UI 中渲染内联图像
6. 然后扩展到音频和视频

这是证明两个目标的最小路径：

- 通用 Markdown 定义的 QA
- 更丰富的假消息传递表面

## 开放问题

- 场景文件是否应该允许具有变量插值的嵌入式 Markdown 提示模板
- 设置/清理是否应该是命名部分或只是有序的动作列表
- 工件引用是否应该在架构中强类型或基于字符串
- 自定义处理器是否应该存在于一个注册表中或每个表面的注册表中
- 在迁移期间，生成的 JSON 兼容性文件是否应该保持签入
