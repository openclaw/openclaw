---
summary: Use the OpenCode Go catalog with the shared OpenCode setup
read_when:
  - You want the OpenCode Go catalog
  - You need the runtime model refs for Go-hosted models
title: OpenCode Go
---

# OpenCode Go

OpenCode Go 是 [OpenCode](/providers/opencode) 內的 Go 目錄。
它使用與 Zen 目錄相同的 `OPENCODE_API_KEY`，但保留了執行時提供者 ID `opencode-go`，以確保上游的每模型路由保持正確。

## 支援的模型

- `opencode-go/kimi-k2.5`
- `opencode-go/glm-5`
- `opencode-go/minimax-m2.5`

## CLI 設定

```bash
openclaw onboard --auth-choice opencode-go
# or non-interactive
openclaw onboard --opencode-go-api-key "$OPENCODE_API_KEY"
```

## 設定片段

```json5
{
  env: { OPENCODE_API_KEY: "YOUR_API_KEY_HERE" }, // pragma: allowlist secret
  agents: { defaults: { model: { primary: "opencode-go/kimi-k2.5" } } },
}
```

## 路由行為

當模型參考使用 `opencode-go/...` 時，OpenClaw 會自動處理每模型路由。

## 注意事項

- 請使用 [OpenCode](/providers/opencode) 進行共用的上線與目錄總覽。
- 執行時參考保持明確：Zen 使用 `opencode/...`，Go 使用 `opencode-go/...`。
