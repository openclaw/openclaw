# İş Tamamlanma (Job Completion) Bildirim Politikası ve Akışı

Bu doküman, OpenClaw workspace'inde uzun süren işlerin (job) tamamlanma durumlarının kullanıcıya bildirilmesi sürecindeki politikaları, operasyonel akışları, kontrol listelerini ve mesaj şablonlarını tanımlar.

## 1. Temel Prensipler (Policy)

- **Garantili Bildirim:** Hiçbir final durumu (başarılı/başarısız) kaçırılmamalıdır. Supervisor, işin bittiğinden kesin emin olmalı ve bunu raporlamalıdır.
- **Kısa ve Net İletişim:** Kullanıcıya sadece en önemli sonuç bilgisi, kısa ve öz bir şekilde verilmelidir. Log yığınları ve ham teknik çıktılar doğrudan gösterilmemelidir.
- **Spam ve Gürültü Koruması:**
  - Ara durumlar (progress) sadece çok uzun sürüyorsa ve anlamlı bir değişiklik varsa (throttle edilerek) bildirilmelidir.
  - Aynı hata veya aynı başarı mesajı defalarca gönderilmemelidir (Duplicate önleme/Deduplication).

## 2. Operasyonel Akış (Flow)

1. **İş Başlangıcı (Job Start):** İş kuyruğa alınır. Kullanıcıya işin başladığına dair tek, kısa bir bilgi geçilir.
2. **Durum İzleme (Supervision):** Supervisor, işin durumunu belirli aralıklarla (polling veya event tabanlı) kontrol eder.
3. **Ara Durumlar (Intermediate States):** Sadece kritik aşama geçişlerinde veya uzun beklemelerde (örn. max 1 mesaj / 10-15 dk) bilgi verilir. Ara durum değişiklikleri çok hızlıysa sessizce geçilir.
4. **Finalizasyon (Completion):** İş bittiğinde (Success/Fail/Timeout), sonuç alınır, işlenir ve final şablonuna oturtularak kullanıcıya tek bir özet mesajla iletilir.
5. **Deduplication Kontrolü:** Sonuç mesajı gönderilmeden önce sistemin son state'i veya son gönderilen mesajlarla karşılaştırılır. Tekrarlayan bildirimler engellenir.

## 3. Kullanıcı Mesaj Şablonları (Templates)

- **Başlangıç:**

  > ⏳ `[İşlem Adı]` başlatıldı. Arka planda çalışıyor, tamamlandığında size haber vereceğim.

- **Uzun Süren İşlem (Ara Bilgi - Opsiyonel):**

  > 🔄 `[İşlem Adı]` devam ediyor. Şu anki aşama: `[Kısa Aşama Özeti]`.

- **Başarılı Tamamlanma (Success):**

  > ✅ **`[İşlem Adı]` tamamlandı.**
  > 📄 **Sonuç:** `[Çok kısa sonuç özeti, örn: 5 dosya işlendi / Rapor güncellendi]`
  > 🔗 `[Varsa ilgili dosya/bağlantı]`

- **Başarısız Tamamlanma (Failure):**

  > ❌ **`[İşlem Adı]` başarısız oldu.**
  > ⚠️ **Hata:** `[Kısa ve anlaşılır hata nedeni, örn: Hedef sisteme ulaşılamadı]`
  > 💡 **Öneri:** `[Çözüm önerisi veya log dosyası yolu]`

- **Zaman Aşımı / Cevapsızlık (Timeout):**
  > ⏱️ **`[İşlem Adı]` zaman aşımına uğradı.** (`[Beklenen Süre]` aşıldı). İşlem iptal edilmiş veya askıda kalmış olabilir, lütfen durumu kontrol edin.

## 4. Uygulama Kontrol Listesi (Checklist)

- [ ] İş başlatıldığında kullanıcıya anında "Başladı" mesajı gidiyor mu?
- [ ] Ara durum bildirimlerinde rate-limiting (throttle) uygulanıyor mu? (Ara spam engelleme test edildi mi?)
- [ ] İş başarıyla bittiğinde, sonuç çıktısı filtrelenip en fazla 3-4 satırlık bir özetle dönülüyor mu?
- [ ] Hata durumlarında ham stack trace yerine kullanıcı dostu, neyin yanlış gittiğini anlatan hata mesajı üretiliyor mu?
- [ ] Timeout senaryoları (örn: sistemin yanıt vermemesi) handle ediliyor mu? (Sonsuza kadar bekleme engellendi mi?)
- [ ] Aynı sonuç mesajının birden fazla kez gönderilmesini engelleyen deduplication mekanizması devrede mi?
- [ ] Supervisor/Agent yeniden başlarsa veya çökerse, askıdaki işlerin durumunu tekrar alıp doğru bildirim yapabiliyor mu? (Resilience)
