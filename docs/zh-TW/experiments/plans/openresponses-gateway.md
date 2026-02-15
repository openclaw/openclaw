---
summary: "計畫：新增 OpenResponses /v1/responses 端點並乾淨地棄用 chat completions"
owner: "openclaw"
status: "draft"
last_updated: "2026-01-19"
title: "OpenResponses Gateway 計畫"
---

# OpenResponses Gateway 整合計畫

## Context

OpenClaw Gateway 目前在 `/v1/chat/completions` 提供一個極簡的 OpenAI 相容 Chat Completions 端點（參閱 [OpenAI Chat Completions](/gateway/openai-http-api)）。

Open Responses 是一個基於 OpenAI Responses API 的開放推論標準。它專為智慧代理（agentic）工作流設計，並使用基於項目的輸入以及語義化串流事件。OpenResponses 規範定義的是 `/v1/responses`，而非 `/v1/chat/completions`。

## Goals

- 新增一個符合 OpenResponses 語義的 `/v1/responses` 端點。
- 將 Chat Completions 保留為相容層，以便輕鬆停用並最終移除。
- 使用隔離且可重複使用的 schema 來標準化驗證與解析。

## Non-goals

- 在第一階段實現完整的 OpenResponses 功能對齊（圖片、檔案、代管工具）。
- 取代內部的智慧代理執行邏輯或工具編排。
- 在第一階段更改現有的 `/v1/chat/completions` 行為。

## Research Summary

來源：OpenResponses OpenAPI、OpenResponses 規範網站以及 Hugging Face 部落格文章。

關鍵點提取：

- `POST /v1/responses` 接受 `CreateResponseBody` 欄位，例如 `model`、`input`（字串或 `ItemParam[]`）、`instructions`、`tools`、`tool_choice`、`stream`、`max_output_tokens` 與 `max_tool_calls`。
- `ItemParam` 是以下項目的可辨識聯集（discriminated union）：
  - 角色為 `system`、`developer`、`user`、`assistant` 的 `message` 項目
  - `function_call` 與 `function_call_output`
  - `reasoning`
  - `item_reference`
- 成功的回應會回傳一個帶有 `object: "response"`、`status` 與 `output` 項目的 `ResponseResource`。
- 串流傳輸使用語義化事件，例如：
  - `response.created`、`response.in_progress`、`response.completed`、`response.failed`
  - `response.output_item.added`、`response.output_item.done`
  - `response.content_part.added`、`response.content_part.done`
  - `response.output_text.delta`、`response.output_text.done`
- 規範要求：
  - `Content-Type: text/event-stream`
  - `event:` 必須與 JSON 的 `type` 欄位匹配
  - 終端事件必須是字面量 `[DONE]`
- Reasoning 項目可能會公開 `content`、`encrypted_content` 與 `summary`。
- HF 範例在請求中包含 `OpenResponses-Version: latest`（選用標頭）。

## Proposed Architecture

- 新增 `src/gateway/open-responses.schema.ts`，僅包含 Zod schema（不匯入 Gateway）。
- 為 `/v1/responses` 新增 `src/gateway/openresponses-http.ts`（或 `open-responses-http.ts`）。
- 完整保留 `src/gateway/openai-http.ts` 作為舊版相容轉接器。
- 新增設定 `gateway.http.endpoints.responses.enabled`（預設為 `false`）。
- 保持 `gateway.http.endpoints.chatCompletions.enabled` 獨立；允許分別切換這兩個端點。
- 當啟用 Chat Completions 時發出啟動警告，以提示其舊版狀態。

## Deprecation Path for Chat Completions

- 維持嚴格的模組界限：responses 與 chat completions 之間不共用 schema 型別。
- 透過設定讓 Chat Completions 變成選用（opt-in），以便在不更改程式碼的情況下停用。
- 一旦 `/v1/responses` 穩定，更新文件將 Chat Completions 標記為舊版（legacy）。
- 未來的選用步驟：將 Chat Completions 請求映射到 Responses 處理常式，以提供更簡單的移除路徑。

## Phase 1 Support Subset

- 接受 `input` 為字串或包含訊息角色與 `function_call_output` 的 `ItemParam[]`。
- 將 system 與 developer 訊息提取至 `extraSystemPrompt`。
- 使用最近的 `user` 或 `function_call_output` 作為智慧代理執行的當前訊息。
- 對不支援的內容部分（圖片/檔案）回傳 `invalid_request_error` 並拒絕。
- 回傳包含 `output_text` 內容的單一 assistant 訊息。
- 回傳 `usage` 且數值歸零，直到完成代幣計費邏輯。

## Validation Strategy (No SDK)

- 為支援的子集實作 Zod schema：
  - `CreateResponseBody`
  - `ItemParam` + 訊息內容部分聯集
  - `ResponseResource`
  - Gateway 使用的串流事件結構
- 將 schema 保持在單一且隔離的模組中，以避免偏差並允許未來的程式碼產生（codegen）。

## Streaming Implementation (Phase 1)

- SSE 行需同時包含 `event:` 與 `data:`。
- 要求順序（最小可行方案）：
  - `response.created`
  - `response.output_item.added`
  - `response.content_part.added`
  - `response.output_text.delta`（視需要重複）
  - `response.output_text.done`
  - `response.content_part.done`
  - `response.completed`
  - `[DONE]`

## Tests and Verification Plan

- 為 `/v1/responses` 增加端對端（e2e）測試涵蓋範圍：
  - 需經過驗證（Auth required）
  - 非串流回應的結構
  - 串流事件順序與 `[DONE]`
  - 包含標頭與 `user` 的工作階段路由
- 保持 `src/gateway/openai-http.e2e.test.ts` 不變。
- 手動測試：使用 curl 請求 `/v1/responses` 並設定 `stream: true`，驗證事件順序與終端 `[DONE]`。

## Doc Updates (Follow-up)

- 為 `/v1/responses` 的用法與範例新增一個文件頁面。
- 在 `/gateway/openai-http-api` 中加入舊版說明及指向 `/v1/responses` 的連結。
