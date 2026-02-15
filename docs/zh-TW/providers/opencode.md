```
---
summary: "將 OpenCode Zen (策展模型) 與 OpenClaw 搭配使用"
read_when:
  - 您需要 OpenCode Zen 來存取模型
  - 您需要一份精選的程式碼友善模型清單
title: "OpenCode Zen"
---

# OpenCode Zen

OpenCode Zen 是由 OpenCode 團隊為程式碼智慧代理推薦的**策展模型清單**。
這是一個選用、託管的模型存取路徑，它使用 API 金鑰和 `opencode` 供應商。
Zen 目前處於測試階段。

## CLI 設定

```bash
openclaw onboard --auth-choice opencode-zen
# or non-interactive
openclaw onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
```

## 設定程式碼片段

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

## 注意事項

- `OPENCODE_ZEN_API_KEY` 也支援。
- 您登入 Zen，新增帳單資訊，並複製您的 API 金鑰。
- OpenCode Zen 按請求計費；請查看 OpenCode 儀表板了解詳情。
```
