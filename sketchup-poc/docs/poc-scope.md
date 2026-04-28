# PoC Scope

## In scope

- SketchUp aktif modelinden read-only extraction
- Model metadata toplama
- Scene, tag, material listesi
- Group/component instance odaklı entity snapshot
- Bounding box ve transform çıkarımı
- Selection snapshot
- JSON snapshot üretimi
- Markdown summary üretimi

## Out of scope

- Model mutasyonu
- Save/overwrite işlemleri
- Event-driven senkronizasyon
- Mesh/vertex/face export
- Tam geometri analizi
- SketchUp içinde UI otomasyonu ile click akışı
- Production-grade CAD/BIM semantic inference

## Başarı kriteri

PoC başarılı sayılır eğer:

1. Aktif SketchUp modelinden read-only snapshot alınabiliyorsa
2. Snapshot sözleşmeye uygun JSON olarak yazılabiliyorsa
3. Bu snapshot'tan insan okunur bir summary üretilebiliyorsa
4. Aynı akış `refresh` mantığıyla tekrar tetiklenebiliyorsa
