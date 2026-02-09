---
summary: "OpenClaw 中的 OAuth：權杖交換、儲存與多帳號模式"
read_when:
  - 你想了解 OpenClaw 的 OAuth 端到端流程
  - 你遇到權杖失效／登出問題
  - 你想使用 setup-token 或 OAuth 驗證流程
  - 你想要多個帳號或設定檔路由
title: "OAuth"
---

# OAuth

OpenClaw 透過 OAuth 支援「訂閱驗證」（subscription auth），適用於提供此功能的提供者（尤其是 **OpenAI Codex（ChatGPT OAuth）**）。對於 Anthropic 訂閱，請使用 **setup-token** 流程。本頁說明： 對於 Anthropic 訂閱，請使用 **setup-token** 流程。 本頁說明：

- OAuth **權杖交換** 如何運作（PKCE）
- 權杖（token）**儲存**的位置（以及原因）
- 如何處理**多個帳號**（設定檔 + 每個工作階段的覆寫）

OpenClaw 也支援隨附其自有 OAuth 或 API 金鑰流程的 **provider plugins**。可透過以下方式執行： 透過以下方式執行：

```bash
openclaw models auth login --provider <id>
```

## 權杖接收端（為何存在）

OAuth 提供者通常會在登入／重新整理流程中鑄造一個**新的重新整理權杖**。 某些提供者（或 OAuth 用戶端）在為相同使用者／應用程式發行新權杖時，可能會使較舊的重新整理權杖失效。

實際症狀：

- 你同時透過 OpenClaw _以及_ Claude Code／Codex CLI 登入 → 其中一個之後會隨機被「登出」

為了降低這種情況，OpenClaw 將 `auth-profiles.json` 視為 **權杖匯集點**：

- 執行階段會從**單一位置**讀取憑證
- 我們可以保留多個設定檔，並以確定性的方式進行路由

## 儲存（權杖存放位置）

祕密資料會 **依代理程式（per-agent）** 儲存：

- 驗證設定檔（OAuth + API 金鑰）：`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- 執行階段快取（自動管理；請勿編輯）：`~/.openclaw/agents/<agentId>/agent/auth.json`

舊版僅匯入用檔案（仍支援，但不是主要儲存位置）：

- `~/.openclaw/credentials/oauth.json`（首次使用時會匯入到 `auth-profiles.json`）

以上所有項目也都遵循 `$OPENCLAW_STATE_DIR`（狀態目錄覆寫）。 以上所有項目也都遵循 `$OPENCLAW_STATE_DIR`（狀態目錄覆寫）。完整參考：[/gateway/configuration](/gateway/configuration#auth-storage-oauth--api-keys)

## Anthropic setup-token（訂閱驗證）

在任何機器上執行 `claude setup-token`，然後將其貼到 OpenClaw 中：

```bash
openclaw models auth setup-token --provider anthropic
```

如果你是在其他地方產生權杖，請手動貼上：

```bash
openclaw models auth paste-token --provider anthropic
```

驗證：

```bash
openclaw models status
```

## OAuth 交換（登入如何運作）

OpenClaw 的互動式登入流程實作於 `@mariozechner/pi-ai`，並整合至精靈／指令中。

### Anthropic（Claude Pro/Max）setup-token

流程形態：

1. 執行 `claude setup-token`
2. 將權杖貼到 OpenClaw
3. 儲存為權杖驗證設定檔（不重新整理）

精靈路徑為 `openclaw onboard` → 驗證選擇 `setup-token`（Anthropic）。

### OpenAI Codex（ChatGPT OAuth）

流程形態（PKCE）：

1. 產生 PKCE verifier／challenge + 隨機 `state`
2. 開啟 `https://auth.openai.com/oauth/authorize?...`
3. 嘗試在 `http://127.0.0.1:1455/auth/callback` 接收回呼
4. 若回呼無法綁定（或你在遠端／無頭環境），請貼上重新導向 URL／代碼
5. 在 `https://auth.openai.com/oauth/token` 進行交換
6. 從存取權杖中擷取 `accountId`，並儲存 `{ access, refresh, expires, accountId }`

精靈路徑為 `openclaw onboard` → 驗證選擇 `openai-codex`。

## 重新整理 + 到期

設定檔會儲存一個 `expires` 時間戳。

在執行階段：

- 若 `expires` 在未來 → 使用已儲存的存取權杖
- 若已到期 → 在檔案鎖定下重新整理，並覆寫已儲存的認證

重新整理流程是自動的；通常不需要手動管理權杖。

## 多帳號（設定檔）+ 路由

有兩種模式：

### 1）首選：分離代理程式

如果你希望「個人」與「工作」完全不互相影響，請使用隔離的代理程式（獨立的工作階段 + 認證 + 工作區）：

```bash
openclaw agents add work
openclaw agents add personal
```

接著為每個 agent 設定驗證（精靈），並將對話路由到正確的 agent。

### 2）進階：單一代理程式中的多個設定檔

`auth-profiles.json` 支援同一提供者的多個設定檔 ID。

選擇要使用的設定檔：

- 透過設定排序進行全域指定（`auth.order`）
- 透過 `/model ...@<profileId>` 進行每個工作階段的指定

範例（工作階段覆寫）：

- `/model Opus@anthropic:work`

查看目前有哪些設定檔 ID：

- `openclaw channels list --json`（顯示 `auth[]`）

相關文件：

- [/concepts/model-failover](/concepts/model-failover)（輪替 + 冷卻規則）
- [/tools/slash-commands](/tools/slash-commands)（指令介面）
