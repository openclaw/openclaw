# Teknik Mimari Taslağı

## Mimari özeti

Korunan katmanlar:

1. Host Integration Layer
2. Local Windows Executor
3. Context Contract Layer
4. Ceviz Orchestrator
5. Rules / Policy Layer

## Host integration

Yeni host tarafı:

- SketchUp Ruby extension veya uygun automation yüzeyi
- mümkünse V-Ray scene/render metadata erişimi

Bu katman şunları toplar:

- aktif model/sahne bilgisi
- scene graph özeti
- tag/layer yapısı
- component/group sayıları
- material listesi
- camera/scene page bilgisi
- seçili obje bağlamı
- erişilebilirse V-Ray render ayar özeti

## Context contract

İlk sürümde contract şu bölümleri taşımalı:

- `scene`
- `selection`
- `organization`
- `materials`
- `cameras`
- `render`
- `diagnostics`

## Orchestrator görevi

Orchestrator şu niyetleri işler:

- sahneyi özetle
- sunum hazırlık kontrolü yap
- oda bazlı shot list çıkar
- müşteri özeti yaz
- render öncesi riskleri listele

## Rules/policy

Deterministik kontrolde ilk kurallar:

- adsız veya anlamsız component/group isimleri
- eksik tag organizasyonu
- kamerasız ana yaşam alanları
- placeholder/default materyaller
- çok benzer veya çakışan materyal kullanımı
- render öncesi boş/şüpheli scene page yapısı

## Fazlar

### Faz 1

- read-only scene extraction
- checklist ve shot önerisi

### Faz 2

- onaylı kamera oluşturma önerileri
- scene page standardizasyonu

### Faz 3

- guardrailli yarı-otomatik düzenleme
