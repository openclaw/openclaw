---
summary: "WebSocket dinleyicisi bağlaması kullanılarak Gateway tekil örnek koruması"
read_when:
  - Gateway sürecini çalıştırırken veya hata ayıklarken
  - Tek örnek zorlamasını incelerken
title: "Gateway Kilidi"
---

# Gateway kilidi

Son güncelleme: 2025-12-11

## Neden

- Aynı ana makinede, temel port başına yalnızca bir gateway örneğinin çalışmasını sağlamak; ek gateway’ler yalıtılmış profiller ve benzersiz portlar kullanmalıdır.
- Eski kilit dosyaları bırakmadan çökme/SIGKILL durumlarından sağ çıkmak.
- Denetim portu zaten kullanımdayken net bir hata ile hızlıca başarısız olmak.

## Mekanizma

- Gateway, başlangıçta hemen WebSocket dinleyicisini (varsayılan `ws://127.0.0.1:18789`) ayrıcalıklı bir TCP dinleyicisi kullanarak bağlar.
- Bağlama işlemi `EADDRINUSE` ile başarısız olursa, başlangıç `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")` fırlatır.
- İşletim sistemi, çökme ve SIGKILL dâhil olmak üzere herhangi bir süreç çıkışında dinleyiciyi otomatik olarak serbest bırakır—ayrı bir kilit dosyası veya temizlik adımı gerekmez.
- Kapanışta gateway, portu hızlıca serbest bırakmak için WebSocket sunucusunu ve alttaki HTTP sunucusunu kapatır.

## Hata yüzeyi

- Başka bir süreç portu tutuyorsa, başlangıç `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")` fırlatır.
- Diğer bağlama hataları `GatewayLockError("failed to bind gateway socket on ws://127.0.0.1:<port>: …")` olarak yüzeye çıkar.

## Operasyonel notlar

- Port _başka_ bir süreç tarafından kullanılıyorsa hata aynıdır; portu boşaltın veya `openclaw gateway --port <port>` ile başka bir port seçin.
- macOS uygulaması, gateway’i başlatmadan önce kendi hafif PID korumasını sürdürür; çalışma zamanı kilidi WebSocket bağlaması tarafından zorlanır.
