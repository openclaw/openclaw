# CAD/BIM Copilot – PoC PRD Taslağı

## 1. Dokümanın amacı

Bu doküman, SolidWorks ile başlanacak CAD/BIM copilot fikrinin ilk PoC kapsamını netleştirmek için hazırlanmıştır.

Amaç:

- ilk kullanıcıyı tanımlamak
- çözülecek problemi netleştirmek
- PoC kapsamını belirlemek
- başarı kriterlerini yazmak
- teknik mimariye girdi sağlayacak fonksiyonel çerçeveyi oluşturmak

Bu PRD özellikle **ilk uygulanabilir PoC** içindir; tam ürün kapsamı değildir.

---

## 2. Ürün özeti

### Ürün adı

Geçici isim: **CAD/BIM Design Review Copilot**

### Kısa tanım

Kullanıcının CAD modelini veya assembly yapısını okuyup doğal dilde açıklayan, risk/dikkat noktalarını özetleyen, metadata/checklist ön kontrolü yapan ve sonraki adımlar için öneri sunan bir copilot.

### İlk entegrasyon hedefi

- **SolidWorks**

### Ürün ilkesi

- önce **read-only analiz ve yorumlama**
- sonra **guardrailli ve onaylı aksiyonlar**

---

## 3. Problem tanımı

Bugünkü CAD araçları modelleme konusunda güçlü olsa da aşağıdaki ihtiyaçlarda kullanıcı hâlâ manuel efor harcıyor:

- modelin ne anlattığını hızlı anlama
- bir tasarımın kritik risklerini ilk bakışta çıkarma
- eksik property / metadata / naming sorunlarını bulma
- toplantı veya review öncesi hızlı briefing alma
- teknik tasarımı daha sade ve açıklanabilir hale getirme

Özellikle karmaşık dosyalarda veya assembly’lerde kullanıcılar şunları hızlıca sormak ister:

- Bu modelin ana bileşenleri ne?
- Buradaki riskli noktalar neler olabilir?
- Eksik bilgi var mı?
- Review öncesi neye dikkat etmeliyim?
- Bunu başka birine kısa ve net nasıl anlatırım?

Bu PoC, tam da bu “anlama + ön kontrol + açıklama” boşluğunu hedefler.

---

## 4. Hedef kullanıcı profili

### Birincil persona

**Tasarım mühendisi / teknik tasarım uzmanı**

Özellikleri:

- SolidWorks içinde model/assembly ile çalışır
- günlük işinde review, açıklama, kontrol ve yinelemeli düzeltme yapar
- tüm detayları her zaman manuel taramak istemez
- hızlı bir ikinci göz / yardımcı analist ister

### İkincil persona

**Takım lideri / teknik review yapan kıdemli kullanıcı**

Özellikleri:

- modeli hızlı anlamak ister
- review toplantısı öncesi özet görmek ister
- eksik veya riskli alanları önden işaretlemek ister

### Üçüncül persona

**Teknik olmayan ama karar verici paydaş**

Özellikleri:

- tasarımın ayrıntısını bilmez
- sade dilde özet ister
- kritik risk ve karar başlıklarını görmek ister

---

## 5. PoC vizyonu

PoC sonunda kullanıcı şunu yapabilmeli:

- SolidWorks’te açık olan model veya assembly için copilot’a soru sorabilmeli
- copilot seçili bağlamı okuyup kullanıcıya anlamlı bir açıklama dönebilmeli
- copilot risk, eksik metadata ve review notları çıkarabilmeli
- kullanıcı tek tık/tek komutla özet veya checklist çıktısı alabilmeli

PoC’nin amacı tam otomasyon değildir.
Amaç, “bu yapının gerçekten işe yarayacağını” göstermektir.

---

## 6. PoC kapsamı

### In Scope

PoC içinde yer alacak temel yetenekler:

#### 6.1 Model/assembly bağlamını okuma

Sistem aşağıdaki türde bilgileri okuyabilmeli:

