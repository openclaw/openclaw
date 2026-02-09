---
summary: "Discord ボットのサポート状況、機能、および設定"
read_when:
  - Discord チャンネル機能に取り組むとき
title: "Discord"
---

# Discord（Bot API）

ステータス: 公式 Discord ボットゲートウェイ経由で、DM およびギルドのテキストチャンネルに対応済みです。

## クイックセットアップ（初心者向け）

1. Discord ボットを作成し、ボットトークンをコピーします。
2. Discord アプリの設定で **Message Content Intent** を有効にします（許可リストや名前解決を使用する場合は **Server Members Intent** も有効にします）。
3. OpenClaw にトークンを設定します:
   - 環境変数: `DISCORD_BOT_TOKEN=...`
   - または設定: `channels.discord.token: "..."`。
   - 両方が設定されている場合は、設定が優先されます（環境変数のフォールバックはデフォルトアカウントのみ）。
4. メッセージ権限付きでボットをサーバーに招待します（DM のみを使う場合はプライベートサーバーを作成してください）。
5. ゲートウェイを起動します。
6. DM アクセスはデフォルトでペアリング方式です。初回接触時にペアリングコードを承認します。

最小構成:

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

## 目標

- Discord の DM またはギルドチャンネル経由で OpenClaw と対話します。
- ダイレクトチャットはエージェントのメインセッション（デフォルト `agent:main:main`）に集約され、ギルドチャンネルは `agent:<agentId>:discord:channel:<channelId>` として分離されます（表示名は `discord:<guildSlug>#<channelSlug>` を使用）。
- グループ DM はデフォルトで無視されます。`channels.discord.dm.groupEnabled` で有効化し、必要に応じて `channels.discord.dm.groupChannels` で制限します。
- ルーティングを決定的に保ち、返信は常に受信元のチャンネルに返します。

## How it works

1. Discord アプリケーション → Bot を作成し、必要なインテント（DM、ギルドメッセージ、メッセージ内容）を有効化して、ボットトークンを取得します。
2. 使用したい場所でメッセージを読み書きできる権限を付与して、ボットをサーバーに招待します。
3. OpenClaw を `channels.discord.token` で設定します（フォールバックとして `DISCORD_BOT_TOKEN` を使用可能）。
4. ゲートウェイを実行します。トークンが利用可能で（設定優先、環境変数はフォールバック）、かつ `channels.discord.enabled` が `false` でない場合、Discord チャンネルは自動起動します。
   - 環境変数を使う場合は `DISCORD_BOT_TOKEN` を設定します（設定ブロックは任意）。
5. ダイレクトチャット: 配信時に `user:<id>`（または `<@id>` メンション）を使用します。すべてのターンは共有の `main` セッションに入ります。数値 ID のみは曖昧なため拒否されます。 ベア数字のIDは曖昧で拒否されます。
6. ギルドチャンネル: 配信には `channel:<channelId>` を使用します。デフォルトではメンションが必須で、ギルド単位またはチャンネル単位で設定できます。 メンションはデフォルトで必須で、ギルドまたはチャネルごとに設定できます。
7. ダイレクトチャット: デフォルトで `channels.discord.dm.policy` により安全化されています（デフォルト: `"pairing"`）。不明な送信者にはペアリングコードが発行され（1 時間で失効）、`openclaw pairing approve discord <code>` で承認します。 不明な送信者はペアリングコードを取得します（1時間後に有効期限が切れます）。`openclawペアリング承認 <code> `を介して承認してください。
   - 旧来の「誰でも可」動作を維持する場合: `channels.discord.dm.policy="open"` と `channels.discord.dm.allowFrom=["*"]` を設定します。
   - 厳格な許可リストにする場合: `channels.discord.dm.policy="allowlist"` を設定し、`channels.discord.dm.allowFrom` に送信者を列挙します。
   - すべての DM を無視する場合: `channels.discord.dm.enabled=false` または `channels.discord.dm.policy="disabled"` を設定します。
