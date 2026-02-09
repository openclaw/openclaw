---
summary: "Ajan kullanımı için kamera yakalama (iOS düğümü + macOS uygulaması): fotoğraflar (jpg) ve kısa video klipler (mp4)"
read_when:
  - iOS düğümlerinde veya macOS’te kamera yakalamayı eklerken ya da değiştirirken
  - Ajanın erişebildiği MEDIA geçici dosya iş akışlarını genişletirken
title: "Kamera Yakalama"
---

# Kamera yakalama (ajan)

OpenClaw, ajan iş akışları için **kamera yakalamayı** destekler:

- **iOS düğümü** (Gateway üzerinden eşleştirilmiş): `node.invoke` aracılığıyla **fotoğraf** (`jpg`) veya **kısa video klip** (`mp4`, isteğe bağlı sesle) yakalama.
- **Android düğümü** (Gateway üzerinden eşleştirilmiş): `node.invoke` aracılığıyla **fotoğraf** (`jpg`) veya **kısa video klip** (`mp4`, isteğe bağlı sesle) yakalama.
- **macOS uygulaması** (Gateway üzerinden düğüm): `node.invoke` aracılığıyla **fotoğraf** (`jpg`) veya **kısa video klip** (`mp4`, isteğe bağlı sesle) yakalama.

Tüm kamera erişimleri **kullanıcı tarafından kontrol edilen ayarlarla** sınırlandırılmıştır.

## iOS düğümü

### Kullanıcı ayarı (varsayılan açık)

- iOS Ayarlar sekmesi → **Kamera** → **Kameraya İzin Ver** (`camera.enabled`)
  - Varsayılan: **açık** (anahtar yoksa etkin kabul edilir).
  - Kapalıyken: `camera.*` komutları `CAMERA_DISABLED` döndürür.

### Komutlar (Gateway üzerinden `node.invoke`)

- `camera.list`
  - Yanıt yükü:
    - `devices`: `{ id, name, position, deviceType }` dizisi

- `camera.snap`
  - Parametreler:
    - `facing`: `front|back` (varsayılan: `front`)
    - `maxWidth`: sayı (isteğe bağlı; iOS düğümünde varsayılan `1600`)
    - `quality`: `0..1` (isteğe bağlı; varsayılan `0.9`)
    - `format`: şu anda `jpg`
    - `delayMs`: sayı (isteğe bağlı; varsayılan `0`)
    - `deviceId`: string (isteğe bağlı; `camera.list`’ten)
  - Yanıt yükü:
    - `format: "jpg"`
    - `base64: "<...>"`
    - `width`, `height`
  - Yük koruması: fotoğraflar, base64 yükünü 5 MB altında tutmak için yeniden sıkıştırılır.

- `camera.clip`
  - Parametreler:
    - `facing`: `front|back` (varsayılan: `front`)
    - `durationMs`: sayı (varsayılan `3000`, en fazla `60000` ile sınırlandırılır)
    - `includeAudio`: boolean (varsayılan `true`)
    - `format`: şu anda `mp4`
    - `deviceId`: string (isteğe bağlı; `camera.list`’den)
  - Yanıt yükü:
    - `format: "mp4"`
    - `base64: "<...>"`
    - `durationMs`
    - `hasAudio`

### Ön planda olma gereksinimi

`canvas.*` gibi, iOS düğümü `camera.*` komutlarına yalnızca **ön planda** izin verir. Arka plan çağrıları `NODE_BACKGROUND_UNAVAILABLE` döndürür.

### CLI yardımcı aracı (geçici dosyalar + MEDIA)

Ekleri almanın en kolay yolu, çözümlenmiş medyayı geçici bir dosyaya yazan ve `MEDIA:<path>` yazdıran CLI yardımcı aracını kullanmaktır.

Örnekler:

