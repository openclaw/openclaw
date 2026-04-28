# SketchUp PoC Bridge Integration Phase

## Amaç

Bu faz, `sketchup-poc` içindeki mock extractor akışını workspace'te zaten var olan Windows queue/request-response bridge modeline bağlar.

Yeni bir transport icat edilmedi. Aşağıdaki mevcut zincir korunur:

1. WSL tarafı request JSON üretir
2. `windows-bridge-bootstrap/queue/inbound/` altına enqueue eder
3. mevcut Windows runner allowlist edilmiş handler'ı çalıştırır
4. sonuç `queue/outbound/<requestId>.result.json` olarak döner

## Bu fazda eklenen SketchUp katmanı

- bridge request envelope şeması:
  - `contracts/bridge-request-envelope.schema.json`
- bridge response envelope şeması:
  - `contracts/bridge-response-envelope.schema.json`
- sketchup-specific action payload şeması:
  - `contracts/sketchup-action-payload.schema.json`
- Windows-side SketchUp handler:
  - `windows/bridge/handle-sketchup-bridge-request.ps1`
- WSL-side demo runner:
  - `scripts/run_sketchup_bridge_demo.py`

## Request layering

Mevcut bridge envelope değişmedi; SketchUp davranışı `payload` içine taşındı:

```json
{
  "requestId": "sketchup-poc-action-abc123",
  "kind": "sketchup-poc-action",
  "createdAtUtc": "2026-04-05T19:00:00Z",
  "status": "pending",
  "payload": {
    "action": "extract-model-snapshot",
    "probeMode": "probe-first",
    "fallbackMode": "mock-sample",
    "liveExtractorMode": "handoff-plan",
    "snapshotOutputPath": "C:\\OpenClaw\\SketchUpPoC\\model-snapshot.json",
    "responseArtifactPath": "C:\\OpenClaw\\SketchUpPoC\\extract-model-response.json",
    "options": {
      "documentName": "office-demo.skp"
    }
  }
}
```

## Probe-first davranış

Handler önce güvenli ve dürüst bir probe yapar:

- bilinen veya keşfedilebilir `SketchUp.exe` path'lerini kontrol eder
- `Get-Process SketchUp` ile çalışan process var mı bakar
- mümkünse process command line ve main window title üstünden aktif document hint'i arar
- canlı automation olmadığını ve probe'un sadece host metadata seviyesinde kaldığını response içinde açıkça yazar

Bu probe şunları **yapmaz**:

- açık SketchUp oturumuna attach olmak
- Ruby/COM/SDK otomasyonu sürmek
- model içeriğini canlı okumak

## Probe status contract

`output.liveProbe.status` alanı şu değerlerden birini üretir:

- `unavailable`
- `available-no-process`
- `process-running-no-document`
- `process-running-document-detected`

Ek makine-okunur alanlar:

- `output.liveProbe.source`
  - `windows-host-real` veya `skipped`
- `output.execution.probeResultKind`
  - `real` veya `none`
- `output.execution.metadataResultKind`
  - `real-minimal-metadata`, `real-probe-no-metadata` veya `none`
- `output.execution.snapshotResultKind`
  - `live-handoff-plan`, `mock-fallback` veya `none`
- `output.execution.resultKind`
  - `real-minimal-metadata`, `real-probe-no-metadata`, `live-handoff-plan`, `mock-fallback` veya `none`

Bu ayrım özellikle önemlidir:

- `sketchup-ping`
  - probe sonucu gerçek Windows host inspection'dan gelir
  - mümkünse minimal live metadata da döner
- `get-minimal-live-metadata`
  - metadata varsa bunu birinci sınıf sonuç olarak döner
  - metadata yoksa bunu açıkça `real-probe-no-metadata` diye işaretler
- `extract-model-snapshot`
  - probe kısmı gerçek olabilir
  - metadata kısmı gerçek olabilir
  - sonuç ya `live-handoff-plan` ya da `mock-fallback` olarak gelir

## Desteklenen action'lar

- `sketchup-ping`
  - bridge zincirinin ve probe-first mantığın çalıştığını gösterir
  - canlı automation varmış gibi davranmaz
- `get-minimal-live-metadata`
  - gerçek Windows host inspection üzerinden elde edilebilen dürüst minimal metadata sinyallerini döndürür
  - app/version hint, process running, active document name/path hint gibi alanlarla sınırlıdır
- `extract-model-snapshot`
  - önce probe yapar
  - gerçek probe bir document hint'i bulursa varsayılan olarak `live-handoff-plan` sonucu döner
  - `liveExtractorMode=execute-bootstrap-ack` verilirse aynı handoff request'i canlı extractor'a geçirip gerçek `bootstrap-status` ack artifact'ını denemeye çalışır
  - `succeeded-live-model-access` alınırsa bridge sonucu compact `liveModelHeader` yüzeyi taşır; bu yüzey model kimliği ile hafif count alanlarını birlikte toplar
  - canlı target bulunamazsa ve `fallbackMode=mock-sample` ise mevcut mock extractor'a düşer
  - hangi yolun seçildiği response içinde açıkça işaretlenir
  - varsa gerçek minimal live metadata ayrıca response içine eklenir

