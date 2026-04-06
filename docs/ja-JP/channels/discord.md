---
summary: "Discord ボットのサポート状況、機能、および設定"
read_when:
  - Discord チャンネル機能を開発するとき
title: "Discord"
x-i18n:
    generated_at: "2026-04-03T00:00:00Z"
    model: claude-sonnet-4-6
    provider: anthropic
    source_hash: cceb25d11397a918ca97f7bd3586c7be5506eea40ab1863cea8f151774432f6b
    source_path: channels/discord.md
    workflow: 15
---

# Discord (Bot API)

ステータス: 公式 Discord Gateway を通じた DM およびギルドチャンネルで使用できます。

<CardGroup cols={3}>
  <Card title="ペアリング" icon="link" href="/channels/pairing">
    Discord DM のデフォルトはペアリングモードです。
  </Card>
  <Card title="スラッシュコマンド" icon="terminal" href="/tools/slash-commands">
    ネイティブコマンドの動作とコマンドカタログ。
  </Card>
  <Card title="チャンネルトラブルシューティング" icon="wrench" href="/channels/troubleshooting">
    チャンネル横断の診断と修復フロー。
  </Card>
</CardGroup>

## クイックセットアップ

ボットを持つ新しいアプリケーションを作成し、サーバーにボットを追加して、OpenClaw とペアリングする必要があります。ボットを自分専用のプライベートサーバーに追加することを推奨します。まだ持っていない場合は、[先にサーバーを作成してください](https://support.discord.com/hc/en-us/articles/204849977-How-do-I-create-a-server)（**自分用に作成 > 自分と友達のために** を選択）。

<Steps>
  <Step title="Discord アプリケーションとボットを作成する">
    [Discord Developer Portal](https://discord.com/developers/applications) にアクセスし、**New Application** をクリックします。「OpenClaw」などの名前を付けてください。

    サイドバーの **Bot** をクリックします。**Username** を OpenClaw エージェントの名前に設定します。

  </Step>

  <Step title="特権インテントを有効にする">
    **Bot** ページのまま、**Privileged Gateway Intents** までスクロールして以下を有効にします:

    - **Message Content Intent**（必須）
    - **Server Members Intent**（推奨; ロールの許可リストと名前からIDへの変換に必要）
    - **Presence Intent**（オプション; プレゼンス更新にのみ必要）

  </Step>

  <Step title="ボットトークンをコピーする">
    **Bot** ページの上部にスクロールして **Reset Token** をクリックします。

    <Note>
    名称に反して、これは最初のトークンを生成するものです — 「リセット」されるものは何もありません。
    </Note>

    トークンをコピーして保存してください。これは **Bot Token** で、すぐに必要になります。

  </Step>

  <Step title="招待 URL を生成してボットをサーバーに追加する">
    サイドバーの **OAuth2** をクリックします。ボットをサーバーに追加するための適切な権限を持つ招待 URL を生成します。

    **OAuth2 URL Generator** までスクロールして以下を有効にします:

    - `bot`
    - `applications.commands`

    下に **Bot Permissions** セクションが表示されます。以下を有効にします:

    - チャンネルを見る
    - メッセージを送信する
    - メッセージ履歴を読む
    - リンクを埋め込む
    - ファイルを添付する
    - リアクションを追加（オプション）

    下部に生成された URL をコピーしてブラウザに貼り付け、サーバーを選択し **Continue** をクリックして接続します。Discord サーバーにボットが表示されるはずです。

  </Step>

  <Step title="デベロッパーモードを有効にして ID を収集する">
    Discord アプリに戻り、デベロッパーモードを有効にして内部 ID をコピーできるようにします。

    1. **ユーザー設定**（アバター横の歯車アイコン）→ **詳細設定** → **デベロッパーモード** をオンにする
    2. サイドバーの**サーバーアイコン**を右クリック → **サーバー ID をコピー**
    3. **自分のアバター**を右クリック → **ユーザー ID をコピー**

    **サーバー ID** と **ユーザー ID** を Bot Token とともに保存してください — 次のステップで3つすべてを OpenClaw に送信します。

  </Step>

  <Step title="サーバーメンバーからの DM を許可する">
    ペアリングが機能するには、Discord がボットからの DM を許可する必要があります。**サーバーアイコン**を右クリック → **プライバシー設定** → **ダイレクトメッセージ** をオンにします。

    これにより、サーバーメンバー（ボットを含む）があなたに DM を送信できます。OpenClaw で Discord DM を使用する場合はこれを有効にしてください。ギルドチャンネルのみ使用する場合は、ペアリング後に DM を無効にできます。

  </Step>

  <Step title="ボットトークンを安全に設定する（チャットで送信しないこと）">
    Discord ボットトークンはシークレット（パスワードのようなもの）です。エージェントにメッセージを送信する前に、OpenClaw が実行されているマシンに設定してください。

```bash
export DISCORD_BOT_TOKEN="YOUR_BOT_TOKEN"
openclaw config set channels.discord.token --ref-provider default --ref-source env --ref-id DISCORD_BOT_TOKEN --dry-run
openclaw config set channels.discord.token --ref-provider default --ref-source env --ref-id DISCORD_BOT_TOKEN
openclaw config set channels.discord.enabled true --strict-json
openclaw gateway
```

    OpenClaw がすでにバックグラウンドサービスとして実行されている場合は、OpenClaw Mac アプリを介してか、`openclaw gateway run` プロセスを停止・再起動して再起動してください。

  </Step>

  <Step title="OpenClaw を設定してペアリングする">

    <Tabs>
      <Tab title="エージェントに依頼する">
        既存のチャンネル（例: Telegram）で OpenClaw エージェントとチャットして伝えます。Discord が最初のチャンネルの場合は、CLI / 設定タブを代わりに使用してください。

        > 「Discord ボットトークンは設定済みです。ユーザー ID `<user_id>` とサーバー ID `<server_id>` で Discord のセットアップを完了してください。」
      </Tab>
      <Tab title="CLI / 設定">
        ファイルベースの設定を好む場合は、以下を設定します:

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: {
        source: "env",
        provider: "default",
        id: "DISCORD_BOT_TOKEN",
      },
    },
  },
}
```

        デフォルトアカウントの環境変数フォールバック:

```bash
DISCORD_BOT_TOKEN=...
```

        プレーンテキストの `token` 値がサポートされています。SecretRef 値も `channels.discord.token` に対して env/file/exec プロバイダーでサポートされています。[シークレット管理](/gateway/secrets)を参照してください。

      </Tab>
    </Tabs>

  </Step>

  <Step title="最初の DM ペアリングを承認する">
    Gateway ゲートウェイが起動するのを待ってから、Discord でボットに DM を送信します。ボットはペアリングコードで応答します。

    <Tabs>
      <Tab title="エージェントに依頼する">
        既存のチャンネルのエージェントにペアリングコードを送信します:

        > 「この Discord ペアリングコードを承認してください: `<CODE>`」
      </Tab>
      <Tab title="CLI">

```bash
openclaw pairing list discord
openclaw pairing approve discord <CODE>
```

      </Tab>
    </Tabs>

    ペアリングコードは 1 時間後に期限切れになります。

    これで Discord の DM でエージェントとチャットできるようになります。

  </Step>
</Steps>

<Note>
トークンの解決はアカウント対応です。設定のトークン値は環境変数フォールバックより優先されます。`DISCORD_BOT_TOKEN` はデフォルトアカウントにのみ使用されます。
高度な送信呼び出し（メッセージツール / チャンネルアクション）では、その呼び出しに明示的なトークンが使用されます。これは送信および読み取り / プローブスタイルのアクション（例: 読み取り / 検索 / フェッチ / スレッド / ピン / 権限）に適用されます。アカウントポリシー / リトライ設定は、アクティブなランタイムスナップショット内の選択されたアカウントから取得されます。
</Note>

## 推奨: ギルドワークスペースを設定する

DM が機能したら、Discord サーバーを各チャンネルが独自のコンテキストを持つ独立したエージェントセッションを持つフルワークスペースとして設定できます。これはあなたとボットだけのプライベートサーバーに推奨されます。

<Steps>
  <Step title="サーバーをギルド許可リストに追加する">
    これにより、エージェントが DM だけでなくサーバー上の任意のチャンネルで応答できるようになります。

    <Tabs>
      <Tab title="エージェントに依頼する">
        > 「Discord サーバー ID `<server_id>` をギルド許可リストに追加してください」
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

  <Step title="@mention なしの応答を許可する">
    デフォルトでは、エージェントは @mention されたときのみギルドチャンネルで応答します。プライベートサーバーでは、すべてのメッセージに応答させたいでしょう。

    <Tabs>
      <Tab title="エージェントに依頼する">
        > 「@mention なしでもこのサーバーで応答できるようにしてください」
      </Tab>
      <Tab title="設定">
        ギルド設定で `requireMention: false` を設定します:

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

  <Step title="ギルドチャンネルでのメモリを計画する">
    デフォルトでは、長期メモリ（MEMORY.md）は DM セッションでのみロードされます。ギルドチャンネルでは MEMORY.md は自動ロードされません。

    <Tabs>
      <Tab title="エージェントに依頼する">
        > 「Discord チャンネルで質問する際は、MEMORY.md から長期コンテキストが必要な場合は memory_search または memory_get を使用してください。」
      </Tab>
      <Tab title="手動">
        すべてのチャンネルで共有コンテキストが必要な場合は、安定した指示を `AGENTS.md` または `USER.md` に記述してください（すべてのセッションに注入されます）。長期メモは `MEMORY.md` に保存し、メモリツールでオンデマンドにアクセスしてください。
      </Tab>
    </Tabs>

  </Step>
</Steps>

Discord サーバーにいくつかのチャンネルを作成してチャットを始めましょう。エージェントはチャンネル名を認識でき、各チャンネルは独自の分離されたセッションを持ちます — `#coding`、`#home`、`#research` など、ワークフローに合ったものを設定できます。

