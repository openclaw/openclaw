---
summary: "Zarf, istemler, araçlar ve bağlayıcılar genelinde tarih ve saat işleme"
read_when:
  - Zaman damgalarının modele veya kullanıcılara nasıl gösterildiğini değiştiriyorsunuz
  - Mesajlarda veya sistem istemi çıktısında zaman biçimlendirmesini ayıklıyorsunuz
title: "Tarih ve Saat"
---

# Tarih ve Saat

OpenClaw, **taşıma zaman damgaları için ana makine yerel saatini** ve **sistem isteminde yalnızca kullanıcı saat dilimini** kullanır.
Sağlayıcı zaman damgaları korunur, böylece araçlar yerel semantiklerini korur (mevcut saat `session_status` aracılığıyla mevcuttur).

## Mesaj zarfı (varsayılan olarak yerel)

Gelen mesajlar bir zaman damgasıyla sarılır (dakika hassasiyeti):

```
[Sağlayıcı ... 2026-01-05 16:26 PST] mesaj metni
```

Bu zarf zaman damgası, sağlayıcı saat diliminden bağımsız olarak **varsayılan olarak ana makine yerelidir**.

Bu davranışı geçersiz kılabilirsiniz:

```json5
{
  agents: {
    defaults: {
      envelopeTimezone: "local", // "utc" | "local" | "user" | IANA saat dilimi
      envelopeTimestamp: "on", // "on" | "off"
      envelopeElapsed: "on", // "on" | "off"
    },
  },
}
```

- `envelopeTimezone: "utc"` UTC kullanır.
- `envelopeTimezone: "local"` ana makine saat dilimini kullanır.
- `envelopeTimezone: "user"` `agents.defaults.userTimezone` kullanır (ana makine saat dilimine geri döner).
- Sabit bir bölge için açık bir IANA saat dilimi kullanın (ör. `"America/Chicago"`).
- `envelopeTimestamp: "off"` zarf başlıklarından mutlak zaman damgalarını kaldırır.
- `envelopeElapsed: "off"` geçen zaman son eklerini kaldırır (`+2m` stili).

### Örnekler

**Yerel (varsayılan):**

```
[WhatsApp +1555 2026-01-18 00:19 PST] merhaba
```

**Kullanıcı saat dilimi:**

```
[WhatsApp +1555 2026-01-18 00:19 CST] merhaba
```

**Geçen zaman etkin:**

```
[WhatsApp +1555 +30s 2026-01-18T05:19Z] takip
```

## Sistem istemi: Mevcut Tarih ve Saat

Kullanıcı saat dilimi biliniyorsa, sistem istemi, istem önbelleğe alma kararlılığını korumak için **yalnızca saat dilimini** (saat/saat formatı yok) içeren ayrılmış bir **Mevcut Tarih ve Saat** bölümü içerir:

```
Saat dilimi: America/Chicago
```

Aracın mevcut saate ihtiyacı olduğunda, `session_status` aracını kullanın; durum kartı bir zaman damgası satırı içerir.

## Sistem olay satırları (varsayılan olarak yerel)

Aracı bağlamına eklenen kuyruğa alınmış sistem olayları, mesaj zarfıyla aynı saat dilimi seçimi kullanılarak bir zaman damgası ile öneklenir (varsayılan: ana makine yerel).

```
Sistem: [2026-01-12 12:19:17 PST] Model değiştirildi.
```

### Kullanıcı saat dilimi + formatını yapılandırma

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

- `userTimezone`, istem bağlamı için **kullanıcı yerel saat dilimini** ayarlar.
- `timeFormat`, istemdeki **12s/24s görüntülemeyi** kontrol eder. `auto` OS tercihlerini izler.

## Saat formatı algılama (oto)

`timeFormat: "auto"` olduğunda, OpenClaw OS tercihini (macOS/Windows) inceler ve yerel ayara geri döner. Algılanan değer, tekrarlanan sistem çağlarından kaçınmak için **proses başına önbelleğe alınır**.

## Araç yüklemeleri + bağlayıcılar (ham sağlayıcı zamanı + normalleştirilmiş alanlar)

Kanal araçları **sağlayıcı yerel zaman damgalarını** döndürür ve tutarlılık için normalleştirilmiş alanlar ekler:

- `timestampMs`: epoch milisaniyesi (UTC)
- `timestampUtc`: ISO 8601 UTC dizesi

Ham sağlayıcı alanları korunur, hiçbir şey kaybedilmez.

- Slack: API'den epoch benzeri dizeler
- Discord: UTC ISO zaman damgaları
- Telegram/WhatsApp: sağlayıcıya özel sayısal/ISO zaman damgaları

Yerel saate ihtiyacınız varsa, bilinen saat dilimini kullanarak aşağı akışta dönüştürün.

## İlgili belgeler

- [Sistem İstemi](/concepts/system-prompt)
- [Saat Dilimleri](/concepts/timezone)
- [Mesajlar](/concepts/messages)
