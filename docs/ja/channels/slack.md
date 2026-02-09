---
summary: "Socket モードまたは HTTP Webhook モード向けの Slack セットアップ"
read_when: "Slack をセットアップする場合、または Slack の Socket / HTTP モードをデバッグする場合"
title: "Slack"
---

# Slack

## Socket モード（デフォルト）

### クイックセットアップ（初心者向け）

1. Slack アプリを作成し、**Socket Mode** を有効にします。
2. **App Token**（`xapp-...`）と **Bot Token**（`xoxb-...`）を作成します。
3. OpenClaw 用にトークンを設定し、ゲートウェイを起動します。

最小構成:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### セットアップ

1. [https://api.slack.com/apps](https://api.slack.com/apps) で Slack アプリを作成します（From scratch）。
2. **ソケットモード** → オンに切り替え **Socket Mode** → 有効化。次に **Basic Information** → **App-Level Tokens** → スコープ `connections:write` を指定して **Generate Token and Scopes** を実行します。**App Token**（`xapp-...`）をコピーします。 **App Token** (`xapp-...`) をコピーします。
3. **OAuth と権限** → ボットトークンスコープの追加 (下のマニフェストを使用してください)。 **Install to Workspace**をクリックします。 **OAuth & Permissions** → ボットトークンのスコープを追加します（下記のマニフェストを使用）。**Install to Workspace** をクリックし、**Bot User OAuth Token**（`xoxb-...`）をコピーします。
4. オプション: **OAuth およびパーミッション** → **ユーザトークンスコープ** の追加 (読み取り専用リストを参照してください。 任意: **OAuth & Permissions** → **User Token Scopes** を追加します（下記の読み取り専用リスト参照）。アプリを再インストールし、**User OAuth Token**（`xoxp-...`）をコピーします。
5. **Event Subscriptions** → イベントを有効化し、以下を購読します:
   - `message.*`（編集／削除／スレッドブロードキャストを含む）
   - `app_mention`
   - `reaction_added`、`reaction_removed`
   - `member_joined_channel`、`member_left_channel`
   - `channel_rename`
   - `pin_added`、`pin_removed`
6. 読み取り対象にしたいチャンネルにボットを招待します。
7. スラッシュコマンド → `channels.slack.slashCommand` を使用する場合は、 `/openclaw` を作成します。 ネイティブコマンドを有効にする場合は、組み込みコマンド(`/help`と同じ名前)ごとにスラッシュコマンドを1つ追加してください。 Slash Commands → `channels.slack.slashCommand` を使用する場合は `/openclaw` を作成します。ネイティブコマンドを有効にする場合、組み込みコマンドごとに 1 つの Slash コマンドを追加します（`/help` と同名）。Slack では、`channels.slack.commands.native: true` を設定しない限りネイティブはデフォルトでオフです（グローバル `commands.native` の既定値は `"auto"` で、Slack はオフのままです）。
8. **App Home** → **Messages Tab** を有効にし、ユーザーがボットに DM できるようにします。

スコープとイベントの同期を保つため、以下のマニフェストを使用してください。

マルチアカウント対応: アカウントごとのトークンと任意の `name` を指定して `channels.slack.accounts` を使用します。共通パターンについては [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) を参照してください。 マルチアカウント対応: アカウントごとの設定と任意の `name` を使用して `channels.signal.accounts` を指定します。共通パターンについては [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) を参照してください。

### OpenClaw 設定（Socket モード）

環境変数でトークンを設定します（推奨）:

- `SLACK_APP_TOKEN=xapp-...`
- `SLACK_BOT_TOKEN=xoxb-...`

または設定ファイルで指定します:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### ユーザートークン（任意）

OpenClaw は、読み取り操作（履歴、ピン、リアクション、絵文字、メンバー情報）に Slack のユーザートークン（`xoxp-...`）を使用できます。デフォルトでは読み取り専用のままです。ユーザートークンが存在する場合、読み取りはそれを優先し、書き込みは明示的にオプトインしない限りボットトークンを使用します。`userTokenReadOnly: false` を設定しても、ボットトークンが利用可能な場合は書き込みでボットトークンが引き続き優先されます。 4. デフォルトではこれは読み取り専用のままです。読み取りはユーザートークンが存在する場合はそれを優先し、書き込みは明示的にオプトインしない限り引き続きボットトークンを使用します。 5. `userTokenReadOnly: false` の場合でも、利用可能であれば書き込みにはボットトークンが優先されます。

ユーザートークンは設定ファイル内に設定されています(env var サポートはありません)。
マルチアカウントの場合、`channels.slack.accounts.<id> を設定します。.userToken` を設定します。

ボット + アプリ + ユーザートークンの例:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
    },
  },
}
```

userTokenReadOnly を明示的に設定した例（ユーザートークンでの書き込みを許可）:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
      userTokenReadOnly: false,
    },
  },
}
```

