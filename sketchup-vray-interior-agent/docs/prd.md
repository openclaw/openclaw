# SketchUp + V-Ray Daire İçi Sunum Agentı PRD

## Amaç

Mert'in kısa sürede gösterebileceği ilk PoC:

- SketchUp sahnesini ve V-Ray sunum hazırlığını analiz etsin
- daire içi sunum için eksikleri söylesin
- oda bazlı kamera/render önerileri üretsin
- müşteriye dönük kısa metin hazırlasın

## Birincil kullanıcı

- iç mimar
- görselleştirme uzmanı
- freelance daire içi sunum hazırlayan tasarımcı

## Problem

SketchUp + V-Ray akışında kullanıcılar çoğu zaman şunları elle toparlıyor:

- hangi odalar için hangi kameralar gerektiği
- hangi materyallerin sunuma hazır olmadığı
- sahnede tutarsız isimlendirme/organizasyon
- render öncesi eksik asset, ışık veya kalite riski
- müşteriye gönderilecek kısa açıklama metni

## İlk PoC kapsamı

### In Scope

- aktif SketchUp sahnesi/projesi özetini alma
- tag/group/component/material/camera özetini çıkarma
- seçili oda veya obje bağlamını okuma
- sunum hazırlık checklist'i üretme
- önerilen kamera listesi oluşturma
- müşteri odaklı kısa sunum metni üretme

### Out of Scope

- otomatik modelleme
- geometri düzenleme
- otomatik materyal atama
- otomatik ışık kurma
- final render pipeline orchestration

## Başlıca kullanıcı soruları

- Bu daire sunuma hazır mı?
- Hangi odalarda kamera eksiğim var?
- Hangi materyaller zayıf veya tutarsız görünüyor?
- Müşteriye bu projeyi 5 cümlede nasıl anlatırım?
- Render almadan önce neyi düzeltmeliyim?

## Başarı ölçütü

PoC başarılı sayılırsa kullanıcı tek akışta şunları alır:

- kısa sahne özeti
- eksik/risk listesi
- önerilen shot list
- kısa müşteri sunum metni

## Çıktı formatları

- chat yanıtı
- kısa checklist
- oda bazlı shot list
- müşteri sunum özeti
