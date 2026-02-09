---
summary: "macOS uygulamasının gateway WebChat’i nasıl gömdüğü ve bunun nasıl hata ayıklanacağı"
read_when:
  - macOS WebChat görünümü veya loopback portu hata ayıklanırken
title: "WebChat"
---

# WebChat (macOS uygulaması)

macOS menü çubuğu uygulaması, WebChat kullanıcı arayüzünü yerel bir SwiftUI görünümü olarak gömer. Gateway’e bağlanır ve seçili ajan için varsayılan olarak **ana oturumu** kullanır (diğer oturumlar için bir oturum değiştirici ile).

- **Yerel mod**: yerel Gateway WebSocket’e doğrudan bağlanır.
- **Uzak mod**: Gateway denetim portunu SSH üzerinden iletir ve bu tüneli veri düzlemi olarak kullanır.

## Başlatma ve hata ayıklama

- Manuel: Lobster menüsü → “Sohbeti Aç”.

- Test için otomatik açma:

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat
  ```

- Günlükler: `./scripts/clawlog.sh` (alt sistem `bot.molt`, kategori `WebChatSwiftUI`).

## Nasıl bağlanır

- Veri düzlemi: Gateway WS yöntemleri `chat.history`, `chat.send`, `chat.abort`,
  `chat.inject` ve olaylar `chat`, `agent`, `presence`, `tick`, `health`.
- Oturum: varsayılan olarak birincil oturumdur (`main`; kapsam global olduğunda `global`). Kullanıcı arayüzü oturumlar arasında geçiş yapabilir.
- İlk kullanım akışı, ilk çalıştırma kurulumunu ayrı tutmak için özel bir oturum kullanır.

## Güvenlik yüzeyi

- Uzak mod, yalnızca Gateway WebSocket denetim portunu SSH üzerinden iletir.

## Bilinen sınırlamalar

- Kullanıcı arayüzü sohbet oturumları için optimize edilmiştir (tam bir tarayıcı sandbox’ı değildir).
