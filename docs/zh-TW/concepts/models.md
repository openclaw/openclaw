---
summary: "Models CLI：列出、設定、別名、備援、掃描、狀態"
read_when:
  - 新增或修改 Models CLI（models list/set/scan/aliases/fallbacks）
  - 變更模型備援行為或選擇 UX
  - 更新模型掃描探測（工具／圖片）
title: "Models CLI"
---

# Models CLI

36. 有關驗證設定檔輪替、冷卻時間，以及其如何與回退互動，請參閱 [/concepts/model-failover](/concepts/model-failover)。
37. 供應商快速總覽與範例：[/concepts/model-providers](/concepts/model-providers)。

## 模型選擇如何運作

OpenClaw 依下列順序選擇模型：

1. **主要** 模型（`agents.defaults.model.primary` 或 `agents.defaults.model`）。
2. `agents.defaults.model.fallbacks` 中的 **備援**（依順序）。
3. 38. **供應商驗證回退** 會在供應商內部發生，然後才移至
       下一個模型。

39) 相關：

- `agents.defaults.models` 是 OpenClaw 可使用的模型允許清單／目錄（含別名）。
- `agents.defaults.imageModel` **僅在** 主要模型無法接受圖片時使用。
- 每個代理程式的預設值可透過 `agents.list[].model` 加上繫結覆寫 `agents.defaults.model`（請參閱 [/concepts/multi-agent](/concepts/multi-agent)）。

## 快速模型選擇（經驗談）

- **GLM**：在程式碼與工具呼叫方面稍好。
- **MiniMax**：寫作與氛圍較佳。

## 設定精靈（建議）

如果不想手動編輯設定，請執行入門引導精靈：

```bash
openclaw onboard
```

它可為常見提供者設定模型與身分驗證，包含 **OpenAI Code（Codex）訂閱**（OAuth）與 **Anthropic**（建議使用 API 金鑰；亦支援 `claude setup-token`）。

## 40. 設定鍵（總覽）

- `agents.defaults.model.primary` 與 `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` 與 `agents.defaults.imageModel.fallbacks`
- `agents.defaults.models`（允許清單 + 別名 + 提供者參數）
- `models.providers`（自訂提供者會寫入 `models.json`）

1. 模型參考會正規化為小寫。 2. 像 `z.ai/*` 這樣的提供者別名會正規化為 `zai/*`。

提供者設定範例（包含 OpenCode Zen）位於
[/gateway/configuration](/gateway/configuration#opencode-zen-multi-model-proxy)。

## 「Model is not allowed」（以及為何回覆會停止）

若設定了 `agents.defaults.models`，它會成為 `/model` 與工作階段覆寫的 **允許清單**。當使用者選擇不在該允許清單中的模型時，OpenClaw 會回傳： 3. 當使用者選擇的模型不在允許清單中時，OpenClaw 會回傳：

```
Model "provider/model" is not allowed. Use /model to list available models.
```

這會在產生一般回覆 **之前** 發生，因此訊息可能感覺像是「沒有回應」。修正方式為其一： 4. 修正方式是以下其中之一：

- 將模型加入 `agents.defaults.models`，或
- 清除允許清單（移除 `agents.defaults.models`），或
- 從 `/model list` 選擇模型。

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

你可以在不重新啟動的情況下，為目前工作階段切換模型：

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model status
```

注意事項：

- `/model`（以及 `/model list`）是精簡的編號選擇器（模型家族 + 可用提供者）。
- `/model <#>` 會從該選擇器中選取。
- `/model status` 是詳細檢視（身分驗證候選，以及在設定時顯示的提供者端點 `baseUrl` + `api` 模式）。
- 5. 模型參考是透過在**第一個** `/` 處進行分割來解析的。 模型參照會以 **第一個** `/` 進行分割。輸入 `/model <ref>` 時請使用 `provider/model`。
- 若模型 ID 本身包含 `/`（OpenRouter 風格），你必須包含提供者前綴（例如：`/model openrouter/moonshotai/kimi-k2`）。
- 若省略提供者，OpenClaw 會將輸入視為別名或 **預設提供者** 的模型（僅在模型 ID 中沒有 `/` 時可用）。

完整指令行為／設定請參閱：[Slash commands](/tools/slash-commands)。

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

`openclaw models`（不帶子指令）是 `models status` 的捷徑。

### `models list`

6. 預設會顯示已設定的模型。 7. 實用的旗標：

- `--all`：完整目錄
- `--local`：僅本地提供者
- `--provider <name>`：依提供者篩選
- `--plain`：每行一個模型
- `--json`：機器可讀輸出

### `models status`

8. 顯示已解析的主要模型、備援模型、影像模型，以及已設定提供者的驗證總覽。 9. 也會顯示在驗證儲存區中找到的設定檔的 OAuth 到期狀態（預設在 24 小時內到期會警告）。 10. `--plain` 只會輸出已解析的主要模型。
9. OAuth 狀態一定會顯示（並包含在 `--json` 輸出中）。 12. 如果已設定的提供者沒有憑證，`models status` 會列印 **Missing auth** 區段。
10. JSON 會包含 `auth.oauth`（警告視窗 + 設定檔）以及 `auth.providers`（各提供者的實際驗證）。
11. 在自動化中使用 `--check`（缺少/已過期時結束碼為 `1`，即將到期時為 `2`）。

Anthropic 建議的身分驗證方式為 Claude Code CLI 的 setup-token（可在任何地方執行；必要時貼到閘道器主機）：

```bash
claude setup-token
openclaw models status
```

## 掃描（OpenRouter 免費模型）

`openclaw models scan` 會檢視 OpenRouter 的 **免費模型目錄**，並可選擇性地探測模型是否支援工具與圖片。

主要旗標：

- `--no-probe`：跳過即時探測（僅中繼資料）
- `--min-params <b>`：最小參數規模（十億）
- `--max-age-days <days>`：跳過較舊模型
- `--provider <name>`：提供者前綴篩選
- `--max-candidates <n>`：備援清單大小
- `--set-default`：將 `agents.defaults.model.primary` 設為第一個選擇
- `--set-image`：將 `agents.defaults.imageModel.primary` 設為第一個圖片選擇

探測需要 OpenRouter API 金鑰（來自身分驗證設定檔或
`OPENROUTER_API_KEY`）。沒有金鑰時，請使用 `--no-probe` 僅列出候選項目。 15. 沒有金鑰時，使用 `--no-probe` 只列出候選項目。

掃描結果的排序依據：

1. 圖片支援
2. 工具延遲
3. 16. 上下文大小
4. 17. 參數數量

Input

- OpenRouter `/models` 清單（篩選 `:free`）
- 需要來自身分驗證設定檔或 `OPENROUTER_API_KEY` 的 OpenRouter API 金鑰（見 [/environment](/help/environment)）
- 選用篩選條件：`--max-age-days`、`--min-params`、`--provider`、`--max-candidates`
- 探測控制：`--timeout`、`--concurrency`

18. 在 TTY 中執行時，可以互動式地選擇備援模型。 19. 在非互動模式下，傳入 `--yes` 以接受預設值。

## 模型登錄表（`models.json`）

`models.providers` 中的自訂提供者會寫入代理程式目錄下的 `models.json`（預設為 `~/.openclaw/agents/<agentId>/models.json`）。此檔案預設會被合併，除非將 `models.mode` 設為 `replace`。 20. 除非將 `models.mode` 設為 `replace`，否則此檔案預設會被合併。
