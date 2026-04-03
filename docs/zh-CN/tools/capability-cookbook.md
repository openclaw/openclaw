---
summary: "向 OpenClaw 插件系统添加新共享功能的贡献者指南"
read_when:
  - 添加新的核心功能和插件注册接口
  - 决定代码是属于核心、供应商插件还是功能插件
  - 为渠道或工具连接新的运行时辅助程序
title: "添加功能（贡献者指南）"
sidebarTitle: "添加功能"
---

# 添加功能

<Info>
  这是 OpenClaw 核心开发人员的**贡献者指南**。如果您正在构建外部插件，请改参阅 [构建插件](/plugins/building-plugins)。
</Info>

当 OpenClaw 需要新领域（如图像生成、视频生成或某些未来供应商支持的功能区域）时使用。

规则：

- 插件 = 所有权边界
- 功能 = 共享核心契约

这意味着您不应该从将供应商直接连接到渠道或工具开始。应该从定义功能开始。

## 何时创建功能

当满足以下所有条件时创建新功能：

1. 多个供应商可以合理地实现它
2. 渠道、工具或功能插件应该消费它而不关心供应商
3. 核心需要拥有后备、策略、配置或传递行为

如果工作仅是供应商特定的且尚不存在共享契约，请停下来先定义契约。

## 标准顺序

1. 定义类型化的核心契约。
2. 为该契约添加插件注册。
3. 添加共享运行时辅助程序。
4. 连接一个真正的供应商插件作为证明。
5. 将功能/渠道消费者转移到运行时辅助程序。
6. 添加契约测试。
7. 记录面向操作员的配置和所有权模型。

## 什么放在哪里

核心：

- 请求/响应类型
- 提供商注册表 + 解析
- 后备行为
- 配置模式和标签/帮助
- 运行时辅助程序表面

供应商插件：

- 供应商 API 调用
- 供应商认证处理
- 供应商特定的请求规范化
- 功能实现的注册

功能/渠道插件：

- 调用 `api.runtime.*` 或匹配的 `plugin-sdk/*-runtime` 辅助程序
- 永不直接调用供应商实现

## 文件检查清单

对于新功能，期望触及这些区域：

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
- 一个或多个 `extensions/<vendor>/...`
- config/docs/tests

## 示例：图像生成

图像生成遵循标准形状：

1. 核心定义 `ImageGenerationProvider`
2. 核心暴露 `registerImageGenerationProvider(...)`
3. 核心暴露 `runtime.imageGeneration.generate(...)`
4. `openai` 和 `google` 插件注册供应商支持实现
5. 未来供应商可以注册相同契约而无需更改渠道/工具

配置键与视觉分析路由分开：

- `agents.defaults.imageModel` = 分析图像
- `agents.defaults.imageGenerationModel` = 生成图像

保持这些分开，以便后备和策略保持明确。

## 审查检查清单

在发布新功能之前，验证：

- 没有渠道/工具直接导入供应商代码
- 运行时辅助程序是共享路径
- 至少一个契约测试断言捆绑所有权
- 配置文档命名新模型/配置键
- 插件文档解释所有权边界

如果 PR 跳过功能层并将供应商行为硬编码到渠道/工具中，请将其退回并首先定义契约。