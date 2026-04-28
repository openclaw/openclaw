# CAD/BIM Copilot – Teknik Mimari Taslağı

## 1. Amaç

Bu doküman, SolidWorks ile başlanacak CAD/BIM Design Review Copilot için önerilen ilk teknik mimariyi tanımlar.

Bu mimarinin amacı:

- host uygulama bağlamını güvenilir şekilde okumak
- yerel Windows entegrasyonunu kontrollü tutmak
- LLM/orchestrator katmanını host uygulamadan ayrıştırmak
- ilk PoC için hızlı ama ölçeklenebilir bir yapı kurmak
- gelecekte başka host uygulamalara genişlemeye açık kalmak

Bu taslak özellikle **read-only PoC** hedefi için hazırlanmıştır.

---

## 2. Mimari özeti

Önerilen mimari 5 ana katmandan oluşur:

1. **Host Integration Layer**
   - SolidWorks add-in / local plugin / automation surface
   - aktif doküman, seçim, metadata, assembly ilişkileri gibi verileri toplar

2. **Local Windows Executor Layer**
   - Windows üzerinde çalışan kontrollü uygulayıcı katman
   - host API çağrılarını yapar
   - veri çıkarır
   - komutları güvenli bir yüzey üzerinden kabul eder

3. **Context Contract Layer**
   - host’tan gelen veriyi ortak bir JSON sözleşmesine dönüştürür
   - orchestrator’un uygulamaya özel detaylara bağımlı olmasını azaltır

4. **Ceviz Orchestrator / Reasoning Layer**
   - kullanıcı niyetini yorumlar
   - gerekli veriyi ister
   - veri + prompt + kurallar üzerinden cevap üretir

5. **Rules / Policy Layer**
   - checklist kuralları
   - naming/metadata gereksinimleri
   - approval guardrail’leri
   - risk ve belirsizlik davranışı

---

## 3. Tasarım ilkeleri

### 3.1 Host uygulama ile LLM ayrık olmalı

LLM doğrudan SolidWorks API’sine bağlı bir plugin içinde yaşamamalı.

**Neden?**

- hata ayıklama zorlaşır
- güvenlik ve kontrol azalır
- başka host uygulamalara genişleme zorlaşır
- reasoning katmanı gereksiz şekilde host bağımlı olur

Bu yüzden host uygulama entegrasyonu ile reasoning katmanı ayrılmalıdır.

### 3.2 Ortak veri sözleşmesi kullanılmalı

SolidWorks’ten gelen veri doğrudan “ham API objeleri” olarak üst katmana taşınmamalı.

Arada normalize edilmiş bir sözleşme olmalı:

- document context
- selection context
- metadata context
- assembly tree summary
- diagnostics/evidence

### 3.3 İlk PoC read-only kalmalı

İlk fazda executor yalnızca güvenli okuma komutlarını desteklemelidir.

Örnek:

- aktif dokümanı getir
- seçimi getir
- custom properties getir
- assembly özetini getir
- rule check için gerekli bağlamı çıkar

Ama desteklememeli:

- model değiştir
- property güncelle
- geometri oluştur/sil

### 3.4 Deterministic katman ile LLM ayrılmalı

Rule/checklist değerlendirmeleri mümkün olduğunca deterministik tutulmalı.

Önerilen ayrım:

- executor / rule layer → veri toplama + sabit kural kontrolleri
- orchestrator / LLM → açıklama, özetleme, öneri, doğal dil arayüzü

Bu sayede “AI her şeyi karar veriyor” yerine daha güvenli bir yapı oluşur.

---

## 4. Katmanlar ve sorumluluklar

## 4.1 Host Integration Layer

### Görev

SolidWorks içinden bağlam çıkarmak.

### Olası teknik biçimler

- SolidWorks add-in
- .NET tabanlı COM entegrasyonu
- lokal automation bridge
- gerekiyorsa başlangıçta daha basit bir macro/prototype yüzeyi

### Sorumluluklar

- aktif dokümanı tanımlamak
- part/assembly/drawing türünü belirlemek
- seçili öğeyi tespit etmek
- custom property bilgilerini çekmek
- erişilebilen temel yapı/komponent özetini toplamak
- bağlamı executor’a iletmek veya executor tarafından çekilebilir hale getirmek

### Bu katman ne yapmamalı?

- yoğun reasoning
- karmaşık prompt kurma
- ürün mantığını UI event’lerine gömme
- uzun iş akışlarını tek başına yönetme

---

## 4.2 Local Windows Executor Layer

