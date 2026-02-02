---
last_updated: "2026-01-19"
owner: openclaw
status: 草稿
summary: 计划：添加 OpenResponses /v1/responses 端点并平稳废弃 Chat Completions
title: OpenResponses Gateway网关计划
x-i18n:
  generated_at: "2026-02-01T20:25:20Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 71a22c48397507d1648b40766a3153e420c54f2a2d5186d07e51eb3d12e4636a
  source_path: experiments/plans/openresponses-gateway.md
  workflow: 14
---

# OpenResponses Gateway网关集成计划

## 背景

OpenClaw Gateway网关当前在 `/v1/chat/completions` 暴露了一个最小化的 OpenAI 兼容 Chat Completions 端点（参见 [OpenAI Chat Completions](/gateway/openai-http-api)）。

Open Responses 是一个基于 OpenAI Responses API 的开放推理标准。它专为智能体工作流设计，使用基于项目的输入和语义化流式事件。OpenResponses 规范定义的是 `/v1/responses`，而非 `/v1/chat/completions`。

## 目标

- 添加一个遵循 OpenResponses 语义的 `/v1/responses` 端点。
- 将 Chat Completions 保留为兼容层，便于禁用并最终移除。
- 使用隔离的、可复用的 schema 标准化验证和解析。

## 非目标

- 第一阶段不追求完整的 OpenResponses 功能对等（图片、文件、托管工具）。
- 不替换内部智能体执行逻辑或工具编排。
- 第一阶段不改变现有 `/v1/chat/completions` 的行为。

## 研究摘要

来源：OpenResponses OpenAPI、OpenResponses 规范站点和 Hugging Face 博客文章。

提取的关键要点：

- `POST /v1/responses` 接受 `CreateResponseBody` 字段，包括 `model`、`input`（字符串或 `ItemParam[]`）、`instructions`、`tools`、`tool_choice`、`stream`、`max_output_tokens` 和 `max_tool_calls`。
- `ItemParam` 是一个可区分联合类型，包含：
  - 角色为 `system`、`developer`、`user`、`assistant` 的 `message` 项
  - `function_call` 和 `function_call_output`
  - `reasoning`
  - `item_reference`
- 成功响应返回一个 `ResponseResource`，包含 `object: "response"`、`status` 和 `output` 项。
- 流式传输使用语义化事件，例如：
  - `response.created`、`response.in_progress`、`response.completed`、`response.failed`
  - `response.output_item.added`、`response.output_item.done`
  - `response.content_part.added`、`response.content_part.done`
  - `response.output_text.delta`、`response.output_text.done`
- 规范要求：
  - `Content-Type: text/event-stream`
  - `event:` 必须与 JSON 的 `type` 字段匹配
  - 终止事件必须是字面量 `[DONE]`
- 推理项可以暴露 `content`、`encrypted_content` 和 `summary`。
- HF 示例在请求中包含 `OpenResponses-Version: latest`（可选头部）。

## 建议架构

- 添加 `src/gateway/open-responses.schema.ts`，仅包含 Zod schema（不引入 Gateway网关依赖）。
- 添加 `src/gateway/openresponses-http.ts`（或 `open-responses-http.ts`）用于 `/v1/responses`。
- 保持 `src/gateway/openai-http.ts` 不变，作为旧版兼容适配器。
- 添加配置 `gateway.http.endpoints.responses.enabled`（默认 `false`）。
- 保持 `gateway.http.endpoints.chatCompletions.enabled` 独立；允许两个端点分别切换。
- 当 Chat Completions 启用时，在启动时发出警告以提示其旧版状态。

## Chat Completions 废弃路径

- 维护严格的模块边界：Responses 和 Chat Completions 之间不共享 schema 类型。
- 通过配置使 Chat Completions 变为可选启用，这样无需修改代码即可禁用。
- 待 `/v1/responses` 稳定后，更新文档将 Chat Completions 标记为旧版。
- 可选的未来步骤：将 Chat Completions 请求映射到 Responses 处理器，以简化移除路径。

## 第一阶段支持子集

- 接受 `input` 为字符串或包含消息角色和 `function_call_output` 的 `ItemParam[]`。
- 将 system 和 developer 消息提取到 `extraSystemPrompt` 中。
- 使用最近的 `user` 或 `function_call_output` 作为智能体运行的当前消息。
- 对不支持的内容部分（图片/文件）返回 `invalid_request_error` 拒绝。
- 返回包含 `output_text` 内容的单条助手消息。
- 返回 `usage`，在接入令牌计量之前使用零值。

## 验证策略（无 SDK）

- 为以下支持的子集实现 Zod schema：
  - `CreateResponseBody`
  - `ItemParam` + 消息内容部分联合类型
  - `ResponseResource`
  - Gateway网关使用的流式事件结构
- 将 schema 保存在单个隔离模块中，以避免漂移并支持未来的代码生成。

## 流式实现（第一阶段）

- SSE 行同时包含 `event:` 和 `data:`。
- 必需的序列（最小可行方案）：
  - `response.created`
  - `response.output_item.added`
  - `response.content_part.added`
  - `response.output_text.delta`（按需重复）
  - `response.output_text.done`
  - `response.content_part.done`
  - `response.completed`
  - `[DONE]`

## 测试和验证计划

- 为 `/v1/responses` 添加端到端测试覆盖：
  - 需要认证
  - 非流式响应结构
  - 流式事件顺序和 `[DONE]`
  - 使用头部和 `user` 的会话路由
- 保持 `src/gateway/openai-http.e2e.test.ts` 不变。
- 手动测试：使用 curl 请求 `/v1/responses`，设置 `stream: true`，验证事件顺序和终止 `[DONE]`。

## 文档更新（后续）

- 为 `/v1/responses` 的用法和示例添加新的文档页面。
- 在 `/gateway/openai-http-api` 中添加旧版说明并指向 `/v1/responses`。
