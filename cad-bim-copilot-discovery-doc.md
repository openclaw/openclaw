# CAD/BIM Copilot Discovery Dokümanı

## Amaç

Bu dokümanın amacı, mimarlık/mühendislik çizim programları kullanan profesyonellere yardımcı olacak bir copilot ürününün ilk kapsamını netleştirmek, neden bu yönde ilerlediğimizi görünür kılmak ve ilk PoC için doğru başlangıç noktasını seçmektir.

Bu aşamada özellikle şu prensibi baz alıyorum:

- ilk sürümde **read-only analiz + öneri üretimi**
- ikinci aşamada **onaylı/guardrailli düzenleme**
- yerel Windows uygulamalarıyla konuşmak için **plugin/add-in + local executor/bridge + Ceviz orchestrator** yaklaşımı

---

## 1. Mevcut kararlar ve varsayımlar

### Doğrulanmış girdiler

- Hedef şirkette **SolidWorks** kullanılıyor.
- Use-case tarafında **mimarlık disiplini ağırlıklı** örnekler öncelikli düşünülüyor.
- Kullanıcı için yapılan işin görünür olması önemli; bu yüzden önce stratejik/analitik bir doküman üretmek mantıklı.

### Bu bilgilerden çıkardığım anlam

Bu kombinasyon biraz hibrit bir alan işaret ediyor:

- **SolidWorks** tipik olarak mekanik ürün tasarımı / parça / montaj dünyasında çok güçlü.
- **Mimarlık odaklı ihtiyaçlar** ise çoğu zaman Revit / AutoCAD / Rhino / IFC/BIM tarafına daha yakın oluyor.

Bu yüzden ürün fikrini tek bir yazılıma kilitlemek yerine şu şekilde konumlandırmak daha doğru:

> Çekirdekte “tasarım dosyasını/anlamını okuyup öneri veren domain copilot”, ilk entegrasyonda ise şirketin gerçek dünyada kullandığı araçtan başlamak.

Yani başlangıç noktası olarak SolidWorks mantıklı olabilir; fakat ürün dili yalnızca “SolidWorks assistant” olmamalı. Daha üst seviyede:

- CAD/BIM copilot
- design review assistant
- engineering/architecture reasoning layer

---

## 2. Neden önce dokümanla başlamak doğru seçim

Bence 1. seçenekle başlamak doğru, çünkü şu an henüz üç kritik konu tamamen net değil:

- nihai hedef kullanıcı profili
- ilk PoC’nin hangi problemi çözeceği
- SolidWorks ile mimarlık use-case’lerinin nasıl bağlanacağı

Bu belirsizlikler varken doğrudan implementasyona girmek kolayca yanlış entegrasyona veya gösterişli ama değersiz bir demo’ya götürür.

Dokümanla başlamak şu faydaları sağlar:

- kapsamı görünür hale getirir
- teknik mimariyi use-case’ten türetmemizi sağlar
- PoC’yi “agent yapabildiği için yapılan” bir şey olmaktan çıkarıp “gerçek iş problemi çözen” bir şeye dönüştürür
- sonrasında backlog, mimari ve demo akışı daha hızlı çıkar

---

## 3. Problem çerçevesi

### Temel problem

Bugünkü CAD/BIM araçları modelleme konusunda güçlü; fakat modelin ne anlattığını, nerede risk olduğunu, hangi kurala uymadığını veya hangi iyileştirmenin mantıklı olacağını kullanıcıya doğal dille açıklayan katman zayıf.

### Copilot neyi çözmeli?

İyi bir copilot, kullanıcıya şunları sağlayabilir:

- modeli veya seçili parçaları/öğeleri anlamlandırma
- kalite/risk/uygunluk kontrolü
- doğal dille soru-cevap
- tekrar eden review işlerini hızlandırma
- aksiyon öncesi açıklanabilir öneri

---

## 4. İlk ürün ilkesi: read-only önce, write sonra

İlk PoC’de düzenleme yapmaktan özellikle kaçınmayı öneriyorum.

### Sebep

CAD/BIM tarafında yanlış bir otomatik işlem:

