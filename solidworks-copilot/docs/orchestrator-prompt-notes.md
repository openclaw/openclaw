# Orchestrator Prompt Notes

## Amaç

`extract_poc_context` çıktısını kullanıcıya anlamlı review cevabına dönüştürmek için ilk prompt notlarını tutar.

## Çıktı formatı

Orchestrator mümkünse şu başlıklarda cevap vermeli:

- kısa özet
- ana bileşenler / bağlam
- dikkat noktaları
- eksik bilgi / belirsizlikler
- önerilen sonraki adımlar

## Kurallar

- veri yoksa uydurma yapma
- diagnostics.warnings alanını ciddiye al
- metadata eksiklerini açıkça söyle
- assembly summary sadece top-level ise bunu belirt
- teknik olmayan özet istenirse jargon azalt

## İlk use-case promptları

- Bu modeli bana açıkla
- Bu assembly'de dikkat edilmesi gereken noktalar ne?
- Checklist ön kontrolü yap
- Bunu teknik olmayan bir yönetici için özetle
