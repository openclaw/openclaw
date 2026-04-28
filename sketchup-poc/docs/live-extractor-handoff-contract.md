# Live Extractor Handoff Contract

## Amaç

Bu doküman, bridge katmanının ürettiği `live-handoff-plan` sonucunu bir sonraki gerçek live extractor fazı için çalıştırılabilir contract boundary'ye çevirir.

Bu doküman **canlı extractor'ın çalıştığını iddia etmez**. Sadece bridge ile gelecekteki live extractor arasındaki net request/response/artifact yüzeyini tanımlar.

## Contract dosyaları

- request:
  - `contracts/live-extractor-request.schema.json`
- response:
  - `contracts/live-extractor-response.schema.json`
- output artifact:
  - `contracts/live-extraction-output-artifact.schema.json`
- bootstrap status artifact:
  - `contracts/live-bootstrap-status-artifact.schema.json`
- snapshot payload:
  - `contracts/model-snapshot.schema.json`

## Bridge -> live extractor sınırı

`extract-model-snapshot` bridge action'ı canlı document hint'i bulursa artık sadece serbest metin plan dönmez.

Bunun yerine `output.result.liveExtractionPlan` içinde:

- hangi schema'ların kullanılacağı
- örneklenmiş gerçek bir `extractorRequest`
- beklenen artifact path'leri
- explicit failure mode listesi
- canlı yol için dürüst strategy notes

yer alır.

## Beklenen akış

1. Bridge probe-first çalışır.
2. Gerçek probe bir live document hint'i bulursa `execution.resultKind=live-handoff-plan` döner.
3. `result.liveExtractionPlan.extractorRequest` nesnesi future live extractor'a verilecek giriş contract'ıdır.
4. Live extractor boundary artık request'i tüketebilir ve bootstrap-ack lane'inde gerçek SketchUp-side acknowledgment deneyebilir.
5. True live extractor geldiğinde aynı request contract'ı üstünden:
   - `live-extractor-response.schema.json` uyumlu response yazar
   - `live-extraction-output-artifact.schema.json` uyumlu output artifact yazar
   - `model-snapshot.schema.json` uyumlu snapshot üretir
6. Orchestrator snapshot validation ve summary katmanını mevcut yapıyla sürdürebilir.

## Live vs mock ayrımı

- Bridge live probe:
  - gerçek Windows host inspection
- Bridge live handoff:
  - gerçek probe'dan türetilen plan
- Mock fallback:
  - mevcut sample/mock extractor
- Bootstrap ack output:
  - ancak gerçek SketchUp-side Ruby startup yüklenirse `bootstrap-status` artifact'ı canlı olarak oluşur
- Future live extractor output:
  - ancak gerçek SketchUp-side bootstrap uygulanırsa `sourceKind=live`

Bridge response içindeki `liveVsMock` alanı bu ayrımı makine-okunur taşır.

## Request contract özeti

Live extractor request şu çekirdek bölümleri taşır:

- `target`
  - probe'dan gelen SketchUp exe/process/document hint'leri
- `artifacts`
  - response, output artifact ve snapshot hedef path'leri
- `strategy`
  - muhtemel canlı yol; başlangıçta dürüst varsayılan `ruby-startup-open-document`
- `probeContext`
  - handoff'un hangi gerçek probe sonucundan türediği

## Response contract özeti

Future live extractor response şu durumları açıkça ayırır:

- `succeeded-live`
- `succeeded-live-model-access`
- `succeeded-bootstrap-ack`
- `failed-live`
- `failed-preflight`
- `failed-not-implemented`

Mevcut executable boundary şu sınırda kalır:

- request'i gerçekten okur
- `artifacts.responseArtifactPath` hedefine contract-shaped response yazar
- `artifacts.outputArtifactPath` hedefine execution/output artifact manifest'i yazar
- bootstrap actionable ise gelecekteki SketchUp-side yol için Ruby/bootstrap artifact bundle'ı materyalize eder
- true extraction öncesinde explicit bootstrap/readiness preflight çalıştırır
- Windows host üzerinde gerçek `SketchUp.exe -RubyStartup ...` launch yapabiliyorsa bootstrap ack için bunu gerçekten dener
- `bootstrap-status` artifact'ı belirlenen timeout içinde gelirse bunu response/output içine taşır
- Ruby bootstrap `Sketchup.active_model` handle'ına erişebilirse bunu `liveModelAccess` proof objesi olarak response/output/bootstrap-status içine taşır
- bootstrap aday yolu yapısal olarak uygunsa ama implementasyon yoksa dürüst biçimde `executionState=failed-not-implemented` döner
- request/strategy/artifact/environment katmanlarından biri bloklanmışsa `executionState=failed-preflight` döner
- snapshot üretmez