8. グループ DM はデフォルトで無視されます。`channels.discord.dm.groupEnabled` で有効化し、必要に応じて `channels.discord.dm.groupChannels` で制限します。
9. 任意のギルドルール: ギルド ID（推奨）またはスラッグをキーに `channels.discord.guilds` を設定し、チャンネルごとのルールを指定します。
10. 任意のネイティブコマンド: `commands.native` のデフォルトは `"auto"` です（Discord/Telegram はオン、Slack はオフ）。`channels.discord.commands.native: true|false|"auto"` で上書きできます。`false` は既存の登録済みコマンドをクリアします。テキストコマンドは `commands.text` で制御され、単独の `/...` メッセージとして送信する必要があります。コマンドのアクセスグループチェックを回避するには `commands.useAccessGroups: false` を使用します。 `channels.discord.commands.native: true|false|"auto"`; `false` 以前に登録されたコマンドをクリアします。 テキストコマンドは `commands.text` によって制御され、スタンドアロンの `/...` メッセージとして送信する必要があります。 アクセスグループのコマンドチェックを回避するには、`commands.useAccessGroups: false` を使用します。
    - コマンド一覧と設定: [Slash commands](/tools/slash-commands)
11. 任意のギルドコンテキスト履歴: メンションに返信する際、直近 N 件のギルドメッセージをコンテキストとして含めるために `channels.discord.historyLimit`（デフォルト 20、`messages.groupChat.historyLimit` にフォールバック）を設定します。無効化するには `0` を設定します。 `0` を無効にします。
12. リアクション: エージェントは `discord` ツールを介してリアクションを実行できます（`channels.discord.actions.*` により制御）。
    - リアクション削除の挙動: [/tools/reactions](/tools/reactions) を参照してください。
    - `discord` ツールは、現在のチャンネルが Discord の場合にのみ公開されます。
13. ネイティブコマンドは、共有の `main` セッションではなく、分離されたセッションキー（`agent:<agentId>:discord:slash:<userId>`）を使用します。

注意: 名前 → ID 解像度はギルドメンバー検索を使用し、サーバーメンバー情報が必要です。ボットがメンバーを検索できない場合は、IDまたは `<@id>` のメンションを使用してください。
注意: スラグは小文字で空白は `-` に置き換えられます。 チャンネル名は先頭の `#` なしでスラッグされます。
注意: ギルドのコンテキスト`[from:]`行には`author.tag` + `id`が含まれています。ping-readyの返信を簡単にします。

## 設定の書き込み

デフォルトでは、Discord は `/config set|unset` によってトリガーされる設定更新の書き込みを許可されています（`commands.config: true` が必要）。

無効化するには：

```json5
{
  channels: { discord: { configWrites: false } },
}
```

## 独自ボットの作成方法

これは、`#help` のようなサーバー（ギルド）チャンネルで OpenClaw を実行するための「Discord Developer Portal」設定手順です。

### 1. Discord アプリ + ボットユーザーを作成

1. Discord Developer Portal → **Applications** → **New Application**
2. アプリ内で:
   - **Bot** → **Add Bot**
   - **Bot Token** をコピーします（`DISCORD_BOT_TOKEN` に設定する値です）

### 2) OpenClaw に必要なゲートウェイインテントを有効化

Discord は「特権インテント」を明示的に有効化しない限りブロックします。

**Bot** → **Privileged Gateway Intents** で次を有効化します:

- **Message Content Intent**（ほとんどのギルドでメッセージ本文を読むために必須。無効の場合「Used disallowed intents」が表示されるか、接続はできても反応しません）
- **Server Members Intent**（推奨。一部のメンバー/ユーザー検索や、ギルド内の許可リスト照合に必要）

