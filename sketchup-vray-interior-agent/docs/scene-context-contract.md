# Scene Context Contract v1

Amaç: agent'in SketchUp/V-Ray sahnesinden okuyacağı minimum, read-only veri modelini sabitlemek.

## Minimum model

- `scene`: aktif dosya ve genel sahne özeti
- `selection`: varsa seçili öğe bağlamı
- `organization`: tag/component/group düzeni
- `materials`: sunum kalitesi için materyal özeti
- `cameras`: page/scene/kamera kapsaması
- `render`: erişilebilen V-Ray render bilgisi
- `diagnostics`: partial read ve uyarılar

## JSON örneği

```json
{
  "scene": {
    "name": "Daire-Sunum-v03",
    "path": "C:\\Projects\\Daire\\daire-sunum-v03.skp",
    "units": "millimeter",
    "pageCount": 6,
    "activePage": "Salon Genis Aci",
    "modelStats": {
      "componentInstanceCount": 184,
      "groupCount": 52,
      "tagCount": 18
    }
  },
  "selection": {
    "exists": true,
    "entityType": "component_instance",
    "name": "Salon_Koltuk_01",
    "tag": "Salon",
    "material": "Kumas_Bej"
  },
  "organization": {
    "tags": ["Salon", "Mutfak", "YatakOdasi"],
    "untaggedEntityCount": 7,
    "unnamedEntityCount": 3,
    "roomCoverage": [
      {
        "room": "Salon",
        "hasCamera": true
      },
      {
        "room": "Mutfak",
        "hasCamera": false
      }
    ]
  },
  "materials": {
    "materialCount": 24,
    "defaultMaterialEntityCount": 5,
    "placeholderMaterials": ["Color_001"],
    "duplicates": [
      {
        "a": "Mermer_Beyaz",
        "b": "Marble_White",
        "reason": "similar-name"
      }
    ]
  },
  "cameras": {
    "pages": [
      {
        "name": "Salon Genis Aci",
        "room": "Salon",
        "cameraType": "perspective"
      }
    ],
    "missingRooms": ["Mutfak"]
  },
  "render": {
    "source": "vray",
    "available": true,
    "qualityPreset": "high",
    "resolution": "1920x1080",
    "warnings": ["gi-cache-not-verified"]
  },
  "diagnostics": {
    "partialRead": false,
    "warnings": [],
    "unsupportedFields": []
  }
}
```

## Alan açıklamaları

- `scene.name`: aktif SketchUp model adı
- `scene.path`: tam dosya yolu
- `scene.units`: model birimi
- `scene.pageCount`: scene/page sayısı
- `scene.activePage`: aktif sunum kamerası/page
- `scene.modelStats`: hızlı hacim özeti; ilk kural kontrolleri için yeterli
- `selection`: kullanıcının o an odaklandığı öğe; yoksa `exists=false`
- `organization.tags`: sahnede kullanılan tag listesi
- `organization.untaggedEntityCount`: organizasyon riski için kritik sayaç
- `organization.unnamedEntityCount`: anlamsız isimlendirme tespiti için sayaç
- `organization.roomCoverage`: oda bazlı kamera kapsaması
- `materials.defaultMaterialEntityCount`: sunuma hazır olmayan yüzey riski
- `materials.placeholderMaterials`: değiştirilmesi beklenen materyaller
- `materials.duplicates`: tutarsız materyal dilini işaretler
- `cameras.pages`: mevcut shot envanteri
- `cameras.missingRooms`: shot list üretiminde ilk boşluk listesi
- `render.source`: veri kaynağı `vray` veya `sketchup-only`
- `render.available`: V-Ray verisi gerçekten okunabildi mi
- `render.qualityPreset`: erişilebilen kalite preset bilgisi
- `render.resolution`: hızlı render readiness kontrolü için minimum veri
- `render.warnings`: render riskleri
- `diagnostics.partialRead`: bazı alanlar okunamadıysa `true`
- `diagnostics.warnings`: extractor uyarıları
- `diagnostics.unsupportedFields`: host yüzeyi desteklemediği alanlar

## Not

MVP için hedef tam doğruluk değil, karar verdiren minimum bağlamdır. Geometri detayları ve tam V-Ray ayar ağacı ilk sürüme bilinçli olarak alınmadı.
