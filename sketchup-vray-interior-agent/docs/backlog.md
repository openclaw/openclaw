# MVP Backlog

Amaç: read-only extraction + checklist + shot önerisi akışını çalıştırmak.

## Öncelik sırası

1. Contract v1'i sabitle
2. Windows helper/runner iskeletini kur
3. `extract-presentation-context` spike'ını seeded veriyle çalıştır
4. SketchUp canlı extraction seam'ini bağla
5. Kurallı checklist ve shot list formatter ekle
6. V-Ray render readiness alanlarını mümkünse doldur

## MVP görevleri

### P0

- `contracts/scene-context-contract-v1.json` oluştur
- request/result envelope'ları bu domain'e uyarlat
- `windows-helper/runner.ps1` + allowlist handler yapısını kur
- `extract-presentation-context` seeded/stub çıktı versin
- local contract verifier ekle
- orchestrator için 4 parçalı cevap formatını sabitle

### P1

- SketchUp aktif sahne özetini canlı oku
- tag/group/component/material sayaçlarını canlı oku
- scene/page/kamera listesini canlı oku
- selection context'i canlı oku
- checklist kurallarını deterministic çalıştır
- oda bazlı shot list üret

### P2

- V-Ray metadata erişim yüzeyini araştır ve bağla
- müşteri sunum metni formatter'ını ekle
- partial read / unsupported capability mesajlarını iyileştir

## Spike görevleri

- Spike 1: SketchUp Ruby extension mı, Ruby console/export script mi daha hızlı başlangıç verir?
- Spike 2: V-Ray bilgisi doğrudan okunabiliyor mu, yoksa ilk MVP `sketchup-only` fallback ile mi başlamalı?
- Spike 3: oda tespiti tag adıyla mı, scene/page adıyla mı, yoksa naming convention ile mi yapılmalı?

## Done kriterleri

- Tek komutla `extract-presentation-context` JSON döner
- JSON, contract v1 doğrulamasından geçer
- En az bir örnek sahnede şu çıktı üretilebilir:
  - kısa sahne özeti
  - sunum hazırlık checklist'i
  - oda bazlı shot list
- V-Ray yoksa akış kırılmaz; `render.available=false` ile devam eder
- Hata durumları `host-not-running`, `no-active-scene`, `partial-extraction` olarak normalize edilir
