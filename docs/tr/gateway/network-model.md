---
summary: "Gateway, düğümler ve canvas ana makinesinin nasıl bağlandığı."
read_when:
  - Gateway ağ modelinin özlü bir görünümünü istediğinizde
title: "Ağ modeli"
x-i18n:
  source_path: gateway/network-model.md
  source_hash: e3508b884757ef19
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:19Z
---

Çoğu işlem, kanal bağlantılarına ve WebSocket denetim düzlemine sahip, tek ve uzun süre çalışan bir süreç olan Gateway (`openclaw gateway`) üzerinden akar.

## Temel kurallar

- Ana makine başına bir Gateway önerilir. WhatsApp Web oturumuna sahip olmasına izin verilen tek süreçtir. Kurtarma botları veya sıkı yalıtım için, yalıtılmış profiller ve portlarla birden fazla gateway çalıştırın. Bkz. [Birden fazla gateway](/gateway/multiple-gateways).
- Önce local loopback: Gateway WS varsayılan olarak `ws://127.0.0.1:18789`’dir. Sihirbaz, loopback için bile varsayılan olarak bir gateway belirteci oluşturur. Tailnet erişimi için `openclaw gateway --bind tailnet --token ...` çalıştırın; çünkü loopback olmayan bağlamalar için belirteçler gereklidir.
- Düğümler, gerektikçe LAN, tailnet veya SSH üzerinden Gateway WS’ye bağlanır. Eski TCP köprüsü kullanım dışıdır.
- Canvas ana makinesi, düğüm WebViews’leri için `/__openclaw__/canvas/` sunan, `canvasHost.port` üzerinde (varsayılan `18793`) bir HTTP dosya sunucusudur. Bkz. [Gateway yapılandırması](/gateway/configuration) (`canvasHost`).
- Uzaktan kullanım genellikle SSH tüneli veya tailnet VPN’dir. Bkz. [Uzaktan erişim](/gateway/remote) ve [Keşif](/gateway/discovery).
