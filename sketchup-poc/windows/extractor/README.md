# Windows Extractor

Bu klasör, SketchUp'tan read-only snapshot almak için Windows tarafında çalışacak extractor bileşeninin mock PoC halini içerir.

## Durum

- `sketchup-extractor.ps1` request JSON alır, response JSON yazar.
- `sketchup-live-extractor.ps1` yeni live handoff request contract'ını tüketen executable stub'dır.
- `sketchup-live-extractor.ps1` artık bootstrap ack lane'inde gerçek `SketchUp.exe -RubyStartup` launch + ack-wait denemesi de yapabilir.
- Bu extractor artık doğrudan çağrılabildiği gibi mevcut workspace Windows bridge handler'ı tarafından da fallback katmanı olarak kullanılabilir.
- Desteklenen komutlar:
  - `ping-sketchup`
  - `get-extraction-capabilities`
  - `extract-model-snapshot`
  - `extract-selection-snapshot`
- Mock/sample extractor hâlâ sample veri kullanır.
- Canlı extractor tarafında artık gerçek SketchUp-side `bootstrap-status` acknowledgment artifact'ı denenebilir.
- Canlı SketchUp entity traversal / snapshot extraction hâlâ yoktur.
- Future live extractor boundary için ayrı contract dosyaları eklendi:
  - `../../contracts/live-extractor-request.schema.json`
  - `../../contracts/live-extractor-response.schema.json`
  - `../../contracts/live-extraction-output-artifact.schema.json`
- Yeni stub, `live-extractor-request` alıp contract-shaped `live-extractor-response` artifact'ı gerçekten yazar.
- Response artık explicit `preflight` alanı taşır ve bootstrap/readiness durumunu machine-readable raporlar.
- Stub artık `outputArtifactPath` verilirse preflight-only output artifact manifest'i de gerçekten yazar.
- Bootstrap actionable ise stub ayrıca Ruby bootstrap script/context/manifest artifact bundle'ı da gerçekten yazar.
- Bootstrap bundle artık future Ruby-side startup ack için `bootstrap-status` artifact path'ini de taşır.
- Windows + SketchUp erişilebilirse stub bu bundle'ı gerçekten çalıştırıp `bootstrap-status` ack artifact'ını bekler.
- Ack ile birlikte Ruby tarafı `Sketchup.active_model` erişimini kanıtlarsa response dürüst biçimde `succeeded-live-model-access` döner.
- Bu durumda response/output/bootstrap-status ayrıca küçük bir `liveModelHeader` nesnesi taşır (`modelTitle`, `modelPath`, `modelGuid`, `requestedDocumentMatched`, `stats`).
- `succeeded-live-model-access` durumunda response/output artık proof'tan türetilmiş hafif `stats` alanını da taşır (`entityCount`, `sceneCount`, `selectionCount`).
- `liveModelHeader.stats` ve top-level `stats` traversal değildir; yalnızca `active_model` handle/count promotion'larıdır.
- Aynı proof zinciri artık küçük bir `safeQueryProof` da taşıyabilir; PoC bunu `active_model.bounds` üzerinden width/height/depth/diagonal olarak sınırlar.
- Sadece ack görülür, model handle proof'u gelmezse response `succeeded-bootstrap-ack` döner.
- Ack gelmez veya launch başarısız olursa response dürüst biçimde `failed-live` döner.
- Request/strategy/artifact/environment blokları varsa response `failed-preflight` döner.

## Bridge bağlantısı

Bridge-oriented çağrı akışında asıl entrypoint bu dosya değildir. Sıra şu şekildedir:

1. WSL tarafı `windows-bridge-bootstrap/scripts/run-bridge-request.py` ile request yollar
2. Windows runner `sketchup-poc-action` handler'ını çalıştırır
3. Handler probe-first davranır
4. Live extraction mümkün değilse bu extractor'a mock fallback için döner

Bridge katmanı ile ilgili detaylar:

- `../../docs/bridge-integration-phase.md`
- `../../docs/live-extractor-handoff-contract.md`

## Request / Response

Çalıştırma biçimi:

```powershell
pwsh -File .\windows\extractor\sketchup-extractor.ps1 `
  -CommandPath .\samples\commands\extract-model-snapshot.json `
  -OutputPath .\samples\out\extract-model-response.json
```

Temel request örneği:

```json
{
  "command": "extract-model-snapshot",
  "requestId": "req-20260405-001",
  "outputPath": "samples/out/model-snapshot.json",
  "options": {
    "documentName": "office-demo.skp",
    "documentPath": "C:\\Projects\\office-demo.skp"
  }
}
```

Live handoff stub çalıştırma biçimi:

```powershell
pwsh -File .\windows\extractor\sketchup-live-extractor.ps1 `
  -RequestPath .\samples\live-extractor\live-extractor-request.from-bridge-handoff.json
```

WSL helper:

```bash
python3 sketchup-poc/scripts/run_live_extractor_stub.py
python3 sketchup-poc/scripts/run_live_extractor_stub.py --inspect-live-model-header
python3 sketchup-poc/scripts/inspect_live_model_header.py \
  sketchup-poc/samples/live-extractor/live-extractor-response.bootstrap-ack.sample.json
```

Bu stub şunları yapar:

- `live-extractor-request` contract'ını okur
- request completeness / strategy support / artifact path readiness / environment readiness / bootstrap blocker check'lerini çalıştırır
- `artifacts.responseArtifactPath` hedefinde gerçek response dosyası yazar
- `artifacts.outputArtifactPath` hedefinde execution manifest'i yazar
- bootstrap actionable ise response artifact dizini altında Ruby bootstrap script/context/manifest dosyaları üretir
- bootstrap actionable ise generated Ruby stub'un yazacağı bootstrap status artifact path'ini de üretir
- Windows host üzerinde gerçek launch mümkünse `SketchUp.exe -RubyStartup ...` çağrısı yapar
- gerçek `bootstrap-status` artifact'ı için timeout ile bekler
- canlı ack görülürse bunu response/result/output artifact içine taşır
- Ruby tarafı `Sketchup.active_model` erişebilirse hafif live model access proof'unu da aynı artifact zincirine taşır
- aynı proof'tan türetilen compact `liveModelHeader` yüzeyini de artifact zincirine taşır
- aynı zincirde opsiyonel `safeQueryProof` ile küçük bir model-level read-only query sonucunu da taşıyabilir
- helper inspect lane'i bu mevcut header/metadata yuzeyini okunabilir text veya JSON ciktiya cevirir
- traversal/snapshot yolunun hâlâ eksik olduğunu explicit biçimde belirtir

Bu stub şunları yapmaz:

- mevcut çalışan SketchUp instance'ına güvenli attach/reuse yapmak
- model entity traversal veya selection traversal yapmak
- live snapshot üretmek

Temel response örneği:

```json
{
  "requestId": "req-20260405-001",
  "command": "extract-model-snapshot",
  "ok": true,
  "mode": "mock",
  "readOnly": true,
  "generatedAt": "2026-04-05T18:00:00Z",
  "warnings": [
    "Snapshot content is seeded from the sample file; no live SketchUp session was read."
  ],
  "errors": [],
  "result": {
    "snapshotPath": "samples/out/model-snapshot.json",
    "snapshotKind": "model",
    "stats": {
      "entityCount": 418,
      "sceneCount": 4,
      "selectionCount": 2,
      "durationMs": 12
    }
  }
}
```
