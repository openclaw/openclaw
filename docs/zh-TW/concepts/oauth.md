---
summary: "OpenClaw 中的 OAuth：權杖交換、儲存與多帳號模式"
read_when:
  - 您想全面了解 OpenClaw OAuth
  - 您遇到權杖失效 / 登出問題
  - 您想使用 setup-token 或 OAuth 驗證流程
  - 您需要多帳號或設定檔路由
title: "OAuth"
---

# OAuth

OpenClaw 針對提供 OAuth 的供應商（特別是 **OpenAI Codex (ChatGPT OAuth)**）支援「訂閱驗證」。對於 Anthropic 訂閱，請使用 **setup-token** 流程。本頁面說明：

- OAuth **權杖交換** 如何運作 (PKCE)
- 權杖**儲存**在哪裡（以及原因）
- 如何處理**多帳號**（設定檔 + 個別工作階段覆寫）

OpenClaw 也支援內建專屬 OAuth 或 API 金鑰流程的**供應商外掛程式**。透過以下方式執行：

```bash
openclaw models auth login --provider <id>
```

## 權杖接收器（存在的目的）

OAuth 供應商通常會在登入/重新整理流程中核發**新的重新整理權杖 (refresh token)**。某些供應商（或 OAuth 用戶端）在為同一使用者/應用程式核發新權杖時，會使舊的重新整理權杖失效。

實際現象：

- 您同時透過 OpenClaw _和_ Claude Code / Codex CLI 登入 → 其中一個之後會隨機「被登出」

為減少此情況，OpenClaw 將 `auth-profiles.json` 視為**權杖接收器 (token sink)**：

- 執行階段會從**單一位置**讀取憑證
- 我們可以保留多個設定檔並進行確定的路由

## 儲存位置（權杖儲存處）

秘密資訊會**按智慧代理**儲存：

- 驗證設定檔 (OAuth + API 金鑰)：`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- 執行階段快取（自動管理；請勿編輯）：`~/.openclaw/agents/<agentId>/agent/auth.json`

舊版僅供匯入的檔案（仍支援，但非主要儲存位置）：

- `~/.openclaw/credentials/oauth.json`（首次使用時會匯入至 `auth-profiles.json`）

以上所有路徑皆遵循 `$OPENCLAW_STATE_DIR`（狀態目錄覆寫）。完整參考：[/gateway/configuration](/gateway/configuration#auth-storage-oauth--api-keys)

## Anthropic setup-token（訂閱驗證）

在任何機器上執行 `claude setup-token`，然後將其貼上到 OpenClaw：

```bash
openclaw models auth setup-token --provider anthropic
```

如果您是在其他地方產生的權杖，請手動貼上：

```bash
openclaw models auth paste-token --provider anthropic
```

驗證：

```bash
openclaw models status
```

## OAuth 交換（登入運作方式）

OpenClaw 的互動式登入流程實作於 `@mariozechner/pi-ai` 並整合至精靈/指令中。

### Anthropic (Claude Pro/Max) setup-token

流程形式：

1. 執行 `claude setup-token`
2. 將權杖貼上到 OpenClaw
3. 儲存為權杖驗證設定檔（不重新整理）

精靈路徑為 `openclaw onboard` → 驗證選項 `setup-token` (Anthropic)。

### OpenAI Codex (ChatGPT OAuth)

流程形式 (PKCE)：

1. 產生 PKCE 驗證碼/挑戰碼 + 隨機 `state`
2. 開啟 `https://auth.openai.com/oauth/authorize?...`
3. 嘗試在 `http://127.0.0.1:1455/auth/callback` 擷取回呼 (callback)
4. 如果回呼無法繫結（或您處於遠端/無介面環境），請貼上重新導向 URL/代碼
5. 在 `https://auth.openai.com/oauth/token` 進行交換
6. 從存取權杖 (access token) 中擷取 `accountId` 並儲存 `{ access, refresh, expires, accountId }`

精靈路徑為 `openclaw onboard` → 驗證選項 `openai-codex`。

## 重新整理與過期

設定檔中儲存了 `expires` 時間戳記。

在執行階段：

- 如果 `expires` 在未來 → 使用儲存的存取權杖
- 如果已過期 → 重新整理（在檔案鎖定下）並覆寫儲存的憑證

重新整理流程是自動的；您通常不需要手動管理權杖。

## 多帳號（設定檔）與路由

兩種模式：

### 1) 偏好方式：獨立智慧代理

如果您希望「個人」和「工作」互不干擾，請使用隔離的智慧代理（獨立的工作階段 + 憑證 + 工作區）：

```bash
openclaw agents add work
openclaw agents add personal
```

然後為各個智慧代理設定驗證（精靈），並將對話路由到正確的智慧代理。

### 2) 進階方式：在單一智慧代理中使用多個設定檔

`auth-profiles.json` 支援同一個供應商有多個設定檔 ID。

選擇使用的設定檔：

- 透過設定排序進行全域選擇 (`auth.order`)
- 透過 `/model ... @<profileId>` 進行個別工作階段選擇

範例（工作階段覆寫）：

- `/model Opus @anthropic:work`

如何查看現有的設定檔 ID：

- `openclaw channels list --json`（顯示 `auth[]`）

相關文件：

- [/concepts/model-failover](/concepts/model-failover)（輪詢 + 冷卻規則）
- [/tools/slash-commands](/tools/slash-commands)（指令介面）
