---
summary: "`openclaw health` için CLI başvurusu (RPC üzerinden Gateway sağlık uç noktası)"
read_when:
  - Çalışan Gateway’in sağlığını hızlıca kontrol etmek istediğinizde
title: "sağlık"
---

# `openclaw health`

Çalışan Gateway’den sağlık bilgisini alır.

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

Notlar:

- `--verbose` canlı yoklamalar çalıştırır ve birden fazla hesap yapılandırıldığında hesap başına zamanlamaları yazdırır.
- Çıktı, birden fazla ajan yapılandırıldığında ajan başına oturum depolarını içerir.