- aktif doküman bilgisi
- doküman tipi (part / assembly / drawing ise erişilebilen temel ayrım)
- dosya adı / temel metadata
- custom properties
- seçili öğe bilgisi varsa onun özeti
- assembly ise erişilebilen temel bileşen listesi / hiyerarşik özet

#### 6.2 Doğal dilde açıklama üretimi

Kullanıcı aşağıdaki gibi sorular sorabilmeli:

- Bu model neyi temsil ediyor?
- Ana bileşenler neler?
- Review için dikkat edilmesi gereken noktalar ne?
- Kısa özet çıkar.

Sistem şu tip çıktılar üretebilmeli:

- kısa özet
- bileşen/bağlam özeti
- dikkat noktaları
- belirsizlikler / veri eksikleri

#### 6.3 Checklist / metadata ön kontrolü

Sistem belirli kurallara göre ilk kontrol yapabilmeli:

- eksik custom property tespiti
- naming / metadata eksikliği
- tanımlanmış alanlarda boş değer kontrolü
- review öncesi tamamlanması gereken maddelerin raporlanması

#### 6.4 Role-based çıktı formatları

Sistem aynı tasarım bağlamını farklı tonlarda özetleyebilmeli:

- teknik kullanıcı için detaylı özet
- yönetici/paydaş için sade özet

#### 6.5 Rapor çıktısı

Sistem analiz sonucu aşağıdaki yapılarda çıktı verebilmeli:

- chat yanıtı
- kısa checklist raporu
- kopyalanabilir toplantı özeti

---

## 7. Out of Scope

İlk PoC’de özellikle yapılmayacaklar:

- geometriyi otomatik değiştirme
- parametrik model düzenleme
- çizim/görünüş üretimini otonom yönetme
- tam üretilebilirlik/doğrulama garantisi verme
- resmi compliance motoru gibi davranma
- kurumsal ERP/PLM tam entegrasyonu
- çoklu CAD platformunu aynı anda destekleme
- tam ajan-otonom akışlar

PoC’nin bilinçli sınırı:
**anlama, yorumlama, ön kontrol, açıklanabilir çıktı**

---

## 8. Ana kullanıcı hikâyeleri

### User Story 1

Bir tasarım mühendisi olarak,
açık modelin veya assembly’nin ne anlattığını hızlıca görmek istiyorum,
böylece tüm ağacı manuel gezmeden bağlamı anlayabileyim.

**Başarı çıktısı:**

- sistem 1-2 dakikadan kısa sürede anlamlı özet döner

### User Story 2

Bir review yapan kullanıcı olarak,
modelde eksik metadata veya dikkat gerektiren alanları görmek istiyorum,
böylece toplantıdan önce hızlı ön kontrol yapabileyim.

**Başarı çıktısı:**

- eksik alanlar ve dikkat noktaları listelenir

### User Story 3

Bir takım lideri olarak,
aynı tasarım için teknik olmayan kişilere uygun kısa bir açıklama üretmek istiyorum,
böylece toplantı iletişimi kolaylaşsın.

**Başarı çıktısı:**

- sade dilde kısa ve anlaşılır özet üretilir

### User Story 4

Bir kullanıcı olarak,
analiz sonucunda sistemin neden böyle söylediğini görmek istiyorum,
böylece cevaba güvenip güvenmeyeceğime karar verebileyim.

**Başarı çıktısı:**

- mümkünse bulgular veri noktalarıyla ilişkilendirilir
- belirsizlik varsa açıkça söylenir

---

## 9. Fonksiyonel gereksinimler

### FR-1: Aktif doküman okuma

Sistem aktif dokümanın temel bağlamını okuyabilmelidir.

### FR-2: Seçim bağlamı okuma

Kullanıcı belirli bir öğe seçtiyse sistem o bağlamı da analiz edebilmelidir.

### FR-3: Metadata çıkarımı

Sistem custom properties ve temel belge alanlarını çıkarabilmelidir.

### FR-4: Assembly özeti

