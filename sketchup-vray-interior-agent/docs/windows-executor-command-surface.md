# SketchUp + V-Ray Windows Executor Command Surface

## Tasarım ilkeleri

- küçük allowlist
- JSON request/response
- read-only öncelik
- host-özel hata kodları

## İlk komutlar

### `ping`

Helper erişilebilir mi?

### `capabilities`

SketchUp ve V-Ray tarafında hangi extraction yüzeyleri aktif?

### `get-active-scene`

Aktif model/sahne özeti:

- dosya adı
- yol
- birim
- scene/page sayısı
- seçili görünüm

### `get-selection-context`

Seçili group/component/material/camera bağlamı.

### `get-scene-organization-summary`

- tag/layer özeti
- group/component sayıları
- isimlendirme gözlemleri

### `get-material-summary`

- materyal listesi
- default/placeholder şüpheleri
- muhtemel tutarsızlıklar

### `get-camera-shot-summary`

- mevcut scene page/kamera listesi
- oda kapsama boşlukları

### `get-render-readiness`

- erişilebilirse V-Ray render ayar özeti
- sunum öncesi riskler

### `extract-presentation-context`

PoC için gerekli minimum bağlamı tek çağrıda döndürür.

## Hata sınıfları

- `host-not-running`
- `no-active-scene`
- `vray-not-available`
- `partial-extraction`
- `unsupported-host-capability`
- `integration-error`
