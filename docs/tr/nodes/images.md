---
summary: "Gönderim, gateway ve ajan yanıtları için görsel ve medya işleme kuralları"
read_when:
  - Medya hattı veya ekler değiştirildiğinde
title: "Görsel ve Medya Desteği"
---

# Görsel & Medya Desteği — 2025-12-05

WhatsApp kanalı **Baileys Web** üzerinden çalışır. Bu belge, gönderim, gateway ve ajan yanıtları için geçerli mevcut medya işleme kurallarını kapsar.

## Hedefler

- `openclaw message send --media` üzerinden isteğe bağlı açıklamalarla medya gönderimi.
- Web gelen kutusundan otomatik yanıtların metnin yanında medya içerebilmesi.
- Tür bazlı sınırların makul ve öngörülebilir tutulması.

## CLI Yüzeyi

- `openclaw message send --media <path-or-url> [--message <caption>]`
  - `--media` isteğe bağlıdır; yalnızca medya gönderimleri için açıklama boş olabilir.
  - `--dry-run` çözümlenen yükü yazdırır; `--json` ise `{ channel, to, messageId, mediaUrl, caption }` üretir.

## WhatsApp Web kanal davranışı

- Girdi: yerel dosya yolu **veya** HTTP(S) URL’si.
- Akış: Buffer’a yükle, medya türünü algıla ve doğru yükü oluştur:
  - **Görseller:** JPEG’e yeniden boyutlandırma ve yeniden sıkıştırma (maks. kenar 2048px), hedef `agents.defaults.mediaMaxMb` (varsayılan 5 MB), üst sınır 6 MB.
  - **Ses/Voice/Video:** 16 MB’a kadar doğrudan iletim; ses, sesli not olarak gönderilir (`ptt: true`).
  - **Belgeler:** diğer her şey; 100 MB’a kadar, mümkünse dosya adı korunur.
- WhatsApp GIF tarzı oynatma: mobil istemcilerin satır içi döngülemesi için `gifPlayback: true` (CLI: `--gif-playback`) ile bir MP4 gönderin.
- MIME algılama; önce magic byte’ları, sonra başlıkları, ardından dosya uzantısını tercih eder.
- Açıklama `--message` veya `reply.text`’den alınır; boş açıklamaya izin verilir.
- Günlükleme: ayrıntısız mod `↩️`/`✅` gösterir; ayrıntılı mod boyut ve kaynak yol/URL’yi içerir.

## Otomatik Yanıt Hattı

- `getReplyFromConfig`, `{ text?, mediaUrl?, mediaUrls? }` döndürür.
- Medya mevcut olduğunda, web gönderici yerel yolları veya URL’leri `openclaw message send` ile aynı hat üzerinden çözümler.
- Birden fazla medya girdisi sağlanırsa ardışık olarak gönderilir.

## Komutlara Gelen Medya (Pi)

- Gelen web mesajları medya içerdiğinde, OpenClaw geçici bir dosyaya indirir ve şablonlama değişkenlerini sunar:
  - Gelen medya için sözde URL: `{{MediaUrl}}`.
  - Komut çalıştırılmadan önce yazılan yerel geçici yol: `{{MediaPath}}`.
- Oturum başına Docker sandbox etkinleştirildiğinde, gelen medya sandbox çalışma alanına kopyalanır ve `MediaPath`/`MediaUrl`, `media/inbound/<filename>` gibi göreli bir yola yeniden yazılır.
- Medya anlama ( `tools.media.*` veya paylaşılan `tools.media.models` ile yapılandırıldıysa) şablonlamadan önce çalışır ve `Body` içine `[Image]`, `[Audio]` ve `[Video]` bloklarını ekleyebilir.
  - Ses, `{{Transcript}}` ayarlar ve eğik çizgi komutlarının çalışmaya devam etmesi için komut ayrıştırmada transkripti kullanır.
  - Video ve görsel açıklamaları, komut ayrıştırma için mevcut açıklama metnini korur.
- Varsayılan olarak yalnızca ilk eşleşen görsel/ses/video eki işlenir; birden fazla eki işlemek için `tools.media.<cap>.attachments` ayarlayın.

## Sınırlar ve Hatalar

**Giden gönderim üst sınırları (WhatsApp web gönderimi)**

- Görseller: yeniden sıkıştırma sonrası ~6 MB üst sınır.
- Ses/voice/video: 16 MB üst sınır; belgeler: 100 MB üst sınır.
- Aşırı büyük veya okunamayan medya → günlüklerde açık hata ve yanıt atlanır.

**Medya anlama üst sınırları (transkripsiyon/açıklama)**

- Görsel varsayılanı: 10 MB (`tools.media.image.maxBytes`).
- Ses varsayılanı: 20 MB (`tools.media.audio.maxBytes`).
- Video varsayılanı: 50 MB (`tools.media.video.maxBytes`).
- Aşırı büyük medya, anlamayı atlar; ancak yanıtlar özgün gövdeyle gönderilmeye devam eder.

## Testler için Notlar

- Görsel/ses/belge durumları için gönderim + yanıt akışlarını kapsayın.
- Görseller için yeniden sıkıştırmayı (boyut sınırı) ve ses için sesli not bayrağını doğrulayın.
- Çoklu medya yanıtlarının ardışık gönderimler olarak yayılmasını sağlayın.
