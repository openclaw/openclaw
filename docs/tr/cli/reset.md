---
summary: "`openclaw reset` için CLI başvurusu (yerel durumu/yapılandırmayı sıfırlar)"
read_when:
  - CLI yüklü kalırken yerel durumu silmek istiyorsanız
  - Nelerin kaldırılacağını görmek için bir dry-run istiyorsanız
title: "sıfırla"
x-i18n:
  source_path: cli/reset.md
  source_hash: 08afed5830f892e0
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:59Z
---

# `openclaw reset`

Yerel yapılandırmayı/durumu sıfırlar (CLI yüklü kalır).

```bash
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```
