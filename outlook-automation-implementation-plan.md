# Outlook Otomasyonu Uygulama Planı

Bu doküman, `outlook-automation-architecture.md` içinde tarif edilen mimariyi uygulanabilir adımlara çevirir. Hedef; Ceviz’in Outlook verilerine güvenli, kontrollü ve genişletilebilir biçimde erişebilmesini sağlayan ilk çalışan sürümü üretmektir.

---

## 1. Hedef Çıktı

İlk sürüm sonunda aşağıdaki yetenekler çalışıyor olmalı:

- Son 24 saatte gelen mailleri listeleme
- Okunmamış mailleri özetleme
- Belirli kişiden gelen mailleri filtreleme
- Yaklaşan toplantıları listeleme
- Bir mail için taslak cevap üretme (opsiyonel olarak Outlook draft kaydı)

İlk sürümde özellikle **olmaması gerekenler**:

- doğrudan mail gönderme
- mail silme / taşıma
- Outlook desktop UI otomasyonu

---

## 2. Aşamalı Yol Haritası

### Faz 0 — Hazırlık

Amaç: temel kararları netleştirmek.

Kararlar:

- Teknoloji: **.NET 9/8 + ASP.NET Core Minimal API**
- Entegrasyon: **Microsoft Graph SDK**
- Yetki seviyesi: ilk faz **read-only + calendar read**
- Host yeri: başlangıçta **Windows üzerinde local servis** veya alternatif olarak WSL içinde servis

### Faz 1 — Kimlik doğrulama ve temel Graph erişimi

Amaç: mailbox ve takvim verisini okuyabilmek.

İşler:

1. Azure App Registration oluştur
2. Redirect URI tanımla
3. Scope’ları tanımla:
   - `User.Read`
   - `Mail.Read`
   - `Calendars.Read`
4. OAuth login akışını tamamla
5. Access/refresh token yönetimini doğrula
6. Test çağrıları yap:
   - kullanıcı profili
   - inbox mesajları
   - takvim etkinlikleri

### Faz 2 — Outlook Bridge API

Amaç: Ceviz’in çağıracağı sade bir yerel API oluşturmak.

İlk endpoint seti:

- `GET /health`
- `GET /me`
- `GET /mail/inbox-summary`
- `GET /mail/messages`
- `GET /mail/messages/{id}`
- `GET /calendar/upcoming`
- `POST /mail/draft-reply` (başta mock veya dry-run olabilir)

### Faz 3 — Ceviz entegrasyonu

Amaç: Bu servis Ceviz tarafından çağrılabilir hale gelsin.

Seçenekler:

- küçük bir MCP server katmanı
- local script wrapper
- OpenClaw tarafına özel dar bir tool bridge

### Faz 4 — Güvenlik ve operasyon

Amaç: sistemi güvenli ve sürdürülebilir hale getirmek.

İşler:

- request loglama
- structured error handling
- rate limit / retry yönetimi
- secret storage sertleştirme
- allowed operation policy

### Faz 5 — Draft desteği

Amaç: gönderim olmadan taslak üretmek.

İşler:

- `Mail.ReadWrite` yetkisini kontrollü ekle
- reply draft oluşturma
- yeni draft oluşturma
- Outlook’ta görünen taslakların doğrulanması

---

## 3. Dağıtım Tercihi

Bu senaryo için benim önerim:

### Önerilen başlangıç: Windows üzerinde local servis

Neden?

- Microsoft login ve browser auth akışı Windows’ta daha rahat olabilir
- Sonradan desktop app entegrasyonuna genişleme daha kolay
- Outlook tarafı zaten Microsoft ekosistemine yakın

### Alternatif: WSL içinde servis

Ne zaman mantıklı?

- tüm geliştirme Linux ağırlıklı ilerliyorsa
- token akışı düzgün çözülebiliyorsa
- servis çağrıları yalnızca yerel geliştirme için kullanılacaksa

### Karar notu

Eğer amaç uzun vadede Outlook + başka Windows uygulamaları ise:

- **Windows local automation service** daha mantıklı temel olur

---

## 4. Önerilen Proje Yapısı

