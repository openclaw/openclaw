---
last_updated: "2026-01-19"
owner: openclaw
status: draft
summary: 计划：添加 OpenResponses /v1/responses 端点并干净地弃用 chat completions
title: OpenResponses Gateway 网关计划
x-i18n:
  generated_at: "2026-02-03T07:47:33Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 71a22c48397507d1648b40766a3153e420c54f2a2d5186d07e51eb3d12e4636a
  source_path: experiments/plans/openresponses-gateway.md
  workflow: 15
---

# OpenResponses Gateway 网关集成计划

## 背景

OpenClaw Gateway 网关目前在 `/v1/chat/completions` 暴露了一个最小的 OpenAI 兼容 Chat Completions 端点（参见 [OpenAI Chat Completions](/gateway/openai-http-api)）。

Open Responses 是基于 OpenAI Responses API 的开放推理标准。它专为智能体工作流设计，使用基于项目的输入加语义流式事件。OpenResponses 规范定义的是 `/v1/responses`，而不是 `/v1/chat/completions`。

## 目标

- 添加一个遵循 OpenResponses 语义的 `/v1/responses` 端点。
- 保留 Chat Completions 作为兼容层，易于禁用并最终移除。
- 使用隔离的、可复用的 schema 标准化验证和解析。

## 非目标

- 第一阶段完全实现 OpenResponses 功能（图片、文件、托管工具）。
- 替换内部智能体执行逻辑或工具编排。
- 在第一阶段更改现有的 `/v1/chat/completions` 行为。

## 研究摘要

来源：OpenResponses OpenAPI、OpenResponses 规范网站和 Hugging Face 博客文章。

提取的关键点：

- `POST /v1/responses` 接受 `CreateResponseBody` 字段，如 `model`、`input`（字符串或 `ItemParam[]`）、`instructions`、`tools`、`tool_choice`、`stream`、`max_output_tokens` 和 `max_tool_calls`。
- `ItemParam` 是以下类型的可区分联合：
  - 具有角色 `system`、`developer`、`user`、`assistant` 的 `message` 项
  - `function_call` 和 `function_call_output`
  - `reasoning`
  - `item_reference`
- 成功响应返回带有 `object: "response"`、`status` 和 `output` 项的 `ResponseResource`。
- 流式传输使用语义事件，如：
  - `response.created`、`response.in_progress`、`response.completed`、`response.failed`
  - `response.output_item.added`、`response.output_item.done`
  - `response.content_part.added`、`response.content_part.done`
  - `response.output_text.delta`、`response.output_text.done`
- 规范要求：
  - `Content-Type: text/event-stream`
  - `event:` 必须匹配 JSON `type` 字段
  - 终止事件必须是字面量 `[DONE]`
- Reasoning 项可能暴露 `content`、`encrypted_content` 和 `summary`。
- HF 示例在请求中包含 `OpenResponses-Version: latest`（可选头部）。

## 提议的架构

- 添加 `src/gateway/open-responses.schema.ts`，仅包含 Zod schema（无 gateway 导入）。
- 添加 `src/gateway/openresponses-http.ts`（或 `open-responses-http.ts`）用于 `/v1/responses`。
- 保持 `src/gateway/openai-http.ts` 不变，作为遗留兼容适配器。
- 添加配置 `gateway.http.endpoints.responses.enabled`（默认 `false`）。
- 保持 `gateway.http.endpoints.chatCompletions.enabled` 独立；允许两个端点分别切换。
- 当 Chat Completions 启用时发出启动警告，以表明其遗留状态。

## Chat Completions 弃用路径

- 保持严格的模块边界：responses 和 chat completions 之间不共享 schema 类型。
- 通过配置使 Chat Completions 成为可选，这样无需代码更改即可禁用。
- 一旦 `/v1/responses` 稳定，更新文档将 Chat Completions 标记为遗留。
- 可选的未来步骤：将 Chat Completions 请求映射到 Responses 处理器，以便更简单地移除。

## 第一阶段支持子集

- 接受 `input` 为字符串或带有消息角色和 `function_call_output` 的 `ItemParam[]`。
- 将 system 和 developer 消息提取到 `extraSystemPrompt` 中。
- 使用最近的 `user` 或 `function_call_output` 作为智能体运行的当前消息。
- 对不支持的内容部分（图片/文件）返回 `invalid_request_error` 拒绝。
- 返回带有 `output_text` 内容的单个助手消息。
- 返回带有零值的 `usage`，直到 token 计数接入。

## 验证策略（无 SDK）

- 为以下支持子集实现 Zod schema：
  - `CreateResponseBody`
  - `ItemParam` + 消息内容部分联合
  - `ResponseResource`
  - Gateway 网关使用的流式事件形状
- 将 schema 保存在单个隔离模块中，以避免漂移并允许未来代码生成。

## 流式实现（第一阶段）

- 带有 `event:` 和 `data:` 的 SSE 行。
- 所需序列（最小可行）：
  - `response.created`
  - `response.output_item.added`
  - `response.content_part.added`
  - `response.output_text.delta`（根据需要重复）
  - `response.output_text.done`
  - `response.content_part.done`
  - `response.completed`
  - `[DONE]`

## 测试和验证计划

- 为 `/v1/responses` 添加端到端覆盖：
  - 需要认证
  - 非流式响应形状
  - 流式事件顺序和 `[DONE]`
  - 使用头部和 `user` 的会话路由
- 保持 `src/gateway/openai-http.e2e.test.ts` 不变。
- 手动：用 `stream: true` curl `/v1/responses` 并验证事件顺序和终止 `[DONE]`。

## 文档更新（后续）

- 为 `/v1/responses` 使用和示例添加新文档页面。
- 更新 `/gateway/openai-http-api`，添加遗留说明和指向 `/v1/responses` 的指针。