通常、**Presence Intent**は必要ありません。 通常、**Presence Intent** は不要です。ボット自身のプレゼンス設定（`setPresence` アクション）はゲートウェイ OP3 を使用し、このインテントは不要です。他のギルドメンバーのプレゼンス更新を受信したい場合のみ必要です。

### 3. 招待 URL を生成（OAuth2 URL Generator）

アプリ内: **OAuth2** → **URL Generator**

**Scopes**

- ✅ `bot`
- ✅ `applications.commands`（ネイティブコマンドに必須）

**Bot Permissions**（最小構成）

- ✅ View Channels
- ✅ Send Messages
- ✅ Read Message History
- ✅ Embed Links
- ✅ Attach Files
- ✅ Add Reactions（任意だが推奨）
- ✅ Use External Emojis / Stickers（任意。使用する場合のみ）

デバッグ目的で完全に信頼している場合を除き、**Administrator** は避けてください。

生成された URL をコピーして開き、サーバーを選択し、ボットをインストールします。

### 4. ID（ギルド/ユーザー/チャンネル）を取得

Discord ではすべて数値 ID を使用します。OpenClaw の設定では ID の使用が推奨されます。

1. Discord（デスクトップ/ウェブ）→ **User Settings** → **Advanced** → **Developer Mode** を有効化
2. 右クリックしてコピー:
   - サーバー名 → **Copy Server ID**（ギルド ID）
   - チャンネル（例: `#help`）→ **Copy Channel ID**
   - 自分のユーザー → **Copy User ID**

### 5) OpenClaw を設定

#### トークン

環境変数でボットトークンを設定します（サーバーでは推奨）:

- `DISCORD_BOT_TOKEN=...`

または設定で指定します:

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

マルチアカウント対応: アカウントごとのトークンと任意の `name` を指定して `channels.discord.accounts` を使用します。共通パターンは [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) を参照してください。 マルチアカウント対応: アカウントごとの設定と任意の `name` を使用して `channels.signal.accounts` を指定します。共通パターンについては [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) を参照してください。

#### 許可リスト + チャンネルルーティング

例: 「単一サーバー、自分のみ許可、#help のみ許可」:

```json5
{
  channels: {
    discord: {
      enabled: true,
      dm: { enabled: false },
      guilds: {
        YOUR_GUILD_ID: {
          users: ["YOUR_USER_ID"],
          requireMention: true,
          channels: {
            help: { allow: true, requireMention: true },
          },
        },
      },
      retry: {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

注記:

- `requireMention: true` は、メンションされた場合のみ返信することを意味します（共有チャンネルでは推奨）。
- `agents.list[].groupChat.mentionPatterns`（または `messages.groupChat.mentionPatterns`）も、ギルドメッセージではメンションとして扱われます。
- マルチエージェントの上書き: エージェントごとのパターンを `agents.list[].groupChat.mentionPatterns` に設定します。
- `channels` が存在する場合、列挙されていないチャンネルはデフォルトで拒否されます。
- すべてのチャンネルに既定値を適用するには `"*"` のチャンネルエントリを使用します。明示的なチャンネル設定はワイルドカードを上書きします。
- スレッドは、明示的にスレッドのチャンネル ID を追加しない限り、親チャンネルの設定（許可リスト、`requireMention`、Skills、プロンプトなど）を継承します。 明示的にスレッドチャンネルIDを追加しない限りね
- オーナーヒント: ギルド単位またはチャンネル単位の `users` 許可リストが送信者に一致すると、OpenClaw はその送信者をシステムプロンプト内でオーナーとして扱います。全チャンネル共通のオーナーを設定するには `commands.ownerAllowFrom` を指定します。 チャンネル間のグローバルオーナーの場合は、`commands.ownerFrom` を設定します。
- ボット自身が送信したメッセージはデフォルトで無視されます。許可するには `channels.discord.allowBots=true` を設定します（自分自身のメッセージは引き続き除外されます）。
- 警告: 他のボットへの返信を許可する場合（`channels.discord.allowBots=true`）、`requireMention`、`channels.discord.guilds.*.channels.<id>.users` の許可リスト、および/または `AGENTS.md` と `SOUL.md` のガードレールをクリアして、ボット同士の返信ループを防止してください。

### 6. 動作確認

1. ゲートウェイを起動します。
2. サーバーチャンネルで次を送信します: `@Krill hello`（またはボット名）。
3. 反応がない場合は、以下の **トラブルシューティング** を確認してください。

### トラブルシューティング

- まず、`openclaw doctor` と `openclaw channels status --probe` を実行します（対処可能な警告と簡易監査）。
- **「Used disallowed intents」**: Developer Portal で **Message Content Intent**（および多くの場合 **Server Members Intent**）を有効化し、ゲートウェイを再起動します。
- **ボットは接続するが、ギルドチャンネルで返信しない**:
  - **Message Content Intent** が不足している、または
  - チャンネル権限（表示/送信/履歴読み取り）が不足している、または
  - 設定にはメンションが必要で、メンションしていないか
  - ギルド/チャンネルの許可リストで拒否されている。
- **`requireMention: false` が出るが返信がない**:
- `channels.discord.groupPolicy` のデフォルトは **allowlist** です。`"open"` に設定するか、`channels.discord.guilds` の下にギルドエントリを追加します（必要に応じて `channels.discord.guilds.<id>.channels` にチャンネルを列挙して制限）。
  - `DISCORD_BOT_TOKEN` のみを設定し、`channels.discord` セクションを作成しない場合、ランタイムは
    `groupPolicy` を `open` にデフォルト設定します。`channels.discord.groupPolicy`、
    `channels.defaults.groupPolicy`、またはギルド/チャンネル許可リストを追加して制限してください。 `channels.discord.groupPolicy` 、
    `channels.defaults.groupPolicy` を追加するか、guild/channel allowlistでロックダウンします。
- `requireMention` は `channels.discord.guilds`（または特定のチャンネル）の下に配置する必要があります。トップレベルの `channels.discord.requireMention` は無視されます。 トップレベルの `channels.discord.requireMention` は無視されます。
- **権限監査** (`channels status --probe`) はチャンネルIDのみをチェックします。 **権限監査**（`channels status --probe`）は数値のチャンネル ID のみを確認します。`channels.discord.guilds.*.channels` のキーにスラッグ/名前を使用している場合、監査では検証できません。
- **DM が動作しない**: `channels.discord.dm.enabled=false`、`channels.discord.dm.policy="disabled"`、またはまだ承認されていません（`channels.discord.dm.policy="pairing"`）。
- **Discord での実行承認**: Discord は DM で **ボタン UI**（Allow once / Always allow / Deny）をサポートします。`/approve <id> ...` は転送された承認のみ対象で、Discord のボタンプロンプトは解決しません。`❌ Failed to submit approval: Error: unknown approval id` が表示される、または UI が表示されない場合は、次を確認してください: `/approvide <id> ...`は転送承認のためのみで、Discordのボタンのプロンプトは解決されません。 `❌ 承認の送信に失敗しました: エラー: 不明な承認ID` または UI が表示されない場合は、以下を確認してください。
  - 設定内の `channels.discord.execApprovals.enabled: true`。
  - あなたの Discord ユーザー ID が `channels.discord.execApprovals.approvers` に含まれていること（UI は承認者にのみ送信されます）。
  - DM プロンプト内のボタン（**Allow once**、**Always allow**、**Deny**）を使用してください。
  - 詳細は [Exec approvals](/tools/exec-approvals) および [Slash commands](/tools/slash-commands) を参照してください。

## 機能と制限

- DM およびギルドのテキストチャンネル（スレッドは個別チャンネルとして扱われます。音声は非対応）。
- タイピングインジケーターはベストエフォートで送信されます。メッセージ分割は `channels.discord.textChunkLimit`（デフォルト 2000）を使用し、長文返信は行数（`channels.discord.maxLinesPerMessage`、デフォルト 17）で分割されます。
- 改行ベースの分割（任意）: `channels.discord.chunkMode="newline"` を設定すると、長さ分割の前に空行（段落境界）で分割します。
- ファイルアップロードは、設定された `channels.discord.mediaMaxMb`（デフォルト 8 MB）まで対応します。
- ノイズを避けるため、ギルドでの返信はデフォルトでメンション必須です。
- メッセージが別メッセージを参照している場合、返信コンテキストが注入されます（引用内容 + ID）。
- ネイティブの返信スレッディングは **デフォルトでオフ** です。`channels.discord.replyToMode` と返信タグで有効化します。

## リトライ方針

送信方向の Discord API 呼び出しは、レート制限（429）時に Discord の `retry_after` が利用可能であればそれを使用し、指数バックオフとジッターで再試行します。`channels.discord.retry` で設定します。詳細は [Retry policy](/concepts/retry) を参照してください。 `channels.discord.retry`で設定します。 1. [Retry policy](/concepts/retry) を参照してください。

## 設定

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "abc.123",
      groupPolicy: "allowlist",
      guilds: {
        "*": {
          channels: {
            general: { allow: true },
          },
        },
      },
      mediaMaxMb: 8,
      actions: {
        reactions: true,
        stickers: true,
        emojiUploads: true,
        stickerUploads: true,
        polls: true,
        permissions: true,
        messages: true,
        threads: true,
        pins: true,
        search: true,
        memberInfo: true,
        roleInfo: true,
        roles: false,
        channelInfo: true,
        channels: true,
        voiceStatus: true,
        events: true,
        moderation: false,
        presence: false,
      },
      replyToMode: "off",
      dm: {
        enabled: true,
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["123456789012345678", "steipete"],
        groupEnabled: false,
        groupChannels: ["openclaw-dm"],
      },
      guilds: {
        "*": { requireMention: true },
        "123456789012345678": {
          slug: "friends-of-openclaw",
          requireMention: false,
          reactionNotifications: "own",
          users: ["987654321098765432", "steipete"],
          channels: {
            general: { allow: true },
            help: {
              allow: true,
              requireMention: true,
              users: ["987654321098765432"],
              skills: ["search", "docs"],
              systemPrompt: "Keep answers short.",
            },
          },
        },
      },
    },
  },
}
```

