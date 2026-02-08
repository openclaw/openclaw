---
summary: "Eşleştirmeye genel bakış: size DM atabilecekleri ve hangi düğümlerin katılabileceğini onaylayın"
read_when:
  - DM erişim denetimini ayarlarken
  - Yeni bir iOS/Android düğümünü eşleştirirken
  - OpenClaw güvenlik duruşunu gözden geçirirken
title: "Eşleştirme"
x-i18n:
  source_path: channels/pairing.md
  source_hash: cc6ce9c71db6d96d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:55Z
---

# Eşleştirme

“Eşleştirme”, OpenClaw’ın açık **sahip onayı** adımıdır.
İki yerde kullanılır:

1. **DM eşleştirme** (botla kimlerin konuşmasına izin verildiği)
2. **Düğüm eşleştirme** (hangi cihazların/düğümlerin gateway (ağ geçidi) ağına katılmasına izin verildiği)

Güvenlik bağlamı: [Güvenlik](/gateway/security)

## 1) DM eşleştirme (gelen sohbet erişimi)

Bir kanal DM politikası `pairing` ile yapılandırıldığında, bilinmeyen göndericilere kısa bir kod verilir ve onaylayana kadar mesajları **işlenmez**.

Varsayılan DM politikaları şu belgede yer alır: [Güvenlik](/gateway/security)

Eşleştirme kodları:

- 8 karakter, büyük harf, belirsiz karakter yok (`0O1I`).
- **1 saat sonra sona erer**. Bot, yeni bir istek oluşturulduğunda (gönderici başına yaklaşık saatte bir) yalnızca bir eşleştirme mesajı gönderir.
- Bekleyen DM eşleştirme istekleri varsayılan olarak **kanal başına 3** ile sınırlıdır; biri süresi dolana veya onaylanana kadar ek istekler yok sayılır.

### Bir göndericiyi onaylayın

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

Desteklenen kanallar: `telegram`, `whatsapp`, `signal`, `imessage`, `discord`, `slack`.

### Durumun nerede tutulduğu

`~/.openclaw/credentials/` altında saklanır:

- Bekleyen istekler: `<channel>-pairing.json`
- Onaylı izin listesi deposu: `<channel>-allowFrom.json`

Bunları hassas olarak değerlendirin (asistanınıza erişimi sınırlarlar).

## 2) Düğüm cihaz eşleştirme (iOS/Android/macOS/başsız düğümler)

Düğümler, `role: node` ile **cihaz** olarak Gateway’e bağlanır. Gateway (Ağ Geçidi),
onaylanması gereken bir cihaz eşleştirme isteği oluşturur.

### Bir düğüm cihazını onaylayın

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

### Düğüm eşleştirme durumu depolaması

`~/.openclaw/devices/` altında saklanır:

- `pending.json` (kısa ömürlü; bekleyen isteklerin süresi dolar)
- `paired.json` (eşleştirilmiş cihazlar + belirteçler)

### Notlar

- Eski `node.pair.*` API’si (CLI: `openclaw nodes pending/approve`) gateway’ye ait ayrı bir eşleştirme deposudur. WS düğümleri yine de cihaz eşleştirmesi gerektirir.

## İlgili belgeler

- Güvenlik modeli + prompt enjeksiyonu: [Güvenlik](/gateway/security)
- Güvenli şekilde güncelleme (doctor çalıştırma): [Güncelleme](/install/updating)
- Kanal yapılandırmaları:
  - Telegram: [Telegram](/channels/telegram)
  - WhatsApp: [WhatsApp](/channels/whatsapp)
  - Signal: [Signal](/channels/signal)
  - BlueBubbles (iMessage): [BlueBubbles](/channels/bluebubbles)
  - iMessage (eski): [iMessage](/channels/imessage)
  - Discord: [Discord](/channels/discord)
  - Slack: [Slack](/channels/slack)
