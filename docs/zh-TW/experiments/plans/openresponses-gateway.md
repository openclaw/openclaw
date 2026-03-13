---
summary: >-
  Plan: Add OpenResponses /v1/responses endpoint and deprecate chat completions
  cleanly
read_when:
  - Designing or implementing `/v1/responses` gateway support
  - Planning migration from Chat Completions compatibility
owner: openclaw
status: draft
last_updated: "2026-01-19"
title: OpenResponses Gateway Plan
---

# OpenResponses 閘道整合計畫

## Context

OpenClaw Gateway 目前提供一個最小的 OpenAI 相容的聊天完成端點，位於 `/v1/chat/completions`（請參閱 [OpenAI 聊天完成](/gateway/openai-http-api)）。

Open Responses 是一個基於 OpenAI Responses API 的開放推理標準。它旨在用於代理工作流程，並使用基於專案的輸入以及語義串流事件。OpenResponses 規範定義了 `/v1/responses`，而不是 `/v1/chat/completions`。

## 目標

- 新增一個 `/v1/responses` 端點，符合 OpenResponses 語義。
- 保留 Chat Completions 作為一個易於禁用並最終移除的相容層。
- 使用獨立的可重用架構來標準化驗證和解析。

## 非目標

- 在第一階段實現完整的 OpenResponses 功能平衡（圖片、檔案、託管工具）。
- 替換內部代理執行邏輯或工具協調。
- 在第一階段更改現有的 `/v1/chat/completions` 行為。

## 研究摘要

來源：OpenResponses OpenAPI、OpenResponses 規範網站，以及 Hugging Face 博客文章。

[[BLOCK_1]]

- `POST /v1/responses` 接受 `CreateResponseBody` 欄位，如 `model`、`input`（字串或 `ItemParam[]`）、`instructions`、`tools`、`tool_choice`、`stream`、`max_output_tokens` 和 `max_tool_calls`。
- `ItemParam` 是一個區分聯合（discriminated union），包含：
  - `message` 專案，角色為 `system`、`developer`、`user`、`assistant`
  - `function_call` 和 `function_call_output`
  - `reasoning`
  - `item_reference`
- 成功的回應會返回一個 `ResponseResource`，包含 `object: "response"`、`status` 和 `output` 專案。
- 串流使用語意事件，例如：
  - `response.created`、`response.in_progress`、`response.completed`、`response.failed`
  - `response.output_item.added`、`response.output_item.done`
  - `response.content_part.added`、`response.content_part.done`
  - `response.output_text.delta`、`response.output_text.done`
- 規範要求：
  - `Content-Type: text/event-stream`
  - `event:` 必須符合 JSON `type` 欄位
  - 終端事件必須是字面量 `[DONE]`
- 推理專案可能會暴露 `content`、`encrypted_content` 和 `summary`。
- HF 範例包括在請求中使用 `OpenResponses-Version: latest`（可選標頭）。

## 提議的架構

- 添加 `src/gateway/open-responses.schema.ts` 只包含 Zod schemas（不包含 gateway 匯入）。
- 為 `/v1/responses` 添加 `src/gateway/openresponses-http.ts`（或 `open-responses-http.ts`）。
- 保持 `src/gateway/openai-http.ts` 完整，作為舊版相容適配器。
- 添加設定 `gateway.http.endpoints.responses.enabled`（預設為 `false`）。
- 保持 `gateway.http.endpoints.chatCompletions.enabled` 獨立；允許兩個端點分別切換。
- 當啟用 Chat Completions 時，發出啟動警告以提示舊版狀態。

## Chat 完成的棄用路徑

- 維持嚴格的模組邊界：回應和聊天完成之間不共享架構類型。
- 透過設定使聊天完成選擇性啟用，以便在不更改程式碼的情況下禁用。
- 更新文件，將聊天完成標記為舊版，一旦 `/v1/responses` 穩定後。
- 可選的未來步驟：將聊天完成請求映射到回應處理器，以便簡化移除路徑。

## Phase 1 支援子集

- 接受 `input` 作為字串或 `ItemParam[]` 以及訊息角色和 `function_call_output`。
- 將系統和開發者訊息提取到 `extraSystemPrompt` 中。
- 使用最新的 `user` 或 `function_call_output` 作為代理執行的當前訊息。
- 對不支援的內容部分（圖片/檔案）使用 `invalid_request_error` 拒絕。
- 返回一條包含 `output_text` 內容的單一助手訊息。
- 返回 `usage`，其值為零，直到 token 計算功能啟用。

## 驗證策略 (無 SDK)

- 實作 Zod schema 以支援以下子集：
  - `CreateResponseBody`
  - `ItemParam` + 訊息內容部分的聯合
  - `ResponseResource`
  - 網關使用的串流事件形狀
- 將 schema 保持在單一、獨立的模組中，以避免漂移並允許未來的程式碼生成。

## Streaming 實作 (第一階段)

- SSE 行包含 `event:` 和 `data:`。
- 必要的順序（最小可行）：
  - `response.created`
  - `response.output_item.added`
  - `response.content_part.added`
  - `response.output_text.delta`（根據需要重複）
  - `response.output_text.done`
  - `response.content_part.done`
  - `response.completed`
  - `[DONE]`

## 測試與驗證計畫

- 為 `/v1/responses` 添加端到端測試覆蓋：
  - 需要身份驗證
  - 非串流響應格式
  - 串流事件排序和 `[DONE]`
  - 使用標頭的會話路由和 `user`
- 保持 `src/gateway/openai-http.test.ts` 不變。
- 手動：使用 curl 對 `/v1/responses` 進行請求，並帶上 `stream: true`，驗證事件排序和終端 `[DONE]`。

## Doc Updates (Follow-up)

- 為 `/v1/responses` 的使用和範例新增一個文件頁面。
- 更新 `/gateway/openai-http-api`，加入舊版註解並指向 `/v1/responses`。
