---
summary: "規劃：新增 OpenResponses /v1/responses 端點並妥善棄用聊天補全"
owner: "openclaw"
status: "草稿"
last_updated: "2026-01-19"
title: "OpenResponses Gateway 規劃"
---

# OpenResponses Gateway 整合規劃

## 背景

OpenClaw Gateway 目前在 `/v1/chat/completions` 提供一個最小的與 OpenAI 相容的聊天補全 (Chat Completions) 端點（請參閱 [OpenAI Chat Completions](/gateway/openai-http-api)）。

Open Responses 是一個基於 OpenAI Responses API 的開放推論標準。它專為智慧代理工作流程設計，並使用基於項目的輸入加上語義串流傳輸事件。OpenResponses 規範定義的是 `/v1/responses`，而不是 `/v1/chat/completions`。

## 目標

- 新增一個符合 OpenResponses 語義的 `/v1/responses` 端點。
- 將聊天補全 (Chat Completions) 作為一個相容性層，使其易於停用並最終移除。
- 使用獨立、可重複使用的架構 (schemas) 來標準化驗證和解析。

## 非目標

- 第一階段不追求完整的 OpenResponses 功能一致性（圖片、檔案、託管工具）。
- 不替換內部的智慧代理執行邏輯或工具編排。
- 第一階段不改變現有的 `/v1/chat/completions` 行為。

## 研究摘要

來源：OpenResponses OpenAPI、OpenResponses 規範網站和 Hugging Face 部落格文章。

提取的重點：

- `POST /v1/responses` 接受 `CreateResponseBody` 欄位，例如 `model`、`input`（字串或 `ItemParam[]`）、`instructions`、`tools`、`tool_choice`、`stream`、`max_output_tokens` 和 `max_tool_calls`。
- `ItemParam` 是一個辨識聯合 (discriminated union)，包含：
  - 帶有 `system`、`developer`、`user`、`assistant` 角色的 `message` 項目
  - `function_call` 和 `function_call_output`
  - `reasoning`
  - `item_reference`
- 成功的響應返回一個帶有 `object: "response"`、`status` 和 `output` 項目的 `ResponseResource`。
- 串流傳輸使用語義事件，例如：
  - `response.created`、`response.in_progress`、`response.completed`、`response.failed`
  - `response.output_item.added`、`response.output_item.done`
  - `response.content_part.added`、`response.content_part.done`
  - `response.output_text.delta`、`response.output_text.done`
- 規範要求：
  - `Content-Type: text/event-stream`
  - `event:` 必須與 JSON `type` 欄位匹配
  - 終止事件必須是字面上的 `[DONE]`
- `reasoning` 項目可能會公開 `content`、`encrypted_content` 和 `summary`。
- Hugging Face 的範例請求中包含 `OpenResponses-Version: latest`（可選標頭）。

## 提議的架構

- 新增 `src/gateway/open-responses.schema.ts`，其中僅包含 Zod 架構（無 Gateway 導入）。
- 為 `/v1/responses` 新增 `src/gateway/openresponses-http.ts`（或 `open-responses-http.ts`）。
- 保持 `src/gateway/openai-http.ts` 不變，作為舊版相容性適配器。
- 新增設定 `gateway.http.endpoints.responses.enabled`（預設為 `false`）。
- `gateway.http.endpoints.chatCompletions.enabled` 保持獨立；允許兩個端點分別切換。
- 當聊天補全 (Chat Completions) 啟用時發出啟動警告，以表示其舊版狀態。

## 聊天補全 (Chat Completions) 的棄用路徑

- 維護嚴格的模組邊界：響應和聊天補全之間沒有共享的架構類型。
- 將聊天補全 (Chat Completions) 設定為可選啟用，以便在不更改程式碼的情況下停用。
- 一旦 `/v1/responses` 穩定，更新文件以將聊天補全 (Chat Completions) 標記為舊版。
- 可選的未來步驟：將聊天補全 (Chat Completions) 請求映射到響應處理器，以簡化移除路徑。

## 第一階段支援子集

- 接受 `input` 為字串或 `ItemParam[]`，帶有訊息角色和 `function_call_output`。
- 將 `system` 和 `developer` 訊息提取到 `extraSystemPrompt` 中。
- 使用最新的 `user` 或 `function_call_output` 作為智慧代理執行的當前訊息。
- 拒絕帶有 `invalid_request_error` 的不支援內容部分（圖片/檔案）。
- 返回帶有 `output_text` 內容的單個助理訊息。
- 返回 `usage`，在權杖核算 (token accounting) 接線完成之前使用歸零的值。

## 驗證策略（無 SDK）

- 針對以下支援的子集實作 Zod 架構：
  - `CreateResponseBody`
  - `ItemParam` + 訊息內容部分聯合
  - `ResponseResource`
  - Gateway 使用的串流傳輸事件形狀
- 將架構保持在單一、獨立的模組中，以避免漂移並允許未來的程式碼生成。

## 串流傳輸實作（第一階段）

- 帶有 `event:` 和 `data:` 的 SSE 行。
- 必需的順序（最小可行）：
  - `response.created`
  - `response.output_item.added`
  - `response.content_part.added`
  - `response.output_text.delta`（根據需要重複）
  - `response.output_text.done`
  - `response.content_part.done`
  - `response.completed`
  - `[DONE]`

## 測試與驗證規劃

- 為 `/v1/responses` 新增 e2e 覆蓋率：
  - 需要驗證 (Auth required)
  - 非串流傳輸響應形狀
  - 串流傳輸事件順序和 `[DONE]`
  - 帶有標頭和 `user` 的工作階段路由
- `src/gateway/openai-http.e2e.test.ts` 保持不變。
- 手動：使用 `curl` 對 `/v1/responses` 執行 `stream: true`，並驗證事件順序和終止的 `[DONE]`。

## 文件更新（後續）

- 為 `/v1/responses` 的使用方式和範例新增一個文件頁面。
- 更新 `/gateway/openai-http-api`，加入舊版備註並指向 `/v1/responses`。
