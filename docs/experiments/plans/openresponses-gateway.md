---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Plan: Add OpenResponses /v1/responses endpoint and deprecate chat completions cleanly"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
owner: "openclaw"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
status: "draft"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
last_updated: "2026-01-19"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "OpenResponses Gateway Plan"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# OpenResponses Gateway Integration Plan（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw Gateway currently exposes a minimal OpenAI-compatible Chat Completions endpoint at（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`/v1/chat/completions` (see [OpenAI Chat Completions](/gateway/openai-http-api)).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Open Responses is an open inference standard based on the OpenAI Responses API. It is designed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
for agentic workflows and uses item-based inputs plus semantic streaming events. The OpenResponses（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
spec defines `/v1/responses`, not `/v1/chat/completions`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Goals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add a `/v1/responses` endpoint that adheres to OpenResponses semantics.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep Chat Completions as a compatibility layer that is easy to disable and eventually remove.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Standardize validation and parsing with isolated, reusable schemas.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Non-goals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Full OpenResponses feature parity in the first pass (images, files, hosted tools).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Replacing internal agent execution logic or tool orchestration.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Changing the existing `/v1/chat/completions` behavior during the first phase.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Research Summary（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Sources: OpenResponses OpenAPI, OpenResponses specification site, and the Hugging Face blog post.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Key points extracted:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `POST /v1/responses` accepts `CreateResponseBody` fields like `model`, `input` (string or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `ItemParam[]`), `instructions`, `tools`, `tool_choice`, `stream`, `max_output_tokens`, and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `max_tool_calls`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ItemParam` is a discriminated union of:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `message` items with roles `system`, `developer`, `user`, `assistant`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `function_call` and `function_call_output`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `reasoning`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `item_reference`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Successful responses return a `ResponseResource` with `object: "response"`, `status`, and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `output` items.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Streaming uses semantic events such as:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `response.created`, `response.in_progress`, `response.completed`, `response.failed`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `response.output_item.added`, `response.output_item.done`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `response.content_part.added`, `response.content_part.done`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `response.output_text.delta`, `response.output_text.done`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The spec requires:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `Content-Type: text/event-stream`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `event:` must match the JSON `type` field（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - terminal event must be literal `[DONE]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reasoning items may expose `content`, `encrypted_content`, and `summary`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- HF examples include `OpenResponses-Version: latest` in requests (optional header).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Proposed Architecture（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add `src/gateway/open-responses.schema.ts` containing Zod schemas only (no gateway imports).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add `src/gateway/openresponses-http.ts` (or `open-responses-http.ts`) for `/v1/responses`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep `src/gateway/openai-http.ts` intact as a legacy compatibility adapter.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add config `gateway.http.endpoints.responses.enabled` (default `false`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep `gateway.http.endpoints.chatCompletions.enabled` independent; allow both endpoints to be（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  toggled separately.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Emit a startup warning when Chat Completions is enabled to signal legacy status.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Deprecation Path for Chat Completions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Maintain strict module boundaries: no shared schema types between responses and chat completions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Make Chat Completions opt-in by config so it can be disabled without code changes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Update docs to label Chat Completions as legacy once `/v1/responses` is stable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional future step: map Chat Completions requests to the Responses handler for a simpler（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  removal path.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Phase 1 Support Subset（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Accept `input` as string or `ItemParam[]` with message roles and `function_call_output`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Extract system and developer messages into `extraSystemPrompt`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use the most recent `user` or `function_call_output` as the current message for agent runs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reject unsupported content parts (image/file) with `invalid_request_error`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Return a single assistant message with `output_text` content.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Return `usage` with zeroed values until token accounting is wired.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Validation Strategy (No SDK)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Implement Zod schemas for the supported subset of:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `CreateResponseBody`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `ItemParam` + message content part unions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `ResponseResource`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Streaming event shapes used by the gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep schemas in a single, isolated module to avoid drift and allow future codegen.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Streaming Implementation (Phase 1)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- SSE lines with both `event:` and `data:`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Required sequence (minimum viable):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `response.created`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `response.output_item.added`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `response.content_part.added`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `response.output_text.delta` (repeat as needed)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `response.output_text.done`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `response.content_part.done`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `response.completed`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `[DONE]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tests and Verification Plan（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add e2e coverage for `/v1/responses`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Auth required（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Non-stream response shape（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Stream event ordering and `[DONE]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Session routing with headers and `user`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep `src/gateway/openai-http.e2e.test.ts` unchanged.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Manual: curl to `/v1/responses` with `stream: true` and verify event ordering and terminal（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `[DONE]`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Doc Updates (Follow-up)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add a new docs page for `/v1/responses` usage and examples.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Update `/gateway/openai-http-api` with a legacy note and pointer to `/v1/responses`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