### Görev

Windows üzerinde çalışan kontrollü entegrasyon ve komut yürütme katmanı olmak.

### Bu katman neden gerekli?

Çünkü:

- SolidWorks Windows-native bir uygulama
- yerel API/COM erişimi gerekir
- host ile konuşan kodun güvenilir ve izole yönetilmesi gerekir
- orchestrator katmanının her host ayrıntısını bilmesi iyi bir mimari olmaz

### Sorumluluklar

- tanımlı komut setini kabul etmek
- host uygulama durumuna erişmek
- bağlam verisini toplamak
- JSON contract üretmek
- hataları normalize etmek
- ileride write yetenekleri gelirse approval boundary olmak

### Executor komut yüzeyi – PoC için örnek

- `get_active_document`
- `get_selection_context`
- `get_custom_properties`
- `get_assembly_summary`
- `run_checklist_scan`
- `ping`
- `capabilities`

### Executor tasarım tercihi

PoC için en mantıklı yaklaşım:

- küçük, kontrollü, komut bazlı bir Windows servis/worker
- JSON giriş / JSON çıkış
- iyi loglama
- açıkça version’lanan command contract

Bu, önceki Windows bridge çalışmalarınla da uyumlu.

---

## 4.3 Context Contract Layer

### Görev

Host verisini ürünün ortak diline çevirmek.

Bu katman kritik çünkü:

- LLM’in düzgün çalışması için structured context gerekir
- gelecekte Revit/AutoCAD/Rhino eklenirse üst katmanı korumak isteriz
- prompt’a ham, dağınık, tool-spesifik veri vermek yerine normalize edilmiş veri vermek daha iyi sonuç üretir

### Önerilen sözleşme bileşenleri

#### A. DocumentContext

- documentId
- fileName
- filePath
- documentType
- configurationName
- units
- lastModified
- activeView gibi erişilebilen temel alanlar

#### B. SelectionContext

- selectionExists
- selectedEntityType
- selectedEntityName
- selectedCount
- selectedProperties

#### C. MetadataContext

- customProperties
- missingRequiredProperties
- emptyProperties
- namingObservations

#### D. AssemblyContext

- isAssembly
- topLevelComponentCount
- componentSummary
- hierarchyDepthEstimate
- repeatedParts
- suppressed/lightweight gibi erişilebilen özet durumlar

#### E. DiagnosticsContext

- extractionWarnings
- unavailableFields
- confidenceHints

#### F. ChecklistResult

- passedChecks
- failedChecks
- warnings
- evidence
- severity

---

## 4.4 Ceviz Orchestrator / Reasoning Layer

### Görev

Kullanıcı niyetini işleyip doğru veri akışını kurmak ve son cevabı üretmek.

### Sorumluluklar

- kullanıcı isteğini sınıflandırmak
- hangi host verisinin gerektiğine karar vermek
- executor’dan doğru komutları çağırmak
- rule sonuçları ile bağlamsal açıklamayı birleştirmek
- kullanıcı tipine uygun çıktı üretmek
- belirsizlikleri açıkça belirtmek

### Örnek niyet sınıfları

- modeli açıkla
- seçili öğeyi açıkla
- hızlı review yap
- checklist tara
- yönetici özeti çıkar
- eksik verileri söyle

### Çıktı üretim ilkeleri

Ceviz şu yapıda cevap üretmeli:

- kısa cevap
- ana bulgular
- dikkat noktaları
- eksik/veri yetersiz alanlar
- önerilen sonraki adımlar

### Bu katman ne yapmamalı?

- doğrudan host API detaylarını bilmeye çalışmamalı
- ham tool cevaplarıyla kullanıcıya konuşmamalı
- veri yoksa sallamamalı

---

## 4.5 Rules / Policy Layer

### Görev

Deterministik kontrolleri ve güvenlik davranışını yönetmek.

### PoC için kapsayabileceği alanlar

- zorunlu metadata alanları
- naming convention kontrolleri
- boş/eksik field tespiti
- role-specific çıktı sınırları
- uncertainty davranışı

### Gelecek fazlarda

- write aksiyon approval’ları
- organization-specific rule packs
- audit trail
- aksiyon policy’leri

---

## 5. Veri akışı

## 5.1 Soru-cevap akışı

1. Kullanıcı chat/panel üzerinden soru sorar.
2. Orchestrator niyeti anlar.
3. Gerekli veri tiplerini belirler.
4. Executor’dan ilgili bağlam çağrılır.
5. Context contract oluşturulur.
6. Gerekirse rules layer checklist/validation çalıştırır.
7. Orchestrator structured context üzerinden yanıt üretir.
8. UI katmanına sonuç döner.

