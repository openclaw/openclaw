---
summary: CLI reference for `openclaw onboard` (interactive onboarding wizard)
read_when:
  - "You want guided setup for gateway, workspace, auth, channels, and skills"
title: onboard
---

# `openclaw onboard`

互動式入門精靈（本地或遠端閘道設定）。

## 相關指南

- CLI 入門中心: [入門精靈 (CLI)](/start/wizard)
- 入門概覽: [入門概覽](/start/onboarding-overview)
- CLI 入門參考: [CLI 入門參考](/start/wizard-cli-reference)
- CLI 自動化: [CLI 自動化](/start/wizard-cli-automation)
- macOS 入門: [入門 (macOS 應用程式)](/start/onboarding)

## Examples

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url wss://gateway-host:18789
```

對於純文字私有網路 `ws://` 目標（僅限受信任的網路），在入門過程環境中設置 `OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1`。

非互動式自訂提供者：

```bash
openclaw onboard --non-interactive \
  --auth-choice custom-api-key \
  --custom-base-url "https://llm.example.com/v1" \
  --custom-model-id "foo-large" \
  --custom-api-key "$CUSTOM_API_KEY" \
  --secret-input-mode plaintext \
  --custom-compatibility openai
```

`--custom-api-key` 在非互動模式中是可選的。如果省略，則會進行入門檢查 `CUSTOM_API_KEY`。

[[BLOCK_1]]  
非互動式 Ollama:  
[[BLOCK_1]]

```bash
openclaw onboard --non-interactive \
  --auth-choice ollama \
  --custom-base-url "http://ollama-host:11434" \
  --custom-model-id "qwen3.5:27b" \
  --accept-risk
```

`--custom-base-url` 預設為 `http://127.0.0.1:11434`。`--custom-model-id` 是可選的；如果省略，則入門將使用 Ollama 建議的預設值。雲端模型 ID 例如 `kimi-k2.5:cloud` 也可以在這裡使用。

將提供者金鑰儲存為引用而非明文：

```bash
openclaw onboard --non-interactive \
  --auth-choice openai-api-key \
  --secret-input-mode ref \
  --accept-risk
```

使用 `--secret-input-mode ref` 時，入門過程會寫入環境變數支援的引用，而不是明文金鑰值。對於以 auth-profile 支援的提供者，這會寫入 `keyRef` 條目；對於自定義提供者，這會寫入 `models.providers.<id>.apiKey` 作為環境引用（例如 `{ source: "env", provider: "default", id: "CUSTOM_API_KEY" }`）。

非互動式 `ref` 模式合約：

- 在入門過程的環境中設置提供者環境變數（例如 `OPENAI_API_KEY`）。
- 除非該環境變數也已設置，否則不要傳遞內聯金鑰標誌（例如 `--openai-api-key`）。
- 如果在沒有所需環境變數的情況下傳遞內聯金鑰標誌，則入門過程會快速失敗並提供指導。

Gateway token 選項在非互動模式下：

- `--gateway-auth token --gateway-token <token>` 儲存一個明文 token。
- `--gateway-auth token --gateway-token-ref-env <name>` 將 `gateway.auth.token` 儲存為 env SecretRef。
- `--gateway-token` 和 `--gateway-token-ref-env` 是互斥的。
- `--gateway-token-ref-env` 在入門過程環境中需要一個非空的 env 變數。
- 使用 `--install-daemon` 時，當 token 認證需要一個 token，SecretRef 管理的閘道 token 會被驗證，但不會作為已解析的明文持久化在監控服務的環境元數據中。
- 使用 `--install-daemon` 時，如果 token 模式需要一個 token 且設定的 token SecretRef 未解析，則入門將關閉並提供修復指導。
- 使用 `--install-daemon` 時，如果同時設定了 `gateway.auth.token` 和 `gateway.auth.password` 且 `gateway.auth.mode` 未設置，則入門將阻止安裝，直到模式被明確設置。

[[BLOCK_1]]  
範例：  
[[BLOCK_1]]

```bash
export OPENCLAW_GATEWAY_TOKEN="your-token"
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice skip \
  --gateway-auth token \
  --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN \
  --accept-risk
```

[[BLOCK_1]]  
非互動式本地閘道健康狀態：  
[[BLOCK_1]]

- 除非您傳遞 `--skip-health`，否則入門過程會等待可達的本地閘道，然後才會成功退出。
- `--install-daemon` 首先啟動受管理的閘道安裝路徑。若沒有它，您必須已經有一個本地閘道在執行，例如 `openclaw gateway run`。
- 如果您只想在自動化中進行 config/workspace/bootstrap 的寫入，請使用 `--skip-health`。
- 在原生 Windows 上，`--install-daemon` 目前使用排程任務，並可能需要以管理員身份執行 PowerShell。

[[BLOCK_1]] 互動式入門行為與參考模式：[[BLOCK_1]]

- 當被提示時，選擇 **使用秘密參考**。
- 然後選擇以下任一項：
  - 環境變數
  - 設定的秘密提供者 (`file` 或 `exec`)
- 上線過程在保存參考之前會進行快速的預檢驗證。
  - 如果驗證失敗，上線過程會顯示錯誤並讓你重試。

非互動式 Z.AI 端點選擇：

注意：`--auth-choice zai-api-key` 現在自動檢測您金鑰的最佳 Z.AI 端點（優先使用帶有 `zai/glm-5` 的一般 API）。如果您特別想要 GLM Coding Plan 端點，請選擇 `zai-coding-global` 或 `zai-coding-cn`。

bash

# 無提示的端點選擇

openclaw onboard --non-interactive \
 --auth-choice zai-coding-global \
 --zai-api-key "$ZAI_API_KEY"

# 其他 Z.AI 端點選擇：

# --auth-choice zai-coding-cn

# --auth-choice zai-global

# --auth-choice zai-cn

[[BLOCK_1]]  
非互動式 Mistral 範例：  
[[BLOCK_1]]

```bash
openclaw onboard --non-interactive \
  --auth-choice mistral-api-key \
  --mistral-api-key "$MISTRAL_API_KEY"
```

Flow notes:

- `quickstart`: 最小提示，自動生成網關 token。
- `manual`: 完整提示用於端口/綁定/驗證（`advanced` 的別名）。
- 本地入門 DM 範圍行為: [CLI 入門參考](/start/wizard-cli-reference#outputs-and-internals)。
- 最快的首次聊天: `openclaw dashboard`（控制 UI，無需設置通道）。
- 自訂提供者: 連接任何兼容 OpenAI 或 Anthropic 的端點，包括未列出的託管提供者。使用 Unknown 進行自動檢測。

## 常見的後續指令

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` 並不表示非互動模式。請使用 `--non-interactive` 來執行腳本。
</Note>
