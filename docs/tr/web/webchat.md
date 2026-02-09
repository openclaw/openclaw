---
summary: "Loopback WebChat statik barındırma ve sohbet UI için Gateway WS kullanımı"
read_when:
  - WebChat erişimini hata ayıklarken veya yapılandırırken
title: "WebChat"
---

# WebChat (Gateway WebSocket UI)

Durum: macOS/iOS SwiftUI sohbet UI’si doğrudan Gateway WebSocket ile konuşur.

## Nedir

- Gateway için yerel bir sohbet UI’si (gömülü tarayıcı yok ve yerel statik sunucu yok).
- Diğer kanallarla aynı oturumları ve yönlendirme kurallarını kullanır.
- Deterministik yönlendirme: yanıtlar her zaman WebChat’e geri döner.

## Hızlı Başlangıç

1. Gateway’i başlatın.
2. WebChat UI’yi (macOS/iOS uygulaması) veya Control UI sohbet sekmesini açın.
3. Gateway kimlik doğrulamasının yapılandırıldığından emin olun (local loopback üzerinde bile varsayılan olarak gereklidir).

## Nasıl çalışır (davranış)

- UI, Gateway WebSocket’e bağlanır ve `chat.history`, `chat.send` ve `chat.inject` kullanır.
- `chat.inject`, bir asistan notunu doğrudan konuşma dökümüne ekler ve UI’ye yayınlar (ajan çalıştırılmaz).
- Geçmiş her zaman gateway’den alınır (yerel dosya izleme yok).
- Gateway’e ulaşılamıyorsa, WebChat salt okunurdur.

## Uzaktan kullanım

- Uzaktan mod, gateway WebSocket’ini SSH/Tailscale üzerinden tüneller.
- Ayrı bir WebChat sunucusu çalıştırmanız gerekmez.

## Yapılandırma başvurusu (WebChat)

Tam yapılandırma: [Configuration](/gateway/configuration)

Kanal seçenekleri:

- Ayrı bir `webchat.*` bloğu yoktur. WebChat, aşağıdaki gateway uç noktasını + kimlik doğrulama ayarlarını kullanır.

İlgili genel seçenekler:

- `gateway.port`, `gateway.bind`: WebSocket ana makinesi/portu.
- `gateway.auth.mode`, `gateway.auth.token`, `gateway.auth.password`: WebSocket kimlik doğrulaması.
- `gateway.remote.url`, `gateway.remote.token`, `gateway.remote.password`: uzak gateway hedefi.
- `session.*`: oturum depolama ve ana anahtar varsayılanları.