#### トークンの使用方法

- 読み取り操作 (履歴、リアクションリスト、ピンリスト、絵文字リスト、メンバー情報、
  検索) は、設定時にユーザートークンを好み、そうでなければボットトークンを好みます。
- 書き込み操作 (メッセージの送信/編集/削除、リアクションの追加/削除、ピン/アンピン、
  ファイルアップロード) はデフォルトでボットトークンを使用します。 `userTokenReadyOnly: false` と
  ボットトークンが利用できない場合は、OpenClawはユーザートークンに戻ります。

### 履歴コンテキスト

- `channels.slack.historyLimit`（または `channels.slack.accounts.*.historyLimit`）は、直近のチャンネル／グループメッセージをプロンプトに含める数を制御します。
- `messages.groupChat.historyLimit` にフォールバックします。無効化するには `0` を設定します（デフォルト 50）。 `0`を無効にします（デフォルトは50）。

## HTTP モード（Events API）

Gateway（ゲートウェイ）が HTTPS 経由で Slack から到達可能な場合（サーバー配備が一般的）に HTTP Webhook モードを使用します。HTTP モードは、Events API + Interactivity + Slash Commands を共通のリクエスト URL で使用します。
HTTP モードでは、イベント API + Interactivity + Slash コマンドと共有リクエストの URL を使用します。

### セットアップ（HTTP モード）

1. Slack アプリを作成し、**Socket Mode** を無効化します（HTTP のみを使用する場合は任意）。
2. **Basic Information** → **Signing Secret** をコピーします。
3. **OAuth & Permissions** → アプリをインストールし、**Bot User OAuth Token**（`xoxb-...`）をコピーします。
4. **Event Subscriptions** → イベントを有効化し、**Request URL** にゲートウェイの Webhook パス（デフォルト `/slack/events`）を設定します。
5. **Interactivity & Shortcuts** → 有効化し、同じ **Request URL** を設定します。
6. **Slash Commands** → コマンドごとに同じ **Request URL** を設定します。

リクエスト URL の例:
`https://gateway-host/slack/events`

