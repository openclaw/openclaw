# SketchUp-first Read-Only Presentation PoC

Bu klasör, SketchUp-first read-only presentation PoC için minimal ama çalıştırılabilir mock/demo pipeline içerir. Bu geçiş fazında PoC, workspace'teki mevcut Windows bridge queue/request-response mimarisine bağlanır.

## Amaç

- SketchUp modelinden güvenli/read-only snapshot almak
- Snapshot'ı normalize JSON olarak dışa vermek
- Ceviz tarafında bu snapshot'tan özet ve yorum üretmek
- İlk fazda hiçbir model değişikliği yapmamak

## Kapsam

İlk PoC şu akışı hedefler:

1. WSL tarafı mevcut bridge wrapper ile request enqueue eder
2. Windows helper mevcut allowlist/queue runner üzerinden SketchUp handler'ını çağırır
3. Handler probe-first davranır
4. Gerçek probe bir canlı document hint'i bulursa varsayılan olarak explicit `live-handoff-plan` sonucu üretir
5. İstenirse aynı handoff request'i canlı extractor'a verilerek gerçek SketchUp-side `bootstrap-status` ack artifact'ı denenebilir
6. Canlı extraction hedefi yoksa explicit mock fallback ile `model-snapshot.json` üretilir
7. Bootstrap ack lane'i çalıştırılırsa Ruby tarafı en azından `Sketchup.active_model` erişimini machine-readable artifact ile kanıtlayabilir
8. Orchestrator mock snapshot varsa bunu okuyup markdown summary üretir

## Demo akışı

Bu repo şu anda doğrulanmış tam canlı SketchUp extraction yapmaz. Ama aşağıdaki probe-first ve bridge-oriented akış uçtan uca tanımlanmıştır:

1. Extractor request JSON alır ve response JSON + snapshot JSON üretir
2. Snapshot schema checker ile doğrulanır
3. Snapshot'tan markdown summary üretilir
4. Live handoff request'i artık executable bir stub ile tüketilip gerçek response artifact'ına çevrilebilir

Linux/WSL veya PowerShell'de validator/summary:

```bash
python3 scripts/validate_model_snapshot.py
python3 scripts/generate_summary.py --input samples/sample-model-snapshot.json --output samples/out/sample-summary.generated.md
```

PowerShell ile extractor demo:

```powershell
pwsh -File .\windows\extractor\sketchup-extractor.ps1 `
  -CommandPath .\samples\commands\ping-sketchup.json `
  -OutputPath .\samples\out\ping-response.json

pwsh -File .\windows\extractor\sketchup-extractor.ps1 `
  -CommandPath .\samples\commands\get-extraction-capabilities.json `
  -OutputPath .\samples\out\capabilities-response.json

pwsh -File .\windows\extractor\sketchup-extractor.ps1 `
  -CommandPath .\samples\commands\extract-model-snapshot.json `
  -OutputPath .\samples\out\extract-model-response.json

python3 scripts/validate_model_snapshot.py --input samples/out/model-snapshot.json
python3 scripts/generate_summary.py --input samples/out/model-snapshot.json --output samples/out/model-summary.md
```

Live handoff stub demo:

```powershell
pwsh -File .\windows\extractor\sketchup-live-extractor.ps1 `
  -RequestPath .\samples\live-extractor\live-extractor-request.from-bridge-handoff.json
```

veya WSL'den:

```bash
python3 sketchup-poc/scripts/run_live_extractor_stub.py
```

Bridge üzerinden canlı bootstrap ack denemesi:

```bash
python3 sketchup-poc/scripts/run_sketchup_bridge_demo.py extract-model-snapshot \
  --live-extractor-mode execute-bootstrap-ack \
  --timeout-seconds 180
```

Bridge header inspect demo:

```bash
python3 sketchup-poc/scripts/run_sketchup_bridge_demo.py extract-model-snapshot \
  --payload-file sketchup-poc/samples/bridge-payloads/extract-model-snapshot.header-inspect.json \
  --inspect-live-model-header \
  --timeout-seconds 180
```

Bridge consumer validation demo:

```bash
python3 sketchup-poc/scripts/run_sketchup_bridge_demo.py extract-model-snapshot \
  --payload-file sketchup-poc/samples/bridge-payloads/extract-model-snapshot.header-inspect.json \
  --inspect-bridge-consumer \
  --timeout-seconds 180
```

Kaydedilmis response/sample uzerinden header inspect:

```bash
python3 sketchup-poc/scripts/inspect_live_model_header.py \
  sketchup-poc/samples/bridge-responses/extract-model-snapshot.header-inspect.sample.json
```

Kaydedilmis response/sample uzerinden bridge consumer surface:

```bash
python3 sketchup-poc/scripts/inspect_live_model_header.py \
  sketchup-poc/samples/bridge-responses/extract-model-snapshot.header-inspect.sample.json \
  --consumer-surface \
  --validate