- modeli bozabilir
- güven kaybettirir
- sorumluluk ve doğrulama maliyetini artırır
- demo değerini düşürebilir

### Bu yüzden ilk aşama

Copilot önce şunu yapmalı:

- dosyayı / modeli / assembly’yi / metadata’yı oku
- kurallara göre incele
- bulguları doğal dilde açıkla
- istenirse önerilen değişiklikleri listele
- ama uygulamayı kullanıcı onayına bırak

Bu yaklaşım hem teknik risk hem ürün riski açısından en doğru başlangıç.

---

## 5. Önerdiğim örnek kullanım alanları

Sen mimarlık ağırlıklı örnekleri bana bırakmıştın; bu yüzden aşağıdaki seti bilerek seçiyorum. Buradaki amaç, doğrudan BIM yazılımı şart koşmadan “mimarlık/teknik tasarım review” mantığını görünür kılmak.

### A. Tasarım inceleme asistanı

Kullanıcı seçili model/parça/alt sistem için şunu sorar:

- Bu tasarım ne yapıyor?
- Buradaki kritik bileşenler neler?
- Üretilebilirlik / montaj / bakım açısından dikkat edilmesi gereken noktalar ne?
- Bu çözümde muhtemel riskler ne?

**Neden iyi PoC adayı?**

- Tamamen read-only olabilir
- LLM için güçlü açıklama yüzeyi sunar
- Kullanıcıya ilk anda “akıllı” hissettiren çıktı üretir

### B. Kural/standart uygunluk ön kontrolü

Kullanıcı şirkete özel veya proje özel kuralları tanımlar. Copilot:

- isimlendirme standardı
- dosya/konfigürasyon düzeni
- parça özellikleri
- malzeme/metadata eksiklikleri
- belirli geometrik veya yapısal kontrol işaretleri
  üzerinden ön inceleme yapar.

**Neden iyi PoC adayı?**

- Ticarileşmeye en yakın alanlardan biri
- Ölçülebilir fayda üretir
- “AI güzel konuşuyor” yerine “iş sürecine değer katıyor” hissi verir

### C. Değişiklik etki analizi yardımcısı

Kullanıcı der ki:

- Bu parçayı değiştirirsem neler etkilenir?
- Bu assembly’de en kritik bağımlılıklar hangileri?
- Şu komponentin kaldırılması neyi bozar?

**Neden iyi PoC adayı?**

- Assembly ilişkileri varsa çok etkileyici olabilir
- Kurumsal kullanımda ciddi değer üretir
- Sonraki write-capability aşamasına doğal köprü kurar

### D. Mimarlık tarafına uyarlanmış “design review copilot”

Bu örnek doğrudan SolidWorks’e tam oturmasa da ürün vizyonu için önemli.
Copilot ileride şu sorulara cevap verebilir:

- Bu modelde erişim / bakım / dolaşım açısından sorunlu alanlar var mı?
- Bu çözüm uygulama açısından karmaşık görünüyor mu?
- Bu teknik çözümün sahadaki koordinasyon riski ne olabilir?
- Bu tasarım kararını proje toplantısında nasıl özetlerim?

**Neden önemli?**

- Mimarlık odaklı kullanımın “salt çizim değil karar destek” tarafını açar
- Ürünü araçtan bağımsız düşünmemizi sağlar

---

## 6. İlk PoC için öncelik önerim

Eğer bugün tek bir başlangıç seçecek olsam, şu sırayı öneririm:

### 1. öncelik: Tasarım inceleme + açıklama asistanı

İlk PoC şu işi yapsın:

- SolidWorks modelinden erişilebilen yapı/metadata bilgilerini toplasın
- seçili parça/assembly için özet çıkarsın
- risk/dikkat noktaları oluştursun
- doğal dilde “bu tasarım hakkında hızlı briefing” üretsin

**Neden bunu 1. sıraya koyuyorum?**

- uygulaması en gerçekçi başlangıç
- demo etkisi yüksek
- veri okuma, yorumlama, kurallandırma ve açıklama katmanını birlikte test eder
- sonraki use-case’ler için altyapı oluşturur

