# SketchUp Orchestrator Delegation Playbook

## Amaç

Bu not, orchestrator'ın mevcut SketchUp-first Windows executor hattına en küçük ama gerçek akışla nasıl delegasyon yapacağını sabitler.

Odak:

- yeni framework kurmamak
- mevcut queue/request/result hattını kullanmak
- tek gerçek extraction komutu olan `extract-presentation-context` üstünden ilerlemek
- V-Ray bağlı değilken yanlış canlılık hissi vermemek

## Şu an gerçekten hazır olan yüzey

- queue tabanlı request/response hattı
- Windows helper runner allowlist'i
- typed result envelope
- `extract-presentation-context` için `seeded`, `prefer-live`, `live-only` ayrımı
- Windows üstünde `SketchUp.exe -RubyStartup` ile canlı read-only extraction seam'i

## Şu an hazır olmayan yüzey

- açık mevcut SketchUp oturumuna attach
- ayrı komutlar olarak `get-active-scene`, `get-selection-context`, `get-render-readiness`
- V-Ray metadata bağlantısı

## Önerilen delegasyon sırası

### 1. Önce capability yoklaması yap

İlk çağrı:

- `capabilities`

Amaç:

- helper ayakta mı
- hangi extraction mode'ları gerçekten destekleniyor
- canlı yol için `modelPath` zorunlu mu
- V-Ray halen bağlı değil mi

### 2. Sonra tek gerçek PoC çağrısını kullan

İkinci çağrı:

- `extract-presentation-context`

Varsayılan tercih:

- `payload.extractionMode=prefer-live`

Amaç:

- canlı SketchUp extraction mümkünse onu kullan
- canlı yol patlarsa typed warning ile seeded fallback al
- orchestrator tek komutla sahne, organizasyon, materyal, kamera ve render hazırlık özetini toplasın

### 3. Sonucu dürüst etiketle

- `render.source=sketchup-only` ise: canlı veri geldi ama V-Ray bağlı değil
- `render.source=seeded` ise: gerçek host analizi alınamadı, scaffold örneği döndü
- `diagnostics.partialRead=true` ise: fallback veya eksik okuma oldu

Bu ayrım kullanıcıya aynen taşınmalı. "Canlı analiz" ifadesi sadece `seeded` olmayan ve failure olmayan durumda kullanılmalı.

## Karar kuralı

- `prefer-live` başarılıysa: mevcut küçük read-only PoC doğrulandı kabul et
- `prefer-live` seeded fallback'e düştüyse: transport tamam, canlı seam sorunlu kabul et
- `live-only` failed dönerse: typed error kodunu log'a ve kullanıcıya aynen taşı

## Typed failure kodları

- `host-platform-unsupported`
- `sketchup-model-path-required`
- `sketchup-model-not-found`
- `sketchup-executable-not-found`
- `sketchup-live-artifact-timeout`
- `sketchup-ruby-extraction-failed`
- `invalid-extraction-mode`

## Örnek request payload

```json
{
  "extractionMode": "prefer-live",
  "modelPath": "C:\\Projects\\Daire\\daire-sunum-v03.skp",
  "keepSketchUpOpen": false,
  "timeoutSeconds": 120
}
```

## Bu faz için orchestrator çıktısı

Bu PoC fazında orchestrator'ın 4 parçalı cevap formatı şu başlıkları içermeli:

- kısa sahne özeti
- sunum checklist'i
- oda bazlı shot boşlukları
- render/V-Ray durumu

## Bu fazdan sonra en mantıklı küçük teknik adım

Bir sonraki küçük teknik faz:

- Ruby extraction kodunu kalıcı küçük bir SketchUp extension'a taşımak
- aynı `extract-presentation-context` contract'ını koruyup `modelPath` zorunluluğunu kaldırmak

Böylece komut yüzeyi büyümeden, PoC gerçek "active scene" okumasına geçebilir.
