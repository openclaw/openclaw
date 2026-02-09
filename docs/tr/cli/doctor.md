---
summary: "`openclaw doctor` için CLI başvurusu (sağlık kontrolleri + yönlendirmeli onarımlar)"
read_when:
  - Bağlantı/kimlik doğrulama sorunlarınız var ve yönlendirmeli çözümler istiyorsunuz
  - Güncelleme yaptınız ve bir mantık denetimi yapmak istiyorsunuz
title: "doctor"
---

# `openclaw doctor`

Gateway ve kanallar için sağlık kontrolleri + hızlı düzeltmeler.

İlgili:

- Sorun Giderme: [Sorun Giderme](/gateway/troubleshooting)
- Güvenlik denetimi: [Güvenlik](/gateway/security)

## Örnekler

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
```

Notlar:

- Etkileşimli istemler (anahtar zinciri/OAuth düzeltmeleri gibi) yalnızca stdin bir TTY olduğunda ve `--non-interactive` **ayarlı değilken** çalışır. Başsız çalıştırmalar (cron, Telegram, terminal yok) istemleri atlar.
- `--fix` (`--repair` için takma ad), `~/.openclaw/openclaw.json.bak` konumuna bir yedek yazar ve bilinmeyen yapılandırma anahtarlarını kaldırır; her kaldırmayı listeleyerek.

## macOS: `launchctl` env geçersiz kılmaları

Daha önce `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...` (veya `...PASSWORD`) çalıştırdıysanız, bu değer yapılandırma dosyanızın üzerine yazar ve kalıcı “yetkisiz” hatalarına neden olabilir.

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```
