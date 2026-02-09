---
summary: "Düğüm eşleştirme, ön planda olma gereksinimleri, izinler ve araç hatalarını giderme"
read_when:
  - Düğüm bağlı görünüyor ancak kamera/tuval/ekran/exec araçları başarısız oluyor
  - Düğüm eşleştirme ile onaylar arasındaki zihinsel modele ihtiyaç duyuyorsunuz
title: "Düğüm Sorun Giderme"
---

# nodes/troubleshooting.md

Durumda bir düğüm görünürken düğüm araçları başarısız oluyorsa bu sayfayı kullanın.

## Komut merdiveni

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Ardından düğüme özgü denetimleri çalıştırın:

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
```

Sağlıklı sinyaller:

- Düğüm bağlıdır ve `node` rolü için eşleştirilmiştir.
- `nodes describe`, çağırdığınız yeteneği içerir.
- Exec onayları beklenen mod/izin listesiyle görünür.

## Ön planda olma gereksinimleri

`canvas.*`, `camera.*` ve `screen.*`, iOS/Android düğümlerinde yalnızca ön planda çalışır.

Hızlı kontrol ve düzeltme:

```bash
openclaw nodes describe --node <idOrNameOrIp>
openclaw nodes canvas snapshot --node <idOrNameOrIp>
openclaw logs --follow
```

`NODE_BACKGROUND_UNAVAILABLE` görürseniz, düğüm uygulamasını ön plana getirin ve yeniden deneyin.

## İzinler matrisi

| Yetenek                      | iOS                                                               | Android                                                            | macOS düğüm uygulaması                                | Tipik hata kodu                |
| ---------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------- | ------------------------------ |
| `camera.snap`, `camera.clip` | Kamera (+ klip sesi için mikrofon)             | Kamera (+ klip sesi için mikrofon)              | Kamera (+ klip sesi için mikrofon) | `*_PERMISSION_REQUIRED`        |
| `screen.record`              | Ekran Kaydı (+ mikrofon isteğe bağlı)          | Ekran yakalama istemi (+ mikrofon isteğe bağlı) | Ekran Kaydı                                           | `*_PERMISSION_REQUIRED`        |
| `location.get`               | Kullanım Sırasında veya Her Zaman (mode bağlı) | Moda bağlı olarak Ön Plan/Arka Plan konumu                         | Konum izni                                            | `LOCATION_PERMISSION_REQUIRED` |
| `system.run`                 | n/a (düğüm ana makinesi yolu)                  | n/a (düğüm ana makinesi yolu)                   | Exec onayları gerekli                                 | `SYSTEM_RUN_DENIED`            |

## Pairing versus approvals

Bunlar farklı geçitlerdir:

1. **Cihaz eşleştirme**: Bu düğüm gateway'e bağlanabilir mi?
2. **Exec onayları**: Bu düğüm belirli bir kabuk komutunu çalıştırabilir mi?

Hızlı kontroller:

```bash
openclaw devices list
openclaw nodes status
openclaw approvals get --node <idOrNameOrIp>
openclaw approvals allowlist add --node <idOrNameOrIp> "/usr/bin/uname"
```

Eşleştirme eksikse önce düğüm cihazını onaylayın.
Eşleştirme sorunsuzsa ancak `system.run` başarısız oluyorsa, exec onaylarını/izin listesini düzeltin.

## Yaygın düğüm hata kodları

- `NODE_BACKGROUND_UNAVAILABLE` → uygulama arka planda; ön plana getirin.
- `CAMERA_DISABLED` → düğüm ayarlarında kamera anahtarı devre dışı.
- `*_PERMISSION_REQUIRED` → OS izni eksik/reddedilmiş.
- `LOCATION_DISABLED` → konum modu kapalı.
- `LOCATION_PERMISSION_REQUIRED` → istenen konum modu verilmemiş.
- `LOCATION_BACKGROUND_UNAVAILABLE` → uygulama arka planda ancak yalnızca Kullanım Sırasında izni mevcut.
- `SYSTEM_RUN_DENIED: approval required` → exec isteği açık onay gerektiriyor.
- `SYSTEM_RUN_DENIED: allowlist miss` → komut izin listesi modu tarafından engellendi.

## Hızlı toparlanma döngüsü

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
```

Hâlâ takılıysanız:

- Cihaz eşleştirmeyi yeniden onaylayın.
- Düğüm uygulamasını yeniden açın (ön plan).
- OS izinlerini yeniden verin.
- Exec onay politikasını yeniden oluşturun/ayarlayın.

İlgili:

- [/nodes/index](/nodes/index)
- [/nodes/camera](/nodes/camera)
- [/nodes/location-command](/nodes/location-command)
- [/tools/exec-approvals](/tools/exec-approvals)
- [/gateway/pairing](/gateway/pairing)
