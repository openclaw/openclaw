---
summary: "macOS UI otomasyonu için PeekabooBridge entegrasyonu"
read_when:
  - OpenClaw.app içinde PeekabooBridge barındırma
  - Swift Package Manager ile Peekaboo entegrasyonu
  - PeekabooBridge protokolü/yollarını değiştirme
title: "Peekaboo Bridge"
---

# Peekaboo Bridge (macOS UI otomasyonu)

OpenClaw, **PeekabooBridge**’i yerel ve izin farkındalığı olan bir UI otomasyonu
aracısı olarak barındırabilir. Bu, `peekaboo` CLI’nin macOS uygulamasının TCC
izinlerini yeniden kullanarak UI otomasyonunu sürmesini sağlar.

## Bu nedir (ve ne değildir)

- **Host**: OpenClaw.app bir PeekabooBridge host’u olarak davranabilir.
- **Client**: `peekaboo` CLI’yi kullanın (ayrı bir `openclaw ui ...` yüzeyi yoktur).
- **UI**: görsel kaplamalar Peekaboo.app’te kalır; OpenClaw ince bir aracı host’tur.

## Bridge’i etkinleştirme

macOS uygulamasında:

- Ayarlar → **Enable Peekaboo Bridge**

Etkinleştirildiğinde OpenClaw yerel bir UNIX socket sunucusu başlatır. Devre dışı
bırakıldığında host durdurulur ve `peekaboo` diğer mevcut host’lara geri döner.

## İstemci keşif sırası

Peekaboo istemcileri genellikle host’ları şu sırayla dener:

1. Peekaboo.app (tam UX)
2. Claude.app (kuruluysa)
3. OpenClaw.app (ince aracı)

Hangi host’un etkin olduğunu ve hangi socket yolunun kullanıldığını görmek için
`peekaboo bridge status --verbose` kullanın. Şununla geçersiz kılabilirsiniz:

```bash
export PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock
```

## Güvenlik ve izinler

- Bridge, **çağıran kod imzalarını** doğrular; TeamID’lerden oluşan bir izin listesi
  uygulanır (Peekaboo host TeamID + OpenClaw uygulama TeamID).
- İstekler ~10 saniye sonra zaman aşımına uğrar.
- Gerekli izinler eksikse, bridge Sistem Ayarları’nı başlatmak yerine net bir hata
  mesajı döndürür.

## Snapshot davranışı (otomasyon)

Snapshot’lar bellekte saklanır ve kısa bir süre sonra otomatik olarak sona erer.
Daha uzun süreli saklama gerekiyorsa, istemciden yeniden yakalayın.

## Sorun Giderme

- `peekaboo` “bridge client is not authorized” bildiriyorsa, istemcinin doğru
  şekilde imzalandığından emin olun veya host’u yalnızca **debug** modunda
  `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` ile çalıştırın.
- Hiç host bulunamazsa, host uygulamalarından birini (Peekaboo.app veya OpenClaw.app)
  açın ve izinlerin verildiğini doğrulayın.
