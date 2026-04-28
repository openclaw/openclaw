# Extraction Flow

## High-level flow

1. Kullanıcı `modeli tara` veya `refresh` ister
2. Ceviz mevcut Windows bridge request envelope üretir
3. Request `windows-bridge-bootstrap/queue/inbound/` altına düşer
4. Windows helper allowlist edilmiş SketchUp handler'ını çağırır
5. Handler probe-first çalışır
6. Uygunsa minimal live metadata sinyallerini response'a ekler
7. Canlı document hint'i varsa bridge `live-handoff-plan` sonucu üretir
8. Canlı target yoksa mock modda response JSON üretir
9. Snapshot komutlarında sample tabanlı JSON dosyası yazılır
10. Orchestrator snapshot'ı doğrular
11. Orchestrator snapshot'ı okuyup summary üretir
12. Kullanıcıya kısa rapor verilir

## V1 command list

- `ping-sketchup`
- `get-extraction-capabilities`
- `extract-model-snapshot`
- `extract-selection-snapshot`
- bridge action:
  - `sketchup-ping`
  - `get-minimal-live-metadata`
  - `extract-model-snapshot`

## V1 yaklaşımı

- Sadece manual trigger
- Read-only davranış zorunlu
- Snapshot üretimi tek ana çıktı
- Summary üretimi ayrı katman
- Mevcut bridge request/response mimarisi yeniden kullanılır
- Bu repo sürümünde true live snapshot extraction yoktur; extraction katmanı mock/sample tabanlıdır
- Buna rağmen bridge katmanı gerçek Windows host inspection'dan minimal metadata hint'leri döndürebilir
- Yeni ara fazda bridge, canlı document hint'i varsa snapshot yerine future live extractor için handoff planı döndürebilir
- Yeni contract katmanı ile bu handoff plan artık explicit live extractor request/response/artifact yüzeyi taşır
- Live extractor stub artık true extraction öncesinde bootstrap/readiness preflight çalıştırır; bootstrap actionable request'lerde Ruby/bootstrap artifact bundle'ı üretir; Ruby tarafında `Sketchup.active_model` erişim proof'u bırakabilir; gerçek traversal extractor ise hâlâ implement edilmemiştir
