# SolidWorks 2025 – Operasyonel Trial Rotası Seçimi

## Amaç

Bu dokümanın amacı, demo ve harness doğrulaması için hangi resmi trial/evaluation yolunun seçileceğini operasyonel seviyede netleştirmektir.

Bağlam:

- hedef yerel Windows kurulum
- hedef canlı harness testi
- hedef minimum kullanıcı müdahalesi
- lisans yok, trial/evaluation gerekiyor

---

## 1. Değerlendirilen seçenekler

### Seçenek A — MySolidWorks / online browser trial

**Durum:** Uygun değil

Neden elendi?

- yerel masaüstü kurulum sağlamaz
- COM attach testi yapılamaz
- `get-active-document` live extractor hedefini karşılamaz

---

### Seçenek B — Resmi downloadable desktop trial / evaluation

**Durum:** Birinci tercih

Neden?

- yerel kurulum hedefiyle uyumlu
- gerçek uygulama prosesi oluşur
- harness testinin ihtiyaç duyduğu masaüstü ortamı sağlar
- demo için en doğru seçenek

Riskleri:

- trial formu / satış veya partner teması isteyebilir
- indirilebilir kurulum erişimi hemen self-service olmayabilir

---

### Seçenek C — 3DEXPERIENCE SOLIDWORKS Connected evaluation

**Durum:** İkinci tercih / fallback

Neden güçlü aday?

- yerel Windows kurulum verir
- resmi değerlendirme kanalıdır
- SolidWorks Connected masaüstü uygulama sağlar

Neden birinci tercih değil?

- launcher / platform / ek akış bağımlılığı var
- klasik desktop evaluation kadar sade olmayabilir
- ek platform karmaşıklığı getirebilir

---

## 2. Seçilen operasyonel rota

### Seçilen rota

**Önce resmi downloadable desktop trial / evaluation yolu zorlanacak.**

Eğer bu self-service şekilde veya kısa doğrulama ile alınamazsa,
**3DEXPERIENCE SOLIDWORKS Connected evaluation fallback’i kullanılacak.**

Bu kararın nedeni:

- bizim asıl hedefimiz browser demo değil
- yerel executable ve aktif doküman kavramı gerekiyor
- harness’in canlı kısmı ancak böyle doğrulanabilir

---

## 3. Neden bu rota en uygun?

### Teknik gerekçe

Harness’in şu an geldiği seviye artık şunu bekliyor:

- Windows hostta gerçek SolidWorks uygulaması
- aktif document context
- COM attach veya en azından host erişim denemesi

Bu yüzden trial yolu seçiminde temel kriter “kolay deneme” değil,
**yerel uygulama kurma kabiliyeti** olmalı.

### Operasyonel gerekçe

Downloadable evaluation yolu genelde:

- daha doğrudan hedefe götürür
- local install odaklıdır
- kurulum sonrası test zincirini sadeleştirir

3DEXPERIENCE Connected ise güçlü fallback’tir ama daha çok platform/launcher bağımlıdır.

---

## 4. Kullanıcıdan istenecek minimum müdahale

Bu rota için senden muhtemelen yalnızca aşağıdaki minimal katkı gerekecek:

### Muhtemel minimum katkı

1. trial/evaluation formunda kimlik bilgisi onayı
2. e-posta doğrulama
3. gerekiyorsa portal login
4. nadiren kısa bir “hangi kullanım amacı?” benzeri onay

### Özellikle senden istememeye çalışacağım şeyler

- teknik kurulum parametreleri seçmek
- log dosyası ayıklamak
- hangi paket doğru karar vermek
- harness test adımlarını takip etmek

Yani amaç şu:
**sen yalnızca erişim/kimlik gereken yerde devreye gireceksin, teknik devamı ben yöneteceğim.**

---

## 5. Bundan sonra izlenecek sıra

### Faz 1 — Trial acquisition operasyonalizasyonu

Yapılacak:

- resmi desktop trial/evaluation giriş noktasını kullan
- self-service / form / partner yönlendirme durumunu gör
- gerekli minimum kullanıcı etkileşimini tespit et

### Faz 2 — Eğer desktop trial zorlanırsa fallback

Yapılacak:

- 3DEXPERIENCE Connected evaluation akışına dön
- launcher + local install akışını hazırla

### Faz 3 — Kurulum sonrası ilk test

Yapılacak:

- SolidWorks açılış doğrulaması
- aktif belge açma
- `get-active-document` live-only / prefer-live testleri

---

## 6. Başarı ölçütü

Bu operasyonel rota başarılı sayılmalıysa:

- masaüstü kurulum erişimi alınmalı
- SolidWorks Windows hostta açılmalı
- aktif belge ile test edilebilmeli
- harness’in canlı extraction zinciri gerçek dünyaya bağlanmalı

---

## 7. Net karar özeti

Bu noktadaki karar:

> **Birinci rota:** resmi downloadable desktop trial / evaluation
> **Fallback rota:** 3DEXPERIENCE SOLIDWORKS Connected evaluation
> **Elenen rota:** browser-only online trial

Çünkü bizim hedefimiz yalnızca ürünü görmek değil,
**yerel masaüstü uygulama üzerinden harness’i doğrulamak**.
