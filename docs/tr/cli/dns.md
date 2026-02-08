---
summary: "`openclaw dns` için CLI başvurusu (geniş alan keşfi yardımcıları)"
read_when:
  - Tailscale + CoreDNS üzerinden geniş alan keşfi (DNS-SD) istiyorsunuz
  - Özel bir keşif alanı için bölünmüş DNS kuruyorsunuz (örnek: openclaw.internal)
title: "dns"
x-i18n:
  source_path: cli/dns.md
  source_hash: d2011e41982ffb4b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:57Z
---

# `openclaw dns`

Geniş alan keşfi için DNS yardımcıları (Tailscale + CoreDNS). Şu anda macOS + Homebrew CoreDNS odaklıdır.

İlgili:

- Gateway keşfi: [Keşif](/gateway/discovery)
- Geniş alan keşfi yapılandırması: [Yapılandırma](/gateway/configuration)

## Kurulum

```bash
openclaw dns setup
openclaw dns setup --apply
```
