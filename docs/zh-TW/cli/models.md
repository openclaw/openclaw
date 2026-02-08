---
summary: "「openclaw models」的 CLI 參考（status/list/set/scan、別名、後備、身分驗證）"
read_when:
  - 你想要變更預設模型，或查看提供者的身分驗證狀態
  - 你想要掃描可用的模型／提供者，並偵錯身分驗證設定檔
title: "模型"
x-i18n:
  source_path: cli/models.md
  source_hash: 923b6ffc7de382ba
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:27:25Z
---

# `openclaw models`

模型探索、掃描與設定（預設模型、後備、身分驗證設定檔）。

相關：

- 提供者＋模型：[Models](/providers/models)
- 提供者身分驗證設定：[Getting started](/start/getting-started)

## 常用指令

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

`openclaw models status` 會顯示解析後的預設／後備設定，以及身分驗證概覽。
當可取得提供者使用量快照時，OAuth／權杖狀態區段會包含
提供者使用量標頭。
加入 `--probe` 以對每個已設定的提供者設定檔執行即時身分驗證探測。
探測為實際請求（可能消耗權杖並觸發速率限制）。
使用 `--agent <id>` 以檢視已設定代理程式的模型／身分驗證狀態。若省略，
該指令會使用已設定的 `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`，否則使用
已設定的預設代理程式。

注意事項：

- `models set <model-or-alias>` 接受 `provider/model` 或別名。
- 模型參照是以**第一個** `/` 進行分割。若模型 ID 包含 `/`（OpenRouter 風格），請包含提供者前綴（例如：`openrouter/moonshotai/kimi-k2`）。
- 若你省略提供者，OpenClaw 會將輸入視為別名或**預設提供者**的模型（僅在模型 ID 中沒有 `/` 時適用）。

### `models status`

選項：

- `--json`
- `--plain`
- `--check`（結束碼 1＝過期／缺失，2＝即將過期）
- `--probe`（對已設定的身分驗證設定檔進行即時探測）
- `--probe-provider <name>`（探測單一提供者）
- `--probe-profile <id>`（重複或以逗號分隔的設定檔 ID）
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>`（已設定的代理程式 ID；會覆寫 `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`）

## 別名＋後備

```bash
openclaw models aliases list
openclaw models fallbacks list
```

## 身分驗證設定檔

```bash
openclaw models auth add
openclaw models auth login --provider <id>
openclaw models auth setup-token
openclaw models auth paste-token
```

`models auth login` 會執行提供者外掛的身分驗證流程（OAuth／API 金鑰）。使用
`openclaw plugins list` 以查看已安裝的提供者。

注意事項：

- `setup-token` 會提示輸入 setup-token 值（可在任何機器上使用 `claude setup-token` 產生）。
- `paste-token` 接受在其他地方或由自動化產生的權杖字串。
