---
summary: "`openclaw message` için CLI başvurusu (gönderme + kanal eylemleri)"
read_when:
  - Mesaj CLI eylemleri eklerken veya değiştirirken
  - Giden kanal davranışını değiştirirken
title: "message"
---

# `openclaw message`

Mesaj gönderme ve kanal eylemleri için tek bir giden komut
(Discord/Google Chat/Slack/Mattermost (eklenti)/Telegram/WhatsApp/Signal/iMessage/MS Teams).

## Kullanım

```
openclaw message <subcommand> [flags]
```

Kanal seçimi:

- Birden fazla kanal yapılandırılmışsa `--channel` gereklidir.
- Tam olarak bir kanal yapılandırılmışsa, varsayılan olur.
- Değerler: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams` (Mattermost eklenti gerektirir)

Hedef biçimleri (`--target`):

- WhatsApp: E.164 veya grup JID
- Telegram: sohbet kimliği veya `@username`
- Discord: `channel:<id>` veya `user:<id>` (ya da `<@id>` bahsi; ham sayısal kimlikler kanal olarak değerlendirilir)
- Google Chat: `spaces/<spaceId>` veya `users/<userId>`
- Slack: `channel:<id>` veya `user:<id>` (ham kanal kimliği kabul edilir)
- Mattermost (eklenti): `channel:<id>`, `user:<id>` veya `@username` (yalın kimlikler kanal olarak değerlendirilir)
- Signal: `+E.164`, `group:<id>`, `signal:+E.164`, `signal:group:<id>` veya `username:<name>`/`u:<name>`
- iMessage: tanıtıcı, `chat_id:<id>`, `chat_guid:<guid>` veya `chat_identifier:<id>`
- MS Teams: konuşma kimliği (`19:...@thread.tacv2`) veya `conversation:<id>` ya da `user:<aad-object-id>`

Name lookup:

- Desteklenen sağlayıcılar için (Discord/Slack vb.), `Help` veya `#help` gibi kanal adları dizin önbelleği üzerinden çözülür.
- Önbellek kaçırıldığında, sağlayıcı destekliyorsa OpenClaw canlı dizin araması dener.

## Ortak bayraklar

- `--channel <name>`
- `--account <id>`
- `--target <dest>` (gönderme/anket/okuma vb. için hedef kanal veya kullanıcı)
- `--targets <name>` (tekrar; yalnızca yayın)
- `--json`
- `--dry-run`
- `--verbose`

## Eylemler

### Çekirdek

- `send`
  - Kanallar: WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (eklenti)/Signal/iMessage/MS Teams
  - Gerekli: `--target`, ayrıca `--message` veya `--media`
  - İsteğe bağlı: `--media`, `--reply-to`, `--thread-id`, `--gif-playback`
  - Yalnızca Telegram: `--buttons` (buna izin vermek için `channels.telegram.capabilities.inlineButtons` gerekir)
  - Yalnızca Telegram: `--thread-id` (forum konu kimliği)
  - Yalnızca Slack: `--thread-id` (iş parçacığı zaman damgası; `--reply-to` aynı alanı kullanır)
  - Yalnızca WhatsApp: `--gif-playback`

- `poll`
  - Kanallar: WhatsApp/Discord/MS Teams
  - Gerekli: `--target`, `--poll-question`, `--poll-option` (tekrar)
  - İsteğe bağlı: `--poll-multi`
  - Yalnızca Discord: `--poll-duration-hours`, `--message`

- `react`
  - Kanallar: Discord/Google Chat/Slack/Telegram/WhatsApp/Signal
  - Gerekli: `--message-id`, `--target`
  - İsteğe bağlı: `--emoji`, `--remove`, `--participant`, `--from-me`, `--target-author`, `--target-author-uuid`
  - Not: `--remove` için `--emoji` gerekir (desteklenen yerlerde kendi tepkilerinizi temizlemek için `--emoji` öğesini atlayın; /tools/reactions’a bakın)
  - Yalnızca WhatsApp: `--participant`, `--from-me`
  - Signal grup tepkileri: `--target-author` veya `--target-author-uuid` gereklidir

- `reactions`
  - Kanallar: Discord/Google Chat/Slack
  - Gerekli: `--message-id`, `--target`
  - İsteğe bağlı: `--limit`

- `read`
  - Kanallar: Discord/Slack
  - Gerekli: `--target`
  - İsteğe bağlı: `--limit`, `--before`, `--after`
  - Yalnızca Discord: `--around`

- `edit`
  - Kanallar: Discord/Slack
  - Gerekli: `--message-id`, `--message`, `--target`

