# `get-active-document` Live Extraction Seam

Bu adım, mevcut queue/request/result iskeletini bozmadan `get-active-document` için ilk gerçek extraction sınırını ekler.

## İstek modları

`get-active-document` request payload içine isteğe bağlı `extractionMode` alanı verilebilir:

- `seeded`
  - varsayılan davranış
  - mevcut seeded probe döner
- `prefer-live`
  - önce canlı extractor denenir
  - extractor başarısız olursa seeded fallback döner
  - fallback nedeni `diagnostics.warnings` içine yazılır
- `live-only`
  - yalnızca canlı extractor denenir
  - başarısız olursa result envelope `status=failed` döner

## Canlı extractor sınırı

Canlı yol:

- handler: `windows-helper/handlers/get-active-document.ps1`
- shared routing: `windows-helper/handlers/shared.ps1`
- extractor: `windows-helper/extractors/get-active-document-live.ps1`

Bu extractor Windows üstünde çalışan bir SolidWorks COM host'una sadece attach olmaya çalışır:

- `Marshal.GetActiveObject('SldWorks.Application')`
- ardından `ActiveDoc`

Bu, gerçek entegrasyon yönünde dürüst bir ilk adımdır. SolidWorks process başlatma, model açma, metadata/selection/assembly extraction gibi daha geniş davranışlar bu adımda yoktur.

## Hata modeli

`live-only` modunda beklenen typed failure kodları:

- `host-platform-unsupported`
  - helper Windows dışında çalışıyor
- `solidworks-host-not-running`
  - SolidWorks COM host bulunamadı
- `solidworks-no-active-document`
  - SolidWorks açık ama aktif doküman yok
- `invalid-extraction-mode`
  - desteklenmeyen `extractionMode`

Runner artık bu kodları result envelope `error.code` alanına, ek bilgileri ise `error.details` alanına taşır.

## Örnek artifact'ler

- `artifacts/get-active-document-live-host-not-running.result.json`
- `artifacts/get-active-document-live-no-active-document.result.json`

Bu dosyalar gerçek host gerektirmeden beklenen failure envelope şeklini gösterir.
