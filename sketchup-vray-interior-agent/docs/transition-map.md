# SolidWorks'ten SketchUp + V-Ray'e Geçiş Haritası

## 1. Korunacak genel mimari

Aşağıdaki parçalar doğrudan yeniden kullanılabilir:

- `Ceviz orchestrator + harness + executor` ayrımı
- read-only önce, write sonra ilkesi
- request/result envelope mantığı
- normalize edilmiş context contract yaklaşımı
- rules/policy katmanı
- orchestrator cevap formatı:
  - kısa özet
  - dikkat noktaları
  - eksik bilgi
  - önerilen sonraki adımlar

## 2. SolidWorks'e özel kalıp ve terimler

Aşağıdakiler yeni hedefe aynen taşınmamalı:

- `part / assembly / drawing` belge sınıfları
- COM üzerinden `SldWorks.Application` attach akışı
- `get_active_document`, `get_assembly_summary` gibi mekanik tasarım merkezli komutlar
- custom property ve assembly tree ağırlıklı veri modeli
- üretilebilirlik/montaj dili

## 3. Yeni hedef için domain karşılıkları

SolidWorks dilinden yeni hedefe pratik eşleme:

- `document` -> `scene/project`
- `assembly summary` -> `scene graph / tag summary`
- `custom properties` -> `scene metadata / room metadata / client brief`
- `selection context` -> `selected group/component/material/camera`
- `review checklist` -> `presentation readiness checklist`
- `technical summary` -> `client-facing interior presentation summary`

## 4. İlk faydalı kullanım alanları

Bu hedefte ilk hızlı değer üretecek işler:

- daire içi sunum için sahne hazırlık kontrolü
- oda bazlı kamera önerisi
- materyal/tutarlılık kontrolü
- render öncesi eksiklerin listelenmesi
- kısa müşteri sunum metni üretimi

## 5. Önerilen yeni doküman seti

Minimum set:

- `README.md`
- `docs/prd.md`
- `docs/technical-architecture.md`
- `docs/windows-executor-command-surface.md`
- `docs/presentation-playbook.md`

İkinci dalga için eklenebilir:

- `docs/scene-context-contract.md`
- `docs/backlog.md`
- `docs/client-brief-template.md`
