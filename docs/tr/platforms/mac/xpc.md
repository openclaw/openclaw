---
summary: "OpenClaw uygulaması, gateway düğüm taşıması ve PeekabooBridge için macOS IPC mimarisi"
read_when:
  - IPC sözleşmelerini veya menü çubuğu uygulaması IPC'sini düzenlerken
title: "macOS IPC"
---

# OpenClaw macOS IPC mimarisi

**Mevcut model:** yerel bir Unix soketi, **node ana makinesi servisini** **macOS uygulamasına** exec onayları + `system.run` için bağlar. Keşif/bağlantı kontrolleri için bir `openclaw-mac` hata ayıklama CLI mevcuttur; ajan eylemleri hâlâ Gateway WebSocket ve `node.invoke` üzerinden akar. UI otomasyonu PeekabooBridge kullanır.

## Hedefler

- Tüm TCC temaslı işleri (bildirimler, ekran kaydı, mikrofon, konuşma, AppleScript) sahiplenen tek bir GUI uygulaması örneği.
- Otomasyon için küçük bir yüzey: Gateway + node komutları ve UI otomasyonu için PeekabooBridge.
- Öngörülebilir izinler: her zaman aynı imzalı bundle ID, launchd tarafından başlatılır, böylece TCC izinleri kalıcı olur.

## Nasıl çalışır

### Gateway + node taşıması

- Uygulama Gateway’i (yerel mod) çalıştırır ve bir node olarak ona bağlanır.
- Ajan eylemleri `node.invoke` aracılığıyla gerçekleştirilir (ör. `system.run`, `system.notify`, `canvas.*`).

### Node servisi + uygulama IPC

- Başsız bir node ana makinesi servisi Gateway WebSocket’e bağlanır.
- `system.run` istekleri yerel bir Unix soketi üzerinden macOS uygulamasına iletilir.
- Uygulama exec işlemini UI bağlamında gerçekleştirir, gerekirse kullanıcıdan onay ister ve çıktıyı döndürür.

Diyagram (SCI):

```
Agent -> Gateway -> Node Service (WS)
                      |  IPC (UDS + token + HMAC + TTL)
                      v
                  Mac App (UI + TCC + system.run)
```

### PeekabooBridge (UI otomasyonu)

- UI otomasyonu, `bridge.sock` adlı ayrı bir UNIX soketi ve PeekabooBridge JSON protokolünü kullanır.
- Ana makine tercih sırası (istemci tarafı): Peekaboo.app → Claude.app → OpenClaw.app → yerel yürütme.
- Güvenlik: köprü ana makineleri izin verilen bir TeamID gerektirir; DEBUG-only aynı UID kaçış yolu `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` ile korunur (Peekaboo geleneği).
- Ayrıntılar için bkz.: [PeekabooBridge kullanımı](/platforms/mac/peekaboo).

## Operasyonel akışlar

- Yeniden başlatma/yeniden derleme: `SIGN_IDENTITY="Apple Development: <Developer Name> (<TEAMID>)" scripts/restart-mac.sh`
  - Mevcut örnekleri sonlandırır
  - Swift derleme + paketleme
  - LaunchAgent’i yazar/başlatır/kickstart eder
- Tek örnek: aynı bundle ID’ye sahip başka bir örnek çalışıyorsa uygulama erken çıkar.

## Sertleştirme notları

- Tüm ayrıcalıklı yüzeyler için TeamID eşleşmesi zorunlu tutulmalıdır.
- PeekabooBridge: `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (DEBUG-only) yerel geliştirme için aynı UID çağıranlara izin verebilir.
- Tüm iletişim yalnızca yereldir; ağ soketleri açığa çıkarılmaz.
- TCC istemleri yalnızca GUI uygulaması paketinden kaynaklanır; yeniden derlemeler arasında imzalı bundle ID’yi sabit tutun.
- IPC sertleştirmesi: soket modu `0600`, belirteç, eş UID denetimleri, HMAC challenge/response, kısa TTL.
