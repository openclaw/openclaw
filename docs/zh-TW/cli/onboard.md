---
summary: "CLI 參考文件，關於 `openclaw onboard`（互動式新手導覽精靈）"
read_when:
  - 您需要 Gateway、工作區、憑證、頻道和 Skills 的引導式設定
title: "onboard"
---

# `openclaw onboard`

互動式新手導覽精靈（本地或遠端 Gateway 設定）。

## 相關指南

- CLI 新手導覽中心：[新手導覽精靈 (CLI)](/start/wizard)
- 新手導覽總覽：[新手導覽總覽](/start/onboarding-overview)
- CLI 新手導覽參考文件：[CLI 新手導覽參考文件](/start/wizard-cli-reference)
- CLI 自動化：[CLI 自動化](/start/wizard-cli-automation)
- macOS 新手導覽：[新手導覽 (macOS 應用程式)](/start/onboarding)

## 範例

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url ws://gateway-host:18789
```

非互動式自訂供應商：

```bash
openclaw onboard --non-interactive \
  --auth-choice custom-api-key \
  --custom-base-url "https://llm.example.com/v1" \
  --custom-model-id "foo-large" \
  --custom-api-key "$CUSTOM_API_KEY" \
  --custom-compatibility openai
```

`--custom-api-key` 在非互動模式下為選填。如果省略，新手導覽將檢查 `CUSTOM_API_KEY`。

非互動式 Z.AI 端點選項：

注意：`--auth-choice zai-api-key` 現在會自動偵測適用於您金鑰的最佳 Z.AI 端點（偏好使用帶有 `zai/glm-5` 的通用 API）。如果您特別需要 GLM Coding Plan 端點，請選擇 `zai-coding-global` 或 `zai-coding-cn`。

```bash
# Promptless endpoint selection
openclaw onboard --non-interactive \
  --auth-choice zai-coding-global \
  --zai-api-key "$ZAI_API_KEY"

# Other Z.AI endpoint choices:
# --auth-choice zai-coding-cn
# --auth-choice zai-global
# --auth-choice zai-cn
```

流程注意事項：

- `quickstart`：最少提示，自動產生 Gateway 權杖。
- `manual`：關於連接埠/綁定/憑證的完整提示（`advanced` 的別名）。
- 最快首次聊天：`openclaw dashboard` (控制使用者介面，無需頻道設定)。
- 自訂供應商：連接任何與 OpenAI 或 Anthropic 相容的端點，包括未列出的託管供應商。使用「未知」進行自動偵測。

## 常見後續指令

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` 不代表非互動模式。對於指令碼，請使用 `--non-interactive`。
</Note>