### 2. öncelik: Kural uygunluk ön kontrolü

İkinci adımda:

- kullanıcı tanımlı checklist/rule set
- metadata eksikleri
- naming / property / configuration kontrolleri
- rapor üretimi

Bu, PoC’den pilot ürüne geçişte çok güçlü olur.

### 3. öncelik: Onaylı değişiklik önerileri

Ancak bundan sonra:

- “şu property’yi düzelt”
- “şu isimlendirmeyi standardize et”
- “şu template’e göre güncelle”
  gibi yarı-otomatik write aksiyonları eklenebilir.

---

## 7. Önerilen ürün mimarisi

Bugüne kadar konuştuğumuz Windows bridge yaklaşımını bu probleme uyarlayınca en mantıklı yapı şu görünüyor:

### Katmanlar

1. **Host application integration layer**
   - SolidWorks add-in / macro / local plugin yüzeyi
   - aktif doküman, seçim, metadata, tree, custom properties, assembly ilişkileri gibi bilgileri toplar

2. **Local Windows executor**
   - Windows üzerinde çalışan güvenilir uygulayıcı katman
   - host uygulama API’leriyle doğrudan konuşur
   - kontrollü komut seti uygular

3. **Ceviz orchestrator**
   - kullanıcı niyetini anlar
   - hangi veri gerektiğine karar verir
   - executor’dan veri ister
   - LLM reasoning + rule evaluation + response composition yapar

4. **Rules / policy layer**
   - şirket kuralları
   - naming conventions
   - metadata zorunlulukları
   - role-based guardrails
   - write işlemleri için approval kapıları

5. **Conversation/UI layer**
   - chat panel
   - side panel bulgu listesi
   - explain / why / show evidence etkileşimleri

### Neden bu mimari iyi?

- Windows uygulamalarının yerel API gerçekliğine uyuyor
- LLM’i doğrudan CAD yazılımının içine gömmek yerine ayrık ve kontrol edilebilir tutuyor
- gelecekte başka host’lara genişlemeyi kolaylaştırıyor
  - SolidWorks
  - Revit
  - AutoCAD
  - Rhino
  - IFC viewer

---

## 8. Teknik olarak ilk PoC’de neleri gerçekten yapabiliriz?

Aşağıdaki kapsam gerçekçi görünüyor:

### Yapılabilir çekirdek akış

- kullanıcı host uygulamada bir model/parça/assembly açar
- add-in/executor seçili context’i okur
- gerekli metadata + yapı bilgisi JSON’a çevrilir
- Ceviz bu veriyi yorumlar
- kullanıcıya:
  - özet
  - dikkat noktaları
  - eksik bilgi
  - olası riskler
  - önerilen sonraki adımlar
    döner

### İlk versiyonda özellikle sınırlı tutulmalı

- doğrudan geometri düzenleme
- karmaşık parametrik değişiklik yazımı
- tam otonom model güncelleme
- doğrulanmamış üretim/uyumluluk kararları

---

## 9. Örnek PoC senaryoları

### Senaryo 1 — “Bu assembly’yi bana açıkla”

Kullanıcı bir assembly açar ve sorar:

> Bu assembly’nin ana bileşenleri neler, kritik noktaları ne, hangi alanlar review gerektiriyor?

Copilot çıktısı:

- ana alt bileşen özeti
- dikkat edilmesi gereken parçalar
- eksik property veya belirsiz adlandırmalar
- montaj/erişim/bakım riski olabilecek noktalar

### Senaryo 2 — “Checklist ön kontrolü yap”

Kullanıcı der ki:

> Bu modeli şirket standardına göre hızlıca tara.

Copilot çıktısı:

- eksik custom property listesi
- naming sorunları
- release öncesi tamamlanması gereken maddeler
- düşük/orta/yüksek önem dereceli bulgular

### Senaryo 3 — “Toplantı özeti üret”

Kullanıcı der ki:

> Bu tasarımı teknik olmayan bir proje yöneticisine anlatacak kısa özet çıkar.

Copilot çıktısı:

- sade dilde çözüm özeti
- kritik riskler
- karar verilmesi gereken başlıklar

