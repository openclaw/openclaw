---
summary: "`openclaw health` için CLI başvurusu (RPC üzerinden Gateway sağlık uç noktası)"
read_when:
  - Çalışan Gateway’in sağlığını hızlıca kontrol etmek istediğinizde
title: "sağlık"
x-i18n:
  source_path: cli/health.md
  source_hash: 82a78a5a97123f7a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:58Z
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
