# SolidWorks 2025 Trial Edinme ve Kurulum Yolu

## Amaç

Bu dokümanın amacı, demo hedefi için SolidWorks 2025 veya eşdeğer resmi deneme/evaluation yolunu minimum insan müdahalesi ile edinmek adına en uygulanabilir seçenekleri netleştirmektir.

Bağlam:

- amaç tam üretim lisansı değil
- amaç harness demo ve extractor doğrulaması
- Windows hostta henüz SolidWorks kurulu değil
- kullanıcı mümkün olduğunca sürece az dahil olmak istiyor

---

## 1. Ana bulgu

Resmi kanallara göre iki ana trial/evaluation yolu görünüyor:

### Yol A — Browser tabanlı / online trial

Avantajları:

- kurulum gerekmez
- hızlı erişim olabilir
- demo için bazı ürün kabiliyetleri görülebilir

Dezavantajları:

- bizim harness hedefimiz için yetersiz
- yerel Windows uygulaması kurulmaz
- SolidWorks COM / ActiveDoc / live extractor test edilemez

### Yol B — Desktop evaluation / 3DEXPERIENCE SOLIDWORKS Connected / indirilebilir değerlendirme

Avantajları:

- yerel masaüstü kurulum sağlar
- Windows host üzerinde gerçek uygulama oluşur
- harness’in canlı extraction tarafı test edilebilir

Dezavantajları:

- hesap / entitlement / form / launcher gibi adımlar isteyebilir
- tam sıfır insan müdahalesi garanti değil

### Sonuç

Bizim hedefimiz için **Yol B zorunluya yakın**.
Çünkü browser trial bizim `get-active-document` live extraction hedefimizi karşılamaz.

---

## 2. Hedefe en uygun seçenek

### En uygun aday

**3DEXPERIENCE SOLIDWORKS Connected** veya resmi desktop evaluation akışı

Neden?

- Windows üstünde gerçek masaüstü uygulama kurulur
- uygulama açılabilir
- aktif doküman kavramı vardır
- COM / host attach denemesi teoriden pratiğe geçebilir

Bu nedenle harness açısından en mantıklı hedef:

> "Kurulum gerektiren resmi evaluation / desktop trial yolu"

---

## 3. Neden browser trial yetmez?

Her ne kadar browser trial hızlı olsa da:

- yerel installer yok
- Windows hostta uygulama prosesi yok
- COM automation / ActiveDoc erişimi yok
- queue/executor/live extractor zinciri gerçek dünyaya bağlanamaz

Bu yüzden browser trial, yalnızca ürün tanıtımı için faydalı olabilir.
Harness doğrulaması için tek başına yeterli değildir.

---

## 4. Minimum insan müdahalesi açısından gerçekçi çerçeve

Tamamen sıfır insan müdahalesi bu akışta zor olabilir.
Muhtemel insan temas noktaları:

- hesap oluşturma
- e-posta doğrulama
- form / şirket bilgisi
- trial onayı
- resmi portal erişimi

Bu yüzden daha dürüst hedef şu olmalı:

> Kullanıcıdan sadece gerekli kimlik/doğrulama adımlarında yardım alıp,
> geri kalan kurulum planı, kontrol ve harness doğrulamasını mümkün olduğunca otomatik yürütmek.

---

## 5. Önerilen edinme stratejisi

## Strateji 1 — Resmi desktop evaluation / free trial form yolu

### Akış

1. Resmi SolidWorks trial/evaluation sayfasına gidilir.
2. Uygun masaüstü değerlendirme seçeneği seçilir.
3. Gerekirse SolidWorks ID / 3DEXPERIENCE ID oluşturulur.
4. Entitlement onayı alınır.
5. İndirilebilir installer / launcher erişimi sağlanır.
6. Kurulum yapılır.

### Artıları

- resmi yol
- demo için en uygun yol olabilir
- masaüstü uygulama hedefiyle uyumlu

### Eksileri

- form ve onay gerektirebilir
- bazen satış/partner akışına düşebilir

