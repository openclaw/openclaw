---
summary: "Düğümler için konum komutu (location.get), izin modları ve arka plan davranışı"
read_when:
  - Konum düğümü desteği veya izinler UI'si eklerken
  - Arka plan konumu + push akışları tasarlarken
title: "Location Command"
---

# Konum komutu (düğümler)

## TL;DR

- `location.get` bir düğüm komutudur (`node.invoke` aracılığıyla).
- Varsayılan olarak kapalıdır.
- Ayarlar bir seçici kullanır: Kapalı / Kullanım Sırasında / Her Zaman.
- Ayrı bir anahtar: Hassas Konum.

## Neden bir seçici (sadece bir anahtar değil)

İşletim sistemi izinleri çok seviyelidir. Uygulama içinde bir seçici sunabiliriz, ancak gerçek yetkilendirmeyi OS belirler.

- iOS/macOS: kullanıcı sistem istemlerinde/Ayarlar’da **Kullanım Sırasında** veya **Her Zaman** seçebilir. Uygulama yükseltme isteyebilir, ancak OS Ayarlar’ı gerektirebilir.
- Android: arka plan konumu ayrı bir izindir; Android 10+’ta çoğu zaman bir Ayarlar akışı gerektirir.
- Hassas konum ayrı bir izindir (iOS 14+ “Precise”, Android’de “fine” vs “coarse”).

UI’daki seçici, talep edilen modu belirler; gerçek yetki OS ayarlarında bulunur.

## Ayarlar modeli

Düğüm cihazı başına:

- `location.enabledMode`: `off | whileUsing | always`
- `location.preciseEnabled`: bool

UI davranışı:

- Selecting `whileUsing` requests foreground permission.
- `always` seçildiğinde önce `whileUsing` sağlanır, ardından arka plan izni istenir (gerekirse kullanıcı Ayarlar’a yönlendirilir).
- OS istenen seviyeyi reddederse, verilen en yüksek seviyeye geri dönülür ve durum gösterilir.

## İzin eşlemesi (node.permissions)

İsteğe bağlıdır. macOS düğümü izinler haritası üzerinden `location` bildirir; iOS/Android bunu atlayabilir.

## Komut: `location.get`

`node.invoke` aracılığıyla çağrılır.

Parametreler (önerilen):

```json
{
  "timeoutMs": 10000,
  "maxAgeMs": 15000,
  "desiredAccuracy": "coarse|balanced|precise"
}
```

Yanıt yükü:

```json
{
  "lat": 48.20849,
  "lon": 16.37208,
  "accuracyMeters": 12.5,
  "altitudeMeters": 182.0,
  "speedMps": 0.0,
  "headingDeg": 270.0,
  "timestamp": "2026-01-03T12:34:56.000Z",
  "isPrecise": true,
  "source": "gps|wifi|cell|unknown"
}
```

Hatalar (sabit kodlar):

- `LOCATION_DISABLED`: seçici kapalı.
- `LOCATION_PERMISSION_REQUIRED`: istenen mod için izin eksik.
- `LOCATION_BACKGROUND_UNAVAILABLE`: uygulama arka planda ancak yalnızca Kullanım Sırasında izinli.
- `LOCATION_TIMEOUT`: zamanında konum alınamadı.
- `LOCATION_UNAVAILABLE`: sistem hatası / sağlayıcı yok.

## Arka plan davranışı (gelecek)

Amaç: model, düğüm arka plandayken bile konum isteyebilsin, ancak yalnızca şu durumlarda:

- Kullanıcı **Her Zaman**’ı seçtiyse.
- OS arka plan konumunu verdiyse.
- Uygulamanın konum için arka planda çalışmasına izin veriliyorsa (iOS arka plan modu / Android foreground service veya özel izin).

Push tetiklemeli akış (gelecek):

1. Gateway düğüme bir push gönderir (sessiz push veya FCM veri).
2. Düğüm kısa süreliğine uyanır ve cihazdan konum ister.
3. Düğüm yükü Gateway’e iletir.

Notlar:

- iOS: Her Zaman izni + arka plan konum modu gereklidir. Sessiz push kısıtlanabilir; aralıklı başarısızlıklar beklenir.
- Android: arka plan konumu bir foreground service gerektirebilir; aksi halde reddedilmesi beklenir.

## Model/araç entegrasyonu

- Araç yüzeyi: `nodes` aracı `location_get` eylemini ekler (düğüm gereklidir).
- CLI: `openclaw nodes location get --node <id>`.
- Ajan yönergeleri: yalnızca kullanıcı konumu etkinleştirdiğinde ve kapsamı anladığında çağırın.

## UX copy (suggested)

- Kapalı: “Konum paylaşımı devre dışı.”
- Kullanım Sırasında: “Yalnızca OpenClaw açıkken.”
- Her Zaman: “Arka plan konumuna izin ver. Sistem izni gerektirir.”
- Hassas: “Hassas GPS konumu kullan. Yaklaşık konum paylaşmak için kapatın.”
