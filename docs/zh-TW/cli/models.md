---
summary: "`openclaw models` 的 CLI 參考文件 (status/list/set/scan, 別名, 遞補模型, 憑證)"
read_when:
  - 您想要更改預設模型或查看供應商憑證狀態
  - 您想要掃描可用的模型/供應商並對憑證設定檔進行除錯
title: "models"
---

# `openclaw models`

模型探索、掃描與設定（預設模型、遞補模型、憑證設定檔）。

相關連結：

- 供應商 + 模型：[Models](/providers/models)
- 供應商憑證設定：[入門指南](/start/getting-started)

## 常用指令

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

`openclaw models status` 顯示解析後的預設/遞補模型以及憑證概覽。
當供應商使用量快照可用時，OAuth/權杖狀態區塊會包含供應商使用量標頭。
加入 `--probe` 對每個已設定的供應商設定檔執行即時憑證測試。
測試為真實請求（可能會消耗權杖並觸發速率限制）。
使用 `--agent <id>` 檢查特定智慧代理的模型/憑證狀態。若省略，則在已設定的情況下使用 `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`，否則使用預設智慧代理。

注意：

- `models set <model-or-alias>` 接受 `provider/model` 或別名。
- 模型參考的解析方式是在**第一個** `/` 處進行分割。如果模型 ID 本身包含 `/`（如 OpenRouter 樣式），請包含供應商前綴（例如：`openrouter/moonshotai/kimi-k2`）。
- 如果省略供應商，OpenClaw 會將輸入視為別名或**預設供應商**的模型（僅在模型 ID 中不含 `/` 時有效）。

### `models status`

選項：

- `--json`
- `--plain`
- `--check` (結束代碼 1=已過期/遺失, 2=即將過期)
- `--probe` (對已設定的憑證設定檔進行即時測試)
- `--probe-provider <name>` (測試單一供應商)
- `--probe-profile <id>` (重複使用或以逗號分隔設定檔 ID)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>` (已設定的智慧代理 ID；會覆蓋 `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`)

## 別名 + 遞補模型

```bash
openclaw models aliases list
openclaw models fallbacks list
```

## 憑證設定檔

```bash
openclaw models auth add
openclaw models auth login --provider <id>
openclaw models auth setup-token
openclaw models auth paste-token
```

`models auth login` 執行供應商外掛程式的驗證流程 (OAuth/API key)。使用 `openclaw plugins list` 查看已安裝的供應商。

注意：

- `setup-token` 提示輸入 setup-token 值（可在任何機器上使用 `claude setup-token` 產生）。
- `paste-token` 接受從其他地方或自動化程式產生的權杖字串。
