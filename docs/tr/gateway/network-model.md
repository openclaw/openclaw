---
summary: "Gateway, düğümler ve canvas ana makinesinin nasıl bağlandığı."
read_when:
  - Gateway ağ modelinin özlü bir görünümünü istediğinizde
title: "Ağ modeli"
---

Çoğu işlem, kanal bağlantılarına ve WebSocket denetim düzlemine sahip, tek ve uzun süre çalışan bir süreç olan Gateway (`openclaw gateway`) üzerinden akar.

## Temel kurallar

- Ana makine başına bir Gateway önerilir. WhatsApp Web oturumuna sahip olmasına izin verilen tek süreçtir. Kurtarma botları veya sıkı yalıtım için, yalıtılmış profiller ve portlarla birden fazla gateway çalıştırın. [Birden fazla gateway](/gateway/multiple-gateways).
- Önce local loopback: Gateway WS varsayılan olarak `ws://127.0.0.1:18789`’dir. Sihirbaz, loopback için bile varsayılan olarak bir gateway belirteci oluşturur. Tailnet erişimi için `openclaw gateway --bind tailnet --token ...` çalıştırın; çünkü loopback olmayan bağlamalar için belirteçler gereklidir.
- Düğümler, gerektikçe LAN, tailnet veya SSH üzerinden Gateway WS’ye bağlanır. Eski TCP köprüsü kullanım dışıdır.
- Canvas ana makinesi, düğüm WebViews’leri için `/__openclaw__/canvas/` sunan, `canvasHost.port` üzerinde (varsayılan `18793`) bir HTTP dosya sunucusudur. [Gateway yapılandırması](/gateway/configuration) (`canvasHost`).
- Uzaktan kullanım genellikle SSH tüneli veya tailnet VPN’dir. [Uzaktan erişim](/gateway/remote) ve [Keşif](/gateway/discovery).