## ランタイムモデル

- Gateway ゲートウェイが Discord 接続を管理します。
- 返信ルーティングは決定論的です: Discord のインバウンドは Discord に返信されます。
- デフォルト（`session.dmScope=main`）では、ダイレクトチャットはエージェントのメインセッション（`agent:main:main`）を共有します。
- ギルドチャンネルは分離されたセッションキーを使用します（`agent:<agentId>:discord:channel:<channelId>`）。
- グループ DM はデフォルトで無視されます（`channels.discord.dm.groupEnabled=false`）。
- ネイティブスラッシュコマンドは分離されたコマンドセッション（`agent:<agentId>:discord:slash:<userId>`）で実行され、ルーティングされた会話セッションに `CommandTargetSessionKey` を持ちます。

## フォーラムチャンネル

Discord のフォーラムおよびメディアチャンネルはスレッド投稿のみを受け付けます。OpenClaw はそれらを作成するための 2 つの方法をサポートしています:

- フォーラムの親（`channel:<forumId>`）にメッセージを送信してスレッドを自動作成します。スレッドタイトルはメッセージの最初の空でない行が使用されます。
- `openclaw message thread create` を使用してスレッドを直接作成します。フォーラムチャンネルでは `--message-id` を渡さないでください。

例: フォーラム親に送信してスレッドを作成する

