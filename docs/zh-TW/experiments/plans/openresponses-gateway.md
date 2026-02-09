---
summary: "計畫：新增 OpenResponses /v1/responses 端點，並乾淨地淘汰 Chat Completions"
owner: "openclaw"
status: "draft"
last_updated: "2026-01-19"
title: "OpenResponses Gateway 閘道器計畫"
---

# OpenResponses Gateway 閘道器整合計畫

## Context

OpenClaw Gateway 目前提供一個最小化、相容 OpenAI 的 Chat Completions 端點，位於
`/v1/chat/completions`（請參閱 [OpenAI Chat Completions](/gateway/openai-http-api)）。

Open Responses 是一個基於 OpenAI Responses API 的開放推論標準。它專為代理式工作流程設計，
使用以項目為基礎的輸入以及語意化的串流事件。OpenResponses 規格定義的是
`/v1/responses`，而非 `/v1/chat/completions`。 30. 它是為代理式工作流程所設計，並使用以項目為基礎的輸入以及語意串流事件。 31. OpenResponses 規格定義的是 `/v1/responses`，而非 `/v1/chat/completions`。

## 目標

- 新增一個遵循 OpenResponses 語意的 `/v1/responses` 端點。
- 保留 Chat Completions 作為相容性層，且應易於停用並最終移除。
- 32. 使用獨立且可重複使用的結構來標準化驗證與解析。

## 非目標

- 首次實作即達成完整的 OpenResponses 功能對等（影像、檔案、託管工具）。
- 33. 取代內部代理執行邏輯或工具編排。
- 在第一階段中變更既有的 `/v1/chat/completions` 行為。

## 研究摘要

來源：OpenResponses OpenAPI、OpenResponses 規格網站，以及 Hugging Face 部落格文章。

34. 擷取的重點：

- `POST /v1/responses` 接受 `CreateResponseBody` 欄位，例如 `model`、`input`（字串或
  `ItemParam[]`）、`instructions`、`tools`、`tool_choice`、`stream`、`max_output_tokens`，
  以及 `max_tool_calls`。
- `ItemParam` 是一個具判別欄位的聯合型別，包含：
  - 具有 `system`、`developer`、`user`、`assistant` 角色的 `message` 項目
  - `function_call` 與 `function_call_output`
  - `reasoning`
  - `item_reference`
- 成功的回應會回傳一個 `ResponseResource`，其中包含 `object: "response"`、`status` 與
  `output` 項目。
- 串流使用語意事件，例如：
  - `response.created`、`response.in_progress`、`response.completed`、`response.failed`
  - `response.output_item.added`、`response.output_item.done`
  - `response.content_part.added`、`response.content_part.done`
  - `response.output_text.delta`、`response.output_text.done`
- 規格要求：
  - `Content-Type: text/event-stream`
  - `event:` 必須與 JSON 的 `type` 欄位相符
  - 終止事件必須是字面值 `[DONE]`
- 推理項目可能會揭露 `content`、`encrypted_content` 與 `summary`。
- HF 範例在請求中包含 `OpenResponses-Version: latest`（選用標頭）。

## 35. 提議的架構

- 新增僅包含 Zod 結構描述的 `src/gateway/open-responses.schema.ts`（不匯入 Gateway 閘道器程式碼）。
- 新增 `src/gateway/openresponses-http.ts`（或 `open-responses-http.ts`）用於 `/v1/responses`。
- 保持 `src/gateway/openai-http.ts` 完整，作為既有的相容性轉接層。
- 新增設定 `gateway.http.endpoints.responses.enabled`（預設為 `false`）。
- 保持 `gateway.http.endpoints.chatCompletions.enabled` 的獨立性；允許兩個端點分別切換啟用。
- 36. 當啟用 Chat Completions 時發出啟動警告，以標示其為舊版狀態。

## Chat Completions 的淘汰路徑

- 維持嚴格的模組邊界：responses 與 chat completions 之間不共用任何結構描述型別。
- 讓 Chat Completions 透過設定選擇性啟用，以便在不修改程式碼的情況下停用。
- 當 `/v1/responses` 穩定後，更新文件，將 Chat Completions 標示為舊版。
- 選擇性的未來步驟：將 Chat Completions 請求對映至 Responses 處理器，以簡化移除路徑。

## 第一階段支援子集

- 接受 `input`，形式為字串或包含訊息角色與 `function_call_output` 的 `ItemParam[]`。
- 將 system 與 developer 訊息抽取至 `extraSystemPrompt`。
- 使用最新的 `user` 或 `function_call_output` 作為代理執行的目前訊息。
- 對不支援的內容部分（image/file）以 `invalid_request_error` 拒絕。
- 回傳單一 assistant 訊息，內容為 `output_text`。
- 37. 在完成權杖計量接線前，回傳數值為零的 `usage`。

## 驗證策略（不使用 SDK）

- 為下列支援子集實作 Zod 結構描述：
  - `CreateResponseBody`
  - `ItemParam` + 訊息內容部分的聯合型別
  - `ResponseResource`
  - Gateway 閘道器使用的串流事件結構
- 38. 將結構集中於單一、獨立的模組中，以避免漂移並支援未來的程式碼產生。

## 39. 串流實作（第一階段）

- SSE 行同時包含 `event:` 與 `data:`。
- 必要的事件順序（最小可行）：
  - `response.created`
  - `response.output_item.added`
  - `response.content_part.added`
  - `response.output_text.delta`（視需要重複）
  - `response.output_text.done`
  - `response.content_part.done`
  - `response.completed`
  - `[DONE]`

## 測試與驗證計畫

- 為 `/v1/responses` 新增端到端測試涵蓋：
  - 需要驗證
  - 40. 非串流回應結構
  - 串流事件順序與 `[DONE]`
  - 使用標頭與 `user` 的工作階段路由
- 保持 `src/gateway/openai-http.e2e.test.ts` 不變。
- 手動測試：使用 curl 呼叫 `/v1/responses`，搭配 `stream: true`，並驗證事件順序與終止
  `[DONE]`。

## 文件更新（後續）

- 新增一個文件頁面，說明 `/v1/responses` 的使用方式與範例。
- 更新 `/gateway/openai-http-api`，加入舊版說明，並指向 `/v1/responses`。
