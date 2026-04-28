# SolidWorks Live Extraction Bridge Plan

## Amaç

Mevcut çalışan Windows queue/helper pattern'ini kullanarak SolidWorks copilot klasörünü canlı extraction denemelerine hazırlamak.

## Mevcut durum

- contract-first iskelet var
- queue request/response yapısı var
- stub handler'lar var
- önceki bootstrap köprüsü Windows host üzerinde çalıştığını kanıtladı

## Hedef

Bu projede iki aşamalı ilerlemek:

### Aşama 1 — Seeded live transport

- SolidWorks copilot helper gerçekten Windows host üzerinde çalışsın
- handler çıktıları örnek/stub olsa bile canlı Windows lane üzerinden dönsün
- böylece transport, queue ve executor boundary doğrulansın

### Aşama 2 — Real SolidWorks extraction

- seeded probe yerine gerçek SolidWorks API çağrıları gelsin
- document/metadata/selection/assembly summary canlı okunsun

## Neden bu sıra?

Böylece iki farklı problemi ayırmış oluruz:

1. transport/executor çalışıyor mu?
2. SolidWorks API extraction çalışıyor mu?

Aynı anda ikisini çözmeye çalışmak debug maliyetini artırır.

## İlk uygulanacak nokta

- `run-solidworks-bridge-request.py`
- Windows helper runner
- seeded probe script
- artifact output path
- request/result envelope validation

## Canlı entegrasyonun takılacağı seam

Bugünkü yapıdaki gerçek entegrasyon noktası:

- `windows-helper/handlers/shared.ps1`

Buradaki `Invoke-SeededProbeHandler` içinde yer alan TODO, seeded probe yerine canlı extractor çağrısının geleceği sınırdır.

Beklenen yaklaşım:

- Windows helper aynı queue mimarisini korur
- handler aynı `kind` allowlist'ini korur
- canlı extractor read-only kalır
- dönüş biçimi bugünkü output contract ile aynı kalır
- partial read ve host hata durumları `diagnostics` ve result envelope `error` alanlarına yansıtılır

Bu sayede transport değişmeden yalnızca extraction implementation değiştirilir.

## Sonraki iş

Canlı Windows lane doğrulanınca gerçek extraction handler'larına geçilir.