Assembly bağlamında sistem erişilebilen temel yapı bilgisinden özet oluşturabilmelidir.

### FR-5: Doğal dil soru-cevap

Kullanıcı chat benzeri arayüzden tasarım hakkında soru sorabilmelidir.

### FR-6: Açıklama üretimi

Sistem modeli sade veya teknik dilde özetleyebilmelidir.

### FR-7: Ön kontrol raporu

Sistem tanımlı checklist/rule set üzerinden eksik veya şüpheli alanları raporlayabilmelidir.

### FR-8: Belirsizlik bildirimi

Sistem emin olmadığı durumda bunu açıkça belirtebilmelidir.

### FR-9: Kopyalanabilir çıktı

Sistem toplantı notu / kısa review özeti gibi kopyalanabilir metin üretebilmelidir.

---

## 10. Non-functional gereksinimler

### NFR-1: Güven

Sistem doğrulanmamış bilgiyi kesinmiş gibi sunmamalıdır.

### NFR-2: Açıklanabilirlik

Bulgular mümkün olduğunca görünür veri veya kurala dayandırılmalıdır.

### NFR-3: Kontrol

PoC hiçbir durumda kullanıcı onayı olmadan model değiştirmemelidir.

### NFR-4: Performans

İlk yanıt süresi demo açısından makul olmalıdır.
Hedef: basit bağlamlarda birkaç saniye ila kabul edilebilir kısa bekleme süresi.

### NFR-5: Genişletilebilirlik

Mimari ileride farklı host uygulamalara genişlemeye uygun olmalıdır.

### NFR-6: Yerel çalışma uyumu

Windows uygulamasıyla entegrasyon yerel executor mantığıyla uyumlu olmalıdır.

---

## 11. PoC kullanıcı akışları

### Akış 1 — Hızlı model özeti

1. Kullanıcı SolidWorks’te model/assembly açar.
2. Copilot panelini veya komutunu açar.
3. “Bu modeli özetle” der.
4. Sistem bağlamı okur.
5. Kısa özet + kritik noktalar + eksik veri döner.

### Akış 2 — Review checklist

1. Kullanıcı “Bu modeli checklist’e göre tara” der.
2. Sistem metadata/rule kontrolü yapar.
3. Eksik alanlar ve dikkat noktaları listelenir.
4. Kullanıcı çıktıyı toplantı öncesi kullanır.

### Akış 3 — Paydaş özeti

1. Kullanıcı “Bunu teknik olmayan biri için açıkla” der.
2. Sistem daha sade, kısa ve karar odaklı özet üretir.

---

## 12. Demo senaryosu

PoC demosu için önerilen akış:

1. SolidWorks’te örnek bir assembly açılır.
2. Copilot’tan “Bu assembly’yi bana açıkla” istenir.
3. Sistem ana bileşenleri ve dikkat noktalarını özetler.
4. Ardından “Checklist ön kontrolü yap” komutu verilir.
5. Sistem eksik property veya review maddelerini raporlar.
6. Son olarak “Bunu proje yöneticisine anlatacak kısa özet çıkar” denir.
7. Sistem teknik olmayan özet üretir.

Bu demo üç şeyi aynı anda gösterir:

- bağlam okuma
- reasoning
- role-specific çıktı

---

## 13. Başarı kriterleri

### Ürün başarı kriterleri

- Kullanıcı demo sonunda çıktıyı “gerçekten işe yarar ikinci göz” olarak algılamalı.
- Çıktılar sadece genel laf değil, bağlama temas eden somut gözlemler içermeli.
- En az bir checklist/metadata kontrolü anlamlı değer göstermeli.
- Teknik ve sade özet arasında fark hissedilmeli.

### Teknik başarı kriterleri

- SolidWorks bağlamından veri çekilebildiği gösterilmeli.
- Bu veri tutarlı bir JSON/ara temsil biçimine dönüştürülebilmeli.
- Ceviz anlamlı ve açıklanabilir cevap üretebilmeli.
- Sistem read-only sınırını korumalı.

