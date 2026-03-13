---
summary: >-
  CLI reference for `openclaw models` (status/list/set/scan, aliases, fallbacks,
  auth)
read_when:
  - You want to change default models or view provider auth status
  - You want to scan available models/providers and debug auth profiles
title: models
---

`openclaw models`

模型發現、掃描和設定（預設模型、後備方案、身份驗證設定檔）。

[[BLOCK_1]]

- 供應商 + 模型: [模型](/providers/models)
- 供應商身份驗證設置: [開始使用](/start/getting-started)

## 常用指令

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

`openclaw models status` 顯示了解決的預設值/備用值以及身份驗證概覽。當提供者使用快照可用時，OAuth/token 狀態區域包含提供者使用標頭。添加 `--probe` 以對每個設定的提供者設定檔執行即時身份驗證探測。探測是實際請求（可能會消耗 token 並觸發速率限制）。使用 `--agent <id>` 來檢查設定代理的模型/身份驗證狀態。當省略時，該命令會使用 `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`（如果已設置），否則使用設定的預設代理。

[[BLOCK_1]]

- `models set <model-or-alias>` 接受 `provider/model` 或別名。
- 模型引用透過在 **第一個** `/` 上進行分割來解析。如果模型 ID 包含 `/`（OpenRouter 風格），請包含提供者前綴（範例：`openrouter/moonshotai/kimi-k2`）。
- 如果您省略提供者，OpenClaw 將輸入視為別名或 **預設提供者** 的模型（僅在模型 ID 中沒有 `/` 時有效）。
- `models status` 可能在身份驗證輸出中顯示非秘密佔位符的 `marker(<value>)`（例如 `OPENAI_API_KEY`、`secretref-managed`、`minimax-oauth`、`qwen-oauth`、`ollama-local`），而不是將它們遮蔽為秘密。

### `models status`

Options:

- `--json`
- `--plain`
- `--check` (退出 1=過期/缺失, 2=即將過期)
- `--probe` (已設定的認證檔案的即時探測)
- `--probe-provider <name>` (探測一個提供者)
- `--probe-profile <id>` (重複或以逗號分隔的檔案 ID)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>` (已設定的代理 ID; 覆蓋 `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`)

## 別名 + 備援

```bash
openclaw models aliases list
openclaw models fallbacks list
```

## Auth profiles

```bash
openclaw models auth add
openclaw models auth login --provider <id>
openclaw models auth setup-token
openclaw models auth paste-token
```

`models auth login` 執行提供者插件的認證流程（OAuth/API 金鑰）。使用 `openclaw plugins list` 來查看已安裝的提供者。

[[BLOCK_1]]

- `setup-token` 提示輸入 setup-token 值（可在任何機器上使用 `claude setup-token` 生成）。
- `paste-token` 接受在其他地方或自動化生成的 token 字串。
- Anthropic 政策說明：setup-token 支援是技術相容性。Anthropic 過去曾阻止某些訂閱在 Claude Code 之外的使用，因此在廣泛使用之前請確認當前條款。