Ack リアクションは `messages.ackReaction` + `messages.ackReactionScope` によりグローバル制御されます。ボットが返信した後に Ack リアクションを消すには `messages.removeAckAfterReply` を使用します。 Ack リアクションは、グローバルに `messages.ackReaction` +
`messages.ackReactionScope` で制御されます。ボットが返信後に
ack リアクションをクリアするには `messages.removeAckAfterReply` を使用します。

- `dm.enabled`: `false` を設定すると、すべての DM を無視します（デフォルト `true`）。
- `dm.policy`: DM のアクセス制御(`ペアリング`を推奨)。 `dm.policy`: DM アクセス制御（`pairing` 推奨）。`"open"` には `dm.allowFrom=["*"]` が必要です。
- `dm.allowFrom`: DM allowlist (user ids, names). `dm.policy="allowlist"`と`dm.policy="open"`の検証で使用されます。 ウィザードはユーザー名を受け取り、ボットがメンバーを検索できるときにIDを取得します。
- `dm.groupEnabled`: グループ DM を有効化（デフォルト `false`）。
- `dm.groupChannels`: グループ DM チャンネル ID またはスラッグの任意の許可リスト。
- `groupPolicy`: ギルドチャンネルの扱いを制御（`open|disabled|allowlist`）。`allowlist` にはチャンネル許可リストが必要です。
- `guilds`: ギルド ID（推奨）またはスラッグをキーにしたギルド別ルール。
- `guilds."*"`: 明示的なエントリがない場合に適用されるギルド既定設定。
- `guilds.<id>.slug`: 表示名に使用される任意のフレンドリーなスラッグ。
- `guilds.<id>.users`: ギルド単位の任意のユーザー許可リスト（ID または名前）。
- `guilds.<id>.tools`: チャンネル上書きがない場合に使用される、ギルド単位の任意のツールポリシー上書き（`allow`/`deny`/`alsoAllow`）。
- `guilds.<id>.toolsBySender`: ギルドレベルでの送信者別ツールポリシー上書き（チャンネル上書きがない場合に適用。`"*"` ワイルドカード対応）。
- `guilds.<id>.channels.<channel>.allow`: `groupPolicy="allowlist"` の場合にチャンネルを許可/拒否。
- `guilds.<id>.channels.<channel>.requireMention`: チャンネルのメンション必須設定。
- `guilds.<id>.channels.<channel>.tools`: チャンネル単位の任意のツールポリシー上書き（`allow`/`deny`/`alsoAllow`）。
- `guilds.<id>.channels.<channel>.toolsBySender`: チャンネル内の送信者別ツールポリシー上書き（`"*"` ワイルドカード対応）。
- `guilds.<id>.channels.<channel>.users`: チャンネル単位の任意のユーザー許可リスト。
- `guilds.<id>.channels.<channel>.skills`: スキルフィルター（省略 = すべての Skills、空 = なし）。
- `guilds.<id>.channels.<channel>.systemPrompt`: チャンネル用の追加システムプロンプト。Discord のチャンネルトピックは **信頼されない** コンテキストとして注入されます（システムプロンプトではありません）。 Discordチャンネルのトピックは、**信頼されていない** コンテキストとして注入されます (システムプロンプトではありません)。
- `guilds.<id>.channels.<channel>.enabled`: `false` を設定するとチャンネルを無効化します。
- `guilds.<id>.channels`: チャンネルルール（キーはチャンネルのスラッグまたは ID）。
- `guilds.<id>.requireMention`: ギルド単位のメンション必須設定（チャンネルごとに上書き可能）。
- `guilds.<id>.reactionNotifications`: リアクションシステムのイベントモード（`off`、`own`、`all`、`allowlist`）。
- `textChunkLimit`: 送信テキストのチャンクサイズ（文字数）。デフォルト: 2000。 デフォルト: 2000
- `chunkMode`: `length`（デフォルト）は `textChunkLimit` 超過時のみ分割します。`newline` は長さ分割前に空行（段落境界）で分割します。
- `maxLinesPerMessage`: メッセージあたりの行数ソフト上限。デフォルト: 17。 デフォルト：17。
- `mediaMaxMb`: ディスクに保存する受信メディアのクランプ。
- `historyLimit`: メンションに返信する際にコンテキストとして含める最近のギルドメッセージ数（デフォルト 20。`messages.groupChat.historyLimit` にフォールバック。`0` で無効）。
- `dmHistoryLimit`: DM 履歴のユーザーターン数上限。ユーザー別上書き: `dms["<user_id>"].historyLimit`。 ユーザ毎のオーバーライド: `dms["<user_id>"].historyLimit`。
- `retry`: 送信方向の Discord API 呼び出しのリトライ方針（attempts、minDelayMs、maxDelayMs、jitter）。
- `pluralkit`: PluralKit によるプロキシメッセージを解決し、システムメンバーを個別の送信者として扱います。
- `actions`: アクション別ツールゲート。省略するとすべて許可（無効化するには `false` を設定）。
  - `reactions`（リアクション + リアクション読み取りを含む）
  - `stickers`、`emojiUploads`、`stickerUploads`、`polls`、`permissions`、`messages`、`threads`、`pins`、`search`
  - `memberInfo`、`roleInfo`、`channelInfo`、`voiceStatus`、`events`
  - `channels`（チャンネル/カテゴリ/権限の作成・編集・削除）
  - `roles`（ロールの追加/削除、デフォルト `false`）
  - `moderation`（タイムアウト/キック/バン、デフォルト `false`）
  - `presence`（ボットのステータス/アクティビティ、デフォルト `false`）
