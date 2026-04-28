# SolidWorks Data Extraction Spike Planı

## 1. Amaç

Bu planın amacı, CAD/BIM Design Review Copilot PoC’si için SolidWorks tarafında ilk teknik keşfi kontrollü şekilde yapmaktır.

Buradaki temel soru şudur:

> İlk PoC için ihtiyaç duyduğumuz minimum bağlamı SolidWorks’ten güvenilir biçimde çıkarabiliyor muyuz?

Bu spike’ın hedefi tam ürün geliştirmek değil; aşağıdakileri netleştirmektir:

- hangi verilere erişebiliyoruz
- bu verileri hangi yüzeyden alacağız
- ilk PoC için minimum işe yarar veri sözleşmesi ne olacak
- entegrasyon maliyeti ve riskleri neler
- fallback yaklaşımımız ne olmalı

---

## 2. Spike kapsamı

Bu spike yalnızca **read-only context extraction** üzerine odaklanır.

### Spike içinde

- aktif doküman bağlamını okuma
- doküman türünü belirleme
- temel dosya bilgilerini alma
- custom property bilgilerini çıkarma
- seçili öğe bağlamını okuma
- assembly ise temel component summary üretme
- extraction çıktısını JSON sözleşmesine map etme

### Spike dışında

- model değiştirme
- custom property yazma
- geometri düzenleme
- üretim seviyesi kalite/doğrulama
- UI polish
- tam rule engine
- tam ürünleşmiş add-in deneyimi

---

## 3. Spike’ın cevaplaması gereken sorular

### Teknik sorular

1. SolidWorks açıkken aktif doküman bilgisine ne kadar güvenilir şekilde erişebiliyoruz?
2. Part / assembly / drawing ayrımını net alabiliyor muyuz?
3. Dosya adı, yol, configuration gibi temel alanlara erişim kolay mı?
4. Custom properties okunabiliyor mu?
5. Seçili öğe bağlamı alınabiliyor mu?
6. Assembly için top-level component listesi alınabiliyor mu?
7. Hiyerarşi derinliği veya en azından özet çıkarabiliyor muyuz?
8. Bu veri JSON formatında normalize edilip dış katmana verilebiliyor mu?
9. SolidWorks API erişimi için en uygun ilk yüzey ne: add-in mi, automation mı, macro/prototype mi?
10. Kısmi veri durumunda sistem bunu düzgün işaretleyebiliyor mu?

### Ürün soruları

1. İlk demo için minimum hangi veri seti yeterli?
2. Hangi veri alanları yüksek değer üretir?
3. Hangi alanlar ilk aşamada gereksiz karmaşıklık ekler?
4. Mimari olarak host integration ile executor ayrımını korumak pratikte mümkün mü?

---

## 4. Spike başarı kriteri

Spike başarılı sayılmalıysa aşağıdakiler yapılabilmeli:

### Başarı kriterleri

- aktif doküman bağlamı programatik olarak okunabiliyor olmalı
- doküman türü güvenilir biçimde alınabiliyor olmalı
- en azından bazı custom properties okunabiliyor olmalı
- selection context veya selection yok bilgisi alınabiliyor olmalı
- assembly için top-level component summary çıkarılabiliyor olmalı
- çıktı ortak JSON sözleşmesine dönüştürülebiliyor olmalı
- başarısız veya eksik alanlar açıkça raporlanabiliyor olmalı

### Demo açısından minimum başarı

Aşağıdaki gibi bir JSON üretebiliyorsak spike faydalıdır:

- document info
- metadata/custom properties
- selection summary
- component summary
- extraction warnings

---

## 5. Önerilen yaklaşım

Bu spike’ı tek adımda “nihai çözüm” gibi yapmak yerine katmanlı ilerlemek daha doğru.

### Faz 1 — Erişilebilirlik doğrulaması

Amaç:

- SolidWorks API yüzeyine temel erişim doğrulansın
- aktif doküman, belge türü, dosya adı gibi en basit alanlar alınsın

### Faz 2 — Metadata extraction

Amaç:

- custom properties alınsın
- gerekli alanların eksik/boş olması tespit edilsin

### Faz 3 — Selection extraction

Amaç:

- kullanıcı bir öğe seçtiğinde bunun bağlamı okunabilsin
- seçim yoksa da bu durum açık dönsün

### Faz 4 — Assembly summary extraction

Amaç:

- top-level component count/list alınsın
- ilk seviyede anlamlı bir özet çıkarılsın

### Faz 5 — JSON contract mapping

Amaç:

- tüm çıktılar ortak veri sözleşmesine dönüştürülsün
- diagnostics/warnings alanı eklensin

---

## 6. Keşfedilecek veri yüzeyleri

İlk PoC için bence aşağıdaki veri yüzeyleri öncelikli.

### 6.1 Document context

Hedef alanlar:

- document type
- file name
- file path
- title
- active configuration
- save state / dirty state mümkünse
- units mümkünse

