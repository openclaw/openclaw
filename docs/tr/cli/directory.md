---
summary: "`openclaw directory` için CLI referansı (self, peers, groups)"
read_when:
  - Bir kanal için kişiler/gruplar/self kimliklerini aramak istiyorsunuz
  - Bir kanal dizini bağdaştırıcısı geliştiriyorsunuz
title: "directory"
---

# `openclaw directory`

Bunu destekleyen kanallar için dizin sorgulamaları (kişiler/peers, gruplar ve “ben”).

## Common flags

- `--channel <name>`: kanal kimliği/takma adı (birden fazla kanal yapılandırılmışsa gereklidir; yalnızca biri yapılandırılmışsa otomatik)
- `--account <id>`: hesap kimliği (varsayılan: kanal varsayılanı)
- `--json`: JSON çıktısı

## Notlar

- `directory`, diğer komutlara (özellikle `openclaw message send --target ...`) yapıştırabileceğiniz kimlikleri bulmanıza yardımcı olmak içindir.
- Birçok kanal için sonuçlar, canlı bir sağlayıcı dizini yerine yapılandırma desteklidir (izin listeleri / yapılandırılmış gruplar).
- Varsayılan çıktı, sekme ile ayrılmış `id` (ve bazen `name`) şeklindedir; betikleme için `--json` kullanın.

## `message send` ile sonuçların kullanımı

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "hello"
```

## Kimlik biçimleri (kanala göre)

- WhatsApp: `+15551234567` (DM), `1234567890-1234567890@g.us` (grup)
- Telegram: `@username` veya sayısal sohbet kimliği; gruplar sayısal kimliklerdir
- Slack: `user:U…` ve `channel:C…`
- Discord: `user:<id>` ve `channel:<id>`
- Matrix (eklenti): `user:@user:server`, `room:!roomId:server` veya `#alias:server`
- Microsoft Teams (eklenti): `user:<id>` ve `conversation:<id>`
- Zalo (eklenti): kullanıcı kimliği (Bot API)
- Zalo Personal / `zalouser` (eklenti): `zca` içinden (DM/grup) iş parçacığı kimliği (`me`, `friend list`, `group list`)

## Self (“ben”)

```bash
openclaw directory self --channel zalouser
```

## Peers (kişiler/kullanıcılar)

```bash
openclaw directory peers list --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory peers list --channel zalouser --limit 50
```

## Gruplar

```bash
openclaw directory groups list --channel zalouser
openclaw directory groups list --channel zalouser --query "work"
openclaw directory groups members --channel zalouser --group-id <id>
```