- `delete`
  - Kanallar: Discord/Slack/Telegram
  - Gerekli: `--message-id`, `--target`

- `pin` / `unpin`
  - Kanallar: Discord/Slack
  - Gerekli: `--message-id`, `--target`

- `pins` (liste)
  - Kanallar: Discord/Slack
  - Gerekli: `--target`

- `permissions`
  - Kanallar: Discord
  - Gerekli: `--target`

- `search`
  - Kanallar: Discord
  - Gerekli: `--guild-id`, `--query`
  - İsteğe bağlı: `--channel-id`, `--channel-ids` (tekrar), `--author-id`, `--author-ids` (tekrar), `--limit`

### Konular

- `thread create`
  - Kanallar: Discord
  - Gerekli: `--thread-name`, `--target` (kanal kimliği)
  - İsteğe bağlı: `--message-id`, `--message`, `--auto-archive-min`

- `thread list`
  - Kanallar: Discord
  - Gerekli: `--guild-id`
  - İsteğe bağlı: `--channel-id`, `--include-archived`, `--before`, `--limit`

- `thread reply`
  - Kanallar: Discord
  - Gerekli: `--target` (iş parçacığı kimliği), `--message`
  - İsteğe bağlı: `--media`, `--reply-to`

### Emojiler

- `emoji list`
  - Discord: `--guild-id`
  - Slack: ek bayrak yok

- `emoji upload`
  - Kanallar: Discord
  - Gerekli: `--guild-id`, `--emoji-name`, `--media`
  - İsteğe bağlı: `--role-ids` (tekrar)

### Çıkartmalar

- `sticker send`
  - Kanallar: Discord
  - Gerekli: `--target`, `--sticker-id` (tekrar)
  - İsteğe bağlı: `--message`

- `sticker upload`
  - Kanallar: Discord
  - Gerekli: `--guild-id`, `--sticker-name`, `--sticker-desc`, `--sticker-tags`, `--media`

### Roller / Kanallar / Üyeler / Ses

- `role info` (Discord): `--guild-id`
- `role add` / `role remove` (Discord): `--guild-id`, `--user-id`, `--role-id`
- `channel info` (Discord): `--target`
- `channel list` (Discord): `--guild-id`
- `member info` (Discord/Slack): `--user-id` (+ Discord için `--guild-id`)
- `voice status` (Discord): `--guild-id`, `--user-id`

### Etkinlikler

- `event list` (Discord): `--guild-id`
- `event create` (Discord): `--guild-id`, `--event-name`, `--start-time`
  - İsteğe bağlı: `--end-time`, `--desc`, `--channel-id`, `--location`, `--event-type`

### Moderasyon (Discord)

- `timeout`: `--guild-id`, `--user-id` (isteğe bağlı `--duration-min` veya `--until`; zaman aşımını temizlemek için ikisini de atlayın)
- `kick`: `--guild-id`, `--user-id` (+ `--reason`)
- `ban`: `--guild-id`, `--user-id` (+ `--delete-days`, `--reason`)
  - `timeout` ayrıca `--reason` destekler

### Broadcast

- `broadcast`
  - Kanallar: yapılandırılmış herhangi bir kanal; tüm sağlayıcıları hedeflemek için `--channel all` kullanın
  - Gerekli: `--targets` (tekrar)
  - İsteğe bağlı: `--message`, `--media`, `--dry-run`

## Örnekler

Bir Discord yanıtı gönderme:

```
openclaw message send --channel discord \
  --target channel:123 --message "hi" --reply-to 456
```

Bir Discord anketi oluşturma:

```
openclaw message poll --channel discord \
  --target channel:123 \
  --poll-question "Snack?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-multi --poll-duration-hours 48
```

Bir Teams proaktif mesajı gönderme:

```
openclaw message send --channel msteams \
  --target conversation:19:abc@thread.tacv2 --message "hi"
```

Bir Teams anketi oluşturma:

```
openclaw message poll --channel msteams \
  --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" \
  --poll-option Pizza --poll-option Sushi
```

Slack’te tepki verme:

```
openclaw message react --channel slack \
  --target C123 --message-id 456 --emoji "✅"
```

Bir Signal grubunda tepki verme:

```
openclaw message react --channel signal \
  --target signal:group:abc123 --message-id 1737630212345 \
  --emoji "✅" --target-author-uuid 123e4567-e89b-12d3-a456-426614174000
```

Telegram satır içi düğmeleri gönderme:

```
openclaw message send --channel telegram --target @mychat --message "Choose:" \
  --buttons '[ [{"text":"Yes","callback_data":"cmd:yes"}], [{"text":"No","callback_data":"cmd:no"}] ]'
```
