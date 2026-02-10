---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
last_updated: "2026-01-19"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
owner: openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
status: draft（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: 计划：添加 OpenResponses /v1/responses 端点并干净地弃用 chat completions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: OpenResponses Gateway 网关计划（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
x-i18n:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  generated_at: "2026-02-03T07:47:33Z"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: claude-opus-4-5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  provider: pi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  source_hash: 71a22c48397507d1648b40766a3153e420c54f2a2d5186d07e51eb3d12e4636a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  source_path: experiments/plans/openresponses-gateway.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  workflow: 15（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# OpenResponses Gateway 网关集成计划（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 背景（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw Gateway 网关目前在 `/v1/chat/completions` 暴露了一个最小的 OpenAI 兼容 Chat Completions 端点（参见 [OpenAI Chat Completions](/gateway/openai-http-api)）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Open Responses 是基于 OpenAI Responses API 的开放推理标准。它专为智能体工作流设计，使用基于项目的输入加语义流式事件。OpenResponses 规范定义的是 `/v1/responses`，而不是 `/v1/chat/completions`。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 目标（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 添加一个遵循 OpenResponses 语义的 `/v1/responses` 端点。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 保留 Chat Completions 作为兼容层，易于禁用并最终移除。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 使用隔离的、可复用的 schema 标准化验证和解析。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 非目标（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 第一阶段完全实现 OpenResponses 功能（图片、文件、托管工具）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 替换内部智能体执行逻辑或工具编排。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 在第一阶段更改现有的 `/v1/chat/completions` 行为。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 研究摘要（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
来源：OpenResponses OpenAPI、OpenResponses 规范网站和 Hugging Face 博客文章。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
提取的关键点：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `POST /v1/responses` 接受 `CreateResponseBody` 字段，如 `model`、`input`（字符串或 `ItemParam[]`）、`instructions`、`tools`、`tool_choice`、`stream`、`max_output_tokens` 和 `max_tool_calls`。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ItemParam` 是以下类型的可区分联合：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 具有角色 `system`、`developer`、`user`、`assistant` 的 `message` 项（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `function_call` 和 `function_call_output`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `reasoning`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `item_reference`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 成功响应返回带有 `object: "response"`、`status` 和 `output` 项的 `ResponseResource`。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 流式传输使用语义事件，如：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `response.created`、`response.in_progress`、`response.completed`、`response.failed`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `response.output_item.added`、`response.output_item.done`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `response.content_part.added`、`response.content_part.done`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `response.output_text.delta`、`response.output_text.done`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 规范要求：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `Content-Type: text/event-stream`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `event:` 必须匹配 JSON `type` 字段（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 终止事件必须是字面量 `[DONE]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reasoning 项可能暴露 `content`、`encrypted_content` 和 `summary`。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- HF 示例在请求中包含 `OpenResponses-Version: latest`（可选头部）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 提议的架构（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 添加 `src/gateway/open-responses.schema.ts`，仅包含 Zod schema（无 gateway 导入）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 添加 `src/gateway/openresponses-http.ts`（或 `open-responses-http.ts`）用于 `/v1/responses`。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 保持 `src/gateway/openai-http.ts` 不变，作为遗留兼容适配器。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 添加配置 `gateway.http.endpoints.responses.enabled`（默认 `false`）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 保持 `gateway.http.endpoints.chatCompletions.enabled` 独立；允许两个端点分别切换。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 当 Chat Completions 启用时发出启动警告，以表明其遗留状态。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Chat Completions 弃用路径（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 保持严格的模块边界：responses 和 chat completions 之间不共享 schema 类型。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 通过配置使 Chat Completions 成为可选，这样无需代码更改即可禁用。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 一旦 `/v1/responses` 稳定，更新文档将 Chat Completions 标记为遗留。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 可选的未来步骤：将 Chat Completions 请求映射到 Responses 处理器，以便更简单地移除。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 第一阶段支持子集（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 接受 `input` 为字符串或带有消息角色和 `function_call_output` 的 `ItemParam[]`。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 将 system 和 developer 消息提取到 `extraSystemPrompt` 中。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 使用最近的 `user` 或 `function_call_output` 作为智能体运行的当前消息。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 对不支持的内容部分（图片/文件）返回 `invalid_request_error` 拒绝。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 返回带有 `output_text` 内容的单个助手消息。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 返回带有零值的 `usage`，直到 token 计数接入。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 验证策略（无 SDK）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 为以下支持子集实现 Zod schema：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `CreateResponseBody`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `ItemParam` + 消息内容部分联合（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `ResponseResource`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Gateway 网关使用的流式事件形状（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 将 schema 保存在单个隔离模块中，以避免漂移并允许未来代码生成。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 流式实现（第一阶段）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 带有 `event:` 和 `data:` 的 SSE 行。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 所需序列（最小可行）：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `response.created`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `response.output_item.added`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `response.content_part.added`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `response.output_text.delta`（根据需要重复）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `response.output_text.done`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `response.content_part.done`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `response.completed`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `[DONE]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 测试和验证计划（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 为 `/v1/responses` 添加端到端覆盖：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 需要认证（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 非流式响应形状（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 流式事件顺序和 `[DONE]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 使用头部和 `user` 的会话路由（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 保持 `src/gateway/openai-http.e2e.test.ts` 不变。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 手动：用 `stream: true` curl `/v1/responses` 并验证事件顺序和终止 `[DONE]`。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 文档更新（后续）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 为 `/v1/responses` 使用和示例添加新文档页面。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 更新 `/gateway/openai-http-api`，添加遗留说明和指向 `/v1/responses` 的指针。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
