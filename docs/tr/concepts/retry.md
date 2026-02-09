---
summary: "Giden sağlayıcı çağrıları için yeniden deneme ilkesi"
read_when:
  - Sağlayıcı yeniden deneme davranışını veya varsayılanlarını güncellerken
  - Sağlayıcı gönderim hatalarını veya oran sınırlarını ayıklarken
title: "Retry Policy"
---

# Yeniden deneme politikası

## Hedefler

- Çok adımlı akış başına değil, HTTP isteği başına yeniden denemek.
- Yalnızca mevcut adımı yeniden deneyerek sıralamayı korumak.
- İdempotent olmayan işlemlerin çoğaltılmasını önlemek.

## Varsayılanlar

- Deneme sayısı: 3
- Maksimum gecikme üst sınırı: 30000 ms
- Jitter: 0.1 (%10)
- Sağlayıcı varsayılanları:
  - Telegram minimum gecikme: 400 ms
  - Discord minimum gecikme: 500 ms

## Davranış

### Discord

- Yalnızca oran sınırı hatalarında (HTTP 429) yeniden dener.
- Mümkün olduğunda Discord `retry_after` kullanır; aksi halde üstel geri çekilme uygular.

### Telegram

- Geçici hatalarda yeniden dener (429, zaman aşımı, bağlantı/yeniden ayarlama/kapatma, geçici olarak kullanılamıyor).
- Mümkün olduğunda `retry_after` kullanır; aksi halde üstel geri çekilme uygular.
- Markdown ayrıştırma hataları yeniden denenmez; düz metne geri düşer.

## Yapılandırma

Yeniden deneme ilkesini sağlayıcı başına `~/.openclaw/openclaw.json` içinde ayarlayın:

```json5
{
  channels: {
    telegram: {
      retry: {
        attempts: 3,
        minDelayMs: 400,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
    discord: {
      retry: {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

## Notlar

- Yeniden denemeler istek başına uygulanır (mesaj gönderme, medya yükleme, tepki, anket, çıkartma).
- Bileşik akışlar tamamlanan adımları yeniden denemez.
