---
summary: "CLI 參考資料，關於 `openclaw models` (status/list/set/scan, aliases, fallbacks, auth)"
read_when:
  - 您想要變更預設模型或查看供應商憑證狀態
  - 您想要掃描可用的模型/供應商並偵錯憑證設定檔
title: "models"
---

# `openclaw models`

模型裝置探索、掃描和設定（預設模型、備援、憑證設定檔）。

相關：

- 供應商 + 模型：[模型](/providers/models)
- 供應商憑證設定：[入門指南](/start/getting-started)

## 一般命令

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

`openclaw models status` 顯示已解析的預設/備援以及憑證概覽。
當供應商使用快照可用時，OAuth/權杖狀態區段會包含供應商使用標頭。
新增 `--probe` 以針對每個已設定的供應商設定檔執行即時憑證探測。
探測是真實的請求（可能會消耗權杖並觸發速率限制）。
使用 `--agent <id>` 來檢查已設定智慧代理的模型/憑證狀態。省略時，
此命令會使用 `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`（如果已設定），否則會使用
已設定的預設智慧代理。

注意事項：

- `models set <model-or-alias>` 接受 `provider/model` 或別名。
- 模型參考是透過以**第一個** `/` 分割來解析的。如果模型 ID 包含 `/`（OpenRouter 樣式），請包含供應商前綴（例如：`openrouter/moonshotai/kimi-k2`）。
- 如果您省略供應商，OpenClaw 會將輸入視為**預設供應商**的別名或模型（僅當模型 ID 中沒有 `/` 時才有效）。

### `models status`

選項：

- `--json`
- `--plain`
- `--check` (結束碼 1=過期/遺失，2=即將過期)
- `--probe` (即時探測已設定的憑證設定檔)
- `--probe-provider <name>` (探測單一供應商)
- `--probe-profile <id>` (重複或以逗號分隔的設定檔 ID)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>` (已設定的智慧代理 ID；會覆寫 `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`)

## 別名 + 備援

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

`models auth login` 執行供應商外掛程式的憑證流程 (OAuth/API 金鑰)。使用
`openclaw plugins list` 可查看已安裝哪些供應商。

注意事項：

- `setup-token` 會提示輸入 setup-token 值（在任何機器上使用 `claude setup-token` 產生）。
- `paste-token` 接受在其他地方或從自動化程序產生的權杖字串。
