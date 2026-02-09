---
summary: "Günlükleme yüzeyleri, dosya günlükleri, WS günlük stilleri ve konsol biçimlendirme"
read_when:
  - Günlükleme çıktısını veya biçimlerini değiştirirken
  - CLI veya gateway çıktısını hata ayıklarken
title: "Logging"
---

# Logging

Kullanıcıya dönük bir genel bakış için (CLI + Control UI + yapılandırma), bkz. [/logging](/logging).

OpenClaw’ın iki günlük “yüzeyi” vardır:

- **Konsol çıktısı** (terminalde / Debug UI’da gördükleriniz).
- **Dosya günlükleri** (JSON satırları), gateway günlükleyicisi tarafından yazılır.

## Dosya tabanlı günlükleyici

- Varsayılan dönen günlük dosyası `/tmp/openclaw/` altında yer alır (günde bir dosya): `openclaw-YYYY-MM-DD.log`
  - Tarih, gateway ana makinesinin yerel saat dilimini kullanır.
- Günlük dosyası yolu ve seviyesi `~/.openclaw/openclaw.json` üzerinden yapılandırılabilir:
  - `logging.file`
  - `logging.level`

Dosya biçimi, satır başına bir JSON nesnesidir.

Control UI Logs sekmesi bu dosyayı gateway üzerinden takip eder (`logs.tail`).
CLI de aynısını yapabilir:

```bash
openclaw logs --follow
```

**Ayrıntılı vs. günlük seviyeleri**

- **Dosya günlükleri** yalnızca `logging.level` tarafından kontrol edilir.
- `--verbose` yalnızca **konsol ayrıntı düzeyini** (ve WS günlük stilini) etkiler; dosya günlük seviyesini **artırmaz**.
- Ayrıntı‑özel bilgileri dosya günlüklerinde yakalamak için `logging.level`’ı `debug` veya `trace` olarak ayarlayın.

## Konsol yakalama

CLI, `console.log/info/warn/error/debug/trace`’leri yakalar ve dosya günlüklerine yazar,
aynı zamanda stdout/stderr’e yazdırmaya devam eder.

Konsol ayrıntı düzeyini bağımsız olarak ayarlayabilirsiniz:

- `logging.consoleLevel` (varsayılan `info`)
- `logging.consoleStyle` (`pretty` | `compact` | `json`)

## Tool summary redaction

Ayrıntılı araç özetleri (örn. `🛠️ Exec: ...`), konsol akışına ulaşmadan önce hassas belirteçleri maskeleyebilir. Bu **yalnızca araçlar** içindir ve dosya günlüklerini değiştirmez.

- `logging.redactSensitive`: `off` | `tools` (varsayılan: `tools`)
- `logging.redactPatterns`: regex dizelerinden oluşan dizi (varsayılanları geçersiz kılar)
  - Ham regex dizeleri kullanın (otomatik `gi`), ya da özel bayraklara ihtiyacınız varsa `/pattern/flags`.
  - Eşleşmeler, ilk 6 + son 4 karakter korunarak maskelenir (uzunluk >= 18); aksi halde `***`.
  - Varsayılanlar; yaygın anahtar atamaları, CLI bayrakları, JSON alanları, bearer başlıkları, PEM blokları ve popüler belirteç öneklerini kapsar.

## Gateway WebSocket günlükleri

Gateway, WebSocket protokol günlüklerini iki modda yazdırır:

- **Normal mod ( `--verbose` yok)**: yalnızca “ilginç” RPC sonuçları yazdırılır:
  - hatalar (`ok=false`)
  - yavaş çağrılar (varsayılan eşik: `>= 50ms`)
  - ayrıştırma hataları
- **Ayrıntılı mod (`--verbose`)**: tüm WS istek/yanıt trafiğini yazdırır.

### WS günlük stili

`openclaw gateway`, gateway başına bir stil anahtarı destekler:

- `--ws-log auto` (varsayılan): normal mod optimize edilmiştir; ayrıntılı modda kompakt çıktı kullanır
- `--ws-log compact`: ayrıntılı modda kompakt çıktı (eşleştirilmiş istek/yanıt)
- `--ws-log full`: ayrıntılı modda çerçeve başına tam çıktı
- `--compact`: `--ws-log compact` için takma ad

Örnekler:

```bash
# optimized (only errors/slow)
openclaw gateway

# show all WS traffic (paired)
openclaw gateway --verbose --ws-log compact

# show all WS traffic (full meta)
openclaw gateway --verbose --ws-log full
```

## Konsol biçimlendirme (alt sistem günlükleme)

Konsol biçimlendirici **TTY farkındadır** ve tutarlı, önekli satırlar yazdırır.
Alt sistem günlükleyicileri çıktıyı gruplu ve taranabilir tutar.

Davranış:

- Her satırda **alt sistem önekleri** (örn. `[gateway]`, `[canvas]`, `[tailscale]`)
- **Alt sistem renkleri** (alt sistem başına sabit) ve seviye renklendirmesi
- **Çıktı TTY olduğunda veya ortam zengin bir terminal gibi göründüğünde renklendirme** (`TERM`/`COLORTERM`/`TERM_PROGRAM`), `NO_COLOR`’e saygı duyar
- **Kısaltılmış alt sistem önekleri**: baştaki `gateway/` + `channels/` kaldırılır, son 2 segment korunur (örn. `whatsapp/outbound`)
- **Alt sisteme göre alt‑günlükleyiciler** (otomatik önek + yapılandırılmış alan `{ subsystem }`)
- QR/UX çıktısı için **`logRaw()`** (önek yok, biçimlendirme yok)
- **Konsol stilleri** (örn. `pretty | compact | json`)
- **Konsol günlük seviyesi**, dosya günlük seviyesinden ayrıdır (dosya, `logging.level` `debug`/`trace` olarak ayarlandığında tam ayrıntıyı korur)
- **WhatsApp mesaj gövdeleri** `debug` seviyesinde günlüğe alınır (görmek için `--verbose` kullanın)

Bu, mevcut dosya günlüklerini sabit tutarken etkileşimli çıktıyı taranabilir hale getirir.
