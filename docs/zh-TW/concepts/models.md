---
summary: "Models CLI：列表、設定、別名、遞補、掃描、狀態"
read_when:
  - 新增或修改 models CLI（models list/set/scan/aliases/fallbacks）
  - 更改模型遞補行為或選取使用者體驗（UX）
  - 更新模型掃描探測（工具/影像）
title: "Models CLI"
---

# Models CLI

關於憑證設定檔輪替、冷卻時間，以及其與遞補（fallbacks）的互動方式，請參閱 [/concepts/model-failover](/concepts/model-failover)。
供應商快速概覽與範例請見：[/concepts/model-providers](/concepts/model-providers)。

## 模型選取機制

OpenClaw 依以下順序選取模型：

1. **主要（Primary）**模型（`agents.defaults.model.primary` 或 `agents.defaults.model`）。
2. `agents.defaults.model.fallbacks` 中的**遞補（Fallbacks）**模型（依序排列）。
3. 在移動到下一個模型之前，會在供應商內部先進行**供應商憑證容錯移轉**。

相關項目：

- `agents.defaults.models` 是 OpenClaw 可使用的模型白名單/目錄（加上別名）。
- `agents.defaults.imageModel` **僅在**主要模型無法接受影像時使用。
- 每個智慧代理的預設值可以透過 `agents.list[].model` 加上綁定（bindings）來覆蓋 `agents.defaults.model`（請參閱 [/concepts/multi-agent](/concepts/multi-agent)）。

## 快速模型選擇建議（經驗談）

- **GLM**：在程式編寫/工具呼叫方面表現較佳。
- **MiniMax**：在寫作與語感方面表現較佳。

## 設定精靈（推薦）

如果您不想手動編輯設定，請執行新手導覽精靈：

```bash
openclaw onboard
```

它可以為常見供應商設定模型與憑證，包括 **OpenAI Code (Codex) 訂閱**（OAuth）和 **Anthropic**（建議使用 API key；也支援 `claude setup-token`）。

## 設定鍵值（概覽）

- `agents.defaults.model.primary` 與 `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` 與 `agents.defaults.imageModel.fallbacks`
- `agents.defaults.models`（白名單 + 別名 + 供應商參數）
- `models.providers`（寫入 `models.json` 的自訂供應商）

模型參照會被正規化為小寫。像 `z.ai/*` 這樣的供應商別名會正規化為 `zai/*`。

供應商設定範例（包括 OpenCode Zen）位於 [/gateway/configuration](/gateway/configuration#opencode-zen-multi-model-proxy)。

## 「Model is not allowed」（以及為何停止回覆）

如果設定了 `agents.defaults.models`，它會成為 `/model` 和工作階段覆蓋的**白名單**。當使用者選取不在該白名單中的模型時，OpenClaw 會傳回：

```
Model "provider/model" is not allowed. Use /model to list available models.
```

這發生在產生正常回覆**之前**，因此訊息可能會感覺像是「沒有回應」。修正方法如下：

- 將模型新增至 `agents.defaults.models`，或
- 清除白名單（移除 `agents.defaults.models`），或
- 從 `/model list` 中選取模型。

白名單設定範例：

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

## 在對話中切換模型 (`/model`)

您可以在不重啟的情況下為目前的工作階段切換模型：

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model status
```

注意事項：

- `/model`（以及 `/model list`）是一個精簡的數字選取器（模型系列 + 可用的供應商）。
- `/model <#>` 從該選取器中選取。
- `/model status` 是詳細檢視（憑證候選，以及在設定後顯示供應商端點 `baseUrl` + `api` 模式）。
- 模型參照透過分割**第一個** `/` 來解析。輸入 `/model <ref>` 時請使用 `provider/model`。
- 如果模型 ID 本身包含 `/`（如 OpenRouter 樣式），您必須包含供應商前綴（範例：`/model openrouter/moonshotai/kimi-k2`）。
- 如果省略供應商，OpenClaw 會將輸入視為別名或**預設供應商**的模型（僅在模型 ID 中沒有 `/` 時有效）。

完整的指令行為/設定請見：[斜線指令](/tools/slash-commands)。

## CLI 指令

```bash
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
```

`openclaw models`（不含子指令）是 `models status` 的捷徑。

### `models list`

預設顯示已設定的模型。實用旗標：

- `--all`：完整目錄
- `--local`：僅限本地供應商
- `--provider <name>`：按供應商篩選
- `--plain`：每行一個模型
- `--json`：機器可讀的輸出

### `models status`

顯示解析後的主要模型、遞補模型、影像模型，以及已設定供應商的憑證概覽。它也會顯示在憑證儲存庫中找到的設定檔之 OAuth 到期狀態（預設在 24 小時內發出警告）。`--plain` 僅列印解析後的主要模型。
OAuth 狀態一律會顯示（並包含在 `--json` 輸出中）。如果已設定的供應商沒有認證資訊，`models status` 會列印 **Missing auth** 區塊。
JSON 包含 `auth.oauth`（警告期間 + 設定檔）和 `auth.providers`（每個供應商的有效憑證）。
自動化請使用 `--check`（遺失/過期時結束代碼為 `1`，即將過期時為 `2`）。

建議的 Anthropic 憑證是 Claude Code CLI 的 setup-token（可在任何地方執行；如有需要，請貼到 Gateway 主機上）：

```bash
claude setup-token
openclaw models status
```

## 掃描（OpenRouter 免費模型）

`openclaw models scan` 會檢查 OpenRouter 的**免費模型目錄**，並可選擇性地探測模型是否支援工具與影像。

關鍵旗標：

- `--no-probe`：跳過即時探測（僅限元數據）
- `--min-params <b>`：最小參數大小（十億，billions）
- `--max-age-days <days>`：跳過較舊的模型
- `--provider <name>`：供應商前綴篩選
- `--max-candidates <n>`：遞補列表大小
- `--set-default`：將 `agents.defaults.model.primary` 設定為第一個選取項
- `--set-image`：將 `agents.defaults.imageModel.primary` 設定為第一個影像選取項

探測需要 OpenRouter API key（來自憑證設定檔或 `OPENROUTER_API_KEY`）。若無金鑰，請使用 `--no-probe` 僅列出候選模型。

掃描結果排序依據：

1. 影像支援
2. 工具延遲
3. 上下文大小
4. 參數數量

輸入

- OpenRouter `/models` 列表（篩選 `:free`）
- 需要來自憑證設定檔或 `OPENROUTER_API_KEY` 的 OpenRouter API key（請參閱 [/environment](/help/environment)）
- 選用篩選器：`--max-age-days`、`--min-params`、`--provider`、`--max-candidates`
- 探測控制：`--timeout`、`--concurrency`

在 TTY 中執行時，您可以互動式地選取遞補模型。在非互動模式下，請傳遞 `--yes` 以接受預設值。

## 模型註冊表 (`models.json`)

`models.providers` 中的自訂供應商會寫入智慧代理目錄下的 `models.json`（預設為 `~/.openclaw/agents/<agentId>/models.json`）。除非 `models.mode` 設定為 `replace`，否則此檔案預設會進行合併。
