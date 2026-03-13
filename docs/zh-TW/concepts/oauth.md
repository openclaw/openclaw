---
summary: "OAuth in OpenClaw: token exchange, storage, and multi-account patterns"
read_when:
  - You want to understand OpenClaw OAuth end-to-end
  - You hit token invalidation / logout issues
  - You want setup-token or OAuth auth flows
  - You want multiple accounts or profile routing
title: OAuth
---

# OAuth

OpenClaw 支援透過 OAuth 的「訂閱認證」，適用於提供此功能的服務商（特別是 **OpenAI Codex (ChatGPT OAuth)**）。對於 Anthropic 訂閱，請使用 **setup-token** 流程。過去部分使用者在 Claude Code 以外使用 Anthropic 訂閱時受到限制，因此請視為使用者自行承擔風險，並自行確認 Anthropic 當前政策。OpenAI Codex OAuth 明確支援用於像 OpenClaw 這類外部工具。此頁面說明：

對於 Anthropic 的正式環境，API 金鑰認證比訂閱 setup-token 認證更安全且建議使用。

- OAuth **token 交換** 的運作方式（PKCE）
- token 的 **儲存位置**（以及原因）
- 如何處理 **多帳號**（設定檔 + 每次會話覆寫）

OpenClaw 也支援內建 OAuth 或 API 金鑰流程的 **服務商外掛**。可透過以下指令執行：

```bash
openclaw models auth login --provider <id>
```

## token 匯集點（存在的原因）

OAuth 服務商通常會在登入或刷新流程中產生 **新的 refresh token**。部分服務商（或 OAuth 用戶端）在同一使用者/應用發行新 token 時，會使舊的 refresh token 失效。

實際現象：

- 你同時透過 OpenClaw 和 Claude Code / Codex CLI 登入 → 其中一方可能會隨機被「登出」

為減少此狀況，OpenClaw 將 `auth-profiles.json` 視為 **token 匯集點**：

- 執行時從 **同一處** 讀取認證資料
- 可維護多個設定檔並確保路由行為可預期

## 儲存（token 存放位置）

機密資料依 **代理人** 分開儲存：

- 認證設定檔（OAuth + API 金鑰 + 選用的值層級參考）：`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- 舊版相容檔案：`~/.openclaw/agents/<agentId>/agent/auth.json`
  （發現靜態 `api_key` 專案時會清除）

舊版僅匯入檔案（仍支援，但非主要儲存方式）：

- `~/.openclaw/credentials/oauth.json`（首次使用時匯入至 `auth-profiles.json`）

上述所有專案也會遵守 `$OPENCLAW_STATE_DIR`（狀態目錄覆寫）。完整參考：[/gateway/configuration](/gateway/configuration#auth-storage-oauth--api-keys)

關於靜態密鑰參考與執行時快照啟用行為，請參考 [Secrets Management](/gateway/secrets)。

## Anthropic setup-token（訂閱認證）

<Warning>
Anthropic setup-token 支援屬於技術相容性，並非政策保證。
Anthropic 過去曾封鎖 Claude Code 以外的部分訂閱使用。
請自行判斷是否使用訂閱認證，並確認 Anthropic 當前條款。
</Warning>

在任一機器上執行 `claude setup-token`，然後將結果貼到 OpenClaw：

```bash
openclaw models auth setup-token --provider anthropic
```

如果你是在其他地方產生 token，請手動貼上：

```bash
openclaw models auth paste-token --provider anthropic
```

驗證：

```bash
openclaw models status
```

## OAuth 交換（登入流程說明）

OpenClaw 的互動式登入流程實作於 `@mariozechner/pi-ai`，並整合至精靈／指令中。

### Anthropic setup-token

流程形態：

1. 執行 `claude setup-token`
2. 將 token 貼到 OpenClaw
3. 以 token 認證設定檔儲存（無刷新）

精靈路徑為 `openclaw onboard` → 認證選擇 `setup-token`（Anthropic）。

### OpenAI Codex（ChatGPT OAuth）

OpenAI Codex OAuth 明確支援在 Codex CLI 以外使用，包括 OpenClaw 工作流程。

流程形態（PKCE）：

1. 產生 PKCE 驗證器/挑戰碼 + 隨機 `state`
2. 開啟 `https://auth.openai.com/oauth/authorize?...`
3. 嘗試在 `http://127.0.0.1:1455/auth/callback` 捕捉回調
4. 若無法綁定回調（或你是遠端/無頭模式），請貼上重定向 URL/程式碼
5. 在 `https://auth.openai.com/oauth/token` 交換
6. 從存取權杖中擷取 `accountId` 並儲存 `{ access, refresh, expires, accountId }`

精靈路徑為 `openclaw onboard` → 認證選擇 `openai-codex`。

## 刷新與過期

設定檔會儲存 `expires` 時戳。

執行時：

- 若 `expires` 在未來 → 使用已儲存的存取權杖
- 若已過期 → 透過檔案鎖刷新並覆寫已儲存的憑證

刷新流程是自動的；通常不需要手動管理 token。

## 多帳號（設定檔）與路由

兩種模式：

### 1) 推薦做法：分開代理人

如果你希望「個人」和「工作」帳號完全不互動，請使用獨立代理人（分開的會話 + 認證 + 工作區）：

```bash
openclaw agents add work
openclaw agents add personal
```

接著為每個代理人設定認證（精靈引導），並將聊天導向正確的代理人。

### 2) 進階做法：一個代理人多個設定檔

`auth-profiles.json` 支援同一服務提供者的多個設定檔 ID。

選擇要使用的設定檔：

- 透過設定排序全域指定 (`auth.order`)
- 透過 `/model ...@<profileId>` 於每個會話指定

範例（會話覆寫）：

- `/model Opus@anthropic:work`

如何查看有哪些設定檔 ID：

- `openclaw channels list --json`（會顯示 `auth[]`）

相關文件：

- [/concepts/model-failover](/concepts/model-failover)（輪替 + 冷卻規則）
- [/tools/slash-commands](/tools/slash-commands)（指令介面）
