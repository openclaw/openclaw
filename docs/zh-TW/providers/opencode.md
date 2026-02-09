---
summary: "使用 OpenCode Zen（精選模型）與 OpenClaw 搭配使用"
read_when:
  - 你想要使用 OpenCode Zen 進行模型存取
  - 你想要一份對程式開發友善的精選模型清單
title: "OpenCode Zen"
---

# OpenCode Zen

OpenCode Zen 是由 OpenCode 團隊為程式代理程式推薦的**精選模型清單**。
它是一條可選的、託管式模型存取途徑，使用 API 金鑰 與 `opencode` 提供者。
Zen 目前仍處於 beta。
50. 這是一條可選的、託管的模型存取路徑，使用 API 金鑰與 `opencode` 提供者。
Zen is currently in beta.

## CLI 設定

```bash
openclaw onboard --auth-choice opencode-zen
# or non-interactive
openclaw onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
```

## 設定片段

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

## 注意事項

- `OPENCODE_ZEN_API_KEY` 也受支援。
- 你需要登入 Zen，新增帳務資料，並複製你的 API 金鑰。
- OpenCode Zen 以每次請求計費；詳情請查看 OpenCode 儀表板。