Error nesneleri ayrıca explicit code + stage + retryable bilgisi taşır.

Öne çıkan error code'lar:

- `request-incomplete`
- `unsupported-action`
- `unsupported-strategy`
- `artifact-path-not-ready`
- `environment-not-ready`
- `bootstrap-path-blocked`
- `live-extraction-not-implemented`
- `sketchup-not-installed`
- `document-open-failed`
- `ruby-bootstrap-timeout`
- `snapshot-schema-invalid`

## Bootstrap preflight/readiness layer

Live extractor response artık `preflight` alanı taşır. Bu alan true extraction başlamadan önceki dürüst readiness durumunu makine-okunur özetler.

`preflight` şunları içerir:

- `status`
  - `ready`, `blocked`, `unsupported`
  - burada `ready`, bootstrap ack lane'inin çalıştırılabilir olduğunu; `trueLiveExtractionReady=false` ise snapshot traversal'ın hâlâ hazır olmadığını belirtir
- `bootstrapActionable`
  - request/strategy/artifact/environment önkoşulları bootstrap adayı için yeterli mi
- `trueLiveExtractionReady`
  - gerçek implementasyon + önkoşullar birlikte hazır mı
- `selectedStrategyKey`
  - seçilen canlı stratejinin anahtarı
- `summary`
  - kaç check pass/warn/fail oldu
- `checks`
  - her check için `key`, `category`, `status`, `code`, `message`, `details`
- `blockerCodes`
  - aggregate blocker listesi
- `unsupportedReasons`
  - açıkça desteklenmeyen request/strategy sebepleri

Mevcut stub şu check kategorilerini gerçekten değerlendirir:

- `request`
  - contract alanları, `readOnly=true`, temel request bütünlüğü
- `strategy`
  - seçilen live strategy kombinasyonu mevcut bootstrap fazında destekleniyor mu
- `artifacts`
  - response/output/snapshot path'leri present mi, absolute mı, parent readiness nasıl
- `environment`
  - Windows host, executable hint, document detect/path sinyali yeterli mi
- `bootstrap`
  - yukarıdaki önkoşullar sağlansa bile gerçek Ruby bootstrap/traversal entrypoint implement edildi mi

Bu ayrımın amacı:

- `live-extraction-not-implemented` durumunu request hatalarıyla karıştırmamak
- bridge handoff planının gerçekten çalıştırılabilir olup olmadığını açıkça göstermek
- bir sonraki gerçek faz için hangi blocker'ların kaldığını makine-okunur bırakmak

## Bootstrap artifact boundary

Yeni adımda stub, `preflight.bootstrapActionable=true` ise gerçek launch yapmadan aşağıdaki artifact'leri üretir:

- bootstrap manifest JSON
- Ruby bootstrap script stub
- Ruby bootstrap context JSON

Bu artifact'ler response ve output artifact içinde `bootstrap` alanı altında referanslanır.

Bu katman şunları netleştirir:

- seçilen strategy'nin gerçek launch/invocation şekli
- `SketchUp.exe -RubyStartup ...` çağrısı için beklenen argüman dizisi
- Ruby tarafına geçecek context verisinin şekli
- Ruby tarafının extractor'a geri bırakacağı ilk machine-readable ack/status artifact'inin şekli
- gelecekte gerçek traversal kodunun nereye oturacağı

Bu katman şunları yapmaz:

- çalışan instance'a attach olmak
- canlı snapshot üretmek

## Bootstrap status / ack boundary

Bootstrap artifact shaping'den sonraki en yakın gerçek sınır, SketchUp içinde yüklenen Ruby bootstrap kodunun extractor tarafına machine-readable bir "başladım" sinyali bırakmasıdır.

Yeni `live-bootstrap-status-artifact` contract'ı bu sınırı tanımlar:

- Ruby bootstrap script yüklenirse hangi request/action için çalıştığını yazar
- hangi context/script/snapshot/response path'leriyle başlatıldığını taşır
- `stage` / `status` alanlarıyla startup ack, ilerleme veya failure sinyali bırakabilir
- `liveVsMock` alanı ile yalnızca bootstrap ack üretildiğini, traversal/snapshot'ın hâlâ yapılmadığını açıkça söyler

Mevcut PoC'de:

- live extractor stub bu artifact için path materyalize eder
- generated Ruby stub bu artifact'i yazabilecek şekilde hazırlanır
- Windows + SketchUp runtime erişilebilirse live extractor bu Ruby script'i gerçekten `SketchUp.exe -RubyStartup` ile çalıştırmayı dener
- dolayısıyla bootstrap status artifact'i artık sadece teorik boundary değil, uygun hostta gerçek ack veya minimal live model access artifact'ı olarak gözlenebilir
- buna rağmen artifact yalnızca startup ack anlamına gelir; traversal/snapshot hâlâ yoktur