- `execApprovals`: Discord 専用の実行承認 DM（ボタン UI）。`enabled`、`approvers`、`agentFilter`、`sessionFilter` をサポートします。 `enabled` 、 `approvers` 、 `agentFilter` 、 `sessionFilter` に対応しています。

リアクション通知は `guilds.<id>.reactionNotifications` を使用します:

- `off`: リアクションイベントなし。
- `own`: ボット自身のメッセージへのリアクション（デフォルト）。
- `all`: すべてのメッセージへのすべてのリアクション。
- `allowlist`: `guilds.<id>.users` からのリアクションのみ（空リストで無効）。

### PluralKit（PK）対応

PKのルックアップを有効にすると、プロキシされたメッセージが基盤のシステム + メンバーに解決されます。
PK 参照を有効化すると、プロキシメッセージが基となるシステム + メンバーに解決されます。  
有効時、OpenClaw は許可リストとラベル付けにメンバー ID を使用し、誤った Discord の ping を避けるため、送信者を `Member (PK:System)` として表示します。

```json5
{
  channels: {
    discord: {
      pluralkit: {
        enabled: true,
        token: "pk_live_...", // optional; required for private systems
      },
    },
  },
}
```

許可リストに関する注記（PK 有効時）:

- `dm.allowFrom`、`guilds.<id>.users`、またはチャンネル単位の `users` で `pk:<memberId>` を使用します。
- メンバー表示名は、名前/スラグと一致します。
- 参照は **元の** Discord メッセージ ID（プロキシ前）を使用するため、PK API では 30 分のウィンドウ内でのみ解決されます。
- PK 参照が失敗した場合（例: トークンのない非公開システム）、`channels.discord.allowBots=true` を設定しない限り、プロキシメッセージはボットメッセージとして扱われ、破棄されます。

