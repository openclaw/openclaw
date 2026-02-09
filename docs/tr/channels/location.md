---
summary: "Gelen kanal konum ayrıştırması (Telegram + WhatsApp) ve bağlam alanları"
read_when:
  - Kanal konum ayrıştırması eklerken veya değiştirirken
  - Ajan istemlerinde veya araçlarda konum bağlamı alanlarını kullanırken
title: "Kanal Konum Ayrıştırması"
---

# Kanal konum ayrıştırması

OpenClaw, sohbet kanallarından paylaşılan konumları aşağıdakilere dönüştürür:

- gelen gövdeye eklenen, insan tarafından okunabilir metin ve
- otomatik yanıt bağlamı yükünde yer alan yapılandırılmış alanlar.

Şu anda desteklenenler:

- **Telegram** (konum pinleri + mekânlar + canlı konumlar)
- **WhatsApp** (locationMessage + liveLocationMessage)
- **Matrix** (`m.location` ile `geo_uri`)

## Metin biçimlendirme

Konumlar, köşeli parantez olmadan, anlaşılır satırlar olarak oluşturulur:

- Pin:
  - `📍 48.858844, 2.294351 ±12m`
- Adlandırılmış yer:
  - `📍 Eiffel Tower — Champ de Mars, Paris (48.858844, 2.294351 ±12m)`
- Canlı paylaşım:
  - `🛰 Live location: 48.858844, 2.294351 ±12m`

Kanal bir başlık/açıklama içeriyorsa, bir sonraki satıra eklenir:

```
📍 48.858844, 2.294351 ±12m
Meet here
```

## Bağlam alanları

Bir konum mevcut olduğunda, şu alanlar `ctx` içine eklenir:

- `LocationLat` (sayı)
- `LocationLon` (sayı)
- `LocationAccuracy` (sayı, metre; isteğe bağlı)
- `LocationName` (dize; isteğe bağlı)
- `LocationAddress` (dize; isteğe bağlı)
- `LocationSource` (`pin | place | live`)
- `LocationIsLive` (boolean)

## Kanal notları

- **Telegram**: mekânlar `LocationName/LocationAddress` ile eşleştirilir; canlı konumlar `live_period` kullanır.
- **WhatsApp**: `locationMessage.comment` ve `liveLocationMessage.caption` başlık satırı olarak eklenir.
- **Matrix**: `geo_uri` pin konumu olarak ayrıştırılır; irtifa yok sayılır ve `LocationIsLive` her zaman false olur.
