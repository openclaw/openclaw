---
summary: "Ajanlar, zarflar ve istemler için saat dilimi işleme"
read_when:
  - Model için zaman damgalarının nasıl normalize edildiğini anlamanız gerektiğinde
  - Sistem istemleri için kullanıcı saat dilimini yapılandırırken
title: "Saat Dilimleri"
---

# Saat Dilimleri

OpenClaw, modelin **tek bir referans zaman** görmesi için zaman damgalarını standartlaştırır.

## Mesaj zarfları (varsayılan olarak yerel)

Gelen mesajlar şu şekilde bir zarf içinde sarılır:

```
[Provider ... 2026-01-05 16:26 PST] message text
```

Zarftaki zaman damgası **varsayılan olarak ana makine yerelidir** ve dakika hassasiyetindedir.

Bunu şu şekilde geçersiz kılabilirsiniz:

```json5
{
  agents: {
    defaults: {
      envelopeTimezone: "local", // "utc" | "local" | "user" | IANA timezone
      envelopeTimestamp: "on", // "on" | "off"
      envelopeElapsed: "on", // "on" | "off"
    },
  },
}
```

- `envelopeTimezone: "utc"` UTC kullanır.
- `envelopeTimezone: "user"` `agents.defaults.userTimezone` kullanır (ana makine saat dilimine geri düşer).
- Sabit bir ofset için açık bir IANA saat dilimi (örn. `"Europe/Vienna"`) kullanın.
- `envelopeTimestamp: "off"` zarf başlıklarından mutlak zaman damgalarını kaldırır.
- `envelopeElapsed: "off"` geçen süre son eklerini kaldırır (`+2m` stili).

### Örnekler

**Local (default):**

```
[Signal Alice +1555 2026-01-18 00:19 PST] hello
```

**Sabit saat dilimi:**

```
[Signal Alice +1555 2026-01-18 06:19 GMT+1] hello
```

**Geçen süre:**

```
[Signal Alice +1555 +2m 2026-01-18T05:19Z] follow-up
```

## Araç yükleri (ham sağlayıcı verisi + normalize edilmiş alanlar)

Araç çağrıları (`channels.discord.readMessages`, `channels.slack.readMessages` vb.) **ham sağlayıcı zaman damgalarını** döndürür.
Tutarlılık için ayrıca normalize edilmiş alanlar ekleriz:

- `timestampMs` (UTC epoch milisaniyeleri)
- `timestampUtc` (ISO 8601 UTC dizesi)

Ham sağlayıcı alanları korunur.

## Sistem istemi için kullanıcı saat dilimi

Modelin kullanıcının yerel saat dilimini bilmesi için `agents.defaults.userTimezone` ayarlayın. Ayarlanmazsa,
OpenClaw **çalışma zamanında ana makine saat dilimini çözer** (yapılandırmaya yazmadan).

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

Sistem istemi şunları içerir:

- Yerel saat ve saat dilimini içeren `Current Date & Time` bölümü
- `Time format: 12-hour` veya `24-hour`

İstem biçimini `agents.defaults.timeFormat` ile kontrol edebilirsiniz (`auto` | `12` | `24`).

Tüm davranış ve örnekler için [Date & Time](/date-time) bölümüne bakın.
