---
summary: "Models CLI: list, set, aliases, fallbacks, scan, status"
read_when:
  - Adding or modifying models CLI (models list/set/scan/aliases/fallbacks)
  - Changing model fallback behavior or selection UX
  - Updating model scan probes (tools/images)
title: Models CLI
---

# Models CLI

請參考 [/concepts/model-failover](/concepts/model-failover) 了解認證設定檔輪替、冷卻時間，以及這些如何與備援機制互動。
快速的供應商概覽與範例：[/concepts/model-providers](/concepts/model-providers)。

## 模型選擇運作方式

OpenClaw 按照以下順序選擇模型：

1. **主要**模型 (`agents.defaults.model.primary` 或 `agents.defaults.model`)。
2. **備援**模型，依序在 `agents.defaults.model.fallbacks` 中。
3. **供應商認證故障轉移**會在同一供應商內發生，然後才會切換到下一個模型。

相關資訊：

- `agents.defaults.models` 是 OpenClaw 可使用的模型白名單/目錄（含別名）。
- `agents.defaults.imageModel` 僅在主要模型無法接受圖片時使用。
- 每個代理的預設值可透過 `agents.list[].model` 及綁定覆寫 `agents.defaults.model`（詳見 [/concepts/multi-agent](/concepts/multi-agent)）。

## 快速模型策略

- 將主要模型設定為你可用的最強大且最新世代模型。
- 對於成本/延遲敏感的任務及風險較低的聊天，使用備援模型。
- 對於具工具功能的代理或不受信任的輸入，避免使用較舊或較弱的模型階層。

## 設定精靈（推薦）

如果你不想手動編輯設定，請執行入門精靈：

```bash
openclaw onboard
```

它可以為常見供應商設定模型與認證，包括 **OpenAI Code (Codex) 訂閱**（OAuth）和 **Anthropic**（API 金鑰或 `claude setup-token`）。

## 設定鍵（概覽）

- `agents.defaults.model.primary` 和 `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` 和 `agents.defaults.imageModel.fallbacks`
- `agents.defaults.models`（白名單 + 別名 + 供應商參數）
- `models.providers`（自訂供應商寫入 `models.json`）

模型參考會被正規化為小寫。像 `z.ai/*` 這類的提供者別名會正規化為 `zai/*`。

