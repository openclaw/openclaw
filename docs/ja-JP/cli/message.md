---
read_when:
    - メッセージCLIアクションの追加または変更を行う場合
    - 送信チャネルの動作を変更する場合
summary: '`openclaw message`（送信 + チャネルアクション）のCLIリファレンス'
title: message
x-i18n:
    generated_at: "2026-04-02T07:34:27Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 770015d0db31a2660017a48fb199c1d69cbcae80f1f815f591d24b606ffc40b1
    source_path: cli/message.md
    workflow: 15
---

# `openclaw message`

メッセージ送信とチャネルアクション（Discord/Google Chat/iMessage/Matrix/Mattermost（プラグイン）/Microsoft Teams/Signal/Slack/Telegram/WhatsApp）のための単一の送信コマンドです。

## 使い方

```
openclaw message <subcommand> [flags]
```

チャネル選択:

- 複数のチャネルが設定されている場合、`--channel` が必須です。
- チャネルが1つだけ設定されている場合、それがデフォルトになります。
- 値: `discord|googlechat|imessage|matrix|mattermost|msteams|signal|slack|telegram|whatsapp`（Mattermostにはプラグインが必要）

ターゲット形式（`--target`）:

- WhatsApp: E.164またはグループJID
- Telegram: チャットIDまたは `@username`
- Discord: `channel:<id>` または `user:<id>`（または `<@id>` メンション。生の数値IDはチャネルとして扱われます）
- Google Chat: `spaces/<spaceId>` または `users/<userId>`
- Slack: `channel:<id>` または `user:<id>`（生のチャネルIDも受け付けます）
- Mattermost（プラグイン）: `channel:<id>`、`user:<id>`、または `@username`（IDのみの場合はチャネルとして扱われます）
- Signal: `+E.164`、`group:<id>`、`signal:+E.164`、`signal:group:<id>`、または `username:<name>`/`u:<name>`
- iMessage: ハンドル、`chat_id:<id>`、`chat_guid:<guid>`、または `chat_identifier:<id>`
- Matrix: `@user:server`、`!room:server`、または `#alias:server`
- Microsoft Teams: 会話ID（`19:...@thread.tacv2`）、`conversation:<id>`、または `user:<aad-object-id>`

名前検索:

- 対応プロバイダー（Discord/Slackなど）では、`Help` や `#help` のようなチャネル名がディレクトリキャッシュ経由で解決されます。
- キャッシュミスの場合、プロバイダーが対応していればOpenClawはライブディレクトリ検索を試みます。

## 共通フラグ

- `--channel <name>`
- `--account <id>`
- `--target <dest>`（送信/投票/読み取りなどの対象チャネルまたはユーザー）
- `--targets <name>`（繰り返し可。ブロードキャストのみ）
- `--json`
- `--dry-run`
- `--verbose`

## SecretRefの動作

- `openclaw message` は選択されたアクションを実行する前に、対応チャネルのSecretRefを解決します。
- 解決は可能な場合、アクティブなアクションターゲットにスコープされます:
  - `--channel` が設定されている場合（または `discord:...` のようなプレフィックス付きターゲットから推論される場合）はチャネルスコープ
  - `--account` が設定されている場合はアカウントスコープ（チャネルグローバル + 選択されたアカウントのサーフェス）
  - `--account` が省略された場合、OpenClawは `default` アカウントのSecretRefスコープを強制しません
- 関係のないチャネルの未解決SecretRefは、ターゲット指定されたメッセージアクションをブロックしません。
- 選択されたチャネル/アカウントのSecretRefが未解決の場合、コマンドはそのアクションに対してフェイルクローズします。

## アクション

### コア

- `send`
  - チャネル: WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost（プラグイン）/Signal/iMessage/Matrix/Microsoft Teams
  - 必須: `--target`、および `--message` または `--media`
  - オプション: `--media`、`--reply-to`、`--thread-id`、`--gif-playback`
  - Telegramのみ: `--buttons`（`channels.telegram.capabilities.inlineButtons` で許可が必要）
  - Telegramのみ: `--force-document`（Telegramの圧縮を避けるため画像やGIFをドキュメントとして送信）
  - Telegramのみ: `--thread-id`（フォーラムトピックID）
  - Slackのみ: `--thread-id`（スレッドタイムスタンプ。`--reply-to` は同じフィールドを使用）
  - WhatsAppのみ: `--gif-playback`

- `poll`
  - チャネル: WhatsApp/Telegram/Discord/Matrix/Microsoft Teams
  - 必須: `--target`、`--poll-question`、`--poll-option`（繰り返し）
  - オプション: `--poll-multi`
  - Discordのみ: `--poll-duration-hours`、`--silent`、`--message`
  - Telegramのみ: `--poll-duration-seconds`（5-600）、`--silent`、`--poll-anonymous` / `--poll-public`、`--thread-id`

- `react`
  - チャネル: Discord/Google Chat/Slack/Telegram/WhatsApp/Signal/Matrix
  - 必須: `--message-id`、`--target`
  - オプション: `--emoji`、`--remove`、`--participant`、`--from-me`、`--target-author`、`--target-author-uuid`
  - 注意: `--remove` には `--emoji` が必要です（対応している場合、`--emoji` を省略すると自分のリアクションをクリアできます。/tools/reactions を参照）
  - WhatsAppのみ: `--participant`、`--from-me`
  - Signalグループのリアクション: `--target-author` または `--target-author-uuid` が必須

- `reactions`
  - チャネル: Discord/Google Chat/Slack/Matrix
  - 必須: `--message-id`、`--target`
  - オプション: `--limit`