### Örnek

Kullanıcı: “Bu assembly’de dikkat edilmesi gereken noktalar ne?”

Muhtemel akış:

- `get_active_document`
- `get_assembly_summary`
- `get_custom_properties`
- opsiyonel `run_checklist_scan`
- reasoning + answer composition

---

## 5.2 Checklist akışı

1. Kullanıcı checklist taraması ister.
2. Orchestrator ilgili rule profile’ı seçer.
3. Executor bağlamı toplar.
4. Rules layer deterministic kontrolleri uygular.
5. Sonuç LLM ile insan-dostu rapora çevrilir.

Bu akışta kritik ilke:

- “check geçti/kaldı” kararlarını mümkün olduğunca deterministic katman vermeli
- LLM bu sonucu açıklamalı ve özetlemeli

---

## 6. Bileşenler arası iletişim modeli

PoC için en mantıklı iletişim modeli:

- JSON request / response
- local process veya local IPC tabanlı iletişim
- version’lanan command envelope

### Örnek command envelope

```json
{
  "command": "get_active_document",
  "requestId": "req-123",
  "timestamp": "2026-03-31T19:00:00Z",
  "payload": {}
}
```

### Örnek response envelope

```json
{
  "requestId": "req-123",
  "ok": true,
  "data": {
    "documentType": "assembly",
    "fileName": "MainAssembly.SLDASM"
  },
  "warnings": []
}
```

---

## 7. Önerilen veri modeli

Aşağıdaki ortak model üst katman için yeterli iyi bir başlangıç olabilir.

```json
{
  "document": {
    "id": "doc-001",
    "name": "MainAssembly.SLDASM",
    "path": "C:/Projects/MainAssembly.SLDASM",
    "type": "assembly",
    "configuration": "Default"
  },
  "selection": {
    "exists": true,
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
    "components": [
      { "name": "Bracket_A", "count": 2 },
      { "name": "Housing_1", "count": 1 }
    ]
  },
  "diagnostics": {
    "warnings": [],
    "confidenceHints": ["Geometry detail not included in this scan"]
  }
}
```

Bu veri modeli sonraki host’lar için de adapte edilebilir.

---

## 8. UI / deneyim katmanı

PoC için UI tarafında üç olası yaklaşım var:

### Seçenek A — Basit chat panel

Artıları:

- en hızlı PoC
- doğal dil deneyimi güçlü
- demo için iyi

Eksileri:

- bulguların yapılandırılmış gösterimi sınırlı olabilir

### Seçenek B — Side panel + structured cards

Artıları:

- checklist, warning, summary gibi alanlar temiz gösterilir
- kullanıcı güveni artar

Eksileri:

- daha fazla UI işi gerekir

### Seçenek C — Hibrit

- üstte chat
- altta bulgu kartları / evidence / checklist blokları

**Benim önerim:**
PoC için hibrit veya en azından chat + structured response yaklaşımı.

---

## 9. Hata yönetimi ve belirsizlik tasarımı

Bu ürün için hata yönetimi kritik.

### Executor hata sınıfları

- host not running
- no active document
- unsupported document type
- selection unavailable
- extraction partial
- permission/integration failure

### Kullanıcıya yansıtma ilkesi

Sistem teknik hatayı mümkün olduğunca anlaşılır dile çevirmeli.

Örnek:

- “SolidWorks açık değil.”
- “Aktif doküman bulunamadı.”
- “Bu taramada assembly hiyerarşisinin yalnızca bir kısmı okunabildi.”

### Belirsizlik zorunluluğu

Eğer veri eksikse cevapta mutlaka görünmeli:

- ne okunabildi
- ne okunamadı
- hangi çıkarımın sınırlı güvenle yapıldığı

Bu, güven için şart.

---

## 10. Gözlemlenebilirlik / loglama

PoC olsa bile aşağıdaki loglar tutulmalı:

- command request/response logları
- executor hata logları
- extraction süreleri
- hangi context alanlarının dolu/boş olduğu
- kullanıcı prompt sınıfı

Neden önemli?

- kalite iyileştirme
- debugging
- prompt tuning
- sözleşme evrimi

---

## 11. Güvenlik ve kontrol

İlk PoC read-only olsa da güvenlik mantığı baştan doğru kurulmalı.

### İlkeler