### OpenClaw 設定（最小）

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "http",
      botToken: "xoxb-...",
      signingSecret: "your-signing-secret",
      webhookPath: "/slack/events",
    },
  },
}
```

マルチアカウントの HTTP モード: `channels.slack.accounts.<id>.mode = "http"` を設定し、アカウントごとに一意の `webhookPath` を指定して、各 Slack アプリが固有の URL を指すようにします。

### マニフェスト（任意）

この Slack アプリマニフェストを使用すると、アプリを迅速に作成できます（必要に応じて名前／コマンドを調整してください）。ユーザートークンを設定する予定がある場合は、ユーザースコープを含めてください。 ユーザートークンを設定する場合は、
ユーザースコープを含めます。

```json
{
  "display_information": {
    "name": "OpenClaw",
    "description": "Slack connector for OpenClaw"
  },
  "features": {
    "bot_user": {
      "display_name": "OpenClaw",
      "always_online": false
    },
    "app_home": {
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "slash_commands": [
      {
        "command": "/openclaw",
        "description": "Send a message to OpenClaw",
        "should_escape": false
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "chat:write",
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "groups:write",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "mpim:write",
        "users:read",
        "app_mentions:read",
        "reactions:read",
        "reactions:write",
        "pins:read",
        "pins:write",
        "emoji:read",
        "commands",
        "files:read",
        "files:write"
      ],
      "user": [
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "mpim:history",
        "mpim:read",
        "users:read",
        "reactions:read",
        "pins:read",
        "emoji:read",
        "search:read"
      ]
    }
  },
  "settings": {
    "socket_mode_enabled": true,
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "reaction_added",
        "reaction_removed",
        "member_joined_channel",
        "member_left_channel",
        "channel_rename",
        "pin_added",
        "pin_removed"
      ]
    }
  }
}
```

ネイティブコマンドを有効にする場合、公開したいコマンドごとに `slash_commands` エントリを 1 つ追加します（`/help` の一覧と一致させます）。`channels.slack.commands.native` で上書きできます。 `channels.slack.commands.native` で上書きします。

## スコープ（現在 vs 任意）

Slack の Conversations API はタイプ別スコープです。実際に扱う会話タイプ（channels、groups、im、mpim）に必要なスコープのみを指定してください。概要は
[https://docs.slack.dev/apis/web-api/using-the-conversations-api/](https://docs.slack.dev/apis/web-api/using-the-conversations-api/) を参照してください。 概要については、
[https://docs.slack.dev/apis/web-api/using-the-conversations-api/](https://docs.slack.dev/apis/web-api/using-the-conversations-api/)を参照してください。

### ボットトークンのスコープ（必須）

- `chat:write`（`chat.postMessage` によるメッセージ送信／更新／削除）
  [https://docs.slack.dev/reference/methods/chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)
- `im:write`（ユーザー DM 用に `conversations.open` で DM を開く）
  [https://docs.slack.dev/reference/methods/conversations.open](https://docs.slack.dev/reference/methods/conversations.open)
- `channels:history`、`groups:history`、`im:history`、`mpim:history`
  [https://docs.slack.dev/reference/methods/conversations.history](https://docs.slack.dev/reference/methods/conversations.history)
- `channels:read`、`groups:read`、`im:read`、`mpim:read`
  [https://docs.slack.dev/reference/methods/conversations.info](https://docs.slack.dev/reference/methods/conversations.info)
- `users:read`（ユーザー検索）
  [https://docs.slack.dev/reference/methods/users.info](https://docs.slack.dev/reference/methods/users.info)
- `reactions:read`、`reactions:write`（`reactions.get` / `reactions.add`）
  [https://docs.slack.dev/reference/methods/reactions.get](https://docs.slack.dev/reference/methods/reactions.get)
  [https://docs.slack.dev/reference/methods/reactions.add](https://docs.slack.dev/reference/methods/reactions.add)
- `pins:read`、`pins:write`（`pins.list` / `pins.add` / `pins.remove`）
  [https://docs.slack.dev/reference/scopes/pins.read](https://docs.slack.dev/reference/scopes/pins.read)
  [https://docs.slack.dev/reference/scopes/pins.write](https://docs.slack.dev/reference/scopes/pins.write)
- `emoji:read`（`emoji.list`）
  [https://docs.slack.dev/reference/scopes/emoji.read](https://docs.slack.dev/reference/scopes/emoji.read)
- `files:write`（`files.uploadV2` によるアップロード）
  [https://docs.slack.dev/messaging/working-with-files/#upload](https://docs.slack.dev/messaging/working-with-files/#upload)

### ユーザートークンのスコープ（任意、デフォルトは読み取り専用）

`channels.slack.userToken` を設定する場合、**User Token Scopes** に以下を追加します。

- `channels:history`、`groups:history`、`im:history`、`mpim:history`
- `channels:read`、`groups:read`、`im:read`、`mpim:read`
- `users:read`
- `reactions:read`
- `pins:read`
- `emoji:read`
- `search:read`

### 現時点では不要（将来の可能性あり）

- `mpim:write`（`conversations.open` によるグループ DM オープン／DM 開始を追加する場合のみ）
- `groups:write`（プライベートチャンネル管理（作成／リネーム／招待／アーカイブ）を追加する場合のみ）
- `chat:write.public`（ボットが参加していないチャンネルへ投稿する場合のみ）
  [https://docs.slack.dev/reference/scopes/chat.write.public](https://docs.slack.dev/reference/scopes/chat.write.public)
- `users:read.email`（`users.info` からメールアドレス字段が必要な場合のみ）
  [https://docs.slack.dev/changelog/2017-04-narrowing-email-access](https://docs.slack.dev/changelog/2017-04-narrowing-email-access)
- `files:read`（ファイルメタデータの一覧／読み取りを開始する場合のみ）

## 設定

Slack は Socket モードのみを使用します（HTTP Webhook サーバーなし）。両方のトークンを指定してください。 両方のトークンを提供:

```json
{
  "slack": {
    "enabled": true,
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "groupPolicy": "allowlist",
    "dm": {
      "enabled": true,
      "policy": "pairing",
      "allowFrom": ["U123", "U456", "*"],
      "groupEnabled": false,
      "groupChannels": ["G123"],
      "replyToMode": "all"
    },
    "channels": {
      "C123": { "allow": true, "requireMention": true },
      "#general": {
        "allow": true,
        "requireMention": true,
        "users": ["U123"],
        "skills": ["search", "docs"],
        "systemPrompt": "Keep answers short."
      }
    },
    "reactionNotifications": "own",
    "reactionAllowlist": ["U123"],
    "replyToMode": "off",
    "actions": {
      "reactions": true,
      "messages": true,
      "pins": true,
      "memberInfo": true,
      "emojiList": true
    },
    "slashCommand": {
      "enabled": true,
      "name": "openclaw",
      "sessionPrefix": "slack:slash",
      "ephemeral": true
    },
    "textChunkLimit": 4000,
    "mediaMaxMb": 20
  }
}
```

トークンはenv varを介して供給することもできます:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`

