---
summary: "`openclaw logs` için CLI referansı (Gateway loglarını RPC üzerinden izleme)"
read_when:
  - SSH olmadan Gateway loglarını uzaktan izlemek istediğinizde
  - Araçlar için JSON log satırlarına ihtiyaç duyduğunuzda
title: "loglar"
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
