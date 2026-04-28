# SketchUp + V-Ray Interior Presentation Agent

Bu klasör, mevcut CAD/BIM copilot iskeletini SolidWorks odaklı review akışından çıkarıp SketchUp + V-Ray ile daire içi sunum üretimi yönüne çeviren kısa doküman setini içerir.

## Amaç

İlk hedef:

- mevcut sahneyi read-only şekilde okumak
- daire içi sunum için eksik/riski yüksek noktaları işaretlemek
- kamera, sahne, materyal ve render hazırlığını hızlandırmak
- kısa ve uygulanabilir sunum çıktıları üretmek

## Okuma sırası

1. `docs/transition-map.md`
2. `docs/prd.md`
3. `docs/technical-architecture.md`
4. `docs/windows-executor-command-surface.md`
5. `docs/presentation-playbook.md`
6. `docs/orchestrator-delegation-playbook.md`

## Temel yön

- Genel Ceviz/harness/executor mimarisi korunur.
- SolidWorks'e özgü parça/assembly/drawing dili bırakılır.
- Yeni domain dili: scene/model/tag/material/camera/shot/render/export.
- İlk faz read-only analiz + sunum önerisi; otomatik sahne düzenleme daha sonra gelir.

## Implementasyona geçiş paketi

- `docs/scene-context-contract.md`: minimum veri modeli + örnek JSON
- `docs/backlog.md`: MVP backlog, spike'lar, done kriterleri
- `docs/adapter-spike-skeleton.md`: ilk adapter spike klasör önerisi

## İlk implementasyon iskeleti

- `contracts/scene-context-contract-v1.json`: scene context v1 JSON Schema
- `contracts/sketchup-bridge-request-envelope-v1.json`: helper request zarfı
- `contracts/sketchup-bridge-result-envelope-v1.json`: helper result zarfı
- `windows-helper/runner.ps1`: queue tabanlı allowlist runner taslağı
- `windows-helper/handlers/`: seeded handler katmanı
- `examples/extract-presentation-context/`: minimal request/response örnekleri

Not: Bu turda amaç canlı SketchUp/V-Ray bağlantısı değil, dokümanla uyumlu ve büyütülebilir bir çalışma iskeleti kurmaktır.