Ack リアクションは `messages.ackReaction` + `messages.ackReactionScope` によりグローバル制御されます。ボットが返信した後に Ack リアクションを消すには `messages.removeAckAfterReply` を使用します。 Ack リアクションは、グローバルに `messages.ackReaction` +
`messages.ackReactionScope` で制御されます。ボットが返信後に
ack リアクションをクリアするには `messages.removeAckAfterReply` を使用します。

## 制限

- 送信テキストは `channels.slack.textChunkLimit` まで分割されます（デフォルト 4000）。
- 任意の改行分割: `channels.slack.chunkMode="newline"` を設定すると、長さ分割の前に空行（段落境界）で分割します。
- メディアアップロードは `channels.slack.mediaMaxMb` で上限が設定されます（デフォルト 20）。

## 返信のスレッド化

デフォルトでは、OpenClaw はメインチャンネルに返信します。自動スレッド化は `channels.slack.replyToMode` で制御します。 `channels.slack.replyToMode` を使用して、自動スレッドを制御します。

| モード     | 動作                                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------- |
| `off`   | **デフォルト。** メインチャンネルに返信します。トリガーとなったメッセージが既にスレッド内の場合のみスレッドに返信します。 スレッドは、すでにスレッド内にトリガーメッセージが存在する場合にのみ使用します。      |
| `first` | 最初の返信はスレッド（トリガーメッセージ配下）に送信し、以降の返信はメインチャンネルに送信します。文脈を保ちつつスレッドの乱立を防ぐのに有用です。 スレッドの混乱を避けながらコンテキストを見えるようにするのに便利です。 |
| `all`   | すべての返信はスレッドに移動します。 会話を保持しますが、視認性が低下する可能性があります。                                                                |

このモードは自動返信とエージェントのツール呼び出し（`slack sendMessage`）の両方に適用されます。

### チャットタイプ別スレッド化

`channels.slack.replyToModeByChatType` を設定することで、チャットタイプごとに異なるスレッド動作を設定できます。

```json5
{
  channels: {
    slack: {
      replyToMode: "off", // default for channels
      replyToModeByChatType: {
        direct: "all", // DMs always thread
        group: "first", // group DMs/MPIM thread first reply
      },
    },
  },
}
```

対応するチャットタイプ:

- `direct`: 1:1 DM（Slack の `im`）
- `group`: グループ DM / MPIM（Slack の `mpim`）
- `channel`: 通常チャンネル（公開／非公開）

優先順位:

1. `replyToModeByChatType.<chatType>`
2. `replyToMode`
3. プロバイダー既定（`off`）

レガシーの `channels.slack.dm.replyToMode` は、チャットタイプ別の上書きが設定されていない場合に `direct` のフォールバックとして引き続き受け付けられます。