- `read`
  - チャネル: Discord/Slack/Matrix
  - 必須: `--target`
  - オプション: `--limit`、`--before`、`--after`
  - Discordのみ: `--around`

- `edit`
  - チャネル: Discord/Slack/Matrix
  - 必須: `--message-id`、`--message`、`--target`

- `delete`
  - チャネル: Discord/Slack/Telegram/Matrix
  - 必須: `--message-id`、`--target`

- `pin` / `unpin`
  - チャネル: Discord/Slack/Matrix
  - 必須: `--message-id`、`--target`

- `pins`（一覧）
  - チャネル: Discord/Slack/Matrix
  - 必須: `--target`

- `permissions`
  - チャネル: Discord/Matrix
  - 必須: `--target`
  - Matrixのみ: Matrix暗号化が有効で検証アクションが許可されている場合に利用可能

- `search`
  - チャネル: Discord
  - 必須: `--guild-id`、`--query`
  - オプション: `--channel-id`、`--channel-ids`（繰り返し）、`--author-id`、`--author-ids`（繰り返し）、`--limit`

### スレッド

- `thread create`
  - チャネル: Discord
  - 必須: `--thread-name`、`--target`（チャネルID）
  - オプション: `--message-id`、`--message`、`--auto-archive-min`

- `thread list`
  - チャネル: Discord
  - 必須: `--guild-id`
  - オプション: `--channel-id`、`--include-archived`、`--before`、`--limit`

- `thread reply`
  - チャネル: Discord
  - 必須: `--target`（スレッドID）、`--message`
  - オプション: `--media`、`--reply-to`

### 絵文字

- `emoji list`
  - Discord: `--guild-id`
  - Slack: 追加フラグなし

- `emoji upload`
  - チャネル: Discord
  - 必須: `--guild-id`、`--emoji-name`、`--media`
  - オプション: `--role-ids`（繰り返し）

### スタンプ

- `sticker send`
  - チャネル: Discord
  - 必須: `--target`、`--sticker-id`（繰り返し）
  - オプション: `--message`

- `sticker upload`
  - チャネル: Discord
  - 必須: `--guild-id`、`--sticker-name`、`--sticker-desc`、`--sticker-tags`、`--media`

### ロール / チャネル / メンバー / ボイス

- `role info`（Discord）: `--guild-id`
- `role add` / `role remove`（Discord）: `--guild-id`、`--user-id`、`--role-id`
- `channel info`（Discord）: `--target`
- `channel list`（Discord）: `--guild-id`
- `member info`（Discord/Slack）: `--user-id`（Discordの場合は `--guild-id` も必要）
- `voice status`（Discord）: `--guild-id`、`--user-id`

### イベント

- `event list`（Discord）: `--guild-id`
- `event create`（Discord）: `--guild-id`、`--event-name`、`--start-time`
  - オプション: `--end-time`、`--desc`、`--channel-id`、`--location`、`--event-type`

### モデレーション（Discord）

- `timeout`: `--guild-id`、`--user-id`（オプションで `--duration-min` または `--until`。両方省略するとタイムアウトをクリア）
- `kick`: `--guild-id`、`--user-id`（+ `--reason`）
- `ban`: `--guild-id`、`--user-id`（+ `--delete-days`、`--reason`）
  - `timeout` も `--reason` をサポート

### ブロードキャスト

- `broadcast`
  - チャネル: 設定済みの任意のチャネル。`--channel all` ですべてのプロバイダーを対象にできます
  - 必須: `--targets`（繰り返し）
  - オプション: `--message`、`--media`、`--dry-run`

## 使用例

Discordで返信を送信:

```
openclaw message send --channel discord \
  --target channel:123 --message "hi" --reply-to 456
```

Discordでコンポーネント付きメッセージを送信:

```
openclaw message send --channel discord \
  --target channel:123 --message "Choose:" \
  --components '{"text":"Choose a path","blocks":[{"type":"actions","buttons":[{"label":"Approve","style":"success"},{"label":"Decline","style":"danger"}]}]}'
```

完全なスキーマについては[Discordコンポーネント](/channels/discord#interactive-components)を参照してください。

Discordで投票を作成:

```
openclaw message poll --channel discord \
  --target channel:123 \
  --poll-question "Snack?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-multi --poll-duration-hours 48
```

Telegramで投票を作成（2分で自動クローズ）:

```
openclaw message poll --channel telegram \
  --target @mychat \
  --poll-question "Lunch?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-duration-seconds 120 --silent
```

Teamsでプロアクティブメッセージを送信:

```
openclaw message send --channel msteams \
  --target conversation:19:abc@thread.tacv2 --message "hi"
```

Teamsで投票を作成:

```
openclaw message poll --channel msteams \
  --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" \
  --poll-option Pizza --poll-option Sushi
```

Slackでリアクション:

```
openclaw message react --channel slack \
  --target C123 --message-id 456 --emoji "✅"
```

Signalグループでリアクション:

```
openclaw message react --channel signal \
  --target signal:group:abc123 --message-id 1737630212345 \
  --emoji "✅" --target-author-uuid 123e4567-e89b-12d3-a456-426614174000
```

Telegramでインラインボタンを送信:

```
openclaw message send --channel telegram --target @mychat --message "Choose:" \
  --buttons '[ [{"text":"Yes","callback_data":"cmd:yes"}], [{"text":"No","callback_data":"cmd:no"}] ]'
```

Telegramで圧縮を避けて画像をドキュメントとして送信:

```bash
openclaw message send --channel telegram --target @mychat \
  --media ./diagram.png --force-document
```
