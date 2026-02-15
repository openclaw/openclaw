---
summary: "模型 CLI：清單、設定、別名、備用、掃描、狀態"
read_when:
  - 新增或修改模型 CLI（`models list`/`set`/`scan`/`aliases`/`fallbacks`）
  - 更改模型備用行為或選擇使用者體驗
  - 更新模型掃描探測（工具/圖片）
title: "模型 CLI"
---

# 模型 CLI

請參閱 [/concepts/model-failover](/concepts/model-failover) 以了解憑證設定檔輪替、冷卻時間，以及其與備用機制的互動方式。
供應商快速概述 + 範例：[/concepts/model-providers](/concepts/model-providers)。

## 模型選擇運作方式

OpenClaw 依序選擇模型：

1. **主要**模型（`agents.defaults.model.primary` 或 `agents.defaults.model`）。
2. `agents.defaults.model.fallbacks` 中的**備用**模型（依序）。
3. 在移至下一個模型之前，**供應商憑證故障轉移**發生在供應商內部。

相關：

- `agents.defaults.models` 是 OpenClaw 可以使用的模型（加上別名）的允許清單/目錄。
- `agents.defaults.imageModel` **僅在**主要模型無法接受圖片時使用。
- 每個代理程式的預設值可以透過 `agents.list[].model` 加上繫結來覆寫 `agents.defaults.model`（請參閱 [/concepts/multi-agent](/concepts/multi-agent)）。

## 快速模型選擇（經驗之談）

- **GLM**：在編碼/工具呼叫方面稍佳。
- **MiniMax**：更適合寫作和創造力。

## 設定精靈（推薦）

如果您不想手動編輯設定，請執行新手導覽精靈：

```bash
openclaw onboard
```

它可以為常見的供應商設定模型 + 憑證，包括 **OpenAI Code (Codex) 訂閱**（OAuth）和 **Anthropic**（推薦使用 API 金鑰；也支援 `claude setup-token`）。

## 設定鍵名（概述）

- `agents.defaults.model.primary` 和 `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` 和 `agents.defaults.imageModel.fallbacks`
- `agents.defaults.models`（允許清單 + 別名 + 供應商參數）
- `models.providers`（寫入 `models.json` 的自訂供應商）

模型參考會正規化為小寫。供應商別名，例如 `z.ai/*` 會正規化為 `zai/*`。

供應商設定範例（包括 OpenCode Zen）位於 [/gateway/configuration](/gateway/configuration#opencode-zen-multi-model-proxy)。

##「不允許使用模型」（以及為何回覆會停止）

如果設定了 `agents.defaults.models`，它會成為 `/model` 和工作階段覆寫的**允許清單**。當使用者選擇不在該允許清單中的模型時，OpenClaw 會回傳：

```
Model "provider/model" is not allowed. Use /model to list available models.
```

這會在產生正常回覆**之前**發生，因此訊息可能會感覺像是「沒有回應」。解決方案是：

- 將模型新增至 `agents.defaults.models`，或
- 清除允許清單（移除 `agents.defaults.models`），或
- 從 `/model list` 中選擇模型。

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

## 在聊天中切換模型（`/model`）

您可以切換目前工作階段的模型而無需重新啟動：

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model status
```

注意事項：

- `/model`（和 `/model list`）是一個緊湊的編號選擇器（模型家族 + 可用供應商）。
- `/model <#>` 從該選擇器中選擇。
- `/model status` 是詳細檢視（憑證候選者，以及在設定時，供應商端點 `baseUrl` + `api` 模式）。
- 模型參考透過在**第一個** `/` 上分割來解析。輸入 `/model <ref>` 時請使用 `provider/model`。
- 如果模型 ID 本身包含 `/`（OpenRouter 樣式），您必須包含供應商前綴（範例：`/model openrouter/moonshotai/kimi-k2`）。
- 如果您省略供應商，OpenClaw 會將輸入視為別名或**預設供應商**的模型（僅在模型 ID 中沒有 `/` 時有效）。

完整指令行為/設定：[斜線指令](/tools/slash-commands)。

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

`openclaw models`（沒有子指令）是 `models status` 的捷徑。

### `models list`

預設顯示已設定的模型。實用標誌：

- `--all`：完整目錄
- `--local`：僅限本地供應商
- `--provider <name>`：依供應商篩選
- `--plain`：每行一個模型
- `--json`：機器可讀輸出

### `models status`

顯示已解析的主要模型、備用模型、圖片模型，以及已設定供應商的憑證概覽。它還會顯示憑證儲存中找到的設定檔的 OAuth 到期狀態（預設在 24 小時內發出警告）。`--plain` 僅列印已解析的主要模型。
OAuth 狀態始終顯示（並包含在 `--json` 輸出中）。如果已設定的供應商沒有憑證，`models status` 會列印「**缺少憑證**」部分。
JSON 包含 `auth.oauth`（警告視窗 + 設定檔）和 `auth.providers`（每個供應商的有效憑證）。
使用 `--check` 進行自動化（缺少/到期時退出 `1`，到期中時退出 `2`）。

首選的 Anthropic 憑證是 Claude Code CLI setup-token（可在任何地方執行；必要時貼上至 Gateway 主機）：

```bash
claude setup-token
openclaw models status
```

## 掃描 (OpenRouter 免費模型)

`openclaw models scan` 檢查 OpenRouter 的**免費模型目錄**，並可選擇探測模型是否支援工具和圖片。

主要標誌：

- `--no-probe`：跳過即時探測（僅中繼資料）
- `--min-params <b>`：最小參數大小（十億）
- `--max-age-days <days>`：跳過較舊的模型
- `--provider <name>`：供應商前綴篩選器
- `--max-candidates <n>`：備用清單大小
- `--set-default`：將 `agents.defaults.model.primary` 設定為第一個選擇
- `--set-image`：將 `agents.defaults.imageModel.primary` 設定為第一個圖片選擇

探測需要 OpenRouter API 金鑰（來自憑證設定檔或 `OPENROUTER_API_KEY`）。如果沒有金鑰，請使用 `--no-probe` 僅列出候選者。

掃描結果依以下項目排名：

1. 圖片支援
2. 工具延遲
3. 上下文大小
4. 參數數量

輸入

- OpenRouter `/models` 清單（篩選 `:free`）
- 需要來自憑證設定檔或 `OPENROUTER_API_KEY` 的 OpenRouter API 金鑰（請參閱 [/environment](/help/environment)）
- 選用篩選器：`--max-age-days`、`--min-params`、`--provider`、`--max-candidates`
- 探測控制：`--timeout`、`--concurrency`

在 TTY 中執行時，您可以互動式地選擇備用模型。在非互動模式下，傳遞 `--yes` 接受預設值。

## 模型註冊表（`models.json`）

`models.providers` 中的自訂供應商會寫入代理程式目錄下的 `models.json` 檔案中（預設為 `~/.openclaw/agents/<agentId>/models.json`）。除非將 `models.mode` 設定為 `replace`，否則此檔案預設會合併。