例:

DM のみスレッド化:

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { direct: "all" },
    },
  },
}
```

グループ DM はスレッド化し、チャンネルはルートに保持:

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { group: "first" },
    },
  },
}
```

チャンネルをスレッド化し、DM はルートに保持:

```json5
{
  channels: {
    slack: {
      replyToMode: "first",
      replyToModeByChatType: { direct: "off", group: "off" },
    },
  },
}
```

### 手動スレッドタグ

細かな制御には、エージェントの応答内で以下のタグを使用します。

- `[[reply_to_current]]` — トリガーメッセージに返信します（スレッド開始／継続）。
- `[[reply_to:<id>]]` — 特定のメッセージ ID に返信します。

## セッション + ルーティング

- DM は `main` セッションを共有します（WhatsApp / Telegram と同様）。
- チャンネルは `agent:<agentId>:slack:channel:<channelId>` セッションにマップされます。
- Slash コマンドは `agent:<agentId>:slack:slash:<userId>` セッションを使用します（プレフィックスは `channels.slack.slashCommand.sessionPrefix` で設定可能）。
- Slack が `channel_type` を提供しない場合、OpenClaw はチャンネル ID のプレフィックス（`D`、`C`、`G`）から推測し、セッションキーの安定性を保つためにデフォルトで `channel` を使用します。
- ネイティブコマンド登録は `commands.native` を使用します（グローバル既定 `"auto"` → Slack はオフ）。`channels.slack.commands.native` によりワークスペース単位で上書きできます。テキストコマンドは単独の `/...` メッセージを必要とし、`commands.text: false` で無効化できます。Slack の Slash コマンドは Slack アプリ側で管理され、自動削除されません。コマンドのアクセスグループチェックを回避するには `commands.useAccessGroups: false` を使用します。 テキストコマンドはスタンドアロンの `/...` メッセージを必要とし、`commands.text: false` で無効にできます。 SlackスラッシュコマンドはSlackアプリで管理され、自動的には削除されません。 アクセスグループのコマンドチェックを回避するには、`commands.useAccessGroups: false` を使用します。
- 完全なコマンド一覧と設定: [Slash commands](/tools/slash-commands)

## DM セキュリティ（ペアリング）

- デフォルト: `channels.slack.dm.policy="pairing"` — 未知の DM 送信者にはペアリングコードが送られます（1 時間で失効）。
- 承認方法: `openclaw pairing approve slack <code>`。
- 誰でも許可する場合: `channels.slack.dm.policy="open"` と `channels.slack.dm.allowFrom=["*"]` を設定します。
- `channels.slack.dm.allowFrom` はユーザー ID、@ハンドル、またはメールアドレスを受け付けます（トークンが許可する場合、起動時に解決）。ウィザードはユーザー名を受け付け、セットアップ時に ID へ解決します。 ウィザードはトークンが許可されている場合、ユーザー名を受け取り、セットアップ時にIDを取得します。

## グループポリシー

- `channels.slack.groupPolicy` はチャンネルの扱い（`open|disabled|allowlist`）を制御します。
- `allowlist` は、チャンネルが `channels.slack.channels` に列挙されていることを要求します。
- `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` のみを設定し、`channels.slack` セクションを作成しない場合、実行時の既定で `groupPolicy` は `open` になります。制限するには `channels.slack.groupPolicy`、`channels.defaults.groupPolicy`、またはチャンネル許可リストを追加してください。 `channels.slack.groupPolicy` 、
  `channels.defaults.groupPolicy` を追加するか、チャンネルをロックするための許可リストを追加します。
- 設定ウィザードは `#channel` 名を受け付け、可能な場合に ID へ解決します（公開／非公開）。複数一致がある場合はアクティブなチャンネルを優先します。
- 起動時に OpenClaw は許可リスト内のチャンネル／ユーザー名を ID に解決し（トークンが許可する場合）、対応関係をログに出力します。解決できない項目は入力どおり保持されます。
- **チャンネルを一切許可しない** 場合は `channels.slack.groupPolicy: "disabled"` を設定します（または空の許可リストを維持します）。

チャンネルオプション（`channels.slack.channels.<id>` または `channels.slack.channels.<name>`）:

- `allow`: `groupPolicy="allowlist"` の場合にチャンネルを許可／拒否します。
- `requireMention`: チャンネルごとのメンション制御。
- `tools`: 任意のチャンネル単位のツールポリシー上書き（`allow`/`deny`/`alsoAllow`）。
- `toolsBySender`: チャンネル内の送信者単位のツールポリシー上書き（キーは送信者 ID / @ハンドル / メール。`"*"` ワイルドカード対応）。
- `allowBots`: このチャンネルでボット作成メッセージを許可します（デフォルト: false）。
- `users`: 任意のチャンネル単位ユーザー許可リスト。
- `skills`: スキルフィルター（省略 = すべての Skills、空 = なし）。
- `systemPrompt`: チャンネル用の追加システムプロンプト（トピック／目的と結合）。
- `enabled`: `false` を設定してチャンネルを無効化します。

## 配信ターゲット

cron / CLI 送信で使用します:

- DM 用: `user:<id>`
- チャンネル用: `channel:<id>`

## ツールアクション

Slack のツールアクションは `channels.slack.actions.*` で制御できます。

| アクショングループ  | デフォルト   | 注記                |
| ---------- | ------- | ----------------- |
| reactions  | enabled | React + リアクションリスト |
| messages   | enabled | 読み取り／送信／編集／削除     |
| pins       | enabled | ピン／解除／一覧          |
| memberInfo | enabled | メンバー情報            |
| emojiList  | enabled | カスタム絵文字一覧         |

## セキュリティ注記

- 書き込みはデフォルトでボットトークンを使用するため、状態変更アクションはアプリのボット権限とアイデンティティにスコープされます。
- `userTokenReadOnly: false` を設定すると、ボットトークンが利用できない場合にユーザートークンでの書き込みが許可されます。これはインストールユーザーの権限で実行されることを意味します。ユーザートークンは高権限として扱い、アクションゲートと許可リストを厳格に保ってください。 ユーザートークンを高度な特権として扱い、
  アクションゲートを維持し、厳しいリストを許可します。
- ユーザートークンでの書き込みを有効にする場合、期待する書き込みスコープ（`chat:write`、`reactions:write`、`pins:write`、`files:write`）が含まれていることを確認してください。含まれていない場合、該当操作は失敗します。

## トラブルシューティング

まずは以下の手順を実行してください:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

必要に応じて DM のペアリング状態を確認します:

```bash
openclaw pairing list slack
```

よくある失敗:

- 接続済みだがチャンネルに返信しない: チャンネルが `groupPolicy` によりブロックされている、または `channels.slack.channels` の許可リストに含まれていません。
- DM が無視される: `channels.slack.dm.policy="pairing"` の場合に送信者が未承認です。
- API エラー（`missing_scope`、`not_in_channel`、認証失敗）: ボット／アプリトークン、または Slack のスコープが不完全です。

切り分けフロー: [/channels/troubleshooting](/channels/troubleshooting)。

## 注記

- メンション制御は `channels.slack.channels` で管理されます（`requireMention` を `true` に設定）。`agents.list[].groupChat.mentionPatterns`（または `messages.groupChat.mentionPatterns`）もメンションとして扱われます。
- マルチエージェント上書き: エージェント単位のパターンを `agents.list[].groupChat.mentionPatterns` に設定します。
- リアクション通知は `channels.slack.reactionNotifications` に従います（モード `allowlist` とともに `reactionAllowlist` を使用）。
- ボット作成メッセージはデフォルトで無視されます。`channels.slack.allowBots` または `channels.slack.channels.<id>.allowBots` で有効化できます。
- 注意: 他のボットへの返信を許可する場合（`channels.slack.allowBots=true` または `channels.slack.channels.<id>.allowBots=true`）、`requireMention`、`channels.slack.channels.<id>.users` の許可リスト、および／または `AGENTS.md` と `SOUL.md` のガードレールを調整して、ボット同士の返信ループを防止してください。
- Slack ツールにおけるリアクション削除の仕様については [/tools/reactions](/tools/reactions) を参照してください。
- 添付ファイルは、許可されておりサイズ制限内の場合、メディアストアにダウンロードされます。
