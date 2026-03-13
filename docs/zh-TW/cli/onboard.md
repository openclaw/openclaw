---
summary: CLI reference for `openclaw onboard` (interactive onboarding wizard)
read_when:
  - "You want guided setup for gateway, workspace, auth, channels, and skills"
title: onboard
---

# `openclaw onboard`

互動式新手導引精靈（本地或遠端 Gateway 設定）。

## 相關指南

- CLI 新手導引中心：[新手導引精靈 (CLI)](/start/wizard)
- 新手導引總覽：[新手導引總覽](/start/onboarding-overview)
- CLI 新手導引參考：[CLI 新手導引參考](/start/wizard-cli-reference)
- CLI 自動化：[CLI 自動化](/start/wizard-cli-automation)
- macOS 新手導引：[新手導引 (macOS App)](/start/onboarding)

## 範例

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url wss://gateway-host:18789
```

針對純文字私有網路 `ws://` 目標（僅限受信任網路），請在啟動流程環境中設定 `OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1`。

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

`--custom-api-key` 在非互動模式下為選用專案。若省略，啟動流程將檢查 `CUSTOM_API_KEY`。

非互動式 Ollama：

```bash
openclaw onboard --non-interactive \
  --auth-choice ollama \
  --custom-base-url "http://ollama-host:11434" \
  --custom-model-id "qwen3.5:27b" \
  --accept-risk
```

`--custom-base-url` 預設為 `http://127.0.0.1:11434`。`--custom-model-id` 是可選的；若省略，啟動流程將使用 Ollama 建議的預設值。此處也支援像 `kimi-k2.5:cloud` 這類的雲端模型 ID。

將提供者金鑰以參考（refs）形式儲存，而非純文字：

```bash
openclaw onboard --non-interactive \
  --auth-choice openai-api-key \
  --secret-input-mode ref \
  --accept-risk
```

使用 `--secret-input-mode ref` 時，onboarding 會寫入以環境變數為基礎的參考，而非純文字的金鑰值。
對於以 auth-profile 為基礎的提供者，這會寫入 `keyRef` 條目；對於自訂提供者，則會以環境變數參考的形式寫入 `models.providers.<id>.apiKey`（例如 `{ source: "env", provider: "default", id: "CUSTOM_API_KEY" }`）。

非互動式 `ref` 模式契約：

- 在 onboarding 過程的環境中設定提供者的環境變數（例如 `OPENAI_API_KEY`）。
- 除非該環境變數也已設定，否則不要傳遞內嵌金鑰旗標（例如 `--openai-api-key`）。
- 如果傳遞了內嵌金鑰旗標但缺少必要的環境變數，onboarding 會快速失敗並提供指導。

非互動式模式下的 Gateway token 選項：

- `--gateway-auth token --gateway-token <token>` 儲存純文字 token。
- `--gateway-auth token --gateway-token-ref-env <name>` 將 `gateway.auth.token` 儲存為環境 SecretRef。
- `--gateway-token` 與 `--gateway-token-ref-env` 互斥。
- `--gateway-token-ref-env` 需要 onboarding 過程環境中有非空的環境變數。
- 使用 `--install-daemon` 時，當 token 認證需要 token，SecretRef 管理的 gateway token 會被驗證，但不會以解析後的純文字形式保存在 supervisor 服務環境的元資料中。
- 使用 `--install-daemon` 時，如果 token 模式需要 token，且設定的 token SecretRef 未解析，onboarding 會封閉失敗並提供修復指導。
- 使用 `--install-daemon` 時，如果同時設定了 `gateway.auth.token` 和 `gateway.auth.password`，且 `gateway.auth.mode` 未設定，onboarding 會阻止安裝，直到明確設定模式。

```bash
export OPENCLAW_GATEWAY_TOKEN="your-token"
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice skip \
  --gateway-auth token \
  --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN \
  --accept-risk
```

非互動式本地閘道健康狀態：

- 除非你傳入 `--skip-health`，否則上線程序會等待可連線的本地閘道，才會成功結束。
- `--install-daemon` 會先啟動受管閘道安裝流程。若未使用此參數，你必須已經有本地閘道在執行，例如 `openclaw gateway run`。
- 如果你只想在自動化中寫入 config/workspace/bootstrap，請使用 `--skip-health`。
- 在原生 Windows 上，`--install-daemon` 目前使用排程任務，可能需要以系統管理員身份執行 PowerShell。

互動式上線行為與參考模式：

- 選擇 **使用秘密參考** 當系統提示時。
- 接著選擇其中一項：
  - 環境變數
  - 已設定的秘密提供者 (`file` 或 `exec`)
- 上線流程會在儲存參考前執行快速的預檢驗證。
  - 若驗證失敗，上線流程會顯示錯誤並允許你重試。

非互動式 Z.AI 端點選擇：

注意：`--auth-choice zai-api-key` 現在會自動偵測你金鑰的最佳 Z.AI 端點（偏好使用帶有 `zai/glm-5` 的通用 API）。
如果你特別想使用 GLM Coding Plan 端點，請選擇 `zai-coding-global` 或 `zai-coding-cn`。

bash

# 無提示端點選擇

openclaw onboard --non-interactive \
 --auth-choice zai-coding-global \
 --zai-api-key "$ZAI_API_KEY"

# 其他 Z.AI 端點選擇：

# --auth-choice zai-coding-cn

# --auth-choice zai-global

# --auth-choice zai-cn

非互動式 Mistral 範例：

```bash
openclaw onboard --non-interactive \
  --auth-choice mistral-api-key \
  --mistral-api-key "$MISTRAL_API_KEY"
```

流程說明：

- `quickstart`：最簡化的提示，自動產生 gateway token。
- `manual`：完整提示，包含 port/bind/auth（`advanced` 的別名）。
- 本地上線 DM 範圍行為：[CLI 上線參考](/start/wizard-cli-reference#outputs-and-internals)。
- 最快的首次聊天：`openclaw dashboard`（控制 UI，無需頻道設定）。
- 自訂提供者：連接任何相容 OpenAI 或 Anthropic 的端點，
  包含未列出的託管提供者。使用 Unknown 進行自動偵測。

## 常用後續指令

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` 並不代表非互動模式。腳本請使用 `--non-interactive`。
</Note>
