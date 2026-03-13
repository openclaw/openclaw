---
summary: "Models CLI: list, set, aliases, fallbacks, scan, status"
read_when:
  - Adding or modifying models CLI (models list/set/scan/aliases/fallbacks)
  - Changing model fallback behavior or selection UX
  - Updating model scan probes (tools/images)
title: Models CLI
---

# Models CLI

請參閱 [/concepts/model-failover](/concepts/model-failover) 以了解身份驗證設定檔的輪換、冷卻時間，以及這些如何與備援互動。快速的提供者概述和範例請參見: [/concepts/model-providers](/concepts/model-providers)。

## 模型選擇的運作方式

OpenClaw 依照以下順序選擇模型：

1. **主要**模型 (`agents.defaults.model.primary` 或 `agents.defaults.model`)。
2. **備援**在 `agents.defaults.model.fallbacks` 中（依序）。
3. **提供者認證故障轉移**發生在提供者內部，然後才會轉移到下一個模型。

[[BLOCK_1]]

- `agents.defaults.models` 是 OpenClaw 可以使用的模型的允許清單/目錄（以及別名）。
- `agents.defaults.imageModel` 僅在主要模型無法接受圖像時使用。
- 每個代理的預設值可以通過 `agents.list[].model` 及綁定來覆蓋 `agents.defaults.model`（詳見 [/concepts/multi-agent](/concepts/multi-agent)）。

## Quick model policy

- 將您的主要模型設置為可用的最強最新一代模型。
- 對於成本/延遲敏感的任務和風險較低的聊天，使用備用方案。
- 對於啟用工具的代理或不受信任的輸入，避免使用較舊/較弱的模型層級。

## 設定精靈（推薦）

如果您不想手動編輯設定，請執行入門精靈：

```bash
openclaw onboard
```

它可以為常見的提供者設置模型 + 認證，包括 **OpenAI Code (Codex) 訂閱** (OAuth) 和 **Anthropic** (API 金鑰或 `claude setup-token`).

## Config keys (概述)

- `agents.defaults.model.primary` 和 `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` 和 `agents.defaults.imageModel.fallbacks`
- `agents.defaults.models` (允許清單 + 別名 + 提供者參數)
- `models.providers` (自訂提供者寫入 `models.json`)

模型引用被標準化為小寫。提供者別名如 `z.ai/*` 標準化為 `zai/*`。