提供者設定範例（包含 OpenCode）位於
[/gateway/configuration](/gateway/configuration#opencode)。

## 「模型不被允許」(以及為何回覆會停止)

如果設定了 `agents.defaults.models`，它會成為 `/model` 以及會話覆寫的**允許清單**。當使用者選擇的模型不在該允許清單中時，
OpenClaw 會回傳：

```
Model "provider/model" is not allowed. Use /model to list available models.
```

這會在正常回覆產生之前發生，因此訊息可能會讓人感覺「沒有回應」。解決方法是：

- 將模型加入 `agents.defaults.models`，或
- 清空允許清單（移除 `agents.defaults.models`），或
- 從 `/model list` 選擇一個模型。

允許清單設定範例：

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

## 在聊天中切換模型 (`/model`)

你可以在不重啟的情況下切換當前會話的模型：

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model status
```

注意事項：

- `/model`（和 `/model list`）是簡潔的編號選擇器（模型家族 + 可用提供者）。
- 在 Discord 上，`/model` 和 `/models` 會開啟一個互動式選擇器，包含提供者和模型下拉選單以及提交步驟。
- `/model <#>` 從該選擇器中選擇。
- `/model status` 是詳細視圖（授權候選者，及設定時的提供者端點 `baseUrl` + `api` 模式）。
- 模型參考會以**第一個** `/` 進行拆分。輸入 `/model <ref>` 時請使用 `provider/model`。
- 如果模型 ID 本身包含 `/`（OpenRouter 風格），必須包含提供者前綴（範例：`/model openrouter/moonshotai/kimi-k2`）。
- 如果省略提供者，OpenClaw 會將輸入視為別名或**預設提供者**的模型（僅當模型 ID 中沒有 `/` 時有效）。

完整指令行為/設定說明：[Slash commands](/tools/slash-commands)。

## CLI 指令

bash
openclaw models list
openclaw models status
openclaw models set <provider/model>
openclaw models set-image <provider/model>

openclaw models aliases list
openclaw models aliases add <alias> <provider/model>
openclaw models aliases remove <alias>

openclaw models fallbacks list
openclaw models fallbacks add <provider/model>
openclaw models fallbacks remove <provider/model>
openclaw models fallbacks clear

openclaw models image-fallbacks list
openclaw models image-fallbacks add <provider/model>
openclaw models image-fallbacks remove <provider/model>
openclaw models image-fallbacks clear

`openclaw models`（無子指令）是 `models status` 的捷徑。

### `models list`

預設顯示已設定的模型。常用參數：

- `--all`：完整目錄
- `--local`：僅本地提供者
- `--provider <name>`：依提供者篩選
- `--plain`：每行顯示一個模型
- `--json`：機器可讀輸出

### `models status`

顯示解析後的主要模型、備援模型、影像模型，以及已設定提供者的授權概覽。  
同時會顯示在授權存儲中找到的設定檔的 OAuth 到期狀態（預設在 24 小時內警告）。`--plain` 僅列印解析後的主要模型。  
OAuth 狀態始終顯示（並包含在 `--json` 輸出中）。若設定的提供者沒有憑證，`models status` 會列印 **缺少授權** 區塊。  
JSON 輸出包含 `auth.oauth`（警告視窗 + 設定檔）和 `auth.providers`（每個提供者的有效授權）。  
自動化請使用 `--check`（缺少或過期時退出 `1`，即將過期時退出 `2`）。

授權選擇依提供者/帳號而定。對於持續運作的閘道主機，API 金鑰通常是最穩定的；也支援訂閱 token 流程。

範例（Anthropic setup-token）：

```bash
claude setup-token
openclaw models status
```

## 掃描（OpenRouter 免費模型）

`openclaw models scan` 檢查 OpenRouter 的 **免費模型目錄**，並可選擇性探測模型是否支援工具和影像。

主要參數：

- `--no-probe`：跳過即時探測（僅限元資料）
- `--min-params <b>`：最小參數大小（以十億計）
- `--max-age-days <days>`：跳過較舊模型
- `--provider <name>`：供應商前綴過濾器
- `--max-candidates <n>`：備用清單大小
- `--set-default`：將 `agents.defaults.model.primary` 設為第一個選擇
- `--set-image`：將 `agents.defaults.imageModel.primary` 設為第一個影像選擇

探測需要 OpenRouter API 金鑰（來自認證設定檔或 `OPENROUTER_API_KEY`）。沒有金鑰時，使用 `--no-probe` 僅列出候選專案。

掃描結果排名依據：

1. 影像支援
2. 工具延遲
3. 上下文大小
4. 參數數量

輸入

- OpenRouter `/models` 清單（過濾 `:free`）
- 需要來自認證設定檔或 `OPENROUTER_API_KEY` 的 OpenRouter API 金鑰（參見 [/environment](/help/environment)）
- 可選過濾器：`--max-age-days`、`--min-params`、`--provider`、`--max-candidates`
- 探測控制：`--timeout`、`--concurrency`

在 TTY 環境下執行時，可互動式選擇備用方案。非互動模式下，傳入 `--yes` 以接受預設值。

## 模型註冊表 (`models.json`)

`models.providers` 中的自訂供應商會寫入代理目錄下的 `models.json`（預設為 `~/.openclaw/agents/<agentId>/agent/models.json`）。除非 `models.mode` 設為 `replace`，否則此檔案會被預設合併。

匹配供應商 ID 的合併模式優先順序：

- 代理 `models.json` 中已存在且非空的 `baseUrl` 優先。
- 代理 `models.json` 中非空的 `apiKey` 僅在該供應商未被當前設定/認證設定檔上下文以 SecretRef 管理時優先。
- SecretRef 管理的供應商 `apiKey` 值會從來源標記（環境變數參考為 `ENV_VAR_NAME`，檔案/執行參考為 `secretref-managed`）重新整理，而非持久化解析後的秘密。
- SecretRef 管理的供應商標頭值會從來源標記（環境變數參考為 `secretref-env:ENV_VAR_NAME`，檔案/執行參考為 `secretref-managed`）重新整理。
- 代理 `apiKey`/`baseUrl` 為空或缺失時，回退至設定 `models.providers`。
- 其他供應商欄位會從設定和標準化目錄資料重新整理。

標記持久化以來源為權威：OpenClaw 會從活動來源設定快照（解析前）寫入標記，而非從解析後的執行時秘密值寫入。
此規則適用於 OpenClaw 重新產生 `models.json` 的所有情況，包括由指令驅動的路徑如 `openclaw agent`。
