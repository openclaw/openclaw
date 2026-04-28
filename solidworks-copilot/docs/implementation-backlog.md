# SolidWorks Copilot – İlk Uygulama Backlog'u

## Amaç

Bu backlog, contract-first iskelet kurulduktan sonra gerçek SolidWorks entegrasyonuna ilerlemek için ilk işleri sıralar.

## Phase 1 — Foundation

- [x] keşif dokümanı
- [x] PRD taslağı
- [x] teknik mimari taslağı
- [x] extraction spike planı
- [x] context contract v1
- [x] executor command surface
- [x] queue tabanlı SolidWorks helper iskeleti
- [x] stub handler'lar

## Phase 2 — Live extraction spike

- [ ] Windows tarafında SolidWorks API erişim yolunu netleştir
- [ ] `windows-helper/handlers/shared.ps1` içindeki seeded probe TODO'sunu canlı extractor ile değiştir
- [ ] `get-active-document` handler'ını canlı veriye bağla
- [ ] `get-document-metadata` handler'ını canlı veriye bağla
- [ ] `get-selection-context` handler'ını canlı veriye bağla
- [ ] `get-assembly-summary` handler'ını canlı veriye bağla
- [ ] canlı ve partial-read durumları için diagnostics standardize et

## Phase 3 — Contract hardening

- [x] request/response envelope v1 sabitle
- [x] schema validation ekle
- [x] sample success artifacts üret
- [ ] sample failure artifact üret
- [ ] unsupported field kayıtlarını netleştir

## Phase 4 — Orchestrator integration

- [ ] `extract-poc-context` çıktısını kullanan reasoning prompt taslağı yaz
- [ ] checklist response formatter ekle
- [ ] stakeholder summary formatter ekle
- [ ] uncertainty reporting kalıbını sabitle

## Phase 5 — Demo readiness

- [ ] örnek assembly ile uçtan uca demo akışı
- [ ] 3 demo prompt'u
- [ ] 3 örnek rapor çıktısı
- [ ] hata durumları için kullanıcı dostu metinler
