---
summary: "「openclaw message」（送信 + チャンネル操作）の CLI リファレンス"
read_when:
  - メッセージの CLI 操作を追加または変更する場合
  - 送信先チャンネルの挙動を変更する場合
title: "メッセージ"
---

# `openclaw message`

メッセージ送信およびチャンネル操作のための単一の送信コマンドです  
（Discord/Google Chat/Slack/Mattermost（プラグイン）/Telegram/WhatsApp/Signal/iMessage/MS Teams）。

## Usage

```
openclaw message <subcommand> [flags]
```

チャンネル選択:

- 複数のチャンネルが設定されている場合は `--channel` が必須です。
- ちょうど 1 つのチャンネルのみが設定されている場合、それがデフォルトになります。
- 値: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`（Mattermost はプラグインが必要）

ターゲット形式（`--target`）:

- WhatsApp: E.164 またはグループ JID
- Telegram: チャット ID または `@username`
- Discord: `channel:<id>` または `user:<id>`（または `<@id>` メンション。生の数値 ID はチャンネルとして扱われます）
- Google Chat: `spaces/<spaceId>` または `users/<userId>`
- Slack: `channel:<id>` または `user:<id>`（生のチャンネル ID を受け付けます）
- Mattermost（プラグイン）: `channel:<id>`、`user:<id>`、または `@username`（裸の ID はチャンネルとして扱われます）
- Signal: `+E.164`、`group:<id>`、`signal:+E.164`、`signal:group:<id>`、または `username:<name>`/`u:<name>`
- iMessage: ハンドル、`chat_id:<id>`、`chat_guid:<guid>`、または `chat_identifier:<id>`
- MS Teams: 会話 ID（`19:...@thread.tacv2`）または `conversation:<id>` または `user:<aad-object-id>`

名前解決:

- 対応プロバイダー（Discord/Slack など）では、`Help` や `#help` のようなチャンネル名はディレクトリキャッシュを介して解決されます。
- キャッシュミスの場合、プロバイダーが対応していれば OpenClaw はライブのディレクトリ参照を試みます。

## Common flags

- `--channel <name>`
- `--account <id>`
- `--target <dest>`（send/poll/read などの対象チャンネルまたはユーザー）
- `--targets <name>`（繰り返し。ブロードキャストのみ）
- `--json`
- `--dry-run`
- `--verbose`

## Actions

### Core

- `send`
  - チャンネル: WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost（プラグイン）/Signal/iMessage/MS Teams
  - 必須: `--target`、および `--message` または `--media`
  - 任意: `--media`、`--reply-to`、`--thread-id`、`--gif-playback`
  - Telegram のみ: `--buttons`（許可するには `channels.telegram.capabilities.inlineButtons` が必要）
  - Telegram のみ: `--thread-id`（フォーラムのトピック ID）
  - Slack のみ: `--thread-id`（スレッドのタイムスタンプ。`--reply-to` は同じフィールドを使用）
  - WhatsApp のみ: `--gif-playback`

- `poll`
  - チャンネル: WhatsApp/Discord/MS Teams
  - 必須: `--target`、`--poll-question`、`--poll-option`（繰り返し）
  - 任意: `--poll-multi`
  - Discord のみ: `--poll-duration-hours`、`--message`

- `react`
  - チャンネル: Discord/Google Chat/Slack/Telegram/WhatsApp/Signal
  - 必須: `--message-id`、`--target`
  - 任意: `--emoji`、`--remove`、`--participant`、`--from-me`、`--target-author`、`--target-author-uuid`
  - 注記: `--remove` には `--emoji` が必要です（対応している場合、自分のリアクションをクリアするには `--emoji` を省略します。/tools/reactions を参照）
  - WhatsApp のみ: `--participant`、`--from-me`
  - Signal のグループリアクション: `--target-author` または `--target-author-uuid` が必須

- `reactions`
  - チャンネル: Discord/Google Chat/Slack
  - 必須: `--message-id`、`--target`
  - 任意: `--limit`

- `read`
  - チャンネル: Discord/Slack
  - 必須: `--target`
  - 任意: `--limit`、`--before`、`--after`
  - Discord のみ: `--around`

- `edit`
  - チャンネル: Discord/Slack
  - 必須: `--message-id`、`--message`、`--target`