提供者設定範例（包括 OpenCode）位於 [/gateway/configuration](/gateway/configuration#opencode)。

## “模型不被允許”（以及為什麼回覆會停止）

如果 `agents.defaults.models` 被設定，它將成為 `/model` 的 **允許清單** 以及會話覆蓋的允許清單。當用戶選擇一個不在該允許清單中的模型時，OpenClaw 會返回：

```
Model "provider/model" is not allowed. Use /model to list available models.
```

這發生在正常回覆生成**之前**，因此訊息可能會讓人感覺像是「沒有回應」。解決方法是：

- 將模型新增至 `agents.defaults.models`，或
- 清除允許清單（移除 `agents.defaults.models`），或
- 從 `/model list` 中選擇一個模型。

範例允許清單設定：

```json5
{
  agent: {
    model: { primary: "anthropic/claude-sonnet-4-5" },
    models: {
      "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
      "anthropic/claude-opus-4-6": { alias: "Opus" },
    },
  },
}
```

## 切換聊天中的模型 (`/model`)

您可以在當前會話中切換模型，而無需重新啟動：

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model status
```

Notes:

- `/model`（和 `/model list`）是一個緊湊的編號選擇器（模型系列 + 可用提供者）。
- 在 Discord 上，`/model` 和 `/models` 會打開一個互動式選擇器，包含提供者和模型下拉選單以及提交步驟。
- `/model <#>` 從該選擇器中選擇。
- `/model status` 是詳細視圖（認證候選者，以及在設定時的提供者端點 `baseUrl` + `api` 模式）。
- 模型引用是通過在 **第一個** `/` 上進行分割來解析的。輸入 `/model <ref>` 時請使用 `provider/model`。
- 如果模型 ID 本身包含 `/`（OpenRouter 風格），則必須包含提供者前綴（範例：`/model openrouter/moonshotai/kimi-k2`）。
- 如果省略提供者，OpenClaw 將該輸入視為 **預設提供者** 的別名或模型（僅在模型 ID 中沒有 `/` 時有效）。

完整的指令行為/設定: [斜線指令](/tools/slash-commands)。

## CLI 命令

bash
openclaw models list
openclaw models status
openclaw models set <provider/model>
openclaw models set-image <provider/model>

openclaw 模型別名列表  
openclaw 模型別名新增 <alias> <provider/model>  
openclaw 模型別名移除 <alias>

openclaw 模型回退列表  
openclaw 模型回退新增 <provider/model>  
openclaw 模型回退移除 <provider/model>  
openclaw 模型回退清除

openclaw models image-fallbacks list  
openclaw models image-fallbacks add <provider/model>  
openclaw models image-fallbacks remove <provider/model>  
openclaw models image-fallbacks clear

`openclaw models` (無子命令) 是 `models status` 的快捷方式。

### `models list`

顯示預設設定的模型。實用的標誌：

- `--all`: 完整目錄
- `--local`: 僅限本地供應商
- `--provider <name>`: 按供應商篩選
- `--plain`: 每行一個模型
- `--json`: 機器可讀的輸出

### `models status`

顯示已解析的主要模型、備援、影像模型，以及已設定提供者的授權概覽。它還顯示在授權儲存中找到的個人資料的 OAuth 到期狀態（預設在 24 小時內發出警告）。`--plain` 僅列印已解析的主要模型。OAuth 狀態始終顯示（並包含在 `--json` 輸出中）。如果設定的提供者沒有憑證，`models status` 會列印 **缺少授權** 區段。JSON 包含 `auth.oauth`（警告窗口 + 個人資料）和 `auth.providers`（每個提供者的有效授權）。使用 `--check` 進行自動化（當缺少/過期時退出 `1`，當即將過期時退出 `2`）。

身份驗證選擇取決於提供者/帳戶。對於始終在線的網關主機，API 金鑰通常是最可預測的；也支援訂閱token流程。

[[BLOCK_1]]  
範例 (Anthropic setup-token):  
[[BLOCK_1]]

```bash
claude setup-token
openclaw models status
```

## 掃描 (OpenRouter 免費模型)

`openclaw models scan` 檢查 OpenRouter 的 **免費模型目錄**，並可以選擇性地探查模型的工具和影像支援。

關鍵標誌：

- `--no-probe`: 跳過即時探測（僅限元資料）
- `--min-params <b>`: 最小參數大小（十億）
- `--max-age-days <days>`: 跳過舊版模型
- `--provider <name>`: 供應商前綴過濾器
- `--max-candidates <n>`: 備用列表大小
- `--set-default`: 將 `agents.defaults.model.primary` 設定為第一個選擇
- `--set-image`: 將 `agents.defaults.imageModel.primary` 設定為第一個影像選擇

Probing 需要一個 OpenRouter API 金鑰（來自認證設定或 `OPENROUTER_API_KEY`）。如果沒有金鑰，請使用 `--no-probe` 僅列出候選項。

掃描結果的排名依據為：

1. 圖片支援
2. 工具延遲
3. 上下文大小
4. 參數數量

[[BLOCK_1]]

- OpenRouter `/models` 列表 (過濾 `:free`)
- 需要從認證檔案或 `OPENROUTER_API_KEY` 獲取 OpenRouter API 金鑰 (詳情請參見 [/environment](/help/environment))
- 可選過濾器: `--max-age-days`, `--min-params`, `--provider`, `--max-candidates`
- 探測控制: `--timeout`, `--concurrency`

當在 TTY 中執行時，您可以互動式地選擇後備選項。在非互動模式下，傳遞 `--yes` 以接受預設值。

## 模型註冊 (`models.json`)

自訂提供者在 `models.providers` 中寫入 `models.json` 的代理目錄下（預設為 `~/.openclaw/agents/<agentId>/agent/models.json`）。此檔案預設會合併，除非 `models.mode` 設定為 `replace`。

合併模式優先順序以匹配提供者 ID：

- 非空的 `baseUrl` 已經存在於代理 `models.json` 中則獲勝。
- 代理 `models.json` 中的非空 `apiKey` 只有在該提供者在當前的 config/auth-profile 上下文中不是由 SecretRef 管理時才獲勝。
- 由 SecretRef 管理的提供者 `apiKey` 值是從來源標記中刷新（`ENV_VAR_NAME` 用於環境引用，`secretref-managed` 用於檔案/執行引用），而不是持久化已解析的秘密。
- 由 SecretRef 管理的提供者標頭值是從來源標記中刷新（`secretref-env:ENV_VAR_NAME` 用於環境引用，`secretref-managed` 用於檔案/執行引用）。
- 空的或缺失的代理 `apiKey`/`baseUrl` 會回退到設定 `models.providers`。
- 其他提供者欄位是從設定和標準化目錄數據中刷新。

標記持久性是來源權威的：OpenClaw 從活動來源設定快照（解析前）寫入標記，而不是從解析後的執行時秘密值寫入。這適用於每當 OpenClaw 重新生成 `models.json` 時，包括像 `openclaw agent` 這樣的命令驅動路徑。
