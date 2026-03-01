---
summary: "`openclaw message` の CLI リファレンス（送信 + チャンネルアクション）"
read_when:
  - メッセージ CLI アクションの追加や変更
  - アウトバウンドチャンネルの動作変更
title: "message"
---

# `openclaw message`

メッセージ送信とチャンネルアクションのための単一アウトバウンドコマンドです
（Discord/Google Chat/Slack/Mattermost（プラグイン）/Telegram/WhatsApp/Signal/iMessage/MS Teams）。

## 使い方

```
openclaw message <subcommand> [flags]
```

チャンネルの選択：

- `--channel` は複数のチャンネルが設定されている場合に必須です。
- チャンネルが1つだけ設定されている場合、そのチャンネルがデフォルトになります。
- 値: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`（Mattermost にはプラグインが必要です）

ターゲットの形式（`--target`）：

- WhatsApp: E.164 またはグループ JID
- Telegram: チャット ID または `@username`
- Discord: `channel:<id>` または `user:<id>`（または `<@id>` メンション。数値のみの ID はチャンネルとして扱われます）
- Google Chat: `spaces/<spaceId>` または `users/<userId>`
- Slack: `channel:<id>` または `user:<id>`（チャンネル ID をそのまま指定できます）
- Mattermost（プラグイン）: `channel:<id>`、`user:<id>`、または `@username`（ID のみの場合はチャンネルとして扱われます）
- Signal: `+E.164`、`group:<id>`、`signal:+E.164`、`signal:group:<id>`、または `username:<name>`/`u:<name>`
- iMessage: ハンドル、`chat_id:<id>`、`chat_guid:<guid>`、または `chat_identifier:<id>`
- MS Teams: 会話 ID（`19:...@thread.tacv2`）または `conversation:<id>` または `user:<aad-object-id>`

名前のルックアップ：

- 対応プロバイダー（Discord/Slack 等）では、`Help` や `#help` のようなチャンネル名はディレクトリキャッシュを使って解決されます。
- キャッシュミスの場合、プロバイダーが対応していればライブディレクトリルックアップが試行されます。

## 共通フラグ

- `--channel <name>`
- `--account <id>`
- `--target <dest>`（send/poll/read 等のターゲットチャンネルまたはユーザー）
- `--targets <name>`（繰り返し指定可能。broadcast のみ）
- `--json`
- `--dry-run`
- `--verbose`

## アクション

### コア

- `send`
  - チャンネル: WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost（プラグイン）/Signal/iMessage/MS Teams
  - 必須: `--target`、および `--message` または `--media`
  - オプション: `--media`、`--reply-to`、`--thread-id`、`--gif-playback`
  - Telegram のみ: `--buttons`（`channels.telegram.capabilities.inlineButtons` で許可が必要です）
  - Telegram のみ: `--thread-id`（フォーラムトピック ID）
  - Slack のみ: `--thread-id`（スレッドタイムスタンプ。`--reply-to` も同じフィールドを使用します）
  - WhatsApp のみ: `--gif-playback`

- `poll`
  - チャンネル: WhatsApp/Telegram/Discord/Matrix/MS Teams
  - 必須: `--target`、`--poll-question`、`--poll-option`（繰り返し指定）
  - オプション: `--poll-multi`
  - Discord のみ: `--poll-duration-hours`、`--silent`、`--message`
  - Telegram のみ: `--poll-duration-seconds`（5-600）、`--silent`、`--poll-anonymous` / `--poll-public`、`--thread-id`

- `react`
  - チャンネル: Discord/Google Chat/Slack/Telegram/WhatsApp/Signal
  - 必須: `--message-id`、`--target`
  - オプション: `--emoji`、`--remove`、`--participant`、`--from-me`、`--target-author`、`--target-author-uuid`
  - 注意: `--remove` には `--emoji` が必要です（`--emoji` を省略すると対応プロバイダーで自分のリアクションをクリアします。/tools/reactions を参照）
  - WhatsApp のみ: `--participant`、`--from-me`
  - Signal グループリアクション: `--target-author` または `--target-author-uuid` が必要です

- `reactions`
  - チャンネル: Discord/Google Chat/Slack
  - 必須: `--message-id`、`--target`
  - オプション: `--limit`

- `read`
  - チャンネル: Discord/Slack
  - 必須: `--target`
  - オプション: `--limit`、`--before`、`--after`
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