### 6.2 Metadata context

Hedef alanlar:

- custom properties dictionary
- boş property’ler
- eksik olması gereken zorunlu alanlar
- property kaynak kapsamı (document/configuration) mümkünse

### 6.3 Selection context

Hedef alanlar:

- selection exists
- selected count
- selected entity type
- selected entity name/label
- selection’a bağlı okunabilir bazı özellikler

### 6.4 Assembly context

Hedef alanlar:

- isAssembly
- top-level component count
- top-level component names
- tekrar eden parça sayısı gibi özetler
- suppressed / lightweight benzeri durumlar mümkünse

### 6.5 Diagnostics context

Hedef alanlar:

- extractionWarnings
- unsupportedFields
- partialRead flags
- confidence hints

---

## 7. Minimum veri sözleşmesi

İlk spike için önerdiğim minimum çıktı sözleşmesi:

```json
{
  "document": {
    "name": "MainAssembly.SLDASM",
    "path": "C:/Projects/MainAssembly.SLDASM",
    "type": "assembly",
    "configuration": "Default"
  },
  "selection": {
    "exists": true,
    "count": 1,
    "entityType": "component",
    "name": "Bracket_A"
  },
  "metadata": {
    "customProperties": {
      "PartNumber": "BRK-001",
      "Material": "Aluminum"
    },
    "missingRequired": ["Description"],
    "emptyFields": []
  },
  "assembly": {
    "topLevelComponentCount": 12,
    "topLevelComponents": ["Bracket_A", "Housing_1", "FastenerPack"]
  },
  "diagnostics": {
    "warnings": [],
    "partialRead": false
  }
}
```

Bu sözleşme ilk demo için yeterince bilgi taşır ve üst katmanda reasoning için iyi başlangıç sağlar.

---

## 8. Önerilen prototip komutları

Spike sürecinde Windows executor veya test harness üzerinden aşağıdaki komutları denemek mantıklı olur:

- `ping`
- `capabilities`
- `get_active_document`
- `get_document_metadata`
- `get_selection_context`
- `get_assembly_summary`
- `extract_poc_context`

Burada özellikle `extract_poc_context` önemli bir adaydır.
Çünkü üst katmanın çok fazla küçük çağrı yapmak yerine ilk PoC’de tek bir toplu bağlam çağrısı alması daha pratik olabilir.

### İki olası yaklaşım

#### Yaklaşım A — İnce taneli komutlar

Artıları:

- daha modüler
- test etmesi kolay
- hangi çağrının bozulduğunu anlamak kolay

Eksileri:

- orchestration daha karmaşık
- daha fazla round-trip

#### Yaklaşım B — Toplu bağlam çıkarımı

Artıları:

- demo için hızlı
- tek çağrıda yeterli context
- üst katman sadeleşir

Eksileri:

- hata ayırımı biraz zorlaşabilir

### Önerim

Spike’ta ikisini de düşün ama ilk demoda ağırlıklı olarak:

- altta ince taneli extraction
- üstte `extract_poc_context` gibi toplu bir endpoint

---

## 9. Teknik yürütme seçenekleri

Bu spike için üç muhtemel teknik başlangıç yolu var.

### Seçenek 1 — Minimal automation prototype

SolidWorks’e dışarıdan daha basit bir automation yüzeyi ile bağlanmak.

**Artıları:**

- hızlı keşif
- düşük başlangıç maliyeti

**Eksileri:**

- nihai ürün yapısına tam denk düşmeyebilir
- bazı bağlamlar sınırlı olabilir

### Seçenek 2 — Minimal add-in prototype

Küçük bir add-in ile bağlam çıkarımı yapmak.

**Artıları:**

- ürün mimarisine daha yakın
- host event/context erişimi daha doğal olabilir

**Eksileri:**

- başlangıç kurulum maliyeti daha yüksek
- demo öncesi ekstra entegrasyon işi çıkarabilir

### Seçenek 3 — Hibrit

İlk denemede en hızlı erişim yüzeyiyle doğrulama yapıp,
sonra kalıcı yüzeyi add-in tarafına oturtmak.

**Benim önerim:**

- spike için **hibrit düşünmek**
- ama elde edilen veriyi en baştan ortak contract’a oturtmak

---

## 10. Deney planı

### Deney 1 — SolidWorks aktif doküman erişimi

Amaç:

- host açıkken aktif doküman okunabiliyor mu?

Beklenen çıktı:

- name
- path
- type
- configuration

Başarısızlık durumunda not:

- host bağlantı yüzeyi veya initialization sorunu olabilir

### Deney 2 — Custom properties extraction

Amaç:

- property set okunabiliyor mu?

Beklenen çıktı:

- key/value listesi
- boş property tespiti

Başarısızlık durumunda not:

- scope ayrımı veya property erişim modeli yeniden incelenmeli

### Deney 3 — Selection context extraction

Amaç:

- kullanıcı seçimi bağlama taşınabiliyor mu?