```text
outlook-bridge/
  src/
    OutlookBridge.Api/
      Program.cs
      appsettings.json
      appsettings.Development.json
      Endpoints/
        MailEndpoints.cs
        CalendarEndpoints.cs
        HealthEndpoints.cs
      Services/
        GraphMailService.cs
        GraphCalendarService.cs
        AuthTokenService.cs
      Models/
        MailSummaryDto.cs
        MessageListItemDto.cs
        MessageDetailDto.cs
        CalendarEventDto.cs
        DraftReplyRequest.cs
      Options/
        GraphOptions.cs
      Security/
        OperationPolicy.cs
      Logging/
        RequestLogEnricher.cs
  docs/
    setup.md
    scopes.md
  scripts/
    run-local.ps1
    run-local.sh
```

---

## 5. API Tasarımı

### 5.1 Health

`GET /health`

Dönüş:

- servis ayakta mı
- Graph bağlantısı hazır mı
- auth mevcut mu

### 5.2 Profil

`GET /me`

Dönüş:

- display name
- principal/mail address
- tenant bilgisi (gerektiği kadar)

### 5.3 Inbox özeti

`GET /mail/inbox-summary?hours=24&unreadOnly=true&top=20`

Dönüş örneği:

- toplam mesaj sayısı
- unread sayısı
- yüksek öncelikli gönderenler
- kısa özet listesi

### 5.4 Mesaj listeleme

`GET /mail/messages?folder=Inbox&from=someone@company.com&unreadOnly=true&top=20`

Dönüş:

- message id
- subject
- from
- receivedAt
- snippet
- isRead

### 5.5 Mesaj detayı

`GET /mail/messages/{id}`

Dönüş:

- subject
- sender
- recipients
- receivedAt
- bodyPreview
- body (opsiyonel / sanitize edilmiş)
- conversation id

### 5.6 Takvim yakın görünüm

`GET /calendar/upcoming?hours=48`

Dönüş:

- title
- organizer
- attendees
- start/end
- location / online meeting info

### 5.7 Taslak yanıt

`POST /mail/draft-reply`

Request örneği:

```json
{
  "messageId": "...",
  "body": "Merhaba, ...",
  "saveOnly": true
}
```

Dönüş:

- draft id
- status
- preview

---

## 6. Domain Kuralları

### Mail özeti üretirken

- HTML body doğrudan dönülmemeli
- önce sanitize edilmeli
- aşırı uzun gövdeler kırpılmalı
- attachment içerikleri ilk sürümde işlenmemeli

### Filtreleme kuralları

Desteklenebilecek filtreler:

- gönderen
- klasör
- unread
- zaman aralığı
- subject contains

### Taslak kuralları

- gönderim yapılmaz
- taslak açıkça `draft-only` modda oluşturulur
- kullanıcı onayı olmadan “send” endpoint’i hiç açılmaz

---

## 7. Güvenlik Gereksinimleri

### Secret yönetimi

Yapılacaklar:

- Client secret veya sertifika güvenli saklanmalı
- access/refresh token loglanmamalı
- repo içine secret commit edilmemeli

### Network sınırı

Servis yalnızca:

- `localhost`
- gerekiyorsa local trusted interface
  üzerinde dinlemeli.

### Operation policy

Bridge içinde açık bir policy katmanı olmalı:

- `ReadInbox`: allowed
- `ReadCalendar`: allowed
- `CreateDraft`: disabled/conditional
- `SendMail`: denied
- `DeleteMail`: denied

### Audit

Aşağıdakiler loglanabilir:

- endpoint adı
- çağrı zamanı
- kullanılan filtreler
- sonuç sayısı
- hata kodu

Ama şunları loglama:

- access token
- refresh token
- tam mail body (gerekmedikçe)

---

## 8. Hata Yönetimi

Beklenen hata sınıfları:

- auth expired
- invalid scope
- mailbox unavailable
- throttling
- network timeout
- malformed query

Yanıt standardı önerisi:

```json
{
  "error": {
    "code": "AUTH_EXPIRED",
    "message": "Microsoft oturumu yenilenmeli.",
    "retryable": true
  }
}
```

---

## 9. Test Planı

### Birim testleri

- filtre oluşturma
- DTO mapping
- body sanitization
- operation policy

