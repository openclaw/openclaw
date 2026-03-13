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

OpenClaw 支援透過 OAuth 的「訂閱認證」，適用於提供此功能的供應商（特別是 **OpenAI Codex (ChatGPT OAuth)**）。對於 Anthropic 訂閱，請使用 **setup-token** 流程。過去，某些用戶在 Claude Code 之外使用 Anthropic 訂閱受到限制，因此請將其視為用戶選擇的風險，並自行驗證當前的 Anthropic 政策。OpenAI Codex OAuth 明確支援在像 OpenClaw 這樣的外部工具中使用。本頁面說明：

對於在生產環境中的 Anthropic，API 金鑰認證是比訂閱設置token認證更安全的推薦方式。

- OAuth **token exchange** 的運作方式 (PKCE)
- token是如何被 **儲存** 的 (以及原因)
- 如何處理 **多個帳戶** (個人資料 + 每次會話的覆蓋)

OpenClaw 也支援 **提供者插件**，這些插件可以自帶 OAuth 或 API 金鑰流程。可以透過以下方式執行它們：

```bash
openclaw models auth login --provider <id>
```

## token sink（為什麼存在）

OAuth 提供者通常在登入/刷新流程中發行 **新的刷新token**。某些提供者（或 OAuth 用戶端）在為同一用戶/應用程式發行新的刷新token時，可能會使舊的刷新token失效。

[[BLOCK_1]]

- 您可以透過 OpenClaw _以及_ Claude Code / Codex CLI 登入 → 其中一個會隨機在稍後被“登出”

為了減少這一點，OpenClaw 將 `auth-profiles.json` 視為一個 **token sink**：

- 執行時從 **一個地方** 讀取憑證
- 我們可以保留多個設定檔並以確定性方式進行路由

## Storage (tokens 存放的位置)

Secrets are stored **per-agent**:

- 認證設定檔（OAuth + API 金鑰 + 可選的值層參考）：`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- 舊版相容性檔案：`~/.openclaw/agents/<agentId>/agent/auth.json`
  （靜態 `api_key` 專案在被發現時會被清除）

舊版僅供匯入的檔案（仍然支援，但不是主要儲存）：

- `~/.openclaw/credentials/oauth.json`（在首次使用時匯入至 `auth-profiles.json`）

以上所有內容也遵循 `$OPENCLAW_STATE_DIR`（狀態目錄覆寫）。完整參考：[/gateway/configuration](/gateway/configuration#auth-storage-oauth--api-keys)

有關靜態密鑰引用和執行時快照啟用行為，請參閱 [Secrets Management](/gateway/secrets)。

## Anthropic setup-token (訂閱認證)

<Warning>
Anthropic 的 setup-token 支援是技術相容性，而非政策保證。
Anthropic 過去曾阻止某些訂閱在 Claude Code 之外的使用。
請自行決定是否使用訂閱認證，並確認 Anthropic 當前的條款。
</Warning>

在任何機器上執行 `claude setup-token`，然後將其粘貼到 OpenClaw 中：

```bash
openclaw models auth setup-token --provider anthropic
```

如果您在其他地方生成了 token，請手動貼上：

```bash
openclaw models auth paste-token --provider anthropic
```

[[BLOCK_1]]

```bash
openclaw models status
```

## OAuth 交換（登入如何運作）

OpenClaw 的互動式登入流程實作在 `@mariozechner/pi-ai` 並連接到精靈/指令中。

### Anthropic setup-token

Flow shape:

1. 執行 `claude setup-token`
2. 將 token 貼上到 OpenClaw
3. 儲存為一個 token 認證檔案（不需刷新）

巫師路徑是 `openclaw onboard` → 認證選擇 `setup-token` (Anthropic)。

### OpenAI Codex (ChatGPT OAuth)

OpenAI Codex OAuth 明確支援在 Codex CLI 之外使用，包括 OpenClaw 工作流程。

[[BLOCK_1]]  
Flow shape (PKCE):  
[[INLINE_1]]

1. 生成 PKCE 驗證器/挑戰 + 隨機 `state`
2. 開啟 `https://auth.openai.com/oauth/authorize?...`
3. 嘗試在 `http://127.0.0.1:1455/auth/callback` 捕獲回調
4. 如果回調無法綁定（或您是遠端/無頭模式），請貼上重定向 URL/程式碼
5. 在 `https://auth.openai.com/oauth/token` 進行交換
6. 從存取token中提取 `accountId` 並儲存 `{ access, refresh, expires, accountId }`

Wizard 路徑是 `openclaw onboard` → 認證選擇 `openai-codex`。

## Refresh + expiry

Profiles store an `expires` timestamp.

在執行時：

- 如果 `expires` 在未來 → 使用儲存的存取權杖
- 如果過期 → 在檔案鎖定下刷新並覆寫儲存的憑證

刷新流程是自動的；您通常不需要手動管理 token。

## 多個帳戶（個人資料）+ 路由

[[BLOCK_1]]  
兩種模式：  
[[BLOCK_2]]

### 1) 首選：分開的代理人

如果您希望「個人」和「工作」之間永不互動，請使用隔離代理（獨立的會話 + 憑證 + 工作區）：

```bash
openclaw agents add work
openclaw agents add personal
```

然後為每個代理設定身份驗證（精靈），並將聊天路由到正確的代理。

### 2) 進階：在一個代理中使用多個設定檔

`auth-profiles.json` 支援同一提供者的多個設定檔 ID。

選擇使用的設定檔：

- 全球範圍內透過設定排序 (`auth.order`)
- 每個會話透過 `/model ...@<profileId>`

[[BLOCK_1]]  
範例（會話覆寫）：  
[[BLOCK_1]]

`/model Opus@anthropic:work`

如何查看存在的設定檔 ID：

- `openclaw channels list --json` (顯示 `auth[]`)

相關文件：

- [/concepts/model-failover](/concepts/model-failover) (輪替 + 冷卻規則)
- [/tools/slash-commands](/tools/slash-commands) (指令介面)
