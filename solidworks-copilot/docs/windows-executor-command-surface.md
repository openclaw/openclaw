# SolidWorks Windows Executor Command Surface

## Amaç

Bu doküman, SolidWorks copilot için Windows executor katmanının dışarı açacağı ilk komut yüzeyini tanımlar.

Komutlar özellikle read-only PoC için seçilmiştir.

## Tasarım ilkeleri

- küçük allowlist
- JSON request/response
- deterministic hata davranışı
- write yeteneği yok
- ileride capability-gated genişleme mümkün

## Komutlar

### 1. `ping`

Amaç:

- helper erişilebilir mi?

İstek:

```json
{
  "schemaVersion": "solidworks-bridge-request-envelope-v1",
  "requestId": "ping-123456789abc",
  "kind": "ping",
  "createdAtUtc": "2026-04-01T10:00:00Z",
  "status": "pending",
  "payload": {}
}
```

Yanıt:

```json
{
  "schemaVersion": "solidworks-bridge-result-envelope-v1",
  "requestId": "ping-123456789abc",
  "kind": "ping",
  "status": "succeeded",
  "output": {
    "generatedAtUtc": "2026-04-01T10:00:01Z",
    "mode": "seeded-probe",
    "data": {
      "message": "pong"
    },
    "diagnostics": {
      "warnings": [],
      "partialRead": false
    }
  },
  "error": null
}
```

### 2. `capabilities`

Amaç:

- helper hangi komutları ve hangi host capability’lerini destekliyor?

### 3. `get-active-document`

Amaç:

- aktif SolidWorks dokümanını özetlemek

Beklenen veri:

- name
- path
- type
- configuration
- dirty/save state (mümkünse)

İstek payload alanları:

- `extractionMode` (opsiyonel)
  - `seeded`: varsayılan stub veri
  - `prefer-live`: önce canlı COM extractor, başarısızsa seeded fallback
  - `live-only`: yalnızca canlı COM extractor, başarısızsa typed failure

### 4. `get-document-metadata`

Amaç:

- custom properties ve metadata alanlarını çıkarmak

### 5. `get-selection-context`

Amaç:

- o an seçili entity/öğe bağlamını döndürmek

### 6. `get-assembly-summary`

Amaç:

- top-level component summary üretmek

### 7. `extract-poc-context`

Amaç:

- PoC için gerekli minimum bağlamı tek çağrıda döndürmek

Beklenen alanlar:

- document
- selection
- metadata
- assembly
- diagnostics

## Hata sınıfları

- `host_not_running`
- `no_active_document`
- `unsupported_document_type`
- `partial_extraction`
- `integration_error`

## Yaklaşım

İlk implementasyonda altta ince taneli extraction olabilir, ama üst katmana `extract-poc-context` ana giriş noktası olarak verilir.

Canlı SolidWorks entegrasyonu geldiğinde de aynı request/result envelope korunmalıdır.

## Orchestrator delegasyon notu

Küçük ve düşük riskli delegasyon sırası şu olmalı:

1. `capabilities`
2. `get-active-document` + `payload.extractionMode=prefer-live`
3. canlı doküman özeti geldiyse kullanıcıya host durumunu görünür kıl
4. daha derin bağlam gerekirse şimdilik `extract-poc-context` seeded/stub yoluna dön

Bu sıra, mevcut çalışan Windows executor hattını gerçekten kullanır ama henüz canlı olmayan metadata/selection/assembly yüzeylerini zorlamaz.