### Entegrasyon testleri

- test tenant veya gerçek hesapla smoke test
- inbox summary
- messages list
- message detail
- calendar upcoming

### Manuel testler

- unread summary beklendiği gibi mi?
- Türkçe karakterler düzgün mü?
- HTML mail body özetleri bozuluyor mu?
- uzun thread’lerde performans yeterli mi?

---

## 10. Ceviz ile Entegrasyon Modeli

İki iyi seçenek var:

### Seçenek A — MCP server

Avantaj:

- daha standart agent entegrasyonu
- tool mantığı daha temiz

### Seçenek B — küçük HTTP wrapper/script

Avantaj:

- daha hızlı prototip
- daha az moving part

### Tavsiye

İlk PoC için:

- local HTTP API + dar wrapper

Sonra istenirse:

- MCP server’a çevrilebilir

---

## 11. Örnek Kullanım Senaryoları

### Senaryo 1

Komut:

- “Son 24 saatte gelen önemli mailleri özetle.”

Arka planda:

- `/mail/inbox-summary?hours=24&unreadOnly=false`

### Senaryo 2

Komut:

- “Ahmet’ten gelen okunmamış mailleri bul.”

Arka planda:

- `/mail/messages?from=ahmet@...&unreadOnly=true`

### Senaryo 3

Komut:

- “Önümüzdeki 2 gündeki toplantıları listele.”

Arka planda:

- `/calendar/upcoming?hours=48`

### Senaryo 4

Komut:

- “Bu maile nazik ama kısa bir cevap taslağı hazırla.”

Arka planda:

- önce mesaj detayı çekilir
- sonra taslak metin üretilir
- opsiyonel olarak `/mail/draft-reply`

---

## 12. Sonraki Genişleme Alanları

İlk sürümden sonra eklenebilir:

- attachment metadata listeleme
- conversation/thread summary
- VIP sender rules
- calendar + mail correlation
- scheduled digest generation
- Teams/meeting context bağlantısı

---

## 13. Mimari/Mühendislik Desktop Uygulaması İçin Not

Kullanıcı isteği doğrultusunda tek örnek olarak **Autodesk Revit** üzerinden genişleme notu:

### Ayrı modül stratejisi

Outlook bridge ile aynı servise doğrudan gömülmemeli; modüler ilerlenmeli.

Örnek yapı:

- `OutlookModule`
- `RevitModule`

### Revit modülü hangi işleri yapabilir?

- proje/meta bilgi okuma
- export akışları
- belirli model kontrolleri
- plugin tabanlı komut çağrıları

### Neden aynı anda değil?

Çünkü Outlook problemi API-first bir problem; Revit ise çoğu zaman plugin/desktop integration problemidir. Bu iki alanın operasyonel karakteri farklıdır.

Ben olsam:

- önce Outlook bridge’i bitiririm
- sonra Revit için ayrı bir local automation modülü tasarlarım

---

## 14. Uygulama Sırası Önerisi

Net sırayla yapılacaklar:

1. Azure App Registration oluştur
2. Read-only scope’larla auth akışını ayağa kaldır
3. `GET /me` ve `GET /health` endpoint’lerini çalıştır
4. `GET /mail/messages` endpoint’ini ekle
5. `GET /mail/inbox-summary` endpoint’ini ekle
6. `GET /calendar/upcoming` endpoint’ini ekle
7. policy/logging katmanını ekle
8. draft özelliğini ikinci fazda aç

---

## 15. Başarı Kriteri

Bu plan başarılı sayılır, eğer:

- Ceviz Outlook’tan güvenli biçimde veri okuyabiliyorsa
- kullanıcıya anlamlı özetler dönebiliyorsa
- gönderim ve yıkıcı işlemler kontrol altında kalıyorsa
- kurulum masaüstü otomasyonuna ihtiyaç duymadan çalışıyorsa

---

## 16. En Kısa Sonuç

En doğru ilk ürün:

- küçük bir **.NET Graph bridge**
- read-only izinler
- inbox + calendar odaklı birkaç endpoint
- Ceviz tarafında görev bazlı kullanım

Bu sürüm hem hızlı çıkar hem de ileride büyütülmesi rahattır.
