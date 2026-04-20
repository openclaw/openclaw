---
summary: "向 OpenClaw 插件系统添加新共享能力的贡献者指南"
read_when:
  - 添加新的核心能力和插件注册表面
  - 决定代码是属于核心、供应商插件还是功能插件
  - 为通道或工具连接新的运行时助手
title: "添加能力（贡献者指南）"
sidebarTitle: "添加能力"
---

# 添加能力

<Info>
  这是面向 OpenClaw 核心开发者的**贡献者指南**。如果你正在构建外部插件，请参阅[构建插件](/plugins/building-plugins)。
</Info>

当 OpenClaw 需要新的领域（如图像生成、视频生成或未来的供应商支持的功能领域）时使用此指南。

规则：

- 插件 = 所有权边界
- 能力 = 共享核心契约

这意味着你不应该通过直接将供应商连接到通道或工具开始。首先定义能力。

## 何时创建能力

当所有这些都为真时，创建新能力：

1. 多个供应商可以合理地实现它
2. 通道、工具或功能插件应该使用它而不关心供应商
3. 核心需要拥有回退、策略、配置或交付行为

如果工作仅针对供应商且尚无共享契约，请停止并首先定义契约。

## 标准序列

1. 定义类型化核心契约。
2. 为该契约添加插件注册。
3. 添加共享运行时助手。
4. 连接一个真实的供应商插件作为证明。
5. 将功能/通道消费者移至运行时助手。
6. 添加契约测试。
7. 记录面向操作员的配置和所有权模型。

## 内容放置

核心：

- 请求/响应类型
- 提供者注册表 + 解析
- 回退行为
- 配置架构，加上在嵌套对象、通配符、数组项和组合节点上传播的 `title` / `description` 文档元数据
- 运行时助手表面

供应商插件：

- 供应商 API 调用
- 供应商身份验证处理
- 供应商特定的请求规范化
- 能力实现的注册

功能/通道插件：

- 调用 `api.runtime.*` 或匹配的 `plugin-sdk/*-runtime` 助手
- 从不直接调用供应商实现

## 文件清单

对于新能力，预计会涉及这些区域：

- `src/<capability>/types.ts`
- `src/<capability>/...registry/runtime.ts`
- `src/plugins/types.ts`
- `src/plugins/registry.ts`
- `src/plugins/captured-registration.ts`
- `src/plugins/contracts/registry.ts`
- `src/plugins/runtime/types-core.ts`
- `src/plugins/runtime/index.ts`
- `src/plugin-sdk/<capability>.ts`
- `src/plugin-sdk/<capability>-runtime.ts`
- 一个或多个捆绑的插件包
- 配置/文档/测试

## 示例：图像生成

图像生成遵循标准结构：

1. 核心定义 `ImageGenerationProvider`
2. 核心暴露 `registerImageGenerationProvider(...)`
3. 核心暴露 `runtime.imageGeneration.generate(...)`
4. `openai`、`google`、`fal` 和 `minimax` 插件注册供应商支持的实现
5. 未来的供应商可以注册相同的契约，而无需更改通道/工具

配置键与视觉分析路由分开：

- `agents.defaults.imageModel` = 分析图像
- `agents.defaults.imageGenerationModel` = 生成图像

保持这些分开，以便回退和策略保持明确。

## 审查清单

在发布新能力之前，验证：

- 没有通道/工具直接导入供应商代码
- 运行时助手是共享路径
- 至少有一个契约测试断言捆绑的所有权
- 配置文档命名新的模型/配置键
- 插件文档解释所有权边界

如果 PR 跳过能力层并将供应商行为硬编码到通道/工具中，请将其退回并首先定义契约。