```bash
openclaw message send --channel discord --target channel:<forumId> \
  --message "Topic title\nBody of the post"
```

例: フォーラムスレッドを明示的に作成する

```bash
openclaw message thread create --channel discord --target channel:<forumId> \
  --thread-name "Topic title" --message "Body of the post"
```

フォーラム親は Discord コンポーネントを受け付けません。コンポーネントが必要な場合は、スレッド自体（`channel:<threadId>`）に送信してください。

## インタラクティブコンポーネント

OpenClaw はエージェントメッセージに Discord コンポーネント v2 コンテナをサポートしています。`components` ペイロードでメッセージツールを使用します。インタラクション結果は通常のインバウンドメッセージとしてエージェントに戻され、既存の Discord `replyToMode` 設定に従います。

サポートされているブロック:

- `text`、`section`、`separator`、`actions`、`media-gallery`、`file`
- アクション行は最大 5 つのボタンまたは 1 つのセレクトメニューを許可します
- セレクトタイプ: `string`、`user`、`role`、`mentionable`、`channel`

デフォルトでは、コンポーネントは一度だけ使用できます。`components.reusable=true` を設定すると、ボタン、セレクト、フォームが期限切れになるまで複数回使用できます。

ボタンをクリックできるユーザーを制限するには、そのボタンに `allowedUsers`（Discord ユーザー ID、タグ、または `*`）を設定します。設定された場合、マッチしないユーザーはエフェメラルな拒否を受け取ります。

`/model` と `/models` スラッシュコマンドは、プロバイダーとモデルのドロップダウンおよび送信ステップを含むインタラクティブなモデルピッカーを開きます。ピッカーの返信はエフェメラルで、呼び出したユーザーのみが使用できます。

ファイル添付:

- `file` ブロックは添付参照（`attachment://<filename>`）を指す必要があります
- `media`/`path`/`filePath`（単一ファイル）で添付を提供します; 複数ファイルには `media-gallery` を使用します
- 添付参照と一致するようにアップロード名を上書きする場合は `filename` を使用します

モーダルフォーム:

- 最大 5 つのフィールドを持つ `components.modal` を追加します
- フィールドタイプ: `text`、`checkbox`、`radio`、`select`、`role-select`、`user-select`
- OpenClaw がトリガーボタンを自動的に追加します

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
  <Tab title="DM ポリシー">
    `channels.discord.dmPolicy` は DM アクセスを制御します（レガシー: `channels.discord.dm.policy`）:

    - `pairing`（デフォルト）
    - `allowlist`
    - `open`（`channels.discord.allowFrom` に `"*"` を含める必要あり; レガシー: `channels.discord.dm.allowFrom`）
    - `disabled`

    DM ポリシーがオープンでない場合、不明なユーザーはブロックされます（`pairing` モードではペアリングを求められます）。

    マルチアカウントの優先順位:

    - `channels.discord.accounts.default.allowFrom` は `default` アカウントにのみ適用されます。
    - 名前付きアカウントは、自身の `allowFrom` が未設定の場合、`channels.discord.allowFrom` を継承します。
    - 名前付きアカウントは `channels.discord.accounts.default.allowFrom` を継承しません。

    配信用の DM ターゲットフォーマット:

    - `user:<id>`
    - `<@id>` メンション

    数値のみの ID は曖昧で、明示的なユーザー / チャンネルターゲット種別が提供されない限り拒否されます。

  </Tab>

  <Tab title="ギルドポリシー">
    ギルドの処理は `channels.discord.groupPolicy` で制御されます:

    - `open`
    - `allowlist`
    - `disabled`

    `channels.discord` が存在する場合のセキュアなベースラインは `allowlist` です。

    `allowlist` の動作:

    - ギルドは `channels.discord.guilds` に一致する必要があります（ID 優先、スラグも使用可）
    - オプションの送信者許可リスト: `users`（安定した ID 推奨）と `roles`（ロール ID のみ）; どちらかが設定されている場合、送信者は `users` または `roles` に一致するときに許可されます
    - 直接的な名前/タグマッチングはデフォルトで無効; ブレークグラスの互換モードとしてのみ `channels.discord.dangerouslyAllowNameMatching: true` を有効にしてください
    - `users` の名前/タグはサポートされていますが、ID の方が安全です; `openclaw security audit` は名前/タグエントリが使用されている場合に警告します
    - ギルドに `channels` が設定されている場合、リストにないチャンネルは拒否されます
    - ギルドに `channels` ブロックがない場合、その許可されたギルドのすべてのチャンネルが許可されます

    例:

```json5
{
  channels: {
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        "123456789012345678": {
          requireMention: true,
          ignoreOtherMentions: true,
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

    `DISCORD_BOT_TOKEN` のみを設定して `channels.discord` ブロックを作成しない場合、ランタイムフォールバックは `groupPolicy="allowlist"`（ログに警告あり）となります（`channels.defaults.groupPolicy` が `open` に設定されていても）。

  </Tab>

  <Tab title="メンションとグループ DM">
    ギルドメッセージはデフォルトでメンションゲートされています。

    メンション検出には以下が含まれます:

    - 明示的なボットメンション
    - 設定されたメンションパターン（`agents.list[].groupChat.mentionPatterns`、フォールバック `messages.groupChat.mentionPatterns`）
    - サポートされているケースでの暗黙のボットへの返信動作

    `requireMention` はギルド / チャンネルごとに設定されます（`channels.discord.guilds...`）。
    `ignoreOtherMentions` はオプションで、ボットではなく別のユーザー/ロールをメンションするメッセージを削除します（@everyone / @here を除く）。

    グループ DM:

    - デフォルト: 無視（`dm.groupEnabled=false`）
    - `dm.groupChannels`（チャンネル ID またはスラグ）でオプションの許可リストを設定

  </Tab>
</Tabs>

### ロールベースのエージェントルーティング

`bindings[].match.roles` を使用して、ロール ID で Discord ギルドメンバーを異なるエージェントにルーティングします。ロールベースのバインディングはロール ID のみを受け付け、ピアまたは親ピアのバインディングの後、ギルドのみのバインディングの前に評価されます。バインディングに他のマッチフィールドも設定されている場合（例: `peer` + `guildId` + `roles`）、設定されたすべてのフィールドが一致する必要があります。

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

## デベロッパーポータルのセットアップ

<AccordionGroup>
  <Accordion title="アプリとボットを作成する">

    1. Discord Developer Portal -> **Applications** -> **New Application**
    2. **Bot** -> **Add Bot**
    3. ボットトークンをコピーする

  </Accordion>

  <Accordion title="特権インテント">
    **Bot -> Privileged Gateway Intents** で以下を有効にします:

    - Message Content Intent
    - Server Members Intent（推奨）

    Presence インテントはオプションで、メンバーのプレゼンス更新を受信する場合のみ必要です。ボットのプレゼンスを設定（`setPresence`）する場合はメンバーのプレゼンス更新を有効にする必要はありません。

  </Accordion>

  <Accordion title="OAuth スコープとベースライン権限">
    OAuth URL ジェネレーター:

    - スコープ: `bot`、`applications.commands`

    典型的なベースライン権限:

    - チャンネルを見る
    - メッセージを送信する
    - メッセージ履歴を読む
    - リンクを埋め込む
    - ファイルを添付する
    - リアクションを追加（オプション）

    明示的に必要な場合を除き `Administrator` は避けてください。

  </Accordion>

  <Accordion title="ID をコピーする">
    Discord デベロッパーモードを有効にして、以下をコピーします:

    - サーバー ID
    - チャンネル ID
    - ユーザー ID

    信頼性の高い監査とプローブのために OpenClaw 設定では数値 ID を優先してください。

  </Accordion>
</AccordionGroup>

## ネイティブコマンドとコマンド認証

- `commands.native` はデフォルトで `"auto"` であり、Discord では有効です。
- チャンネルごとの上書き: `channels.discord.commands.native`。
- `commands.native=false` は以前に登録された Discord ネイティブコマンドを明示的にクリアします。
- ネイティブコマンド認証は、通常のメッセージ処理と同じ Discord 許可リスト / ポリシーを使用します。
- コマンドは認証されていないユーザーの Discord UI にも表示される場合がありますが、実行時には OpenClaw 認証が強制され「not authorized」が返されます。

コマンドカタログと動作については[スラッシュコマンド](/tools/slash-commands)を参照してください。

デフォルトのスラッシュコマンド設定:

- `ephemeral: true`

## 機能の詳細

<AccordionGroup>
  <Accordion title="返信タグとネイティブ返信">
    Discord はエージェント出力の返信タグをサポートしています:

    - `[[reply_to_current]]`
    - `[[reply_to:<id>]]`

    `channels.discord.replyToMode` で制御:

    - `off`（デフォルト）
    - `first`
    - `all`

    注意: `off` は暗黙の返信スレッドを無効にします。明示的な `[[reply_to_*]]` タグはまだ尊重されます。

    メッセージ ID はコンテキスト / 履歴に表示されるため、エージェントが特定のメッセージを対象にできます。

  </Accordion>

  <Accordion title="ライブストリームプレビュー">
    OpenClaw は一時的なメッセージを送信してテキストが届くたびに編集することで、下書き返信をストリーミングできます。

    - `channels.discord.streaming` はプレビューストリーミングを制御します（`off` | `partial` | `block` | `progress`、デフォルト: `off`）。
    - Discord のプレビュー編集は、特に複数のボットやゲートウェイが同じアカウントやギルドトラフィックを共有する場合にレート制限にすぐに達する可能性があるため、デフォルトは `off` のままです。
    - `progress` はクロスチャンネルの一貫性のために受け付けられ、Discord では `partial` にマッピングされます。
    - `channels.discord.streamMode` はレガシーエイリアスで自動マイグレーションされます。
    - `partial` はトークンが届くたびに単一のプレビューメッセージを編集します。
    - `block` は下書きサイズのチャンク（`draftChunk` でサイズとブレークポイントを調整）を出力します。

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

    `block` モードのチャンキングデフォルト（`channels.discord.textChunkLimit` にクランプ）:

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

    プレビューストリーミングはテキストのみです; メディア返信は通常の配信にフォールバックします。

    注意: プレビューストリーミングはブロックストリーミングとは別です。Discord でブロックストリーミングが明示的に有効になっている場合、OpenClaw は二重ストリーミングを避けるためにプレビューストリームをスキップします。

  </Accordion>

  <Accordion title="履歴、コンテキスト、スレッドの動作">
    ギルド履歴コンテキスト:

    - `channels.discord.historyLimit` デフォルト `20`
    - フォールバック: `messages.groupChat.historyLimit`
    - `0` で無効

    DM 履歴コントロール:

    - `channels.discord.dmHistoryLimit`
    - `channels.discord.dms["<user_id>"].historyLimit`

    スレッドの動作:

    - Discord スレッドはチャンネルセッションとしてルーティングされます
    - 親スレッドメタデータは親セッションリンケージに使用できます
    - スレッド設定はスレッド固有のエントリがない限り親チャンネル設定を継承します

    チャンネルのトピックは**信頼されていない**コンテキストとして注入されます（システムプロンプトとしてではなく）。

  </Accordion>

  <Accordion title="サブエージェント用スレッドバウンドセッション">
    Discord はスレッドをセッションターゲットにバインドできるため、そのスレッドの後続メッセージは同じセッション（サブエージェントセッションを含む）にルーティングされ続けます。

    コマンド:

    - `/focus <target>` 現在/新しいスレッドをサブエージェント/セッションターゲットにバインドする
    - `/unfocus` 現在のスレッドバインディングを削除する
    - `/agents` アクティブな実行とバインディング状態を表示する
    - `/session idle <duration|off>` フォーカスされたバインディングの非アクティブ自動アンフォーカスを確認/更新する
    - `/session max-age <duration|off>` フォーカスされたバインディングのハード最大年齢を確認/更新する

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

    - `session.threadBindings.*` はグローバルなデフォルトを設定します。
    - `channels.discord.threadBindings.*` は Discord の動作を上書きします。
    - `spawnSubagentSessions` は `sessions_spawn({ thread: true })` でスレッドを自動作成/バインドするために true にする必要があります。
    - `spawnAcpSessions` は ACP（`/acp spawn ... --thread ...` または `sessions_spawn({ runtime: "acp", thread: true })`）でスレッドを自動作成/バインドするために true にする必要があります。
    - アカウントでスレッドバインディングが無効になっている場合、`/focus` と関連するスレッドバインディング操作は使用できません。

    [サブエージェント](/tools/subagents)、[ACP エージェント](/tools/acp-agents)、および[設定リファレンス](/gateway/configuration-reference)を参照してください。

  </Accordion>

  <Accordion title="永続的な ACP チャンネルバインディング">
    安定した「常時オン」の ACP ワークスペースのために、Discord 会話をターゲットにする最上位の型付き ACP バインディングを設定します。

    設定パス:

    - `bindings[]` に `type: "acp"` と `match.channel: "discord"` を設定

    例:

```json5
{
  agents: {
    list: [
      {
        id: "codex",
        runtime: {
          type: "acp",
          acp: {
            agent: "codex",
            backend: "acpx",
            mode: "persistent",
            cwd: "/workspace/openclaw",
          },
        },
      },
    ],
  },
  bindings: [
    {
      type: "acp",
      agentId: "codex",
      match: {
        channel: "discord",
        accountId: "default",
        peer: { kind: "channel", id: "222222222222222222" },
      },
      acp: { label: "codex-main" },
    },
  ],
  channels: {
    discord: {
      guilds: {
        "111111111111111111": {
          channels: {
            "222222222222222222": {
              requireMention: false,
            },
          },
        },
      },
    },
  },
}
```

    注意:

    - `/acp spawn codex --bind here` は現在の Discord チャンネルまたはスレッドをその場でバインドし、将来のメッセージを同じ ACP セッションにルーティングし続けます。
    - これはまだ「新しい Codex ACP セッションを開始する」ことを意味しますが、それ自体では新しい Discord スレッドを作成しません。既存のチャンネルがチャットサーフェスとして残ります。
    - Codex はディスク上の自身の `cwd` またはバックエンドワークスペースで実行される場合があります。そのワークスペースはランタイム状態であり、Discord スレッドではありません。
    - スレッドメッセージは親チャンネルの ACP バインディングを継承できます。
    - バウンドチャンネルまたはスレッドでは、`/new` と `/reset` が同じ ACP セッションをその場でリセットします。
    - 一時的なスレッドバインディングはまだ機能し、アクティブな間はターゲット解決を上書きできます。
    - `spawnAcpSessions` は `--thread auto|here` でOpenClaw が子スレッドを作成/バインドする必要がある場合にのみ必要です。現在のチャンネルでの `/acp spawn ... --bind here` には必要ありません。

    バインディング動作の詳細については[ACP エージェント](/tools/acp-agents)を参照してください。

  </Accordion>

  <Accordion title="リアクション通知">
    ギルドごとのリアクション通知モード:

    - `off`
    - `own`（デフォルト）
    - `all`
    - `allowlist`（`guilds.<id>.users` を使用）

    リアクションイベントはシステムイベントに変換され、ルーティングされた Discord セッションに付加されます。

  </Accordion>

  <Accordion title="Ack リアクション">
    `ackReaction` は OpenClaw がインバウンドメッセージを処理している間に確認の絵文字を送信します。

    解決順序:

    - `channels.discord.accounts.<accountId>.ackReaction`
    - `channels.discord.ackReaction`
    - `messages.ackReaction`
    - エージェント ID の絵文字フォールバック（`agents.list[].identity.emoji`、それ以外は "👀"）

    注意:

    - Discord はユニコード絵文字またはカスタム絵文字名を受け付けます。
    - チャンネルまたはアカウントのリアクションを無効にするには `""` を使用します。

  </Accordion>

  <Accordion title="設定の書き込み">
    チャンネルで開始する設定の書き込みはデフォルトで有効です。

    これは `/config set|unset` フロー（コマンド機能が有効な場合）に影響します。

    無効にする:

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

  <Accordion title="Gateway ゲートウェイプロキシ">
    `channels.discord.proxy` で Discord Gateway ゲートウェイの WebSocket トラフィックとスタートアップ REST ルックアップ（アプリケーション ID + 許可リスト解決）を HTTP(S) プロキシ経由でルーティングします。

```json5
{
  channels: {
    discord: {
      proxy: "http://proxy.example:8080",
    },
  },
}
```

    アカウントごとの上書き:

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

  <Accordion title="PluralKit サポート">
    PluralKit 解決を有効にして、プロキシされたメッセージをシステムメンバー ID にマッピングします:

```json5
{
  channels: {
    discord: {
      pluralkit: {
        enabled: true,
        token: "pk_live_...", // オプション; プライベートシステムに必要
      },
    },
  },
}
```

    注意:

    - 許可リストは `pk:<memberId>` を使用できます
    - メンバーの表示名は `channels.discord.dangerouslyAllowNameMatching: true` の場合にのみ名前/スラグでマッチングされます
    - ルックアップは元のメッセージ ID を使用し、時間ウィンドウ制約があります
    - ルックアップが失敗した場合、プロキシされたメッセージはボットメッセージとして扱われ、`allowBots=true` でない限り削除されます

  </Accordion>

  <Accordion title="プレゼンス設定">
    ステータスまたはアクティビティフィールドを設定するか、自動プレゼンスを有効にすると、プレゼンス更新が適用されます。

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

    アクティビティの例（カスタムステータスはデフォルトのアクティビティタイプ）:

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

    アクティビティタイプのマッピング:

    - 0: プレイ中
    - 1: ストリーミング（`activityUrl` が必要）
    - 2: 聴いている
    - 3: 見ている
    - 4: カスタム（アクティビティテキストをステータス状態として使用; 絵文字はオプション）
    - 5: 競争中

    自動プレゼンスの例（ランタイムヘルスシグナル）:

```json5
{
  channels: {
    discord: {
      autoPresence: {
        enabled: true,
        intervalMs: 30000,
        minUpdateIntervalMs: 15000,
        exhaustedText: "token exhausted",
      },
    },
  },
}
```

    自動プレゼンスはランタイムの可用性を Discord ステータスにマッピングします: 正常 => オンライン、劣化または不明 => アイドル、枯渇または利用不可 => dnd。オプションのテキスト上書き:

    - `autoPresence.healthyText`
    - `autoPresence.degradedText`
    - `autoPresence.exhaustedText`（`{reason}` プレースホルダーをサポート）

  </Accordion>

  <Accordion title="Discord での Exec 承認">
    Discord は DM でのボタンベースの exec 承認をサポートし、オプションで発信元チャンネルに承認プロンプトを投稿できます。

    設定パス:

    - `channels.discord.execApprovals.enabled`
    - `channels.discord.execApprovals.approvers`（オプション; `allowFrom` から推定されるオーナー ID と明示的な DM `defaultTo` にフォールバック）
    - `channels.discord.execApprovals.target`（`dm` | `channel` | `both`、デフォルト: `dm`）
    - `agentFilter`、`sessionFilter`、`cleanupAfterResolve`

    `enabled: true` であり少なくとも 1 人の承認者を解決できる場合（`execApprovals.approvers` またはアカウントの既存のオーナー設定から）、Discord は承認クライアントになります。

    `target` が `channel` または `both` の場合、承認プロンプトはチャンネルに表示されます。解決された承認者のみがボタンを使用できます; 他のユーザーはエフェメラルな拒否を受け取ります。承認プロンプトにはコマンドテキストが含まれるため、信頼されたチャンネルでのみチャンネル配信を有効にしてください。セッションキーからチャンネル ID を導出できない場合、OpenClaw は DM 配信にフォールバックします。

    Discord はまた他のチャットチャンネルが使用する共有承認ボタンをレンダリングします。ネイティブ Discord アダプターは主に承認者の DM ルーティングとチャンネルファンアウトを追加します。

    このハンドラーの Gateway ゲートウェイ認証は、他の Gateway ゲートウェイクライアントと同じ共有認証解決コントラクトを使用します:

    - env ファースト のローカル認証（`OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`、次に `gateway.auth.*`）
    - ローカルモードでは、`gateway.auth.*` が未設定の場合のみ `gateway.remote.*` をフォールバックとして使用できます; 設定されているが未解決のローカル SecretRef はフェイルクローズドされます
    - 該当する場合の `gateway.remote.*` 経由のリモートモードサポート
    - URL 上書きは上書きセーフです: CLI 上書きは暗黙の認証情報を再利用せず、env 上書きは env 認証情報のみを使用します

    Exec 承認はデフォルトで 30 分後に期限切れになります。不明な承認 ID で承認が失敗した場合は、承認者の解決と機能の有効化を確認してください。

    関連ドキュメント: [Exec 承認](/tools/exec-approvals)

  </Accordion>
</AccordionGroup>

## ツールとアクションゲート

Discord メッセージアクションには、メッセージング、チャンネル管理、モデレーション、プレゼンス、メタデータアクションが含まれます。

主要な例:

- メッセージング: `sendMessage`、`readMessages`、`editMessage`、`deleteMessage`、`threadReply`
- リアクション: `react`、`reactions`、`emojiList`
- モデレーション: `timeout`、`kick`、`ban`
- プレゼンス: `setPresence`

アクションゲートは `channels.discord.actions.*` にあります。

デフォルトのゲート動作:

| アクショングループ                                                                                                                                                               | デフォルト |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| reactions, messages, threads, pins, polls, search, memberInfo, roleInfo, channelInfo, channels, voiceStatus, events, stickers, emojiUploads, stickerUploads, permissions | 有効 |
| roles                                                                                                                                                                    | 無効 |
| moderation                                                                                                                                                               | 無効 |
| presence                                                                                                                                                                 | 無効 |

## コンポーネント v2 UI

OpenClaw は exec 承認とクロスコンテキストマーカーに Discord コンポーネント v2 を使用します。Discord メッセージアクションはカスタム UI に `components` を受け付けることもできます（高度; discord ツール経由でコンポーネントペイロードを構築する必要あり）、レガシーの `embeds` は引き続き利用可能ですが推奨されません。

- `channels.discord.ui.components.accentColor` は Discord コンポーネントコンテナで使用されるアクセントカラーを設定します（16進数）。
- アカウントごとに `channels.discord.accounts.<id>.ui.components.accentColor` で設定します。
- コンポーネント v2 が存在する場合、`embeds` は無視されます。

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

OpenClaw はリアルタイムの継続的な会話のために Discord ボイスチャンネルに参加できます。これはボイスメッセージ添付とは別の機能です。

要件:

- ネイティブコマンドを有効にする（`commands.native` または `channels.discord.commands.native`）。
- `channels.discord.voice` を設定する。
- ボットはターゲットボイスチャンネルで接続と発言の権限が必要です。

Discord 専用のネイティブコマンド `/vc join|leave|status` でセッションを制御します。コマンドはアカウントのデフォルトエージェントを使用し、他の Discord コマンドと同じ許可リストとグループポリシールールに従います。

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

- `voice.tts` はボイス再生にのみ `messages.tts` を上書きします。
- ボイストランスクリプトのターンはオーナーステータスを Discord `allowFrom`（または `dm.allowFrom`）から導出します; 非オーナースピーカーはオーナー専用ツール（例: `gateway` と `cron`）にアクセスできません。
- ボイスはデフォルトで有効です; `channels.discord.voice.enabled=false` を設定すると無効になります。
- `voice.daveEncryption` と `voice.decryptionFailureTolerance` は `@discordjs/voice` の参加オプションに渡されます。
- `@discordjs/voice` のデフォルトは未設定の場合 `daveEncryption=true` と `decryptionFailureTolerance=24` です。
- OpenClaw はまた受信復号失敗を監視し、短い期間内に繰り返し失敗した後にボイスチャンネルを離脱/再参加して自動回復します。
- 受信ログに `DecryptionFailed(UnencryptedWhenPassthroughDisabled)` が繰り返し表示される場合は、[discord.js #11419](https://github.com/discordjs/discord.js/issues/11419) で追跡されているアップストリームの `@discordjs/voice` 受信バグである可能性があります。

## ボイスメッセージ

Discord のボイスメッセージは波形プレビューを表示し、OGG/Opus オーディオとメタデータが必要です。OpenClaw は波形を自動的に生成しますが、オーディオファイルを検査・変換するために Gateway ゲートウェイホストで `ffmpeg` と `ffprobe` が使用可能である必要があります。

要件と制約:

- **ローカルファイルパス**を提供してください（URL は拒否されます）。
- テキストコンテンツを省略してください（Discord は同じペイロードにテキストとボイスメッセージを許可しません）。
- 任意のオーディオフォーマットが受け付けられます; OpenClaw は必要に応じて OGG/Opus に変換します。

例:

```bash
message(action="send", channel="discord", target="channel:123", path="/path/to/audio.mp3", asVoice=true)
```

## トラブルシューティング

<AccordionGroup>
  <Accordion title="許可されていないインテントを使用したか、ボットがギルドメッセージを見られない">

    - Message Content Intent を有効にする
    - ユーザー/メンバー解決に依存する場合は Server Members Intent を有効にする
    - インテントを変更した後に Gateway ゲートウェイを再起動する

  </Accordion>

  <Accordion title="ギルドメッセージが予期せずブロックされる">

    - `groupPolicy` を確認する
    - `channels.discord.guilds` のギルド許可リストを確認する
    - ギルドの `channels` マップが存在する場合、リストにあるチャンネルのみが許可される
    - `requireMention` の動作とメンションパターンを確認する

    有用なチェック:

```bash
openclaw doctor
openclaw channels status --probe
openclaw logs --follow
```

  </Accordion>

  <Accordion title="requireMention が false だがまだブロックされる">
    一般的な原因:

    - ギルド/チャンネル許可リストに一致するものがなく `groupPolicy="allowlist"`
    - `requireMention` が間違った場所に設定されている（`channels.discord.guilds` またはチャンネルエントリの下に設定する必要あり）
    - 送信者がギルド/チャンネルの `users` 許可リストでブロックされている

  </Accordion>

  <Accordion title="長時間実行ハンドラーがタイムアウトまたは重複した返信が発生する">

    典型的なログ:

    - `Listener DiscordMessageListener timed out after 30000ms for event MESSAGE_CREATE`
    - `Slow listener detected ...`
    - `discord inbound worker timed out after ...`

    リスナーバジェットのノブ:

    - シングルアカウント: `channels.discord.eventQueue.listenerTimeout`
    - マルチアカウント: `channels.discord.accounts.<accountId>.eventQueue.listenerTimeout`

    ワーカー実行タイムアウトのノブ:

    - シングルアカウント: `channels.discord.inboundWorker.runTimeoutMs`
    - マルチアカウント: `channels.discord.accounts.<accountId>.inboundWorker.runTimeoutMs`
    - デフォルト: `1800000`（30 分）; `0` で無効

    推奨ベースライン:

```json5
{
  channels: {
    discord: {
      accounts: {
        default: {
          eventQueue: {
            listenerTimeout: 120000,
          },
          inboundWorker: {
            runTimeoutMs: 1800000,
          },
        },
      },
    },
  },
}
```

    遅いリスナーセットアップには `eventQueue.listenerTimeout` を使用し、キューに入ったエージェントターンの別の安全弁が必要な場合にのみ `inboundWorker.runTimeoutMs` を使用してください。

  </Accordion>

  <Accordion title="権限の監査で不一致が発生する">
    `channels status --probe` の権限チェックは数値チャンネル ID に対してのみ機能します。

    スラグキーを使用している場合、ランタイムマッチングはまだ機能しますが、プローブは権限を完全に確認できません。

  </Accordion>

  <Accordion title="DM とペアリングの問題">

    - DM 無効: `channels.discord.dm.enabled=false`
    - DM ポリシー無効: `channels.discord.dmPolicy="disabled"`（レガシー: `channels.discord.dm.policy`）
    - `pairing` モードでのペアリング承認待ち

  </Accordion>

  <Accordion title="ボット間ループ">
    デフォルトでボットが作成したメッセージは無視されます。

    `channels.discord.allowBots=true` を設定した場合は、ループ動作を避けるために厳格なメンションと許可リストルールを使用してください。
    ボットをメンションするボットメッセージのみを受け付けるには `channels.discord.allowBots="mentions"` を優先してください。

  </Accordion>

  <Accordion title="ボイス STT が DecryptionFailed(...) でドロップする">

    - OpenClaw を最新にしてください（`openclaw update`）。これにより Discord ボイス受信回復ロジックが存在します
    - `channels.discord.voice.daveEncryption=true`（デフォルト）を確認してください
    - `channels.discord.voice.decryptionFailureTolerance=24`（アップストリームのデフォルト）から始め、必要な場合のみ調整してください
    - 以下のログを監視してください:
      - `discord voice: DAVE decrypt failures detected`
      - `discord voice: repeated decrypt failures; attempting rejoin`
    - 自動再参加後もまだ失敗が続く場合は、ログを収集して [discord.js #11419](https://github.com/discordjs/discord.js/issues/11419) と比較してください

  </Accordion>
</AccordionGroup>

## 設定リファレンスポインター

主要リファレンス:

- [設定リファレンス - Discord](/gateway/configuration-reference#discord)

Discord の主要フィールド:

- スタートアップ/認証: `enabled`、`token`、`accounts.*`、`allowBots`
- ポリシー: `groupPolicy`、`dm.*`、`guilds.*`、`guilds.*.channels.*`
- コマンド: `commands.native`、`commands.useAccessGroups`、`configWrites`、`slashCommand.*`
- イベントキュー: `eventQueue.listenerTimeout`（リスナーバジェット）、`eventQueue.maxQueueSize`、`eventQueue.maxConcurrency`
- インバウンドワーカー: `inboundWorker.runTimeoutMs`
- 返信/履歴: `replyToMode`、`historyLimit`、`dmHistoryLimit`、`dms.*.historyLimit`
- 配信: `textChunkLimit`、`chunkMode`、`maxLinesPerMessage`
- ストリーミング: `streaming`（レガシーエイリアス: `streamMode`）、`draftChunk`、`blockStreaming`、`blockStreamingCoalesce`
- メディア/リトライ: `mediaMaxMb`、`retry`
  - `mediaMaxMb` は Discord のアウトバウンドアップロードをキャップします（デフォルト: `8MB`）
- アクション: `actions.*`
- プレゼンス: `activity`、`status`、`activityType`、`activityUrl`
- UI: `ui.components.accentColor`
- 機能: `threadBindings`、最上位の `bindings[]`（`type: "acp"`）、`pluralkit`、`execApprovals`、`intents`、`agentComponents`、`heartbeat`、`responsePrefix`

## 安全性と運用

- ボットトークンはシークレットとして扱ってください（監視された環境では `DISCORD_BOT_TOKEN` を推奨）。
- 最小権限の Discord 権限を付与してください。
- コマンドデプロイ/状態が古い場合は、Gateway ゲートウェイを再起動して `openclaw channels status --probe` で再確認してください。

## 関連情報

- [ペアリング](/channels/pairing)
- [グループ](/channels/groups)
- [チャンネルルーティング](/channels/channel-routing)
- [セキュリティ](/gateway/security)
- [マルチエージェントルーティング](/concepts/multi-agent)
- [トラブルシューティング](/channels/troubleshooting)
- [スラッシュコマンド](/tools/slash-commands)
