---
summary: "`openclaw devices` için CLI referansı (cihaz eşleştirme + belirteç döndürme/iptal)"
read_when:
  - Cihaz eşleştirme isteklerini onaylıyorsunuz
  - Cihaz belirteçlerini döndürmeniz veya iptal etmeniz gerekiyor
title: "cihazlar"
---

# `openclaw devices`

Cihaz eşleştirme isteklerini ve cihaza kapsamlı belirteçleri yönetin.

## Komutlar

### `openclaw devices list`

Bekleyen eşleştirme isteklerini ve eşleştirilmiş cihazları listeleyin.

```
openclaw devices list
openclaw devices list --json
```

### `openclaw devices approve <requestId>`

Bekleyen bir cihaz eşleştirme isteğini onaylayın.

```
openclaw devices approve <requestId>
```

### `openclaw devices reject <requestId>`

Bekleyen bir cihaz eşleştirme isteğini reddedin.

```
openclaw devices reject <requestId>
```

### `openclaw devices rotate --device <id> --role <role> [--scope <scope...>]`

Belirli bir rol için bir cihaz belirtecini döndürün (isteğe bağlı olarak kapsamları güncelleyerek).

```
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

### `openclaw devices revoke --device <id> --role <role>`

Belirli bir rol için bir cihaz belirtecini iptal edin.

```
openclaw devices revoke --device <deviceId> --role node
```

## Ortak seçenekler

- `--url <url>`: Gateway WebSocket URL’si (yapılandırıldığında varsayılan olarak `gateway.remote.url`).
- `--token <token>`: Gateway belirteci (gerekliyse).
- `--password <password>`: Gateway parolası (parola ile kimlik doğrulama).
- `--timeout <ms>`: RPC zaman aşımı.
- `--json`: JSON çıktısı (betikleme için önerilir).

Not: `--url` ayarlandığında, CLI yapılandırma veya ortam kimlik bilgilerine geri dönmez.
`--token` veya `--password` değerlerini açıkça iletin. Açık kimlik bilgileri eksikse hata oluşur.

## Notlar

- Belirteç döndürme yeni bir belirteç döndürür (hassas). Bir sır gibi ele alın.
- Bu komutlar `operator.pairing` (veya `operator.admin`) kapsamını gerektirir.
