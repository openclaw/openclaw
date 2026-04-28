# Outlook Otomasyonu için Teknik Mimari Taslağı

Bu doküman, Ceviz’in yalnızca **Outlook kullanımı** için nasıl güvenli, sürdürülebilir ve genişletilebilir şekilde yetkilendirileceğini tarif eder. Amaç, Windows masaüstünü serbestçe kontrol eden kırılgan bir bot kurmak değil; Outlook erişimini kontrollü biçimde açan, gerektiğinde de masaüstü uygulaması otomasyonuna genişleyebilen bir mimari kurmaktır.

---

## 1. Amaç ve Kapsam

### Ana hedef

Ceviz’in Outlook ile ilgili işleri güvenli şekilde yapabilmesi:

- Gelen kutusunu okuma
- Okunmamış / önemli mailleri filtreleme
- Günlük özet çıkarma
- Belirli kişilerden veya konulardan gelen mailleri ayırma
- Taslak yanıt hazırlama
- İstenirse ileride mail gönderme
- Takvim ve toplantı bilgileriyle ilişkilendirme

### Kapsam dışı

İlk aşamada şunlar hedeflenmez:

- Outlook masaüstü arayüzünü tıklayarak kullanma
- Serbest Windows masaüstü kontrolü
- Tüm Office uygulamalarını ajan üzerinden yönetme
- Kullanıcı oturumunu birebir devralan genel amaçlı RPA

---

## 2. Tasarım İlkeleri

Bu mimaride temel yaklaşım şudur:

1. **Mail için API, GUI değil**
   Outlook erişimi mümkün oldukça Microsoft Graph üzerinden yapılmalı.

2. **En az yetki**
   Önce read-only, sonra gerekirse taslak, en son gönderme.

3. **İş bazlı yetki**
   “Bilgisayarı kullan” yerine “Inbox özetle”, “şu kişiden gelenleri listele” gibi görev odaklı arayüz.

4. **Windows ile gevşek bağlılık**
   Outlook erişimi, masaüstü pencere durumuna bağlı olmamalı.

5. **Auditability**
   Yapılan işlemler loglanmalı; hangi istek sonucu hangi API çağrısının yapıldığı izlenebilmeli.

---

## 3. Önerilen Mimari

### Yüksek seviye bileşenler

1. **Ceviz / OpenClaw ajanı**
   - İstekleri alır
   - Niyet analizi yapar
   - Uygun Outlook aracını çağırır
   - Sonucu özetleyip kullanıcıya döner

2. **Outlook Bridge (önerilen: küçük bir servis veya MCP aracı)**
   - Microsoft Graph ile konuşur
   - Kimlik doğrulama ve token yönetimini yapar
   - Outlook işlemlerini sınırlı fonksiyonlar olarak sunar

3. **Microsoft Identity + Graph API**
   - Mail, takvim, klasör, draft gibi kaynaklara erişim sağlar

4. **Güvenli yapılandırma katmanı**
   - Secret/token saklama
   - İzin kapsamları
   - Hedef mailbox / tenant ayarları

---

## 4. Neden Microsoft Graph?

Outlook için en doğru entegrasyon katmanı Microsoft Graph’tır.

### Avantajları

- Outlook GUI’ye bağlı değildir
- Daha stabil ve deterministiktir
- Filtreleme, arama, klasör erişimi nettir
- Takvim, kişi ve mail tek platformdan gelir
- Least-privilege modeli uygulanabilir
- Desktop otomasyonundan daha az kırılgandır

### Dezavantajları

- İlk kurulumda Azure App Registration gerekir
- OAuth/token akışı yapılandırılmalıdır
- Kurumsal tenant politikasına takılabilir

Buna rağmen Outlook masaüstü uygulamasını tıklamaktan çok daha doğru çözümdür.

---

## 5. Katmanlı Yetkilendirme Modeli

### Seviye 1 — Read-only

İlk aşamada sadece:

- inbox okuma
- unread mail listeleme
- klasör okuma
- mail başlık/özet alma
- takvim etkinliklerini görüntüleme

Önerilen Graph izinleri örnekleri:

- `Mail.Read`
- `Calendars.Read`
- gerekirse `User.Read`

### Seviye 2 — Draft oluşturma

İkinci aşamada:

- seçilen mail için taslak oluşturma
- yanıt taslağı hazırlama
- kullanıcı onayı sonrası gönderime hazır hale getirme

Olası izin:

- `Mail.ReadWrite`

### Seviye 3 — Gönderme

Yalnızca gerçekten gerekliyse:

- mail gönderme
- taslağı finalize etme

Olası ek izin:

- `Mail.Send`

### Tavsiye

Başlangıç için en güvenli kombinasyon:

- `Mail.Read`
- `Calendars.Read`
- `User.Read`

---

## 6. Önerilen Tool Arayüzü

