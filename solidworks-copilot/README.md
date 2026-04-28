# SolidWorks Copilot Bridge

Bu klasör, CAD/BIM Design Review Copilot için SolidWorks tarafındaki ilk teknik iskeleti içerir.

## Amaç

İlk hedef, SolidWorks bağlamını read-only şekilde çıkarıp Ceviz tarafına normalize edilmiş JSON sözleşmesiyle aktarmaktır.

Bu klasör şu an için:

- command surface taslağı
- context contract v1 taslağı
- bridge request/result envelope v1
- WSL-side request wrapper
- örnek/stub Windows handler mantığı
- ileride gerçek SolidWorks entegrasyonuna oturacak temel dosya yapısı

içerir.

## Yapı

- `contracts/`
  - JSON schema ve örnek context contract dosyaları
- `docs/`
  - command surface, implementation notes ve backlog
- `scripts/`
  - WSL tarafından çağrılacak yardımcı komutlar
- `windows-helper/`
  - Windows tarafı queue runner ve handler stub’ları
- `artifacts/`
  - örnek request/response çıktıları

## İlk hedefler

1. `extract_poc_context` komutunu contract-first şekilde tanımlamak
2. request/response zarfını sabitlemek
3. gerçek SolidWorks entegrasyonu gelmeden önce stub artifact üretebilmek
4. orchestrator tarafının bu contract ile çalışmasını mümkün kılmak

## Doğrulama

Yerel örnek akışı şu komutla doğrulanabilir:

```bash
python3 scripts/verify_contract_examples.py
```

Bu komut:

- request envelope örneği üretir
- seeded probe çıktısını üretir
- result envelope örneği üretir
- mevcut contract/example dosyalarını doğrular

Gerçek SolidWorks erişimi gerektirmez.

## Not

Şu anki implementasyon, mevcut `windows-bridge-bootstrap/` yaklaşımını yeniden kullanır ama bu proje için ayrı bir alan açar. Böylece:

- mevcut bridge çalışmaları korunur
- SolidWorks copilot işi kendi sınırları içinde evrilir
- daha sonra gerçek add-in/executor’a taşınması kolaylaşır
