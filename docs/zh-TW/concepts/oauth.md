---
summary: "OpenClaw 中的 OAuth：權杖交換、儲存與多帳號模式"
read_when:
  - 您想完整了解 OpenClaw OAuth
  - 您遇到權杖失效 / 登出問題
  - 您想要設定權杖或 OAuth 授權流程
  - 您想要多個帳號或設定檔路由
title: "OAuth"
---

# OAuth

OpenClaw 透過 OAuth 支援「訂閱授權」，適用於有提供的供應商（特別是 **OpenAI Codex (ChatGPT OAuth)**）。對於 Anthropic 訂閱，請使用 **setup-token** 流程。本頁說明：

- OAuth **權杖交換** 的運作方式 (PKCE)
- 權杖的**儲存**位置（及原因）
- 如何處理**多個帳號**（設定檔 + 每個工作階段覆寫）

OpenClaw 也支援提供自身 OAuth 或 API 金鑰流程的**供應商外掛程式**。透過以下方式執行：

```bash
openclaw models auth login --provider <id>
```

## 權杖匯集處（為何存在）

OAuth 供應商通常在登入/重新整理流程中發行一個**新的重新整理權杖**。某些供應商（或 OAuth 用戶端）在為相同使用者/應用程式發行新權杖時，可能會使較舊的重新整理權杖失效。

實際症狀：

- 您透過 OpenClaw _和_ 透過 Claude Code / Codex CLI 登入 → 其中之一隨後會隨機「登出」

為了減少這種情況，OpenClaw 將 `auth-profiles.json` 視為**權杖匯集處**：

- 執行時期從**單一位置**讀取憑證
- 我們可以保留多個設定檔並確定性地路由它們

## 儲存（權杖儲存位置）

機密資訊**每個智慧代理**儲存：

- 授權設定檔 (OAuth + API 金鑰)：`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- 執行時期快取（自動管理；請勿編輯）：`~/.openclaw/agents/<agentId>/agent/auth.json`

舊版僅供匯入檔案（仍受支援，但不是主要儲存處）：

- `~/.openclaw/credentials/oauth.json` (首次使用時匯入 `auth-profiles.json`)

以上所有都遵守 `$OPENCLAW_STATE_DIR`（狀態目錄覆寫）。完整參考資料：[/gateway/configuration](/gateway/configuration#auth-storage-oauth--api-keys)

## Anthropic setup-token（訂閱授權）

在任何機器上執行 `claude setup-token`，然後將其貼到 OpenClaw 中：

```bash
openclaw models auth setup-token --provider anthropic
```

如果您在其他地方產生了權杖，請手動貼上：

```bash
openclaw models auth paste-token --provider anthropic
```

驗證：

```bash
openclaw models status
```

## OAuth 交換（登入運作方式）

OpenClaw 的互動式登入流程實作於 ` @mariozechner/pi-ai` 並連接到精靈/命令中。

### Anthropic (Claude Pro/Max) setup-token

流程形狀：

1. 執行 `claude setup-token`
2. 將權杖貼到 OpenClaw 中
3. 儲存為權杖授權設定檔（不重新整理）

精靈路徑為 `openclaw onboard` → 授權選項 `setup-token` (Anthropic)。

### OpenAI Codex (ChatGPT OAuth)

流程形狀 (PKCE)：

1. 產生 PKCE 驗證器/挑戰 + 隨機 `state`
2. 開啟 `https://auth.openai.com/oauth/authorize?...`
3. 嘗試在 `http://127.0.0.1:1455/auth/callback` 上捕捉回呼
4. 如果回呼無法繫結（或您是遠端/無頭模式），請貼上重新導向 URL/程式碼
5. 在 `https://auth.openai.com/oauth/token` 處交換
6. 從存取權杖中提取 `accountId` 並儲存 `{ access, refresh, expires, accountId }`

精靈路徑為 `openclaw onboard` → 授權選項 `openai-codex`。

## 重新整理 + 過期

設定檔儲存 `expires` 時間戳記。

在執行時期：

- 如果 `expires` 在未來 → 使用儲存的存取權杖
- 如果過期 → 重新整理（在檔案鎖定下）並覆寫儲存的憑證

重新整理流程是自動的；您通常不需要手動管理權杖。

## 多個帳號（設定檔）+ 路由

兩種模式：

### 1) 首選：獨立智慧代理

如果您希望「個人」和「工作」之間互不干擾，請使用獨立的智慧代理（獨立的工作階段 + 憑證 + 工作區）：

```bash
openclaw agents add work
openclaw agents add personal
```

然後為每個智慧代理配置授權（精靈）並將聊天路由到正確的智慧代理。

### 2) 進階：單一智慧代理中的多個設定檔

`auth-profiles.json` 支援相同供應商的多個設定檔 ID。

選擇要使用的設定檔：

- 透過設定排序全域 (`auth.order`)
- 透過 `/model ... @<profileId>` 每個工作階段

範例（工作階段覆寫）：

- `/model Opus @anthropic:work`

如何查看現有的設定檔 ID：

- `openclaw channels list --json` (顯示 `auth[]`)

相關文件：

- [/concepts/model-failover](/concepts/model-failover) (輪換 + 冷卻規則)
- [/tools/slash-commands](/tools/slash-commands) (命令介面)