### ツールアクションのデフォルト

| アクショングループ      | デフォルト    | 注記                             |
| -------------- | -------- | ------------------------------ |
| reactions      | enabled  | リアクト + リアクション一覧 + emojiList    |
| stickers       | enabled  | ステッカー送信                        |
| emojiUploads   | enabled  | 絵文字アップロード                      |
| stickerUploads | enabled  | ステッカーアップロード                    |
| polls          | enabled  | 投票の作成                          |
| permissions    | enabled  | チャンネル権限のスナップショット               |
| messages       | enabled  | 読み取り/送信/編集/削除                  |
| threads        | enabled  | 作成/一覧/返信                       |
| pins           | enabled  | ピン/解除/一覧                       |
| search         | enabled  | メッセージ検索（プレビュー機能）               |
| memberInfo     | enabled  | メンバー情報                         |
| roleInfo       | enabled  | ロール一覧                          |
| channelInfo    | enabled  | チャンネル情報 + 一覧                   |
| channels       | enabled  | チャンネル/カテゴリ管理                   |
| voiceStatus    | enabled  | ボイス状態の参照                       |
| events         | enabled  | 予定イベントの一覧/作成                   |
| roles          | disabled | ロールの追加/削除                      |
| moderation     | disabled | タイムアウト/キック/バン                  |
| presence       | disabled | ボットのステータス/アクティビティ（setPresence） |

- `replyToMode`: `off`（デフォルト）、`first`、または `all`。モデルが返信タグを含む場合にのみ適用されます。 モデルに reply タグが含まれている場合にのみ適用されます。

## 返信タグ

スレッド返信を要求するには、モデルの出力に次のいずれか 1 つのタグを含めます:

