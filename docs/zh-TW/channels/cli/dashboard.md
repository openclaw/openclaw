---
summary: CLI reference for `openclaw dashboard` (open the Control UI)
read_when:
  - You want to open the Control UI with your current token
  - You want to print the URL without launching a browser
title: dashboard
---

# `openclaw dashboard`

使用您當前的認證打開控制介面。

```bash
openclaw dashboard
openclaw dashboard --no-open
```

[[BLOCK_1]]

- `dashboard` 會在可能的情況下解析已設定的 `gateway.auth.token` SecretRefs。
- 對於由 SecretRef 管理的 tokens（已解析或未解析），`dashboard` 會列印/複製/打開一個非 token 化的 URL，以避免在終端輸出、剪貼簿歷史或瀏覽器啟動參數中暴露外部秘密。
- 如果 `gateway.auth.token` 是由 SecretRef 管理但在此命令路徑中未解析，該命令會列印一個非 token 化的 URL 和明確的補救指導，而不是嵌入一個無效的 token 佔位符。
