---
summary: "Harici CLI’ler (signal-cli, legacy imsg) ve gateway desenleri için RPC bağdaştırıcıları"
read_when:
  - Harici CLI entegrasyonları eklerken veya değiştirirken
  - RPC bağdaştırıcılarını (signal-cli, imsg) hata ayıklarken
title: "RPC Bağdaştırıcıları"
---

# RPC bağdaştırıcıları

OpenClaw, harici CLI’leri JSON-RPC aracılığıyla entegre eder. Günümüzde iki desen kullanılmaktadır.

## Desen A: HTTP daemon (signal-cli)

- `signal-cli`, HTTP üzerinden JSON-RPC ile bir daemon olarak çalışır.
- Olay akışı SSE’dir (`/api/v1/events`).
- Sağlık denetimi: `/api/v1/check`.
- `channels.signal.autoStart=true` olduğunda yaşam döngüsü OpenClaw’a aittir.

Kurulum ve uç noktalar için [Signal](/channels/signal) sayfasına bakın.

## Desen B: stdio alt süreç (legacy: imsg)

> **Not:** Yeni iMessage kurulumları için bunun yerine [BlueBubbles](/channels/bluebubbles) kullanın.

- OpenClaw, `imsg rpc`’ü bir alt süreç olarak başlatır (legacy iMessage entegrasyonu).
- JSON-RPC, stdin/stdout üzerinden satır sınırlı olarak iletilir (satır başına bir JSON nesnesi).
- TCP portu yoktur, daemon gerekmez.

Kullanılan temel yöntemler:

- `watch.subscribe` → bildirimler (`method: "message"`)
- `watch.unsubscribe`
- `send`
- `chats.list` (prob/tanı)

Legacy kurulum ve adresleme için [iMessage](/channels/imessage) sayfasına bakın (`chat_id` tercih edilir).

## Bağdaştırıcı yönergeleri

- Süreç Gateway’e aittir (başlatma/durdurma, sağlayıcı yaşam döngüsüne bağlıdır).
- RPC istemcilerini dayanıklı tutun: zaman aşımları, çıkışta yeniden başlatma.
- Görünen dizgeler yerine kararlı kimlikleri tercih edin (örn. `chat_id`).