## Demo akışı

WSL tarafında:

```bash
python3 sketchup-poc/scripts/run_sketchup_bridge_demo.py sketchup-ping
python3 sketchup-poc/scripts/run_sketchup_bridge_demo.py get-minimal-live-metadata
python3 sketchup-poc/scripts/run_sketchup_bridge_demo.py extract-model-snapshot
python3 sketchup-poc/scripts/run_sketchup_bridge_demo.py extract-model-snapshot --live-extractor-mode execute-bootstrap-ack
python3 sketchup-poc/scripts/run_sketchup_bridge_demo.py extract-model-snapshot --inspect-bridge-consumer
python3 sketchup-poc/scripts/run_sketchup_bridge_demo.py sketchup-ping --payload-file sketchup-poc/samples/bridge-payloads/sketchup-ping.json
```

Bu komutlar doğrudan yeni bir queue sistemi kurmaz. Arkada mevcut bridge wrapper'ı kullanır:

- `windows-bridge-bootstrap/scripts/run-bridge-request.py`
- `windows-bridge-bootstrap/windows-helper/runner.ps1`

## Dürüstlük sınırı

Bu fazın sonucu:

- bridge-oriented request/response yolu SketchUp PoC için tanımlandı
- probe sonucu ayrı katman olarak ve makine-okunur status kategorileriyle döndürülüyor
- dürüst minimal live metadata sinyalleri ayrıca ayrıştırılıp makine-okunur dönüyor
- live extraction yoksa ya handoff-plan ya mock fallback net biçimde raporlanıyor
- opt-in modda live extractor gerçek SketchUp-side bootstrap acknowledgment artifact'ı deneyebiliyor
- bridge consumer tarafında `diagnosticSummary + safeQueryProof` yüzeyi validate edilip küçük bir contract-aware tüketim çıktısı üretilebiliyor

Bu fazın sonucu **değil**:

- gerçek SketchUp modeline attach olmuş extractor
- Ruby startup sonrası entity traversal veya plugin tabanlı live snapshot
- V-Ray metadata extraction

## Bridge consumer validation slice

Bu küçük A10 dilimi response envelope'u büyütmez; mevcut bridge stdout JSON'u üstünde dar bir consumer davranışı gösterir:

- `scripts/inspect_live_model_header.py --consumer-surface --validate`
  - önce inspect contract'ini validate eder
  - sonra sadece `diagnosticSummary` ve `safeQueryProof` alanlarını tüketen normalize consumer yüzeyi üretir
- `scripts/run_sketchup_bridge_demo.py --inspect-bridge-consumer`
  - canlı bridge çağrısı sonrası aynı consumer slice'i görünür kılar

Bu consumer slice:

- `safeQueryProof.available=true` ise küçük bounds proof'unu contract-aware okur
- proof yoksa `unavailableReason` alanını olduğu gibi raporlar
- traversal/full snapshot varmış gibi yeni bir iddia kurmaz

## Yeni ara faz: live handoff plan

Minimal live metadata'dan sonraki en dar ama yararlı adım, gerçek extraction yokken boş hata vermek yerine bir sonraki fazın girişini makine-okunur üretmektir.

`extract-model-snapshot` artık şu iki dürüst sonuçtan birini verir:

- `execution.resultKind=live-handoff-plan`
  - gerçek Windows probe'u bir canlı SketchUp document hint'i buldu
  - bridge `result.liveExtractionPlan` içine future live extractor için hedef, önerilen strateji ve gereksinimleri koydu
  - snapshot üretilmedi
- `execution.resultKind=mock-fallback`
  - canlı target hazır değildi
  - mevcut sample/mock snapshot yolu kullanıldı

Bu sayede sonraki gerçek adım nettir: `liveExtractionPlan.proposedLiveCommand` içindeki hedefi kullanıp gerçek Ruby/SketchUp-side extractor entrypoint'i yazmak.

Bu boundary artık daha explicit hale getirildi:

- `liveExtractionPlan.extractorContract`
  - hangi schema'ların tüketileceğini söyler
- `liveExtractionPlan.extractorRequest`
  - future live extractor için doğrudan verilebilecek request örneğidir
- `liveExtractionPlan.expectedArtifacts`
  - response/output/snapshot path hedeflerini belirtir
- `liveExtractionPlan.failureModes`
  - extractor'ın hangi explicit error state'leri üretmesi gerektiğini sınırlar

Detay:

- `docs/live-extractor-handoff-contract.md`
