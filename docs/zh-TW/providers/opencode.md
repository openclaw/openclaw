---
summary: Use OpenCode Zen and Go catalogs with OpenClaw
read_when:
  - You want OpenCode-hosted model access
  - You want to pick between the Zen and Go catalogs
title: OpenCode
---

# OpenCode

OpenCode 在 OpenClaw 中提供兩個託管目錄：

- `opencode/...` 代表 **Zen** 目錄
- `opencode-go/...` 代表 **Go** 目錄

兩個目錄共用相同的 OpenCode API 金鑰。OpenClaw 保持執行時提供者 ID 分開，以確保上游的每個模型路由正確，但上線流程和文件將它們視為一個 OpenCode 設定。

## CLI 設定

### Zen 目錄

```bash
openclaw onboard --auth-choice opencode-zen
openclaw onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
```

### Go 目錄

```bash
openclaw onboard --auth-choice opencode-go
openclaw onboard --opencode-go-api-key "$OPENCODE_API_KEY"
```

## 設定片段

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

## 目錄

### Zen

- 執行時提供者：`opencode`
- 範例模型：`opencode/claude-opus-4-6`、`opencode/gpt-5.2`、`opencode/gemini-3-pro`
- 適合想要使用精選的 OpenCode 多模型代理時

### Go

- 執行時提供者：`opencode-go`
- 範例模型：`opencode-go/kimi-k2.5`、`opencode-go/glm-5`、`opencode-go/minimax-m2.5`
- 最適合想使用 OpenCode 托管的 Kimi/GLM/MiniMax 系列時使用

## 注意事項

- 也支援 `OPENCODE_ZEN_API_KEY`。
- 在啟動時輸入一組 OpenCode 金鑰，即可同時儲存兩個執行時提供者的憑證。
- 您需要登入 OpenCode，新增帳單資訊，並複製您的 API 金鑰。
- 帳單和目錄可用性皆由 OpenCode 控制台管理。