```bash
openclaw nodes camera snap --node <id>               # default: both front + back (2 MEDIA lines)
openclaw nodes camera snap --node <id> --facing front
openclaw nodes camera clip --node <id> --duration 3000
openclaw nodes camera clip --node <id> --no-audio
```

Notlar:

- `nodes camera snap`, ajana her iki görünümü de sağlamak için varsayılan olarak **her iki** yüzeyi kullanır.
- Çıkış dosyaları, kendi sarmalayıcınızı oluşturmadıkça geçicidir (OS geçici dizininde).

## Android düğümü

### Android kullanıcı ayarı (varsayılan açık)

- Android Ayarlar sayfası → **Kamera** → **Kameraya İzin Ver** (`camera.enabled`)
  - Varsayılan: **açık** (anahtar yoksa etkin kabul edilir).
  - Kapalıyken: `camera.*` komutları `CAMERA_DISABLED` döndürür.

### Permissions

- Android çalışma zamanı izinleri gerektirir:
  - Hem `camera.snap` hem de `camera.clip` için `CAMERA`.
  - `includeAudio=true` durumunda `camera.clip` için `RECORD_AUDIO`.

İzinler eksikse, uygulama mümkün olduğunda istemde bulunur; reddedilirse, `camera.*` istekleri
`*_PERMISSION_REQUIRED` hatasıyla başarısız olur.

### Android ön planda olma gereksinimi

`canvas.*` gibi, Android düğümü `camera.*` komutlarına yalnızca **ön planda** izin verir. Arka plan çağrıları `NODE_BACKGROUND_UNAVAILABLE` döndürür.

### Yük koruması

Fotoğraflar, base64 yükünü 5 MB altında tutmak için yeniden sıkıştırılır.

## macOS uygulaması

### Kullanıcı ayarı (varsayılan kapalı)

macOS yardımcı uygulaması bir onay kutusu sunar:

- **Ayarlar → Genel → Kameraya İzin Ver** (`openclaw.cameraEnabled`)
  - Varsayılan: **kapalı**
  - Kapalıyken: kamera istekleri “Camera disabled by user” döndürür.

### CLI yardımcı aracı (düğüm çağırma)

macOS düğümünde kamera komutlarını çağırmak için ana `openclaw` CLI’sını kullanın.

Örnekler:

```bash
openclaw nodes camera list --node <id>            # list camera ids
openclaw nodes camera snap --node <id>            # prints MEDIA:<path>
openclaw nodes camera snap --node <id> --max-width 1280
openclaw nodes camera snap --node <id> --delay-ms 2000
openclaw nodes camera snap --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --duration 10s          # prints MEDIA:<path>
openclaw nodes camera clip --node <id> --duration-ms 3000      # prints MEDIA:<path> (legacy flag)
openclaw nodes camera clip --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --no-audio
```

Notlar:

- `openclaw nodes camera snap`, geçersiz kılınmadıkça varsayılan olarak `maxWidth=1600`’dir.
- macOS’te, `camera.snap` çekimden önce ısınma/pozlama dengelenmesinden sonra `delayMs` (varsayılan 2000 ms) bekler.
- Fotoğraf yükleri, base64’ü 5 MB altında tutmak için yeniden sıkıştırılır.

## Güvenli kullanım + pratik sınırlar

- Kamera ve mikrofon erişimi, olağan OS izin istemlerini tetikler (ve Info.plist’te kullanım dizgeleri gerektirir).
- Video klipler, aşırı büyük düğüm yüklerini önlemek için (şu anda `<= 60s`) sınırlandırılmıştır (base64 ek yükü + mesaj sınırları).

## macOS ekran videosu (OS düzeyi)

_Kamera_ değil, _ekran_ videosu için macOS yardımcı uygulamasını kullanın:

```bash
openclaw nodes screen record --node <id> --duration 10s --fps 15   # prints MEDIA:<path>
```

Notlar:

- macOS **Screen Recording** izni (TCC) gerektirir.