- `delete`
  - チャンネル: Discord/Slack/Telegram
  - 必須: `--message-id`、`--target`

- `pin` / `unpin`
  - チャンネル: Discord/Slack
  - 必須: `--message-id`、`--target`

- `pins`（list）
  - チャンネル: Discord/Slack
  - 必須: `--target`

- `permissions`
  - チャンネル: Discord
  - 必須: `--target`

- `search`
  - チャンネル: Discord
  - 必須: `--guild-id`、`--query`
  - 任意: `--channel-id`、`--channel-ids`（繰り返し）、`--author-id`、`--author-ids`（繰り返し）、`--limit`

### Threads

- `thread create`
  - チャンネル: Discord
  - 必須: `--thread-name`、`--target`（チャンネル ID）
  - 任意: `--message-id`、`--message`、`--auto-archive-min`

- `thread list`
  - チャンネル: Discord
  - 必須: `--guild-id`
  - 任意: `--channel-id`、`--include-archived`、`--before`、`--limit`

- `thread reply`
  - チャンネル: Discord
  - 必須: `--target`（スレッド ID）、`--message`
  - 任意: `--media`、`--reply-to`

### Emojis

- `emoji list`
  - Discord: `--guild-id`
  - Slack: 追加フラグはありません

- `emoji upload`
  - チャンネル: Discord
  - 必須: `--guild-id`、`--emoji-name`、`--media`
  - 任意: `--role-ids`（繰り返し）

### Stickers

- `sticker send`
  - チャンネル: Discord
  - 必須: `--target`、`--sticker-id`（繰り返し）
  - 任意: `--message`

- `sticker upload`
  - チャンネル: Discord
  - 必須: `--guild-id`、`--sticker-name`、`--sticker-desc`、`--sticker-tags`、`--media`

### Roles / Channels / Members / Voice

- `role info`（Discord）: `--guild-id`
- `role add` / `role remove`（Discord）: `--guild-id`、`--user-id`、`--role-id`
- `channel info`（Discord）: `--target`
- `channel list`（Discord）: `--guild-id`
- `member info`（Discord/Slack）: `--user-id`（+ Discord 用に `--guild-id`）
- `voice status`（Discord）: `--guild-id`、`--user-id`

### Events

- `event list`（Discord）: `--guild-id`
- `event create`（Discord）: `--guild-id`、`--event-name`、`--start-time`
  - 任意: `--end-time`、`--desc`、`--channel-id`、`--location`、`--event-type`

### Moderation（Discord）

- `timeout`: `--guild-id`、`--user-id`（任意で `--duration-min` または `--until`。両方省略するとタイムアウトを解除）
- `kick`: `--guild-id`、`--user-id`（+ `--reason`）
- `ban`: `--guild-id`、`--user-id`（+ `--delete-days`、`--reason`）
  - `timeout` は `--reason` もサポートします

### Broadcast

- `broadcast`
  - チャンネル: 設定済みの任意のチャンネル。すべてのプロバイダーを対象にするには `--channel all` を使用します
  - 必須: `--targets`（繰り返し）
  - 任意: `--message`、`--media`、`--dry-run`

## Examples

Discord に返信を送信する:

```
openclaw message send --channel discord \
  --target channel:123 --message "hi" --reply-to 456
```

Discord の投票を作成する:

```
openclaw message poll --channel discord \
  --target channel:123 \
  --poll-question "Snack?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-multi --poll-duration-hours 48
```

Teams のプロアクティブメッセージを送信する:

```
openclaw message send --channel msteams \
  --target conversation:19:abc@thread.tacv2 --message "hi"
```

Teams の投票を作成する:

```
openclaw message poll --channel msteams \
  --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" \
  --poll-option Pizza --poll-option Sushi
```

Slack でリアクションする:

```
openclaw message react --channel slack \
  --target C123 --message-id 456 --emoji "✅"
```

Signal グループでリアクションする:

```
openclaw message react --channel signal \
  --target signal:group:abc123 --message-id 1737630212345 \
  --emoji "✅" --target-author-uuid 123e4567-e89b-12d3-a456-426614174000
```

Telegram のインラインボタンを送信する:

```
openclaw message send --channel telegram --target @mychat --message "Choose:" \
  --buttons '[ [{"text":"Yes","callback_data":"cmd:yes"}], [{"text":"No","callback_data":"cmd:no"}] ]'
```