---

## Strateji 2 — 3DEXPERIENCE SOLIDWORKS Connected evaluation

### Akış

1. 3DEXPERIENCE platform hesabı / evaluation erişimi alınır.
2. Platforma giriş yapılır.
3. 3DEXPERIENCE Launcher kurulur.
4. SOLIDWORKS Connected kurulur.
5. Desktop uygulama açılır.

### Artıları

- gerçek masaüstü kurulum sağlar
- modern resmi akışlardan biri
- demo için yeterli olabilir

### Eksileri

- launcher + platform bağımlılığı ekler
- klasik SolidWorks desktop ile birebir aynı dağıtım hissi olmayabilir
- bazı ek adımlar gerektirir

---

## 6. Hangisini tercih etmeliyiz?

Bence öncelik sırası şu olmalı:

### 1. tercih

**Resmi desktop evaluation / downloadable trial**

### 2. tercih

**3DEXPERIENCE SOLIDWORKS Connected evaluation**

### 3. sadece yedek

**Browser-based online trial**

Neden bu sıra?
Çünkü bizim hedefimiz ürün tanıtımı değil;
**yerel uygulama üzerinden harness test etmek**.

---

## 7. Uygulama planı

### Faz A — Trial erişim kanalını sabitle

Yapılacak:

- hangi resmi trial yolunun gerçekten masaüstü kurulum verdiğini teyit et
- gerekiyorsa trial formu doldur
- portal/hesap erişimini hazırla

### Faz B — Kurulum hazırlığı

Yapılacak:

- installer / launcher path belirle
- Windows host ön kontrolü yap
- log/artifact klasörlerini hazırla

### Faz C — Kurulum

Yapılacak:

- mümkün olan yerlerde otomasyon kullan
- zorunlu kimlik/doğrulama adımlarında kısa kullanıcı müdahalesi al

### Faz D — İlk açılış

Yapılacak:

- uygulama açılıyor mu
- lisans/evaluation aktif mi
- boş veya örnek belge açılabiliyor mu

### Faz E — Harness testi

Yapılacak:

- `get-active-document` live-only
- sonra gerekirse prefer-live

---

## 8. Minimum kullanıcı müdahalesi için stratejik yaklaşım

### Kullanıcıdan istenebilecek minimum şeyler

- hesap doğrulama
- gerekiyorsa portal login
- belki kısa bir trial başvuru onayı

### Kullanıcıdan kaçınmak istediğimiz şeyler

- uzun teknik kurulum kararları
- çok adımlı manuel doğrulama
- belirsiz installer seçimleri
- log ve hata ayrıştırma

Bunları Ceviz/harness planı üstlenmeli.

---

## 9. Şu anki en doğru sonraki adım

Bu noktada en mantıklı bir sonraki iş şudur:

> Resmi desktop trial / evaluation yolunu daha da daraltıp,
> hangi URL / hangi hesap akışı / hangi kurulum biçimi ile ilerleyeceğimizi belirlemek.

Bunun ardından:

- kullanıcıya tek seferlik minimum müdahale listesi verilir
- kurulum checklist’i netleştirilir
- sonra harness testine geçilir

---

## 10. Net karar

Şu anda hedef için doğru yaklaşım:

- **SolidWorks 2025 desktop-capable evaluation yolu bulunmalı**
- browser trial yalnızca yedek veya tanıtım amaçlı düşünülmeli
- 3DEXPERIENCE Connected, masaüstü kurulum verdiği için güçlü aday
- kullanıcıdan tamamen bağımsız tam akış garanti değil, ama müdahale minimumda tutulabilir

---

## 11. Kısa sonuç

Bu problem için ana karar şudur:

> Eğer harness’in canlı kısmını gerçekten test etmek istiyorsak,
> yerel Windows kurulum veren resmi evaluation/trial yoluna gitmek zorundayız.

Yani bir sonraki adım artık:
**trial acquisition kanalını operasyonel seviyede netleştirmek**.
