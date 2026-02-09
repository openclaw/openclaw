---
summary: "`openclaw configure` için CLI başvuru belgesi (etkileşimli yapılandırma istemleri)"
read_when:
  - Kimlik bilgilerini, cihazları veya ajan varsayılanlarını etkileşimli olarak ayarlamak istediğinizde
title: "yapılandır"
---

# `openclaw configure`

Kimlik bilgilerini, cihazları ve ajan varsayılanlarını ayarlamak için etkileşimli bir istem.

Not: **Model** bölümü artık
`agents.defaults.models` izin listesi için bir çoklu seçim içerir (`/model` içinde ve model seçicide görünenler).

İpucu: Alt komut olmadan `openclaw config` çalıştırmak aynı sihirbazı açar. Etkileşimsiz düzenlemeler için
`openclaw config get|set|unset` kullanın.

İlgili:

- Gateway yapılandırma başvurusu: [Yapılandırma](/gateway/configuration)
- Config CLI: [Config](/cli/config)

Notlar:

- Gateway’nin nerede çalışacağını seçmek her zaman `gateway.mode`’yı günceller. Yalnızca buna ihtiyacınız varsa diğer bölümler olmadan “Devam”ı seçebilirsiniz.
- Kanal odaklı hizmetler (Slack/Discord/Matrix/Microsoft Teams) kurulum sırasında kanal/oda izin listelerini ister. Adları veya kimlikleri girebilirsiniz; sihirbaz mümkün olduğunda adları kimliklere çözümler.

## Örnekler

```bash
openclaw configure
openclaw configure --section models --section channels
```
