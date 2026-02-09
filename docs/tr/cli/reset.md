---
summary: "`openclaw reset` için CLI başvurusu (yerel durumu/yapılandırmayı sıfırlar)"
read_when:
  - CLI yüklü kalırken yerel durumu silmek istiyorsanız
  - Nelerin kaldırılacağını görmek için bir dry-run istiyorsanız
title: "sıfırla"
---

# `openclaw reset`

Yerel yapılandırmayı/durumu sıfırlar (CLI yüklü kalır).

```bash
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```