- executor yalnızca izinli komutları çalıştırmalı
- komut yüzeyi küçük olmalı
- ham shell/serbest kod yürütme olmamalı
- host uygulama işlemleri command contract üzerinden yürümeli
- write komutları gelecekte gelse bile ayrı capability/approval ile açılmalı

### Neden bu önemli?

Çünkü ürün ileride write aksiyonlara genişleyecekse boundary baştan doğru kurulmalı.

---

## 12. Dağıtım yaklaşımı

Önceki Windows bridge yönünle uyumlu olacak şekilde PoC için mantıklı dağıtım modeli:

- Windows tarafında local executor
- gerekiyorsa host uygulama ile aynı makinede add-in/plugin
- Ceviz orchestrator mevcut yapıyla konuşur
- aradaki veri JSON contract ile taşınır

Bu modelin avantajı:

- laptop/başka makineye paketlenebilir mimari oluşturur
- host-native entegrasyon korunur
- reasoning katmanı ayrık kalır

---

## 13. Geleceğe dönük genişleme stratejisi

Bu mimari yalnızca SolidWorks için değil, ileride diğer host’lara da açılabilir.

### Host-agnostic çekirdek

Ortak soyutlama şu olabilir:

- `DocumentProvider`
- `SelectionProvider`
- `MetadataProvider`
- `StructureProvider`
- `RuleEvaluator`

SolidWorks ilk adapter olur.
Daha sonra:

- Revit adapter
- AutoCAD adapter
- Rhino adapter
- IFC reader adapter

Böylece ürün dili korunur, entegrasyon katmanları değişir.

---

## 14. PoC için önerilen ilk teknik backlog

### Phase 1 — Command surface & contracts

- executor komut setini tanımla
- request/response envelope belirle
- ortak context schema oluştur

### Phase 2 — SolidWorks data extraction spike

- aktif doküman okuma
- custom properties okuma
- seçim bağlamı okuma
- temel assembly özeti çıkarma

### Phase 3 — Rule/checklist engine (minimal)

- required property checks
- naming checks
- missing/empty field detection

### Phase 4 — Orchestrator response composition

- niyet sınıflandırma
- structured prompt input
- summary / checklist / stakeholder summary formatları

### Phase 5 — Demo UI

- chat panel veya minimal side panel
- structured response rendering

### Phase 6 — Reliability pass

- hata mesajları
- uncertainty reporting
- logging

---

## 15. MVP veri sözleşmesi için minimum alanlar

İlk spike’ta bence aşağıdaki minimum alanlar yeterli:

- document type
- file name/path
- selected item summary
- custom properties dictionary
- missing required properties
- top-level component names/counts
- extraction warnings

Bu minimum set bile ilk demo için güçlü olabilir.

---

## 16. Açık teknik kararlar

Henüz netleştirilmesi gerekenler:

- executor bir servis mi olacak, talep bazlı worker mı?
- host ile iletişim add-in üzerinden mi, dış automation üzerinden mi başlayacak?
- ilk UI host içine mi gömülecek, dış chat penceresi mi olacak?
- rule set statik JSON mu olacak, kod mu olacak?
- evidence alanı ne kadar detaylı tutulacak?

---

## 17. Net mimari öneri

Bu PoC için en doğru teknik yön bence şu:

> **SolidWorks add-in veya minimal host integration katmanı** bağlamı çıkarır,
> **local Windows executor** bu bağlamı kontrollü komut yüzeyiyle servis eder,
> **Ceviz orchestrator** structured context’i yorumlayıp kullanıcıya açıklama/checklist/review çıktısı verir,
> **rules layer** ise deterministic kontrolleri yürütür.

Bu mimari:

- bugüne kadar oluşturduğun Windows bridge yönüyle uyumlu
- read-only PoC için güvenli
- genişlemeye açık
- demo üretmeye uygun

---

## 18. Sonraki en mantıklı adım

Bu dokümandan sonra bence yapılması gereken tek bir şey seçilecekse o da şudur:

### SolidWorks Data Extraction Spike Planı

Çünkü mimarinin en kritik belirsizliği burada:

- hangi veriyi gerçekten alabiliyoruz?
- hangi formatta alıyoruz?
- ilk demo için ne kadar veri yeterli?

Dolayısıyla sonraki çalışma olarak şu belgeyi üretmek mantıklı:

- `solidworks-data-extraction-spike-plan.md`

Bu belgede şunları çıkarabiliriz:

- keşfedilecek API yüzeyleri
- okunacak veri alanları
- ilk prototip komutları
- başarı ölçütleri
- riskler ve fallback planı