## Minimal live model access proof

Bootstrap Ruby stub artık `Sketchup.active_model` erişimini denemek zorundadır. Başarılı olursa `liveModelAccess` alanında şunları bırakır:

- `activeModelAccessible`
- `modelTitle`
- `modelPath`
- `modelGuid`
- `requestedDocumentMatched`
- hafif collection erişim/count sinyalleri (`rootEntityCount`, `selectionCount`, `sceneCount`)

Aynı proof'tan türetilen ayrı bir `liveModelHeader` nesnesi de response/output/bootstrap-status zincirinde taşınabilir:

- `modelTitle`
- `modelPath`
- `modelGuid`
- `requestedDocumentMatched`
- `stats`
  - `entityCount`
  - `sceneCount`
  - `selectionCount`
- `sourceKind=bootstrap-live-model-access`

Bu proof:

- gerçek SketchUp Ruby runtime içinden gelir
- model handle erişimini gösterir
- entity traversal, geometry export veya rich snapshot anlamına gelmez

Bu küçük metadata yüzeyi:

- `liveModelAccess` içindeki collection accessibility/count sinyallerinden türetilen hafif count alanlarını header seviyesinde toplar
- live snapshot veya entity traversal yerine geçmez
- downstream katmanların "canlı model erişimi var ama traversal yok" durumunu tek bir read-only yüzeyden işlemesini sağlar

## Diagnostic-backed safe query proof slice

A7 ile aynı bootstrap/live proof zincirine tek bir küçük `safeQueryProof` yüzeyi eklenebilir:

- `queryKind=model-bounds-summary`
- `sourceKind=bootstrap-live-safe-query`
- `readOnly=true`
- `available`
- `value`
  - `width`
  - `height`
  - `depth`
  - `diagonal`
- `unavailableReason`

Bu slice bilinçli olarak dar tutulur:

- `Sketchup.active_model.bounds` üstünden tekil model-level okuma yapar
- selection detayına veya entity traversal'a girmez
- full snapshot veya root traversal varmış gibi yeni runtime iddiası kurmaz

Inspect lane'i bu alanı iki şekilde kullanır:

- proof varsa header/diagnostic ile uyumlu küçük query sonucunu gösterir
- proof yoksa bunu `process-metadata-only`, `bootstrap-ack-without-live-query-proof`, `no-live-model-proof` gibi dürüst unavailable reason ile raporlar

## Header inspect command

Bu fazda yeni bir traversal lane'i eklenmez. Bunun yerine mevcut `liveModelHeader` ve `liveMetadata` yuzeyi okunabilir hale getirilir.

Kucuk inspect/demo slice'i:

- `scripts/inspect_live_model_header.py`
  - bridge output, bridge response sample, live extractor response veya output artifact okur
  - `liveModelHeader` varsa onu, yoksa mevcut `liveMetadata` sinyalini normalize eder
  - mevcut `liveProbe`, `execution`, `bootstrapAck`, `liveModelAccess` ve `liveExtractionPlan` alanlarindan hafif bir `diagnosticSummary` turetir
  - bu ozet yalnizca mevcut kanitlari aciklar: dogru dokuman eslesmesi kanitli mi, canli model access proof'u var mi, cikti sadece process metadata mi, bootstrap ack var ama snapshot yok mu
  - text veya JSON formatinda inspect raporu verir
- `scripts/run_sketchup_bridge_demo.py --inspect-live-model-header`
  - bridge stdout JSON'unu bozmadan ek inspect ozeti basar
- `scripts/run_sketchup_bridge_demo.py --inspect-bridge-consumer`
  - bridge stdout JSON'u ustunde `diagnosticSummary + safeQueryProof` contract-aware consumer slice'ini validate edip basar
- `scripts/run_live_extractor_stub.py --inspect-live-model-header`
  - response artifact uzerinden ayni inspect ozetini basar

Ornek request/response ciftleri:

- request:
  - `samples/bridge-payloads/extract-model-snapshot.header-inspect.json`
- response:
  - `samples/bridge-responses/extract-model-snapshot.header-inspect.sample.json`
  - `samples/live-extractor/live-extractor-response.bootstrap-ack.sample.json`
- `samples/inspect/extract-model-snapshot.header-diagnostic-summary.sample.txt`
  - `samples/inspect/extract-model-snapshot.bridge-consumer.sample.txt`
  - `samples/inspect/get-minimal-live-metadata.bridge-consumer.sample.txt`

