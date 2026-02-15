---
summary: "在 OpenClaw 中使用 OpenCode Zen（精選模型）"
read_when:
  - 您想使用 OpenCode Zen 存取模型
  - 您需要一份適合程式開發的精選模型清單
title: "OpenCode Zen"
---

# OpenCode Zen

OpenCode Zen 是由 OpenCode 團隊為程式開發智慧代理推薦的**精選模型清單**。
這是一個選用的託管模型存取路徑，使用 API 金鑰與 `opencode` 供應商。
Zen 目前處於 Beta 階段。

## CLI 設定

```bash
openclaw onboard --auth-choice opencode-zen
# 或非互動模式
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

- 也支援 `OPENCODE_ZEN_API_KEY`。
- 您登入 Zen，新增帳單詳細資訊，並複製您的 API 金鑰。
- OpenCode Zen 按請求計費；請查看 OpenCode 控制面板了解詳情。