Bu senaryo özellikle ürünün “anlatma / açıklama / iletişim” gücünü göstermek için değerli.

---

## 10. Ürün riski ve dikkat edilmesi gereken noktalar

### Risk 1: Yanlış domain eşleşmesi

Mimarlık use-case’i konuşulurken sadece SolidWorks’e sıkışmak ürün yönünü daraltabilir.

**Azaltma:**

- PoC’yi SolidWorks ile başlat
- fakat dokümantasyon ve mimariyi host-agnostic kurgula

### Risk 2: Fazla erken otomasyon

Write-capability erken eklenirse güven sorunu doğabilir.

**Azaltma:**

- önce explain/review/check
- sonra recommendation
- en son approval-gated action

### Risk 3: LLM halüsinasyonu

Model bilmediği şeyi biliyormuş gibi anlatabilir.

**Azaltma:**

- her iddianın mümkünse kaynak veri/evidence ile gelmesi
- “emin değilim / veri eksik” cevabının desteklenmesi
- deterministic rule engine ile LLM yorumunun ayrılması

### Risk 4: API entegrasyon maliyeti

Host uygulama entegrasyonu zaman alabilir.

**Azaltma:**

- ilk PoC’de minimal veri sözleşmesi çıkar
- önce export/JSON tabanlı demo gerekirse düşün
- sonra canlı entegrasyonu derinleştir

---

## 11. Neden bence en doğru ilk yön bu?

Şu anda senin bağlamında en mantıklı yön şu kombinasyon:

- gerçek iş aracı: **SolidWorks**
- üst seviye pazar dili: **CAD/BIM/Design Review Copilot**
- ilk kabiliyet: **read-only açıklama + review + checklist**
- mimari: **plugin/add-in + local Windows executor + Ceviz orchestrator + rules layer**

Bu kombinasyon üç şeyi aynı anda başarıyor:

- şirketin mevcut aracına temas ediyor
- mimarlık/teknik tasarım tarafına genişlemeye açık kalıyor
- teknik olarak kontrollü ve gerçekçi bir başlangıç sunuyor

---

## 12. Bundan sonra önerdiğim sıradaki işler

Bu dokümandan sonra bence şu sıra mantıklı:

### Seçenek A — Product Requirements / PoC Scope dokümanı

Bir sonraki dokümanda şunları netleştirebilirim:

- hedef kullanıcı personası
- ilk kullanıcı hikâyeleri
- PoC scope / out-of-scope
- demo senaryosu
- başarı kriterleri

### Seçenek B — Teknik mimari dokümanı

Bunda şunları çıkarırım:

- SolidWorks add-in ile executor veri akışı
- JSON contracts
- command surface
- güvenlik / approval kapıları
- local deployment modeli

### Seçenek C — Uygulama backlog’u

Bunu istersen doğrudan sprint-benzeri görev listesine dönüştürürüm:

- Phase 1: discovery + contracts
- Phase 2: SolidWorks data extraction spike
- Phase 3: reasoning/report layer
- Phase 4: chat UI / side panel
- Phase 5: guarded actions

---

## 13. Benim net önerim

Bugün için doğru başlangıç buydu: önce yönü netleştiren bu discovery dokümanı.

Bir sonraki adım olarak ise ben **Seçenek A + B birleşimi** öneririm:

1. önce kısa ama net bir **PoC scope / PRD**
2. hemen ardından ona bağlı **teknik mimari dokümanı**

Böylece “ne yapıyoruz?” ve “nasıl yapıyoruz?” birlikte netleşir.

---

## Kısa karar özeti

Eğer bu dokümandan tek sayfalık karar çıkaracaksak:

- başlangıç aracı: **SolidWorks**
- ürün konumu: **CAD/BIM design review copilot**
- ilk özellik: **read-only model/assembly açıklama + risk/checklist analizi**
- write işlemleri: **sonraki faz, approval-gated**
- teknik mimari: **add-in/plugin + Windows executor + Ceviz orchestrator + rules layer**

Bu bence hem ticari olarak anlatılabilir hem de teknik olarak gerçekçi ilk yön.