Bu inspect lane'i yalnizca mevcut header/metadata yuzeyini gorunur kilmak icindir:

- entity traversal yapmaz
- snapshot varmis gibi davranmaz
- bootstrap-ack ve live-handoff semantigini degistirmez

Bridge consumer validation slice ise bunun da daha dar bir alt-kumesidir:

- inspect summary uretildikten sonra `diagnosticSummary` ve `safeQueryProof` alanlarini validate eder
- downstream bridge consumer'in bu iki alanla nasil karar verecegini gorunur kilar
- proof yoksa unavailable reason'i oldugu gibi tasir
- yine traversal veya snapshot iddiasi kurmaz

`diagnosticSummary` katmani ozellikle su ayrimlari tek yerde toplar:

- `document`
  - request edilen dokuman path'i ile gozetlenen model/path hint'i ayni mi, yoksa sadece aday dokuman mi var
- `liveAccess`
  - `proved-active-model-access`, `bootstrap-ack-only`, `process-metadata-only`, `no-live-evidence`
- `bootstrap`
  - ack goruldu mu, hangi stage/path uzerinden
- `snapshot`
  - snapshot artifact'i var mi, yoksa acikca yok mu
- `handoff`
  - yalnizca hazirlik plani mi var

## Output artifact shape

Canlı extractor'ın ana response'u dışında ikinci bir output artifact manifest'i beklenir. Bu manifest:

- execution state'i
- preflight özetini
- varsa bootstrap plan özetini ve artifact referanslarını
- snapshot gerçekten yazıldıysa snapshot path/kind/schema referansını
- validation durumunu
- mevcutsa özet stats'leri

taşır.

Bu sayede orchestrator sadece ham snapshot path'ine değil, extraction hiç başlamamış olsa bile extractor sonucu hakkında kısa provenance/preflight özetine de sahip olur.

## Muhtemel dürüst canlı yol

Bu PoC için en gerçekçi bir sonraki adım:

1. SketchUp'ı kontrollü bir Ruby startup/bootstrap yolu ile açmak
2. İlk milestone olarak Ruby tarafının machine-readable `bootstrap-status` ack artifact'ını yazdığını doğrulamak
3. İstenen `.skp` dokümanını açmak
4. Ruby tarafında model traversal yapıp `model-snapshot.schema.json` uyumlu JSON üretmek
5. Snapshot'ı validate edip response + output artifact dosyalarını yazmak

Henüz yapılmamış kısımlar:

- Ruby bootstrap implementation
- SketchUp-side entity traversal
- canlı snapshot yazımı
- snapshot validation'ın extractor içine bağlanması

## Sample artifacts

- bridge handoff response:
  - `samples/bridge-responses/extract-model-snapshot.live-handoff-plan.json`
- live extractor request sample:
  - `samples/live-extractor/live-extractor-request.from-bridge-handoff.json`
- live extractor response sample:
  - `samples/live-extractor/live-extractor-response.not-implemented.json`
  - `samples/live-extractor/live-extractor-response.bootstrap-ack.sample.json`
- live output artifact sample:
  - `samples/live-extractor/live-extraction-output.sample.json`
  - `samples/live-extractor/live-extraction-output.bootstrap-ack.sample.json`
- bootstrap plan/context/script samples:
  - `samples/live-extractor/sketchup-poc-action-demo124.bootstrap-plan.sample.json`
  - `samples/live-extractor/sketchup-poc-action-demo124.bootstrap-context.sample.json`
  - `samples/live-extractor/sketchup-poc-action-demo124.bootstrap.sample.rb`
  - `samples/live-extractor/sketchup-poc-action-demo124.bootstrap-status.sample.json`

## Executable stub

PowerShell entrypoint:

- `windows/extractor/sketchup-live-extractor.ps1`

WSL helper:

- `scripts/run_live_extractor_stub.py`

Bu adımın amacı, bridge'in ürettiği `extractorRequest` nesnesinin artık yalnızca dokümantasyon örneği değil, gerçekten tüketilebilen bir contract olduğunu kanıtlamaktır.

Bu adımın sınırı:

- request -> response artifact -> output artifact zinciri gerçektir
- bootstrap-actionable durumda request -> bootstrap manifest/context/Ruby stub zinciri de gerçektir
- bootstrap-actionable durumda gelecekteki Ruby-side ack için `bootstrap-status` artifact boundary de explicit hale gelir
- response içeriği artık explicit bootstrap/readiness preflight sonucu taşır
- output artifact şu anda preflight/execution manifest'i düzeyindedir; varsa bootstrap plan özetini de taşır
- true live extraction, Ruby bootstrap ve snapshot üretimi henüz yoktur