Ceviz’in doğrudan Graph endpoint’leriyle uğraşması yerine, aşağıdaki gibi sınırlı bir araç seti daha doğru olur.

### Örnek fonksiyonlar

#### 6.1 Inbox özeti

- `outlook.inbox_summary(hours=24, unreadOnly=true, top=20)`
- Son 24 saatte gelen önemli mailleri özetler

#### 6.2 Filtreli listeleme

- `outlook.list_messages(folder="Inbox", from="x@domain.com", unreadOnly=true)`
- Belirli gönderen ya da filtre ile mesajları listeler

#### 6.3 Mesaj detayı

- `outlook.get_message(messageId)`
- Mesaj başlığı, göndereni, tarihi, gövde özeti

#### 6.4 Thread özeti

- `outlook.summarize_thread(messageId)`
- Konuşma zincirini okuyup kısa özet çıkarır

#### 6.5 Taslak oluşturma

- `outlook.create_draft(to, subject, body, replyToMessageId?)`
- Mail göndermez; sadece taslak üretir

#### 6.6 Takvim yakın görünüm

- `outlook.calendar_upcoming(hours=48)`
- Yaklaşan toplantıları listeler

Bu yaklaşımın faydası:

- dış API karmaşıklığı ajandan saklanır
- izin sınırları net olur
- loglama kolaylaşır
- hata yönetimi merkezileşir

---

## 7. Çalışma Akışları

### Akış A — Sabah inbox özeti

1. Kullanıcı: “Bugünkü mailleri özetle”
2. Ceviz `outlook.inbox_summary()` çağırır
3. Bridge, Graph üzerinden mailleri çeker
4. Mesajlar önem derecesine göre gruplanır
5. Ceviz kullanıcıya kısa özet döner

### Akış B — Belirli kişiden gelen mailleri bulma

1. Kullanıcı: “Ahmet’ten gelen okunmamış mailleri göster”
2. Ceviz filtreli araç çağrısı yapar
3. Sonuçlar başlık + tarih + kısa özet şeklinde döner

### Akış C — Taslak cevap hazırlama

1. Kullanıcı: “Bu maile kısa ama net bir cevap taslağı hazırla”
2. Ceviz ilgili mail içeriğini alır
3. Yanıtı üretir
4. İstenirse `create_draft` ile Outlook taslağı olarak kaydeder
5. Kullanıcı onayı olmadan gönderim yapılmaz

### Akış D — Toplantı bağlamlı mail özeti

1. Ceviz yaklaşan toplantıları okur
2. Toplantıyla ilişkili mail thread’lerini bulur
3. “Toplantı öncesi briefing” üretir

---

## 8. Dağıtım Seçenekleri

### Seçenek 1 — WSL içindeki bridge servis

Bridge WSL içinde çalışır, internet üzerinden Graph’a erişir.

**Artıları:**

- Mevcut OpenClaw ortamına yakın
- Geliştirmesi kolay
- .NET veya Node ile rahat yazılır

**Eksileri:**

- Token saklama ve browser-based auth akışında ek yapı gerekebilir
- Windows kullanıcı oturumuyla bütünleşme sınırlı olabilir

### Seçenek 2 — Windows tarafında local bridge servis

Bridge Windows üzerinde çalışır; OpenClaw/WSL bu servisi yerel ağ/localhost üzerinden çağırır.

**Artıları:**

- Windows kimlik/oturum ekosistemine daha yakın
- Eğer sonradan desktop automation eklenecekse genişletmesi kolay

**Eksileri:**

- WSL ↔ Windows iletişim katmanı tasarlanmalı
- Servis yaşam döngüsü ayrıca yönetilmeli

### Tavsiye

Sadece Outlook için başlanacaksa:

- **WSL veya Windows üzerinde küçük bir Graph bridge yeterli**
- Eğer ileride desktop automation da eklenecekse Windows-side bridge daha stratejik olabilir

---

## 9. Teknoloji Tercihi

Mert’in geçmişi düşünülünce en doğal iki yol:

### .NET tabanlı bridge

**Önerilen seçenek**

Neden?

- C# geçmişine uyumlu
- Microsoft Graph SDK güçlü
- Windows entegrasyonu rahat
- Background service / minimal API üretmek kolay

Önerilen yapı:

- ASP.NET Core minimal API veya worker service
- Microsoft Graph SDK
- Secret storage için environment variables veya güvenli store

### Node.js tabanlı bridge

Alternatif olarak:

- hızlı prototipleme
- MCP sunucuları için ekosistem avantajı

Ama bu özel senaryoda ben .NET’i daha mantıklı buluyorum.

---

## 10. Kimlik Doğrulama ve Secret Yönetimi

### Gerekenler

- Azure App Registration
- Redirect URI
- OAuth authorization flow
- Access token / refresh token yönetimi