- `[[reply_to_current]]` — トリガーとなった Discord メッセージに返信します。
- `[[reply_to:<id>]]` — コンテキスト/履歴内の特定のメッセージ ID に返信します。現在のメッセージ ID は `[message_id: …]` としてプロンプトに付加されます。履歴エントリには既に ID が含まれています。
  現在のメッセージ ID は `[message_id: …]` としてプロンプトするために追加されます; 履歴エントリはすでにIDを含みます。

挙動は `channels.discord.replyToMode` で制御されます:

- `off`: タグを無視します。
- `first`: 最初の送信チャンク/添付のみが返信になります。
- `all`: すべての送信チャンク/添付が返信になります。

許可リスト照合の注記:

- `allowFrom`/`users`/`groupChannels` は、ID、名前、タグ、または `<@id>` のようなメンションを受け付けます。
- `discord:`/`user:`（ユーザー）および `channel:`（グループ DM）のプレフィックスに対応しています。
- 任意の送信者/チャンネルを許可するには `*` を使用します。
- `guilds.<id>.channels` が存在する場合、列挙されていないチャンネルはデフォルトで拒否されます。
- `guilds.<id>.channels` を省略した場合、許可リストに含まれるギルド内のすべてのチャンネルが許可されます。
- **チャンネルを一切許可しない** 場合は `channels.discord.groupPolicy: "disabled"` を設定します（または空の許可リストを維持します）。
- 設定ウィザードは `Guild/Channel` 名（公開/非公開）を受け付け、可能な場合は ID に解決します。
- 起動時、OpenClaw は許可リスト内のチャンネル/ユーザー名を ID に解決し（ボットがメンバー検索できる場合）、対応関係をログに出力します。解決できないエントリは入力どおり保持されます。

ネイティブコマンドの注記:

- 登録されるコマンドは OpenClaw のチャットコマンドと同等です。
- ネイティブコマンドは、DM/ギルドメッセージと同じ許可リスト（`channels.discord.dm.allowFrom`、`channels.discord.guilds`、チャンネル別ルール）を尊重します。
- スラッシュコマンドは、許可リストに含まれないユーザーにも Discord UI 上で表示される場合がありますが、OpenClaw は実行時に許可リストを適用し、「not authorized」と返信します。

## ツールアクション

エージェントは `discord` を呼び出して、次のようなアクションを実行できます:

- `react` / `reactions`（リアクションの追加または一覧）
- `sticker`、`poll`、`permissions`
- `readMessages`、`sendMessage`、`editMessage`、`deleteMessage`
- 読み取り/検索/ピン系のツールペイロードには、正規化された `timestampMs`（UTC エポック ms）と `timestampUtc` が、生の Discord `timestamp` と併せて含まれます。
- `threadCreate`、`threadList`、`threadReply`
- `pinMessage`、`unpinMessage`、`listPins`
- `searchMessages`、`memberInfo`、`roleInfo`、`roleAdd`、`roleRemove`、`emojiList`
- `channelInfo`、`channelList`、`voiceStatus`、`eventList`、`eventCreate`
- `timeout`、`kick`、`ban`
- `setPresence`（ボットのアクティビティとオンライン状態）

Discord メッセージ ID は、注入されるコンテキスト（`[discord message id: …]` および履歴行）に含まれ、エージェントが対象にできます。  
絵文字は Unicode（例: `✅`）または `<:party_blob:1234567890>` のようなカスタム絵文字構文を使用できます。
絵文字は、Unicode (例: `✅` ) または、 `<:party_blob:1234567890>` のようなカスタム絵文字構文を使用できます。

## 安全性と運用

- ボットトークンはパスワード同様に扱ってください。監視されたホストでは `DISCORD_BOT_TOKEN` 環境変数の使用を推奨し、設定ファイルの権限を厳格に管理してください。
- ボットには必要最小限の権限のみを付与してください（通常はメッセージの読み取り/送信）。
- ボットが停止している、またはレート制限されている場合は、他のプロセスが Discord セッションを保持していないことを確認したうえで、ゲートウェイ（`openclaw gateway --force`）を再起動してください。
