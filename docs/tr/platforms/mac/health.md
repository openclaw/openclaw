---
summary: "macOS uygulamasının gateway/Baileys sağlık durumlarını nasıl raporladığı"
read_when:
  - Mac uygulaması sağlık göstergelerinde hata ayıklama
title: "Sağlık Kontrolleri"
---

# macOS’te Sağlık Kontrolleri

Menü çubuğu uygulamasından bağlı kanalın sağlıklı olup olmadığını nasıl göreceğinizi açıklar.

## Menü çubuğu

- Durum noktası artık Baileys sağlığını yansıtır:
  - Yeşil: bağlı + soket yakın zamanda açıldı.
  - Turuncu: bağlanıyor/yeniden deneniyor.
  - Kırmızı: oturum kapalı veya yoklama başarısız.
- İkincil satır `"bağlı · kimlik doğrulama 12 dk"` okur veya hata nedenini gösterir.
- `"Sağlık Kontrolünü Çalıştır"` menü öğesi isteğe bağlı bir yoklamayı tetikler.

## Ayarlar

- Genel sekmesi; bağlı kimlik doğrulama yaşı, oturum-deposu yolu/sayısı, son kontrol zamanı, son hata/durum kodu ve Sağlık Kontrolünü Çalıştır / Günlükleri Göster düğmelerini içeren bir Sağlık kartı kazanır.
- Arayüzün anında yüklenmesi için önbelleğe alınmış bir anlık görüntü kullanır ve çevrimdışıyken zarif biçimde geri dönüş yapar.
- **Kanallar sekmesi**, WhatsApp/Telegram için kanal durumu + denetimleri (giriş QR’ı, çıkış, yoklama, son bağlantı kesilmesi/hata) sunar.

## Yoklama nasıl çalışır

- Uygulama yaklaşık her 60 saniyede bir ve isteğe bağlı olarak `ShellExecutor` üzerinden `openclaw health --json` çalıştırır. Yoklama, mesaj göndermeden kimlik bilgilerini yükler ve durumu raporlar.
- Titreşimi önlemek için son iyi anlık görüntü ile son hatayı ayrı ayrı önbelleğe alır; her birinin zaman damgasını gösterir.

## Şüphede kalındığında

- [Gateway health](/gateway/health) içindeki CLI akışını (`openclaw status`, `openclaw status --deep`, `openclaw health --json`) hâlâ kullanabilir ve `web-heartbeat` / `web-reconnect` için `/tmp/openclaw/openclaw-*.log`’i takip edebilirsiniz.
