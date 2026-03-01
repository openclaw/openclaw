---
summary: "Discordボットのサポートステータス、機能、および設定"
read_when:
  - Discordチャンネル機能を作業するとき
title: "Discord"
---

# Discord（Bot API）

ステータス: 公式Discordゲートウェイ経由でDMおよびギルドチャンネルに対応しています。

<CardGroup cols={3}>
  <Card title="ペアリング" icon="link" href="/channels/pairing">
    Discord DMはデフォルトでペアリングモードです。
  </Card>
  <Card title="スラッシュコマンド" icon="terminal" href="/tools/slash-commands">
    ネイティブコマンドの動作とコマンドカタログ。
  </Card>
  <Card title="チャンネルトラブルシューティング" icon="wrench" href="/channels/troubleshooting">
    クロスチャンネルの診断と修復フロー。
  </Card>
</CardGroup>

## クイックセットアップ

ボットを持つ新しいアプリケーションを作成し、ボットをサーバーに追加し、OpenClawとペアリングする必要があります。ボットを自分のプライベートサーバーに追加することをお勧めします。まだお持ちでない場合は、[先にサーバーを作成してください](https://support.discord.com/hc/en-us/articles/204849977-How-do-I-create-a-server)（**自分と友達のために作成** > **自分と友達のために**を選択）。

<Steps>
  <Step title="Discordアプリケーションとボットの作成">
    [Discord Developer Portal](https://discord.com/developers/applications)にアクセスし、**New Application**をクリックします。「OpenClaw」のような名前を付けてください。

    サイドバーの**Bot**をクリックします。**Username**をOpenClawエージェントの呼び名に設定します。

  </Step>

  <Step title="特権インテントの有効化">
    **Bot**ページのまま下にスクロールし、**Privileged Gateway Intents**で以下を有効にします:

    - **Message Content Intent**（必須）
    - **Server Members Intent**（推奨、ロール許可リストと名前からIDへのマッチングに必要）
    - **Presence Intent**（オプション、プレゼンス更新が必要な場合のみ）

  </Step>

  <Step title="ボットトークンのコピー">
    **Bot**ページの上部に戻り、**Reset Token**をクリックします。

    <Note>
    名前とは裏腹に、これは最初のトークンを生成するものです。何かが「リセット」されるわけではありません。
    </Note>

    トークンをコピーして保存してください。これが**Bot Token**で、すぐに必要になります。

  </Step>

  <Step title="招待URLの生成とボットのサーバー追加">
    サイドバーの**OAuth2**をクリックします。適切な権限を持つ招待URLを生成してボットをサーバーに追加します。

    **OAuth2 URL Generator**まで下にスクロールし、以下を有効にします:

    - `bot`
    - `applications.commands`

    下に**Bot Permissions**セクションが表示されます。以下を有効にします:

    - View Channels
    - Send Messages
    - Read Message History
    - Embed Links
    - Attach Files
    - Add Reactions（オプション）

    下部に生成されたURLをコピーし、ブラウザに貼り付け、サーバーを選択して**Continue**をクリックして接続します。Discordサーバーにボットが表示されるはずです。

  </Step>

  <Step title="開発者モードの有効化とIDの収集">
    Discordアプリに戻り、内部IDをコピーできるように開発者モードを有効にする必要があります。

    1. **ユーザー設定**（アバター横の歯車アイコン）→ **詳細設定** → **開発者モード**をオンに切り替え
    2. サイドバーの**サーバーアイコン**を右クリック → **サーバーIDをコピー**
    3. **自分のアバター**を右クリック → **ユーザーIDをコピー**

    **サーバーID**と**ユーザーID**をBot Tokenと一緒に保存してください。次のステップで3つすべてをOpenClawに送信します。

  </Step>

  <Step title="サーバーメンバーからのDMを許可">
    ペアリングが機能するには、DiscordがボットからDMを送信できるようにする必要があります。**サーバーアイコン**を右クリック → **プライバシー設定** → **ダイレクトメッセージ**をオンに切り替えます。

    これにより、サーバーメンバー（ボットを含む）がDMを送信できるようになります。OpenClawでDiscord DMを使用する場合は、これを有効のままにしてください。ギルドチャンネルのみを使用する予定の場合は、ペアリング後にDMを無効にできます。

  </Step>

  <Step title="ステップ0: ボットトークンを安全に設定（チャットで送信しないでください）">
    Discordボットトークンはシークレット（パスワードのようなもの）です。エージェントにメッセージを送信する前に、OpenClawを実行しているマシンで設定してください。

```bash
openclaw config set channels.discord.token '"YOUR_BOT_TOKEN"' --json
openclaw config set channels.discord.enabled true --json
openclaw gateway
```

    OpenClawが既にバックグラウンドサービスとして実行されている場合は、代わりに`openclaw gateway restart`を使用してください。

  </Step>

  <Step title="OpenClawの設定とペアリング">

    <Tabs>
      <Tab title="エージェントに依頼">
        既存のチャンネル（例: Telegram）でOpenClawエージェントとチャットして伝えてください。Discordが最初のチャンネルの場合は、CLI / 設定タブを使用してください。

        > 「Discord botトークンは設定済みです。ユーザーID `<user_id>` とサーバーID `<server_id>` でDiscordセットアップを完了してください。」
      </Tab>
      <Tab title="CLI / 設定">
        ファイルベースの設定を好む場合は、以下を設定します:

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

        デフォルトアカウントの環境変数フォールバック:

```bash
DISCORD_BOT_TOKEN=...
```

      </Tab>
    </Tabs>

  </Step>

  <Step title="最初のDMペアリングを承認">
    ゲートウェイが実行されるまで待ってから、Discordでボットにメッセージを送信します。ペアリングコードが返信されます。

    <Tabs>
      <Tab title="エージェントに依頼">
        既存のチャンネルでエージェントにペアリングコードを送信します:

        > 「このDiscordペアリングコードを承認してください: `<CODE>`」
      </Tab>
      <Tab title="CLI">

```bash
openclaw pairing list discord
openclaw pairing approve discord <CODE>
```

      </Tab>
    </Tabs>

    ペアリングコードは1時間後に期限切れになります。

    これでDiscord DM経由でエージェントとチャットできるようになるはずです。

  </Step>
</Steps>

<Note>
トークン解決はアカウント対応です。設定のトークン値は環境変数フォールバックより優先されます。`DISCORD_BOT_TOKEN`はデフォルトアカウントにのみ使用されます。
</Note>

## 推奨: ギルドワークスペースの設定

DMが機能したら、Discordサーバーをフルワークスペースとして設定できます。各チャンネルが独自のコンテキストを持つ独自のエージェントセッションを取得します。あなたとボットだけのプライベートサーバーに推奨されます。

<Steps>
  <Step title="サーバーをギルド許可リストに追加">
    これにより、エージェントがDMだけでなくサーバー上の任意のチャンネルで応答できるようになります。

    <Tabs>
      <Tab title="エージェントに依頼">
        > 「DiscordサーバーID `<server_id>` をギルド許可リストに追加してください」
      </Tab>
      <Tab title="設定">

```json5
{
  channels: {
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        YOUR_SERVER_ID: {
          requireMention: true,
          users: ["YOUR_USER_ID"],
        },
      },
    },
  },
}
```

      </Tab>
    </Tabs>

  </Step>

  <Step title="@メンションなしで応答を許可">
    デフォルトでは、エージェントはギルドチャンネルで@メンションされた場合のみ応答します。プライベートサーバーでは、すべてのメッセージに応答するようにしたいでしょう。

    <Tabs>
      <Tab title="エージェントに依頼">
        > 「このサーバーで@メンションなしでエージェントが応答できるようにしてください」
      </Tab>
      <Tab title="設定">
        ギルド設定で`requireMention: false`を設定します:

```json5
{
  channels: {
    discord: {
      guilds: {
        YOUR_SERVER_ID: {
          requireMention: false,
        },
      },
    },
  },
}
```

      </Tab>
    </Tabs>

  </Step>

  <Step title="ギルドチャンネルでのメモリの計画">
    デフォルトでは、長期メモリ（MEMORY.md）はDMセッションでのみ読み込まれます。ギルドチャンネルはMEMORY.mdを自動的に読み込みません。

    <Tabs>
      <Tab title="エージェントに依頼">
        > 「Discordチャンネルで質問するとき、MEMORY.mdからの長期コンテキストが必要な場合はmemory_searchまたはmemory_getを使用してください。」
      </Tab>
      <Tab title="手動">
        すべてのチャンネルで共有コンテキストが必要な場合は、安定した指示を`AGENTS.md`または`USER.md`に入れてください（すべてのセッションに注入されます）。長期的なメモは`MEMORY.md`に保存し、メモリツールでオンデマンドでアクセスしてください。
      </Tab>
    </Tabs>

  </Step>
</Steps>

Discordサーバーでチャンネルを作成してチャットを始めましょう。エージェントはチャンネル名を確認でき、各チャンネルは独自の分離されたセッションを取得します。`#coding`、`#home`、`#research`など、ワークフローに合ったものを設定できます。

## ランタイムモデル

- GatewayがDiscord接続を所有します。
- 返信ルーティングは決定論的です: Discordからの受信はDiscordに返信されます。
- デフォルト（`session.dmScope=main`）では、ダイレクトチャットはエージェントメインセッション（`agent:main:main`）を共有します。
- ギルドチャンネルは分離されたセッションキーです（`agent:<agentId>:discord:channel:<channelId>`）。
- グループDMはデフォルトで無視されます（`channels.discord.dm.groupEnabled=false`）。
- ネイティブスラッシュコマンドは分離されたコマンドセッション（`agent:<agentId>:discord:slash:<userId>`）で実行されますが、ルーティングされた会話セッションへの`CommandTargetSessionKey`を引き続き運びます。

## フォーラムチャンネル

Discordフォーラムおよびメディアチャンネルはスレッド投稿のみを受け付けます。OpenClawは2つの作成方法をサポートしています:

- フォーラム親（`channel:<forumId>`）にメッセージを送信してスレッドを自動作成します。スレッドタイトルにはメッセージの最初の非空行が使用されます。
- `openclaw message thread create`を使用してスレッドを直接作成します。フォーラムチャンネルでは`--message-id`を渡さないでください。

例: フォーラム親に送信してスレッドを作成

```bash
openclaw message send --channel discord --target channel:<forumId> \
  --message "Topic title\nBody of the post"
```

例: フォーラムスレッドを明示的に作成

```bash
openclaw message thread create --channel discord --target channel:<forumId> \
  --thread-name "Topic title" --message "Body of the post"
```

フォーラム親はDiscordコンポーネントを受け付けません。コンポーネントが必要な場合は、スレッド自体（`channel:<threadId>`）に送信してください。

## インタラクティブコンポーネント

OpenClawはエージェントメッセージにDiscord components v2コンテナをサポートしています。`components`ペイロードでメッセージツールを使用します。インタラクション結果は通常の受信メッセージとしてエージェントにルーティングされ、既存のDiscord `replyToMode`設定に従います。

サポートされているブロック:

- `text`、`section`、`separator`、`actions`、`media-gallery`、`file`
- アクション行は最大5つのボタンまたは1つのセレクトメニューを許可
- セレクトタイプ: `string`、`user`、`role`、`mentionable`、`channel`

デフォルトでは、コンポーネントは使い捨てです。`components.reusable=true`を設定すると、ボタン、セレクト、フォームが期限切れになるまで複数回使用できます。

ボタンをクリックできるユーザーを制限するには、そのボタンに`allowedUsers`を設定します（DiscordユーザーID、タグ、または`*`）。設定されている場合、一致しないユーザーにはエフェメラルな拒否が表示されます。

`/model`および`/models`スラッシュコマンドは、プロバイダーとモデルのドロップダウンおよび送信ステップを含むインタラクティブなモデルピッカーを開きます。ピッカーの返信はエフェメラルで、呼び出したユーザーのみが使用できます。

ファイル添付:

- `file`ブロックは添付ファイル参照（`attachment://<filename>`）を指す必要があります
- `media`/`path`/`filePath`（単一ファイル）で添付ファイルを提供します。複数ファイルには`media-gallery`を使用します
- アップロード名が添付ファイル参照と一致する必要がある場合は、`filename`を使用してオーバーライドします

モーダルフォーム:

- 最大5つのフィールドを持つ`components.modal`を追加
- フィールドタイプ: `text`、`checkbox`、`radio`、`select`、`role-select`、`user-select`
- OpenClawはトリガーボタンを自動的に追加します

例:

```json5
{
  channel: "discord",
  action: "send",
  to: "channel:123456789012345678",
  message: "Optional fallback text",
  components: {
    reusable: true,
    text: "Choose a path",
    blocks: [
      {
        type: "actions",
        buttons: [
          {
            label: "Approve",
            style: "success",
            allowedUsers: ["123456789012345678"],
          },
          { label: "Decline", style: "danger" },
        ],
      },
      {
        type: "actions",
        select: {
          type: "string",
          placeholder: "Pick an option",
          options: [
            { label: "Option A", value: "a" },
            { label: "Option B", value: "b" },
          ],
        },
      },
    ],
    modal: {
      title: "Details",
      triggerLabel: "Open form",
      fields: [
        { type: "text", label: "Requester" },
        {
          type: "select",
          label: "Priority",
          options: [
            { label: "Low", value: "low" },
            { label: "High", value: "high" },
          ],
        },
      ],
    },
  },
}
```

## アクセス制御とルーティング

<Tabs>
  <Tab title="DMポリシー">
    `channels.discord.dmPolicy`はDMアクセスを制御します（レガシー: `channels.discord.dm.policy`）:

    - `pairing`（デフォルト）
    - `allowlist`
    - `open`（`channels.discord.allowFrom`に`"*"`が必要、レガシー: `channels.discord.dm.allowFrom`）
    - `disabled`

    DMポリシーがopenでない場合、不明なユーザーはブロックされます（`pairing`モードではペアリングが促されます）。

    マルチアカウントの優先順位:

    - `channels.discord.accounts.default.allowFrom`は`default`アカウントにのみ適用されます。
    - 名前付きアカウントは、自身の`allowFrom`が未設定の場合、`channels.discord.allowFrom`を継承します。
    - 名前付きアカウントは`channels.discord.accounts.default.allowFrom`を継承しません。

    配信用DMターゲット形式:

    - `user:<id>`
    - `<@id>`メンション

    純粋な数値IDはあいまいであり、明示的なuser/channelターゲット種別が提供されない限り拒否されます。

  </Tab>

  <Tab title="ギルドポリシー">
    ギルド処理は`channels.discord.groupPolicy`で制御されます:

    - `open`
    - `allowlist`
    - `disabled`

    `channels.discord`が存在する場合のセキュアベースラインは`allowlist`です。

    `allowlist`の動作:

    - ギルドは`channels.discord.guilds`に一致する必要があります（`id`推奨、スラッグも受け入れ）
    - オプションの送信者許可リスト: `users`（安定したIDを推奨）と`roles`（ロールIDのみ）。いずれかが設定されている場合、送信者は`users`または`roles`に一致すると許可されます
    - ダイレクトな名前/タグマッチングはデフォルトで無効です。`channels.discord.dangerouslyAllowNameMatching: true`でブレークグラス互換モードとしてのみ有効にしてください
    - `users`には名前/タグがサポートされていますが、IDの方が安全です。`openclaw security audit`は名前/タグエントリが使用されている場合に警告します
    - ギルドに`channels`が設定されている場合、リストにないチャンネルは拒否されます
    - ギルドに`channels`ブロックがない場合、その許可リスト化されたギルドのすべてのチャンネルが許可されます

    例:

```json5
{
  channels: {
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        "123456789012345678": {
          requireMention: true,
          users: ["987654321098765432"],
          roles: ["123456789012345678"],
          channels: {
            general: { allow: true },
            help: { allow: true, requireMention: true },
          },
        },
      },
    },
  },
}
```

    `DISCORD_BOT_TOKEN`のみを設定し`channels.discord`ブロックを作成していない場合、ランタイムフォールバックは`groupPolicy="allowlist"`です（ログに警告が表示されます）。`channels.defaults.groupPolicy`が`open`であっても同様です。

  </Tab>

  <Tab title="メンションとグループDM">
    ギルドメッセージはデフォルトでメンションゲーティングされます。

    メンション検出には以下が含まれます:

    - 明示的なボットメンション
    - 設定されたメンションパターン（`agents.list[].groupChat.mentionPatterns`、フォールバック`messages.groupChat.mentionPatterns`）
    - サポートされるケースでの暗黙的なreply-to-bot動作

    `requireMention`はギルド/チャンネルごとに設定されます（`channels.discord.guilds...`）。

    グループDM:

    - デフォルト: 無視（`dm.groupEnabled=false`）
    - `dm.groupChannels`を介したオプションの許可リスト（チャンネルIDまたはスラッグ）

  </Tab>
</Tabs>

### ロールベースのエージェントルーティング

`bindings[].match.roles`を使用して、DiscordギルドメンバーをロールIDで異なるエージェントにルーティングします。ロールベースのバインディングはロールIDのみを受け付け、peerまたはparent-peerバインディングの後、guild-onlyバインディングの前に評価されます。バインディングが他のmatchフィールド（例: `peer` + `guildId` + `roles`）も設定する場合、設定されたすべてのフィールドが一致する必要があります。

```json5
{
  bindings: [
    {
      agentId: "opus",
      match: {
        channel: "discord",
        guildId: "123456789012345678",
        roles: ["111111111111111111"],
      },
    },
    {
      agentId: "sonnet",
      match: {
        channel: "discord",
        guildId: "123456789012345678",
      },
    },
  ],
}
```

## Developer Portalセットアップ

<AccordionGroup>
  <Accordion title="アプリとボットの作成">

    1. Discord Developer Portal -> **Applications** -> **New Application**
    2. **Bot** -> **Add Bot**
    3. ボットトークンをコピー

  </Accordion>

  <Accordion title="特権インテント">
    **Bot -> Privileged Gateway Intents**で以下を有効にします:

    - Message Content Intent
    - Server Members Intent（推奨）

    Presenceインテントはオプションで、プレゼンス更新を受信する場合にのみ必要です。ボットプレゼンスの設定（`setPresence`）には、メンバーのプレゼンス更新の有効化は不要です。

  </Accordion>

  <Accordion title="OAuthスコープとベースライン権限">
    OAuth URL Generator:

    - スコープ: `bot`、`applications.commands`

    一般的なベースライン権限:

    - View Channels
    - Send Messages
    - Read Message History
    - Embed Links
    - Attach Files
    - Add Reactions（オプション）

    明示的に必要でない限り、`Administrator`は避けてください。

  </Accordion>

  <Accordion title="IDのコピー">
    Discord開発者モードを有効にしてから、以下をコピーします:

    - サーバーID
    - チャンネルID
    - ユーザーID

    信頼性の高い監査とプローブのために、OpenClaw設定では数値IDを推奨します。

  </Accordion>
</AccordionGroup>

## ネイティブコマンドとコマンド認証

- `commands.native`はデフォルトで`"auto"`であり、Discordでは有効です。
- チャンネルごとのオーバーライド: `channels.discord.commands.native`。
- `commands.native=false`は以前に登録されたDiscordネイティブコマンドを明示的にクリアします。
- ネイティブコマンド認証は、通常のメッセージ処理と同じDiscord許可リスト/ポリシーを使用します。
- 認可されていないユーザーにもDiscord UIでコマンドが表示される場合がありますが、実行時にOpenClaw認証が適用され「not authorized」が返されます。

コマンドカタログと動作については[スラッシュコマンド](/tools/slash-commands)を参照してください。

デフォルトのスラッシュコマンド設定:

- `ephemeral: true`

## 機能の詳細

<AccordionGroup>
  <Accordion title="返信タグとネイティブ返信">
    Discordはエージェント出力で返信タグをサポートしています:

    - `[[reply_to_current]]`
    - `[[reply_to:<id>]]`

    `channels.discord.replyToMode`で制御されます:

    - `off`（デフォルト）
    - `first`
    - `all`

    注意: `off`は暗黙的な返信スレッディングを無効にします。明示的な`[[reply_to_*]]`タグは引き続き処理されます。

    メッセージIDはコンテキスト/履歴に表示されるため、エージェントは特定のメッセージをターゲットにできます。

  </Accordion>

  <Accordion title="ライブストリームプレビュー">
    OpenClawは一時メッセージを送信し、テキストが到着するにつれて編集することで、ドラフト返信をストリーミングできます。

    - `channels.discord.streaming`はプレビューストリーミングを制御します（`off` | `partial` | `block` | `progress`、デフォルト: `off`）。
    - `progress`はクロスチャンネル一貫性のために受け入れられ、Discordでは`partial`にマッピングされます。
    - `channels.discord.streamMode`はレガシーエイリアスで、自動マイグレーションされます。
    - `partial`はトークンが到着するにつれて単一のプレビューメッセージを編集します。
    - `block`はドラフトサイズのチャンクを出力します（サイズとブレークポイントの調整に`draftChunk`を使用）。

    例:

```json5
{
  channels: {
    discord: {
      streaming: "partial",
    },
  },
}
```

    `block`モードのチャンキングデフォルト（`channels.discord.textChunkLimit`にクランプされます）:

```json5
{
  channels: {
    discord: {
      streaming: "block",
      draftChunk: {
        minChars: 200,
        maxChars: 800,
        breakPreference: "paragraph",
      },
    },
  },
}
```

    プレビューストリーミングはテキストのみです。メディア返信は通常の配信にフォールバックします。

    注意: プレビューストリーミングはブロックストリーミングとは別です。Discordでブロックストリーミングが明示的に有効な場合、OpenClawは二重ストリーミングを避けるためにプレビューストリームをスキップします。

  </Accordion>

  <Accordion title="履歴、コンテキスト、スレッド動作">
    ギルド履歴コンテキスト:

    - `channels.discord.historyLimit`デフォルト`20`
    - フォールバック: `messages.groupChat.historyLimit`
    - `0`で無効

    DM履歴コントロール:

    - `channels.discord.dmHistoryLimit`
    - `channels.discord.dms["<user_id>"].historyLimit`

    スレッド動作:

    - Discordスレッドはチャンネルセッションとしてルーティングされます
    - 親スレッドメタデータは親セッションリンケージに使用できます
    - スレッド設定は、スレッド固有のエントリが存在しない限り、親チャンネル設定を継承します

    チャンネルトピックは**信頼されない**コンテキストとして注入されます（システムプロンプトとしてではありません）。

  </Accordion>

  <Accordion title="サブエージェント用スレッドバウンドセッション">
    Discordはスレッドをセッションターゲットにバインドして、そのスレッド内のフォローアップメッセージが同じセッション（サブエージェントセッションを含む）にルーティングされ続けるようにできます。

    コマンド:

    - `/focus <target>` 現在/新規スレッドをサブエージェント/セッションターゲットにバインド
    - `/unfocus` 現在のスレッドバインディングを削除
    - `/agents` アクティブな実行とバインディング状態を表示
    - `/session idle <duration|off>` フォーカスされたバインディングの非アクティブ自動アンフォーカスを検査/更新
    - `/session max-age <duration|off>` フォーカスされたバインディングのハード最大エイジを検査/更新

    設定:

```json5
{
  session: {
    threadBindings: {
      enabled: true,
      idleHours: 24,
      maxAgeHours: 0,
    },
  },
  channels: {
    discord: {
      threadBindings: {
        enabled: true,
        idleHours: 24,
        maxAgeHours: 0,
        spawnSubagentSessions: false, // オプトイン
      },
    },
  },
}
```

    注意:

    - `session.threadBindings.*`はグローバルデフォルトを設定します。
    - `channels.discord.threadBindings.*`はDiscordの動作をオーバーライドします。
    - `spawnSubagentSessions`は`sessions_spawn({ thread: true })`のスレッドを自動作成/バインドするためにtrueである必要があります。
    - `spawnAcpSessions`はACP（`/acp spawn ... --thread ...`または`sessions_spawn({ runtime: "acp", thread: true })`）のスレッドを自動作成/バインドするためにtrueである必要があります。
    - アカウントでスレッドバインディングが無効になっている場合、`/focus`および関連するスレッドバインディング操作は利用できません。

    [サブエージェント](/tools/subagents)、[ACPエージェント](/tools/acp-agents)、および[設定リファレンス](/gateway/configuration-reference)を参照してください。

  </Accordion>

  <Accordion title="リアクション通知">
    ギルドごとのリアクション通知モード:

    - `off`
    - `own`（デフォルト）
    - `all`
    - `allowlist`（`guilds.<id>.users`を使用）

    リアクションイベントはシステムイベントに変換され、ルーティングされたDiscordセッションに添付されます。

  </Accordion>

  <Accordion title="確認リアクション">
    `ackReaction`はOpenClawが受信メッセージを処理中に確認絵文字を送信します。

    解決順序:

    - `channels.discord.accounts.<accountId>.ackReaction`
    - `channels.discord.ackReaction`
    - `messages.ackReaction`
    - エージェントアイデンティティ絵文字フォールバック（`agents.list[].identity.emoji`、それ以外は"👀"）

    注意:

    - DiscordはUnicode絵文字またはカスタム絵文字名を受け付けます。
    - チャンネルまたはアカウントのリアクションを無効にするには`""`を使用します。

  </Accordion>

  <Accordion title="設定の書き込み">
    チャンネル起動の設定書き込みはデフォルトで有効です。

    これは`/config set|unset`フロー（コマンド機能が有効な場合）に影響します。

    無効化:

```json5
{
  channels: {
    discord: {
      configWrites: false,
    },
  },
}
```

  </Accordion>

  <Accordion title="Gatewayプロキシ">
    DiscordゲートウェイWebSocketトラフィックと起動時のREST検索（アプリケーションID + 許可リスト解決）を`channels.discord.proxy`でHTTP(S)プロキシ経由でルーティングします。

```json5
{
  channels: {
    discord: {
      proxy: "http://proxy.example:8080",
    },
  },
}
```

    アカウントごとのオーバーライド:

```json5
{
  channels: {
    discord: {
      accounts: {
        primary: {
          proxy: "http://proxy.example:8080",
        },
      },
    },
  },
}
```

  </Accordion>

  <Accordion title="PluralKitサポート">
    PluralKit解決を有効にして、プロキシされたメッセージをシステムメンバーアイデンティティにマッピングします:

```json5
{
  channels: {
    discord: {
      pluralkit: {
        enabled: true,
        token: "pk_live_...", // オプション、プライベートシステムに必要
      },
    },
  },
}
```

    注意:

    - 許可リストは`pk:<memberId>`を使用できます
    - メンバー表示名は`channels.discord.dangerouslyAllowNameMatching: true`の場合のみ名前/スラッグで一致します
    - 検索は元のメッセージIDを使用し、タイムウィンドウの制約があります
    - 検索が失敗した場合、プロキシされたメッセージはボットメッセージとして扱われ、`allowBots=true`でない限りドロップされます

  </Accordion>

  <Accordion title="プレゼンス設定">
    プレゼンス更新は、ステータスまたはアクティビティフィールドを設定した場合にのみ適用されます。

    ステータスのみの例:

```json5
{
  channels: {
    discord: {
      status: "idle",
    },
  },
}
```

    アクティビティの例（カスタムステータスがデフォルトのアクティビティタイプ）:

```json5
{
  channels: {
    discord: {
      activity: "Focus time",
      activityType: 4,
    },
  },
}
```

    ストリーミングの例:

```json5
{
  channels: {
    discord: {
      activity: "Live coding",
      activityType: 1,
      activityUrl: "https://twitch.tv/openclaw",
    },
  },
}
```

    アクティビティタイプマップ:

    - 0: Playing
    - 1: Streaming（`activityUrl`が必要）
    - 2: Listening
    - 3: Watching
    - 4: Custom（アクティビティテキストをステータスステートとして使用、絵文字はオプション）
    - 5: Competing

  </Accordion>

  <Accordion title="Discordでのexec承認">
    DiscordはDMでのボタンベースのexec承認をサポートし、オプションで発信元チャンネルに承認プロンプトを投稿できます。

    設定パス:

    - `channels.discord.execApprovals.enabled`
    - `channels.discord.execApprovals.approvers`
    - `channels.discord.execApprovals.target`（`dm` | `channel` | `both`、デフォルト: `dm`）
    - `agentFilter`、`sessionFilter`、`cleanupAfterResolve`

    `target`が`channel`または`both`の場合、承認プロンプトはチャンネルに表示されます。設定された承認者のみがボタンを使用でき、他のユーザーにはエフェメラルな拒否が表示されます。承認プロンプトにはコマンドテキストが含まれるため、信頼できるチャンネルでのみチャンネル配信を有効にしてください。セッションキーからチャンネルIDを導出できない場合、OpenClawはDM配信にフォールバックします。

    承認が不明な承認IDで失敗する場合は、承認者リストと機能の有効化を確認してください。

    関連ドキュメント: [exec承認](/tools/exec-approvals)

  </Accordion>
</AccordionGroup>

## ツールとアクションゲート

Discordメッセージアクションには、メッセージング、チャンネル管理、モデレーション、プレゼンス、およびメタデータアクションが含まれます。

主な例:

- メッセージング: `sendMessage`、`readMessages`、`editMessage`、`deleteMessage`、`threadReply`
- リアクション: `react`、`reactions`、`emojiList`
- モデレーション: `timeout`、`kick`、`ban`
- プレゼンス: `setPresence`

アクションゲートは`channels.discord.actions.*`にあります。

デフォルトのゲート動作:

| アクショングループ | デフォルト |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| reactions, messages, threads, pins, polls, search, memberInfo, roleInfo, channelInfo, channels, voiceStatus, events, stickers, emojiUploads, stickerUploads, permissions | 有効 |
| roles | 無効 |
| moderation | 無効 |
| presence | 無効 |

## Components v2 UI

OpenClawはexec承認とクロスコンテキストマーカーにDiscord components v2を使用します。Discordメッセージアクションもカスタム UI用に`components`を受け付けることができます（上級、Carbonコンポーネントインスタンスが必要）。レガシーの`embeds`は引き続き利用可能ですが推奨されません。

- `channels.discord.ui.components.accentColor`はDiscordコンポーネントコンテナで使用されるアクセントカラーを設定します（16進数）。
- アカウントごとに`channels.discord.accounts.<id>.ui.components.accentColor`で設定します。
- components v2が存在する場合、`embeds`は無視されます。

例:

```json5
{
  channels: {
    discord: {
      ui: {
        components: {
          accentColor: "#5865F2",
        },
      },
    },
  },
}
```

## ボイスチャンネル

OpenClawはリアルタイムの継続的な会話のためにDiscordボイスチャンネルに参加できます。これはボイスメッセージ添付ファイルとは別です。

要件:

- ネイティブコマンドを有効にします（`commands.native`または`channels.discord.commands.native`）。
- `channels.discord.voice`を設定します。
- ボットはターゲットボイスチャンネルでConnect + Speak権限が必要です。

Discord専用のネイティブコマンド`/vc join|leave|status`を使用してセッションを制御します。このコマンドはアカウントのデフォルトエージェントを使用し、他のDiscordコマンドと同じ許可リストとグループポリシールールに従います。

自動参加の例:

```json5
{
  channels: {
    discord: {
      voice: {
        enabled: true,
        autoJoin: [
          {
            guildId: "123456789012345678",
            channelId: "234567890123456789",
          },
        ],
        daveEncryption: true,
        decryptionFailureTolerance: 24,
        tts: {
          provider: "openai",
          openai: { voice: "alloy" },
        },
      },
    },
  },
}
```

注意:

- `voice.tts`はボイス再生のみの`messages.tts`をオーバーライドします。
- ボイスはデフォルトで有効です。無効にするには`channels.discord.voice.enabled=false`を設定します。
- `voice.daveEncryption`と`voice.decryptionFailureTolerance`は`@discordjs/voice`のjoinオプションにパススルーされます。
- `@discordjs/voice`のデフォルトは、未設定の場合`daveEncryption=true`と`decryptionFailureTolerance=24`です。
- OpenClawは受信の復号化失敗も監視し、短時間に繰り返し失敗が発生した後、ボイスチャンネルを退出/再参加して自動回復します。
- 受信ログが繰り返し`DecryptionFailed(UnencryptedWhenPassthroughDisabled)`を表示する場合、これは[discord.js #11419](https://github.com/discordjs/discord.js/issues/11419)で追跡されている上流の`@discordjs/voice`受信バグの可能性があります。

## ボイスメッセージ

Discordボイスメッセージは波形プレビューを表示し、OGG/Opusオーディオとメタデータが必要です。OpenClawは波形を自動生成しますが、オーディオファイルの検査と変換のためにゲートウェイホストで`ffmpeg`と`ffprobe`が利用可能である必要があります。

要件と制約:

- **ローカルファイルパス**を提供してください（URLは拒否されます）。
- テキストコンテンツを省略してください（Discordは同じペイロードでテキスト + ボイスメッセージを許可しません）。
- 任意のオーディオ形式が受け付けられます。OpenClawは必要に応じてOGG/Opusに変換します。

例:

```bash
message(action="send", channel="discord", target="channel:123", path="/path/to/audio.mp3", asVoice=true)
```

## トラブルシューティング

<AccordionGroup>
  <Accordion title="許可されていないインテントの使用またはボットがギルドメッセージを見られない">

    - Message Content Intentを有効にする
    - ユーザー/メンバー解決に依存する場合はServer Members Intentを有効にする
    - インテント変更後にゲートウェイを再起動する

  </Accordion>

  <Accordion title="ギルドメッセージが予期せずブロックされる">

    - `groupPolicy`を確認
    - `channels.discord.guilds`のギルド許可リストを確認
    - ギルドに`channels`マップがある場合、リストされたチャンネルのみが許可される
    - `requireMention`の動作とメンションパターンを確認

    便利なチェック:

```bash
openclaw doctor
openclaw channels status --probe
openclaw logs --follow
```

  </Accordion>

  <Accordion title="requireMentionがfalseなのにブロックされる">
    一般的な原因:

    - `groupPolicy="allowlist"`で一致するギルド/チャンネル許可リストがない
    - `requireMention`が間違った場所に設定されている（`channels.discord.guilds`またはチャンネルエントリの下に配置する必要がある）
    - 送信者がギルド/チャンネルの`users`許可リストでブロックされている

  </Accordion>

  <Accordion title="権限監査の不一致">
    `channels status --probe`の権限チェックは数値チャンネルIDに対してのみ機能します。

    スラッグキーを使用している場合、ランタイムマッチングは引き続き機能しますが、プローブは権限を完全に検証できません。

  </Accordion>

  <Accordion title="DMとペアリングの問題">

    - DM無効: `channels.discord.dm.enabled=false`
    - DMポリシー無効: `channels.discord.dmPolicy="disabled"`（レガシー: `channels.discord.dm.policy`）
    - `pairing`モードでペアリング承認待ち

  </Accordion>

  <Accordion title="ボット間ループ">
    デフォルトではボットが作成したメッセージは無視されます。

    `channels.discord.allowBots=true`を設定する場合は、ループ動作を避けるために厳密なメンションと許可リストルールを使用してください。

  </Accordion>

  <Accordion title="ボイスSTTがDecryptionFailed(...)でドロップする">

    - OpenClawを最新に保ってください（`openclaw update`）。Discordボイス受信の回復ロジックが存在するようにします
    - `channels.discord.voice.daveEncryption=true`（デフォルト）を確認
    - `channels.discord.voice.decryptionFailureTolerance=24`（上流のデフォルト）から開始し、必要な場合のみ調整
    - ログを監視:
      - `discord voice: DAVE decrypt failures detected`
      - `discord voice: repeated decrypt failures; attempting rejoin`
    - 自動再参加後も失敗が続く場合は、ログを収集して[discord.js #11419](https://github.com/discordjs/discord.js/issues/11419)と比較

  </Accordion>
</AccordionGroup>

## 設定リファレンスポインター

主要リファレンス:

- [設定リファレンス - Discord](/gateway/configuration-reference#discord)

重要なDiscordフィールド:

- 起動/認証: `enabled`、`token`、`accounts.*`、`allowBots`
- ポリシー: `groupPolicy`、`dm.*`、`guilds.*`、`guilds.*.channels.*`
- コマンド: `commands.native`、`commands.useAccessGroups`、`configWrites`、`slashCommand.*`
- 返信/履歴: `replyToMode`、`historyLimit`、`dmHistoryLimit`、`dms.*.historyLimit`
- 配信: `textChunkLimit`、`chunkMode`、`maxLinesPerMessage`
- ストリーミング: `streaming`（レガシーエイリアス: `streamMode`）、`draftChunk`、`blockStreaming`、`blockStreamingCoalesce`
- メディア/リトライ: `mediaMaxMb`、`retry`
- アクション: `actions.*`
- プレゼンス: `activity`、`status`、`activityType`、`activityUrl`
- UI: `ui.components.accentColor`
- 機能: `pluralkit`、`execApprovals`、`intents`、`agentComponents`、`heartbeat`、`responsePrefix`

## セキュリティと運用

- ボットトークンをシークレットとして扱います（管理された環境では`DISCORD_BOT_TOKEN`推奨）。
- 最小権限のDiscord権限を付与します。
- コマンドのデプロイ/状態が古い場合は、ゲートウェイを再起動し`openclaw channels status --probe`で再確認してください。

## 関連

- [ペアリング](/channels/pairing)
- [チャンネルルーティング](/channels/channel-routing)
- [マルチエージェントルーティング](/concepts/multi-agent)
- [トラブルシューティング](/channels/troubleshooting)
- [スラッシュコマンド](/tools/slash-commands)