### Secret saklama prensipleri

- Token’ları düz metin workspace dosyalarına yazma
- Mümkünse OS-level secret store kullan
- En azından `.env` benzeri dosyaları repo dışı tut
- Loglarda token basma

### Audit notu

Bridge şu bilgileri loglayabilir:

- işlem tipi
- zaman
- hedef klasör / message id
- başarı/başarısızlık
- hata kodu

Ama mail gövdelerini gereksiz yere loglamamak daha doğru olur.

---

## 11. Güvenlik Politikası

### Önerilen kurallar

1. Kullanıcı onayı olmadan mail gönderme kapalı
2. İlk fazda sadece okuma izni
3. Draft oluşturma varsa, açıkça “taslak” olarak işaretlenmeli
4. Kritik domain’lere gönderim için ikinci onay katmanı olabilir
5. Silme/taşıma gibi yıkıcı işlemler ilk sürümde hiç açılmamalı

### İlk sürümde özellikle kapalı tutulması gerekenler

- `delete message`
- `move message`
- `mark as junk`
- `send immediately`
- toplu işlem komutları

---

## 12. Operasyonel Senaryolar

### Düzenli inbox özeti

Cron veya heartbeat ile:

- sabah 09:00
- öğleden sonra 14:00
- akşam üstü 18:00

özet üretilebilir.

### Toplantı öncesi brifing

Takvimde yakın toplantı varsa:

- katılımcılar
- ilgili son mailler
- aksiyon maddeleri
- bekleyen yanıtlar

tek özet halinde çıkarılabilir.

### VIP / öncelikli gönderen takibi

Belirli kişi/alan adları için öncelik listesi tanımlanabilir.

---

## 13. Masaüstü Uygulaması İçin Genişleme Notu

Kullanıcı masaüstü uygulaması örneği de istediği için, Outlook dışı bir örnek genişleme olarak **Autodesk Revit** seçiyorum. Bu seçim özellikle mimari / mühendislik işlerinde yaygın olduğu için mantıklı.

### Revit neden iyi örnek?

- Mimari mühendislik akışlarında çok yaygın
- API’si var ama çoğu iş GUI odaklı ilerliyor
- Desktop automation ihtiyacının neden zor olduğunu iyi gösteriyor

### Revit için önerilen yaklaşım

Outlook’tan farklı olarak burada öncelik sırası şöyle olmalı:

1. **Varsa resmi API / eklenti modeli**
2. **Komut/script tabanlı entegrasyon**
3. **En son GUI automation**

### Revit senaryosu örneği

- Projeyi aç
- Belirli family/category elemanlarını kontrol et
- Uyarı listesini çıkar
- Belirli görünümü export et
- Raporu workspace’e kaydet

### Genişleme mimarisi

Eğer ileride Outlook + Revit birlikte çalışacaksa, ortak tasarım şu olabilir:

- `mail-bridge` yerine daha genel bir `local automation hub`
- modüller:
  - `outlook-module` (Graph tabanlı)
  - `revit-module` (plugin/API tabanlı, gerekirse GUI fallback)

Bu modelde Ceviz tek bir katmanla konuşur; her uygulamaya özel mantık arka tarafta modüler kalır.

### Revit için kritik not

Revit gibi uygulamalarda doğrudan “ekranı tıklayan bot” çözümü ilk tercih olmamalı. Çünkü:

- sürüm değişiminde bozulur
- pencere/focus bağımlıdır
- deterministik değildir
- uzun vadede bakım maliyeti yüksektir

Bu yüzden Outlook’ta Graph neyse, Revit tarafında da mümkünse **plugin/API first** yaklaşımı seçilmelidir.

---

## 14. Sonuç ve Tavsiye

Bu senaryo için net önerim:

### İlk kurulum

- Outlook erişimi için **Microsoft Graph tabanlı bir bridge** kur
- İlk fazda yalnızca:
  - `Mail.Read`
  - `Calendars.Read`
  - `User.Read`
- Ceviz’e sınırlı, görev odaklı fonksiyonlar aç
- Gönderme/silme gibi işlemleri kapalı tut

### İkinci faz

- Draft oluşturma ekle
- Inbox özetleri ve toplantı brifingleri otomatikleştir

### Desktop app genişlemesi

- Outlook için GUI automation’a gitme
- Masaüstü uygulaması otomasyonu gerekirse, Outlook’tan bağımsız modül olarak ele al
- Mimari/mühendislik uygulaması örneği olarak Revit için plugin/API-first strateji uygula

---

## 15. En Kısa Özet

Bu işin doğru çözümü:

- **Outlook = Graph API**
- **Ceviz = orkestrasyon + özet + karar desteği**
- **Desktop automation = sadece gerçekten gerekiyorsa, ayrı modül**

Böylece sistem hem güvenli hem de büyütülebilir kalır.
