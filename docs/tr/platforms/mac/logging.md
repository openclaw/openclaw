---
summary: "OpenClaw günlükleme: dönen tanılama dosyası günlüğü + birleşik günlük gizlilik bayrakları"
read_when:
  - macOS günlüklerini yakalarken veya özel veri günlüklemeyi incelerken
  - Sesle uyandırma/oturum yaşam döngüsü sorunlarını ayıklarken
title: "macOS Günlükleme"
---

# Günlükleme (macOS)

## Dönen tanılama dosyası günlüğü (Hata Ayıklama paneli)

OpenClaw, macOS uygulama günlüklerini swift-log üzerinden yönlendirir (varsayılan olarak birleşik günlükleme) ve kalıcı bir kayıt gerektiğinde diske yerel, dönen bir dosya günlüğü yazabilir.

- Ayrıntı düzeyi: **Hata Ayıklama paneli → Logs → App logging → Verbosity**
- Etkinleştir: **Hata Ayıklama paneli → Logs → App logging → “Write rolling diagnostics log (JSONL)”**
- Konum: `~/Library/Logs/OpenClaw/diagnostics.jsonl` (otomatik olarak döner; eski dosyalar `.1`, `.2`, …
- Temizle: **Hata Ayıklama paneli → Logs → App logging → “Clear”**

Notlar:

- Bu özellik **varsayılan olarak kapalıdır**. Yalnızca aktif olarak hata ayıklarken etkinleştirin.
- Dosyayı hassas kabul edin; incelemeden paylaşmayın.

## macOS’ta birleşik günlüklemede özel veriler

Birleşik günlükleme, bir alt sistem `privacy -off` seçeneğine dahil olmadıkça çoğu yükü sansürler. Peter’ın macOS [logging privacy shenanigans](https://steipete.me/posts/2025/logging-privacy-shenanigans) (2025) yazısına göre bu, alt sistem adına göre anahtarlanmış `/Library/Preferences/Logging/Subsystems/` içindeki bir plist tarafından denetlenir. Yalnızca yeni günlük girdileri bayrağı devralır; bu nedenle bir sorunu yeniden üretmeden önce etkinleştirin.

## OpenClaw için etkinleştirme (`bot.molt`)

- Önce plist’i geçici bir dosyaya yazın, ardından root olarak atomik biçimde kurun:

```bash
cat <<'EOF' >/tmp/bot.molt.plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>DEFAULT-OPTIONS</key>
    <dict>
        <key>Enable-Private-Data</key>
        <true/>
    </dict>
</dict>
</plist>
EOF
sudo install -m 644 -o root -g wheel /tmp/bot.molt.plist /Library/Preferences/Logging/Subsystems/bot.molt.plist
```

- Yeniden başlatma gerekmez; logd dosyayı hızla fark eder, ancak yalnızca yeni günlük satırları özel yükleri içerir.
- Daha zengin çıktıyı mevcut yardımcıyla görüntüleyin; örn. `./scripts/clawlog.sh --category WebChat --last 5m`.

## Hata ayıklamadan sonra devre dışı bırakın

- Geçersiz kılmayı kaldırın: `sudo rm /Library/Preferences/Logging/Subsystems/bot.molt.plist`.
- İsteğe bağlı olarak, logd’un geçersiz kılmayı hemen bırakmasını zorlamak için `sudo log config --reload` çalıştırın.
- Bu yüzey telefon numaraları ve mesaj gövdeleri içerebilir; ek ayrıntıya aktif olarak ihtiyaç duyduğunuz süre boyunca plist’i yerinde tutun.