```

Selection snapshot demo:

```powershell
pwsh -File .\windows\extractor\sketchup-extractor.ps1 `
  -CommandPath .\samples\commands\extract-selection-snapshot.json `
  -OutputPath .\samples\out\extract-selection-response.json
```

Bridge-oriented demo:

```bash
python3 sketchup-poc/scripts/run_sketchup_bridge_demo.py sketchup-ping
python3 sketchup-poc/scripts/run_sketchup_bridge_demo.py get-minimal-live-metadata
python3 sketchup-poc/scripts/run_sketchup_bridge_demo.py extract-model-snapshot
python3 sketchup-poc/scripts/run_sketchup_bridge_demo.py sketchup-ping --probe-mode probe-first
```

Detaylar için:

- `docs/bridge-integration-phase.md`

## Notlar

- `sketchup-ping` gerçek Windows host probe sonucu döndürmeye çalışır; metadata varsa response içine ekler ama bu sadece installation/process/document hint seviyesindedir ve live automation yaptığını iddia etmez.
- `get-minimal-live-metadata` aynı gerçek probe tabanından dürüst minimal metadata sinyallerini ayrı action olarak döndürür.
- `extract-model-snapshot` artık canlı document hint'i bulunduğunda mock snapshot'a zorla düşmek yerine `live-handoff-plan` sonucu döndürür; bu, bir sonraki gerçek extractor fazına verilecek hedef/komut taslağıdır.
- `live-handoff-plan` artık sadece yönlendirici not değil; future live extractor için request/response/output artifact contract referansları ve örnek request nesnesi taşır.
- Bu contract artık yalnızca örnek dosya değil; `windows/extractor/sketchup-live-extractor.ps1` ile executable boundary olarak tüketilebilir.
- Live extractor artık true extraction öncesinde explicit bootstrap/readiness preflight çalıştırır, bunu response artifact'ında `preflight` alanı ile raporlar ve ayrıca execution/output artifact manifest'i yazabilir.
- Bootstrap actionable request'lerde live extractor stub artık gelecekteki SketchUp-side yol için Ruby script/context/manifest artifact bundle'ı da üretir.
- Bu bootstrap bundle artık future Ruby-side startup ack için explicit `bootstrap-status` artifact path'ini de taşır.
- Windows + SketchUp runtime gerçekten erişilebilirse aynı extractor artık `SketchUp.exe -RubyStartup ...` çağrısı yapıp gerçek `bootstrap-status` ack artifact'ını bekler.
- Ruby bootstrap `Sketchup.active_model` nesnesine erişebilirse bu durum `succeeded-live-model-access` state'i ile raporlanır; bu hâlâ canlı traversal veya snapshot extraction iddiası değildir.
- `succeeded-live-model-access` durumunda extractor/bridge artık compact bir `liveModelHeader` nesnesi de taşır (`modelTitle`, `modelPath`, `modelGuid`, `requestedDocumentMatched`, `stats`).
- Sadece ack görülür ama model handle proof taşınmazsa state `succeeded-bootstrap-ack` olarak kalır.
- `succeeded-live-model-access` durumunda extractor output/response artık yalnızca A2 proof objesini değil, aynı proof'tan türetilen hafif top-level stats (`entityCount`, `sceneCount`, `selectionCount`) alanını da taşır.
- `liveModelHeader`, aynı canlı proof'un header seviyesindeki alanlarını ve hafif count özetini `liveModelAccess` detaylarından ayırır; bu yine traversal değildir.
- Bu stats alanı canlı traversal sonucu değildir; yalnızca `Sketchup.active_model` üstünden collection count okumalarının promotion edilmiş halidir.
- A7 ile aynı proof zinciri artık tek bir küçük `safeQueryProof` da taşıyabilir: `active_model.bounds` üstünden width/height/depth/diagonal okuması. Bu, canlı model erişimini küçük bir read-only query sonucu ile gösterir; traversal veya full snapshot iddiası değildir.
- `scripts/inspect_live_model_header.py`, bridge/live extractor artifact'lerinden bu küçük yüzeyi okunabilir text veya normalized JSON olarak ayıklar.
- A6 ile aynı inspect komutu artık hafif bir `diagnosticSummary` da üretir: doğru doküman eşleşmesi kanıtlı mı, canlı model erişim proof'u var mı, çıktı sadece process metadata mı, bootstrap ack var ama snapshot yok mu gibi soruları mevcut alanlardan türetir.
- Aynı inspect çıktısı `safeQueryProof` yoksa bunu da dürüstçe neden unavailable olduğunu belirterek raporlar (`process-metadata-only`, `bootstrap-ack-without-live-query-proof`, `no-live-model-proof` gibi).
- A10 bridge consumer slice'i, bu inspect contract'ini validate edip sadece `diagnosticSummary + safeQueryProof` yüzeyini tüketen ayrı bir consumer görünümü sunar; proof varsa bunu kullanır, yoksa `unavailableReason` alanını olduğu gibi raporlar.
- `run_sketchup_bridge_demo.py --inspect-live-model-header` ve `run_live_extractor_stub.py --inspect-live-model-header`, mevcut contract akışını değiştirmeden inspect/demo çıktısı üretir.
- `run_sketchup_bridge_demo.py --inspect-bridge-consumer` aynı bridge stdout'u üstünde consumer-facing validation slice çalıştırır.
- `samples/inspect/extract-model-snapshot.header-diagnostic-summary.sample.txt`, bootstrap ack + live model access örneği üstünden text inspect çıktısının nasıl göründüğünü gösterir.
- `samples/inspect/extract-model-snapshot.bridge-consumer.sample.txt` ve `samples/inspect/get-minimal-live-metadata.bridge-consumer.sample.txt`, bridge consumer slice'inin `available` ve `unavailable` durumlarını gösterir.
- `ping-sketchup` extractor seviyesinde hâlâ mock contract komutudur.
- Snapshot içerikleri `samples/sample-model-snapshot.json` dosyasından seed edilir.
- Amaç, gerçek entegrasyona geçmeden önce contract, bridge reuse ve orchestration akışını netleştirmektir.

## Probe durumları

Bridge handler `liveProbe.status` alanında aşağıdaki makine-okunur durumları döndürür:

- `unavailable`
  - SketchUp executable keşfedilemedi ve çalışan process bulunamadı.
- `available-no-process`
  - SketchUp launchable görünüyor ama çalışan process yok.
- `process-running-no-document`
  - SketchUp process'i var ama aktif model/document yalnızca process metadata ile dürüstçe tespit edilemedi.
- `process-running-document-detected`
  - SketchUp process'i var ve command line veya window title üzerinden bir document hint'i görüldü.

`execution.probeResultKind=real` gerçek Windows host probe'un çalıştığını belirtir.

`execution.metadataResultKind` alanı:

- `real-minimal-metadata`
  - gerçek process/install metadata'dan app/document/model hint'leri üretildi
- `real-probe-no-metadata`
  - probe gerçekti ama dürüstçe anlamlı metadata çıkarılamadı
- `none`
  - probe skip edildi

`execution.snapshotResultKind=mock-fallback` ise snapshot sonucunun hâlâ sample/mock olduğunu açıkça belirtir.

`execution.snapshotResultKind=live-handoff-plan` ise bridge'in gerçek probe verisinden canlı extractor için bir sonraki adımı hazırladığını, fakat henüz snapshot üretmediğini belirtir.

`execution.extractorContractKind=sketchup-live-extractor-request` ise bridge response'un artık future live extractor için explicit request contract boundary taşıdığını belirtir.

## Live extractor contract boundary

Yeni contract katmanı:

- `contracts/live-extractor-request.schema.json`
- `contracts/live-extractor-response.schema.json`
- `contracts/live-extraction-output-artifact.schema.json`
- `contracts/live-bootstrap-status-artifact.schema.json`
- `docs/live-extractor-handoff-contract.md`

Bu katman, mevcut bridge `live-handoff-plan` sonucunu gelecekteki gerçek extractor için çalıştırılabilir request/response yüzeyine çevirir.

Sample artefaktlar:

- `samples/live-extractor/live-extractor-request.from-bridge-handoff.json`
- `samples/live-extractor/live-extractor-response.not-implemented.json`
- `samples/live-extractor/live-extraction-output.sample.json`
- `samples/bridge-payloads/extract-model-snapshot.header-inspect.json`
- `samples/bridge-responses/extract-model-snapshot.header-inspect.sample.json`

Executable stub:

- `windows/extractor/sketchup-live-extractor.ps1`
- `scripts/run_live_extractor_stub.py`

Preflight/readiness katmanı şunları açıkça doğrular:

- request completeness
- strategy selection/support
- artifact path readiness
- environment readiness / unsupported reasons
- bootstrap aday yolunun actionable mı yoksa hâlâ blocked mı olduğu
- bootstrap actionable ise gerçek SketchUp-side boundary için hangi Ruby/bootstrap artifact'lerinin üretileceği
- bootstrap Ruby tarafının hangi machine-readable ack/status artifact'ını yazmasının beklendiği
- output artifact tarafında snapshot henüz yazılmasa bile extractor execution/preflight durumunun makine-okunur bırakılması
- bootstrap ack lane'i için launch + timeout + ack-wait katmanının gerçekten çalıştırılıp çalıştırılmadığı
- Ruby tarafının `Sketchup.active_model` handle'ına erişip erişmediği ve bunun hafif metadata/count proof'u

## İlk milestone'lar

- M1: contract + sample
- M2: executable live handoff stub
- M3: gerçek metadata + live handoff plan
- M4: gerçek SketchUp-side extractor entrypoint
- M5: entity traversal + selection snapshot