- `pins`（一覧）
  - チャンネル: Discord/Slack
  - 必須: `--target`

- `permissions`
  - チャンネル: Discord
  - 必須: `--target`

- `search`
  - チャンネル: Discord
  - 必須: `--guild-id`、`--query`
  - オプション: `--channel-id`、`--channel-ids`（繰り返し指定）、`--author-id`、`--author-ids`（繰り返し指定）、`--limit`

### スレッド

- `thread create`
  - チャンネル: Discord
  - 必須: `--thread-name`、`--target`（チャンネル ID）
  - オプション: `--message-id`、`--message`、`--auto-archive-min`

- `thread list`
  - チャンネル: Discord
  - 必須: `--guild-id`
  - オプション: `--channel-id`、`--include-archived`、`--before`、`--limit`

- `thread reply`
  - チャンネル: Discord
  - 必須: `--target`（スレッド ID）、`--message`
  - オプション: `--media`、`--reply-to`

### 絵文字

- `emoji list`
  - Discord: `--guild-id`
  - Slack: 追加フラグなし

- `emoji upload`
  - チャンネル: Discord
  - 必須: `--guild-id`、`--emoji-name`、`--media`
  - オプション: `--role-ids`（繰り返し指定）

### ステッカー

- `sticker send`
  - チャンネル: Discord
  - 必須: `--target`、`--sticker-id`（繰り返し指定）
  - オプション: `--message`

- `sticker upload`
  - チャンネル: Discord
  - 必須: `--guild-id`、`--sticker-name`、`--sticker-desc`、`--sticker-tags`、`--media`

### ロール / チャンネル / メンバー / ボイス

- `role info`（Discord）: `--guild-id`
- `role add` / `role remove`（Discord）: `--guild-id`、`--user-id`、`--role-id`
- `channel info`（Discord）: `--target`
- `channel list`（Discord）: `--guild-id`
- `member info`（Discord/Slack）: `--user-id`（Discord の場合は `--guild-id` も必要）
- `voice status`（Discord）: `--guild-id`、`--user-id`

### イベント

- `event list`（Discord）: `--guild-id`
- `event create`（Discord）: `--guild-id`、`--event-name`、`--start-time`
  - オプション: `--end-time`、`--desc`、`--channel-id`、`--location`、`--event-type`

### モデレーション（Discord）

- `timeout`: `--guild-id`、`--user-id`（オプションで `--duration-min` または `--until`。両方省略するとタイムアウトを解除します）
- `kick`: `--guild-id`、`--user-id`（+ `--reason`）
- `ban`: `--guild-id`、`--user-id`（+ `--delete-days`、`--reason`）
  - `timeout` も `--reason` をサポートしています

### ブロードキャスト

- `broadcast`
  - チャンネル: 設定済みの任意のチャンネル。すべてのプロバイダーを対象にするには `--channel all` を使用します
  - 必須: `--targets`（繰り返し指定）
  - オプション: `--message`、`--media`、`--dry-run`

## 例

Discord で返信を送信する:

```
openclaw message send --channel discord \
  --target channel:123 --message "hi" --reply-to 456
```

コンポーネント付きの Discord メッセージを送信する:

```
openclaw message send --channel discord \
  --target channel:123 --message "Choose:" \
  --components '{"text":"Choose a path","blocks":[{"type":"actions","buttons":[{"label":"Approve","style":"success"},{"label":"Decline","style":"danger"}]}]}'
```

完全なスキーマについては [Discord コンポーネント](/channels/discord#interactive-components) を参照してください。

Discord で投票を作成する:

```
openclaw message poll --channel discord \
  --target channel:123 \
  --poll-question "Snack?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-multi --poll-duration-hours 48
```

Telegram で投票を作成する（2分後に自動終了）:

```
openclaw message poll --channel telegram \
  --target @mychat \
  --poll-question "Lunch?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-duration-seconds 120 --silent
```

Teams でプロアクティブメッセージを送信する:

```
openclaw message send --channel msteams \
  --target conversation:19:abc@thread.tacv2 --message "hi"
```

Teams で投票を作成する:

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

Telegram でインラインボタンを送信する:

```
openclaw message send --channel telegram --target @mychat --message "Choose:" \
  --buttons '[ [{"text":"Yes","callback_data":"cmd:yes"}], [{"text":"No","callback_data":"cmd:no"}] ]'
```
