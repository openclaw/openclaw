---
summary: >-
  CLI reference for `openclaw models` (status/list/set/scan, aliases, fallbacks,
  auth)
read_when:
  - You want to change default models or view provider auth status
  - You want to scan available models/providers and debug auth profiles
title: models
---

# `openclaw models`

模型發現、掃描與設定（預設模型、備援模型、認證設定檔）。

相關資訊：

- 供應商與模型：[模型](/providers/models)
- 供應商認證設定：[快速開始](/start/getting-started)

## 常用指令

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

`openclaw models status` 顯示解析後的預設/備用設定以及認證概覽。
當提供者使用快照可用時，OAuth/token 狀態區段會包含提供者使用標頭。
加入 `--probe` 以對每個已設定的提供者設定檔執行即時認證探測。
探測為真實請求（可能會消耗 token 並觸發速率限制）。
使用 `--agent <id>` 來檢查已設定代理的模型/認證狀態。若省略此參數，
指令會使用已設定的 `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`，否則使用預設代理。

備註：

- `models set <model-or-alias>` 接受 `provider/model` 或別名。
- 模型參考會以**第一個** `/` 進行拆分解析。若模型 ID 包含 `/`（OpenRouter 風格），需包含提供者前綴（例如：`openrouter/moonshotai/kimi-k2`）。
- 若省略提供者，OpenClaw 會將輸入視為別名或**預設提供者**的模型（僅當模型 ID 中沒有 `/` 時有效）。
- `models status` 在認證輸出中可能會顯示非秘密佔位符的 `marker(<value>)`（例如 `OPENAI_API_KEY`、`secretref-managed`、`minimax-oauth`、`qwen-oauth`、`ollama-local`），而非將其遮蔽為秘密。

### `models status`

選項：

- `--json`
- `--plain`
- `--check`（退出碼 1=過期/缺失，2=即將過期）
- `--probe`（對已設定的認證設定進行即時探測）
- `--probe-provider <name>`（探測單一提供者）
- `--probe-profile <id>`（重複或以逗號分隔的設定 ID）
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>`（設定的代理 ID；會覆蓋 `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`）

## 別名 + 備援機制

```bash
openclaw models aliases list
openclaw models fallbacks list
```

## 認證設定

```bash
openclaw models auth add
openclaw models auth login --provider <id>
openclaw models auth setup-token
openclaw models auth paste-token
```

`models auth login` 執行提供者外掛的認證流程（OAuth/API 金鑰）。使用 `openclaw plugins list` 查看已安裝的提供者。

注意：

- `setup-token` 會提示輸入 setup-token 值（可在任何機器上使用 `claude setup-token` 產生）。
- `paste-token` 接受從其他地方或自動化產生的 token 字串。
- Anthropic 政策說明：setup-token 支援是為了技術相容性。Anthropic 過去曾限制部分訂閱在 Claude Code 以外的使用，請在廣泛使用前確認最新條款。
