---
summary: "`openclaw onboard` CLI 參考指南（互動式新手導覽精靈）"
read_when:
  - 當您想要透過引導式步驟設定 Gateway、工作空間、憑證、頻道和 Skills 時
title: "onboard"
---

# `openclaw onboard`

互動式新手導覽精靈（本地或遠端 Gateway 設定）。

## 相關指南

- CLI 新手導覽中心：[新手導覽精靈 (CLI)](/start/wizard)
- 新手導覽概觀：[新手導覽概觀](/start/onboarding-overview)
- CLI 新手導覽參考指南：[CLI 新手導覽參考指南](/start/wizard-cli-reference)
- CLI 自動化：[CLI 自動化](/start/wizard-cli-automation)
- macOS 新手導覽：[新手導覽 (macOS App)](/start/onboarding)

## 範例

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url ws://gateway-host:18789
```

非互動式自定義供應商：

```bash
openclaw onboard --non-interactive \
  --auth-choice custom-api-key \
  --custom-base-url "https://llm.example.com/v1" \
  --custom-model-id "foo-large" \
  --custom-api-key "$CUSTOM_API_KEY" \
  --custom-compatibility openai
```

`--custom-api-key` 在非互動模式下為選填。如果省略，新手導覽會檢查 `CUSTOM_API_KEY`。

非互動式 Z.AI 端點選擇：

注意：`--auth-choice zai-api-key` 現在會自動偵測最適合您金鑰的 Z.AI 端點（優先選擇帶有 `zai/glm-5` 的一般 API）。
如果您特別需要 GLM Coding Plan 端點，請選擇 `zai-coding-global` 或 `zai-coding-cn`。

```bash
# 無提示端點選擇
openclaw onboard --non-interactive \
  --auth-choice zai-coding-global \
  --zai-api-key "$ZAI_API_KEY"

# 其他 Z.AI 端點選擇：
# --auth-choice zai-coding-cn
# --auth-choice zai-global
# --auth-choice zai-cn
```

流程說明：

- `quickstart`：最少提示，自動產生 Gateway 權杖。
- `manual`：完整的連接埠/綁定/憑證提示（`advanced` 的別名）。
- 最快開始第一次對話：`openclaw dashboard`（控制介面，無需頻道設定）。
- 自定義供應商：連接任何相容 OpenAI 或 Anthropic 的端點，包括未列出的託管供應商。使用 Unknown 以自動偵測。

## 常用的後續命令

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` 並不代表非互動模式。在腳本中請使用 `--non-interactive`。
</Note>