Beklenen çıktı:

- selection exists
- entity type
- entity label/name

Başarısızlık durumunda not:

- event veya current selection erişimi araştırılmalı

### Deney 4 — Assembly summary extraction

Amaç:

- top-level component özeti alınabiliyor mu?

Beklenen çıktı:

- count
- isim listesi
- mümkünse tekrar eden component özeti

Başarısızlık durumunda not:

- traversal stratejisi değiştirilmeli veya ilk PoC için kapsam daraltılmalı

### Deney 5 — Unified JSON context

Amaç:

- yukarıdaki veriler tek contract’ta normalize edilebiliyor mu?

Beklenen çıktı:

- geçerli JSON artifact
- diagnostics alanı dolu

---

## 11. Artifact üretimi

Spike sonunda aşağıdaki artifact’lerin oluşması faydalı olur:

- örnek başarılı JSON çıktı
- eksik/partial data örnek çıktısı
- desteklenmeyen alanlar listesi
- command contract taslağı
- minimal checklist input örneği
- teknik notlar / risk notları

### Özellikle gerekli çıktı

En az 3 örnek context artifact faydalı olur:

1. part dosyası için
2. assembly dosyası için
3. selection varken bir örnek için

Bu örnekler sonraki prompt engineering ve orchestrator işini ciddi kolaylaştırır.

---

## 12. Riskler ve fallback planı

### Risk 1 — API yüzeyi beklenenden zor olabilir

**Fallback:**

- önce daha dar veri yüzeyiyle ilerle
- yalnızca document + metadata + basit assembly summary ile ilk demo yap

### Risk 2 — Selection bağlamı kararsız olabilir

**Fallback:**

- ilk PoC’de selection-based use-case’i zorunlu tutma
- document-level summary ile başla

### Risk 3 — Assembly traversal maliyetli olabilir

**Fallback:**

- sadece top-level summary al
- derin traversal sonraki faza bırak

### Risk 4 — Add-in başlangıcı yavaşlatabilir

**Fallback:**

- ilk doğrulamayı daha hafif automation yüzeyiyle yap
- contract ve executor mantığını bozmadan add-in’e sonra geç

### Risk 5 — Veri reasoning için yetersiz kalabilir

**Fallback:**

- output’ları daha çok metadata/checklist odaklı kurgula
- geometry-semantics iddiasını ilk PoC’de sınırlı tut

---

## 13. Çıkış kararı kriteri

Bu spike sonunda üç olası karar çıkmalı:

### Karar A — Devam

Eğer minimum bağlam güvenilir şekilde okunabiliyorsa:

- executor contract kesinleştirilir
- implementation backlog’a geçilir

### Karar B — Daraltılmış PoC

Eğer bazı alanlar zor ama temel veri alınabiliyorsa:

- PoC yalnızca document + metadata + top-level summary ile daraltılır

### Karar C — Entegrasyon stratejisini değiştir

Eğer erişim yüzeyi ciddi sorun çıkarıyorsa:

- add-in vs automation tercihi yeniden değerlendirilir
- gerekirse önce export-based ara akış düşünülür

---

## 14. Tahmini çıktı: PoC için en değerli minimum set

Bence ilk PoC için en yüksek değer / en düşük risk veri seti şu:

- aktif doküman adı ve tipi
- custom properties
- eksik zorunlu property listesi
- top-level component count ve isim özeti
- selection varsa kısa bağlam
- extraction warnings

Bu set, şu üç use-case’i taşımak için yeterli olabilir:

- “Bu modeli bana açıkla”
- “Checklist ön kontrolü yap”
- “Bunu kısa özetle”

---

## 15. Spike sonrası önerilen sonraki adımlar

Spike başarılı olursa hemen şu sırayla ilerlenmeli:

1. `solidworks-context-contract-v1.json` taslağı
2. `windows-executor-command-surface.md`
3. minimal extraction prototype
4. örnek prompt pack
5. implementation backlog

---

## 16. Net öneri

Bu spike için benim net önerim şu:

> Önce SolidWorks’ten **minimum işe yarar bağlamı** çıkar,
> bunu **tek bir ortak JSON contract** içinde normalize et,
> sonra orchestrator tarafında bu verinin gerçekten iyi açıklama/checklist çıktısı üretip üretmediğini test et.

Burada başarının anahtarı “olabildiğince çok veri çekmek” değil,
**ilk PoC için gerçekten işe yarayan en küçük veri yüzeyini bulmak**.

---

## 17. Kısa karar özeti

Bu spike planına göre:

- hedef: **read-only context extraction feasibility**
- öncelik: **document + metadata + selection + top-level assembly summary**
- çıktı: **JSON contract artifact’leri**
- yaklaşım: **hibrit keşif, kontrollü executor surface, minimum işe yarar context**
- başarı ölçütü: PoC’nin 3 temel use-case’ini taşıyacak kadar veriyi güvenilir şekilde çıkarabilmek
