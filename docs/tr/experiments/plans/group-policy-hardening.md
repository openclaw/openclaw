---
summary: "Telegram izin listesi güçlendirmesi: önek + boşluk normalizasyonu"
read_when:
  - Geçmiş Telegram izin listesi değişikliklerini gözden geçirirken
title: "Telegram İzin Listesi Güçlendirmesi"
---

# Telegram İzin Listesi Güçlendirmesi

**Tarih**: 2026-01-05  
**Durum**: Tamamlandı  
**PR**: #216

## Özet

Telegram izin listeleri artık `telegram:` ve `tg:` öneklerini büyük/küçük harfe duyarsız olarak kabul eder ve
kazara eklenen boşlukları tolere eder. Bu, gelen izin listesi denetimlerini giden gönderim normalizasyonu ile hizalar.

## Neler değişti

- `telegram:` ve `tg:` önekleri aynı şekilde ele alınır (büyük/küçük harfe duyarsız).
- İzin listesi girdileri kırpılır; boş girdiler yok sayılır.

## Örnekler

Bunların tümü aynı kimlik için kabul edilir:

- `telegram:123456`
- `TG:123456`
- `tg:123456`

## Neden önemli

Günlüklerden veya sohbet kimliklerinden kopyala/yapıştır işlemleri sıklıkla önekler ve boşluklar içerir. Normalizasyon,
DM'lerde veya gruplarda yanıt verilip verilmeyeceğine karar verirken yanlış negatifleri önler.

## İlgili belgeler

- [Group Chats](/channels/groups)
- [Telegram Provider](/channels/telegram)
