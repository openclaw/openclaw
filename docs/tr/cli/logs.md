---
summary: "`openclaw logs` için CLI referansı (Gateway loglarını RPC üzerinden izleme)"
read_when:
  - SSH olmadan Gateway loglarını uzaktan izlemek istediğinizde
  - Araçlar için JSON log satırlarına ihtiyaç duyduğunuzda
title: "loglar"
x-i18n:
  source_path: cli/logs.md
  source_hash: 911a57f0f3b78412
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:56Z
---

# `openclaw logs`

Gateway dosya loglarını RPC üzerinden izleyin (uzak modda çalışır).

İlgili:

- Loglama genel bakış: [Logging](/logging)

## Örnekler

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
```
