---
summary: "Zarflar, istemler, araçlar ve bağlayıcılar genelinde tarih ve saat işlemleri"
read_when:
  - Model veya kullanıcılara zaman damgalarının nasıl gösterildiğini değiştiriyorsanız
  - Mesajlarda veya sistem istemi çıktısında zaman biçimlendirmesini hata ayıklıyorsanız
title: "Tarih ve Saat"
---

# Tarih & Saat

OpenClaw varsayılan olarak **taşıma zaman damgaları için ana makine yerel saatini** ve **sistem isteminde yalnızca kullanıcı saat dilimini** kullanır.
Sağlayıcı zaman damgaları korunur; böylece araçlar kendi yerel anlamlarını sürdürür (geçerli zaman `session_status` üzerinden kullanılabilir).

## Mesaj zarfları (varsayılan: yerel)

Gelen mesajlar bir zaman damgası ile sarılır (dakika hassasiyeti):

```
[Provider ... 2026-01-05 16:26 PST] message text
```

Bu zarf zaman damgası, sağlayıcı saat diliminden bağımsız olarak **varsayılan olarak ana makine yereldir**.

Bu davranışı geçersiz kılabilirsiniz:

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
- `envelopeTimezone: "local"` ana makine saat dilimini kullanır.
- `envelopeTimezone: "user"` `agents.defaults.userTimezone` kullanır (ana makine saat dilimine geri döner).
- Sabit bir bölge için açık bir IANA saat dilimi kullanın (örn. `"America/Chicago"`).
- `envelopeTimestamp: "off"` zarf başlıklarından mutlak zaman damgalarını kaldırır.
- `envelopeElapsed: "off"` geçen süre soneklerini kaldırır (`+2m` stili).

### Örnekler

**Local (default):**

```
[WhatsApp +1555 2026-01-18 00:19 PST] hello
```

**Kullanıcı saat dilimi:**

```
[WhatsApp +1555 2026-01-18 00:19 CST] hello
```

**Geçen süre etkin:**

```
[WhatsApp +1555 +30s 2026-01-18T05:19Z] follow-up
```

## Sistem istemi: Geçerli Tarih & Saat

Kullanıcı saat dilimi biliniyorsa, sistem istemi, istem önbelleğini kararlı tutmak için
**yalnızca saat dilimini** (saat/biçim yok) içeren özel bir
**Geçerli Tarih & Saat** bölümü ekler:

```
Time zone: America/Chicago
```

Ajanın geçerli zamana ihtiyaç duyması halinde `session_status` aracını kullanın; durum
kartı bir zaman damgası satırı içerir.

## Sistem olay satırları (varsayılan: yerel)

Ajan bağlamına eklenen kuyruğa alınmış sistem olayları, mesaj zarflarıyla aynı saat dilimi
seçimini kullanarak bir zaman damgası ile öneklenir (varsayılan: ana makine yerel).

```
System: [2026-01-12 12:19:17 PST] Model switched.
```

### Kullanıcı saat dilimi + biçimi yapılandırma

```json5
{
  agents: {
    defaults: {
      userTimezone: "America/Chicago",
      timeFormat: "auto", // auto | 12 | 24
    },
  },
}
```

- `userTimezone` istem bağlamı için **kullanıcı-yerel saat dilimini** ayarlar.
- `timeFormat` istemde **12s/24s gösterimini** denetler. `auto` işletim sistemi tercihlerini izler.

## Zaman biçimi algılama (otomatik)

`timeFormat: "auto"` olduğunda, OpenClaw işletim sistemi tercihini (macOS/Windows) inceler
ve yerel ayar biçimlendirmesine geri düşer. Algılanan değer, yinelenen sistem çağrılarını
önlemek için **süreç başına önbelleğe alınır**.

## Araç yükleri + bağlayıcılar (ham sağlayıcı zamanı + normalize alanlar)

Kanal araçları **sağlayıcıya özgü zaman damgalarını** döndürür ve tutarlılık için normalize alanlar ekler:

- `timestampMs`: epoch milisaniye (UTC)
- `timestampUtc`: ISO 8601 UTC dizesi

Ham sağlayıcı alanları korunur; böylece hiçbir bilgi kaybolmaz.

- Slack: API’den epoch benzeri dizeler
- Discord: UTC ISO zaman damgaları
- Telegram/WhatsApp: sağlayıcıya özgü sayısal/ISO zaman damgaları

Yerel zamana ihtiyacınız varsa, bilinen saat dilimini kullanarak bunu aşağı akışta dönüştürün.

## İlgili belgeler

- [Sistem İstemi](/concepts/system-prompt)
- [Saat Dilimleri](/concepts/timezone)
- [Mesajlar](/concepts/messages)
