---
summary: "`openclaw dns` için CLI başvurusu (geniş alan keşfi yardımcıları)"
read_when:
  - Tailscale + CoreDNS üzerinden geniş alan keşfi (DNS-SD) istiyorsunuz
  - You’re setting up split DNS for a custom discovery domain (example: openclaw.internal)
title: "dns"
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