### Demo başarı kriterleri

- Uçtan uca akış tek oturumda çalışmalı.
- En az 2-3 farklı prompt ile tutarlı kalite görülmeli.
- Çıktı kopyalanabilir ve sunulabilir olmalı.

---

## 14. Varsayımlar

Bu PoC aşağıdaki varsayımlara dayanır:

- SolidWorks tarafında gerekli bağlam okunabilir olacaktır.
- İlk demo için tam geometri analizi gerekmeden anlamlı değer üretilebilir.
- Metadata + yapı + seçim bağlamı, iyi ilk sonuçlar vermek için yeterli olabilir.
- Kullanıcı ilk etapta otomatik düzenleme değil, doğru yorumlama ve görünür fayda ister.

---

## 15. Riskler

### Risk A — Veri yüzeyi yetersiz kalabilir

Okunabilen veri, güçlü açıklama için sınırlı olabilir.

**Azaltma:**

- ilk sözleşmeyi metadata + ağaç + seçim özeti üzerinden kur
- geometri-level derinlik sonra artırılsın

### Risk B — Çıktılar fazla genel kalabilir

LLM bağlama tam oturmazsa sonuç yüzeysel olabilir.

**Azaltma:**

- structured context ver
- prompt kalıbını görev bazlı tasarla
- evidence alanları ekle

### Risk C — Domain uyumsuzluğu

Mimarlık ağırlıklı kullanım ile SolidWorks kullanım alanı tam örtüşmeyebilir.

**Azaltma:**

- PoC’yi “design review copilot” diliyle konumla
- mimariyi host-agnostic kur

### Risk D — Kullanıcı güveni

Sistem emin olmadığı yerlerde fazla iddialı davranırsa güven kaybı olur.

**Azaltma:**

- uncertainty output zorunlu olsun
- kaynak veri alanlarını görünür kıl

---

## 16. PoC teslim çıktıları

Bu PoC sonunda ideal olarak aşağıdakiler elde edilmiş olmalı:

- SolidWorks için çalışan minimum veri çıkarım akışı
- local executor ile copilot reasoning akışı
- chat benzeri veya panel tabanlı demo yüzeyi
- örnek checklist/rule set
- 2-3 demo prompt’u için kaliteli örnek çıktı
- teknik mimariye temel olacak veri sözleşmesi

---

## 17. Gelecek fazlar

### Faz 2

- daha zengin kural motoru
- daha gelişmiş assembly dependency analizi
- daha iyi evidence gösterimi

### Faz 3

- kullanıcı onaylı düzeltme önerileri
- metadata/property update aksiyonları
- template bazlı düzeltmeler

### Faz 4

- çoklu platform desteği
- Revit / AutoCAD / Rhino / IFC benzeri host’lara genişleme

---

## 18. Açık kararlar

Teknik mimariye geçmeden önce netleştirilmesi gereken bazı başlıklar:

- ilk PoC arayüzü ne olacak?
  - doğrudan chat panel mi
  - side panel mi
  - hibrit mi
- ilk rule set ne kadar basit olacak?
- demo verisi gerçek şirket dosyası mı, örnek/sentetik dosya mı olacak?
- çıktı dili sadece Türkçe mi, çift dil ihtiyacı var mı?

---

## 19. Net PoC kararı

Bu PRD’ye göre önerilen ilk PoC:

> SolidWorks üzerinde çalışan, aktif model veya assembly bağlamını okuyup kullanıcıya doğal dilde açıklama, review notları, risk işaretleri ve metadata/checklist ön kontrolü sunan read-only bir design review copilot.

---

## 20. Sonraki adım önerisi

Bu PRD’den sonra en doğru iş:

1. teknik mimari dokümanını yazmak
2. veri sözleşmelerini belirlemek
3. SolidWorks data extraction spike planını çıkarmak
4. ilk demo prompt setini tanımlamak

Bu sırayla gidersek discovery → PRD → architecture → implementation backlog hattı düzgün kapanır.
