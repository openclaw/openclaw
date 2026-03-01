---
summary: "imsg（stdio上のJSON-RPC）経由のレガシーiMessageサポート。新規セットアップにはBlueBubblesを使用してください。"
read_when:
  - iMessageサポートをセットアップするとき
  - iMessageの送受信をデバッグするとき
title: "iMessage"
---

# iMessage（レガシー: imsg）

<Warning>
新しいiMessageデプロイメントには<a href="/channels/bluebubbles">BlueBubbles</a>を使用してください。

`imsg`統合はレガシーであり、将来のリリースで削除される可能性があります。
</Warning>

ステータス: レガシー外部CLI統合。Gatewayは`imsg rpc`を起動し、stdio上のJSON-RPCで通信します（別のデーモン/ポートは不要）。

<CardGroup cols={3}>
  <Card title="BlueBubbles（推奨）" icon="message-circle" href="/channels/bluebubbles">
    新規セットアップに推奨されるiMessageパス。
  </Card>
  <Card title="ペアリング" icon="link" href="/channels/pairing">
    iMessage DMはデフォルトでペアリングモードです。
  </Card>
  <Card title="設定リファレンス" icon="settings" href="/gateway/configuration-reference#imessage">
    完全なiMessageフィールドリファレンス。
  </Card>
</CardGroup>

## クイックセットアップ

<Tabs>
  <Tab title="ローカルMac（ファストパス）">
    <Steps>
      <Step title="imsgのインストールと確認">

```bash
brew install steipete/tap/imsg
imsg rpc --help
```

      </Step>

      <Step title="OpenClawの設定">

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "/usr/local/bin/imsg",
      dbPath: "/Users/<you>/Library/Messages/chat.db",
    },
  },
}
```

      </Step>

      <Step title="Gatewayの起動">

```bash
openclaw gateway
```

      </Step>

      <Step title="最初のDMペアリングを承認（デフォルトdmPolicy）">

```bash
openclaw pairing list imessage
openclaw pairing approve imessage <CODE>
```

        ペアリングリクエストは1時間後に期限切れになります。
      </Step>
    </Steps>

  </Tab>

  <Tab title="SSH経由のリモートMac">
    OpenClawはstdio互換の`cliPath`のみ必要です。`cliPath`をリモートMacにSSHして`imsg`を実行するラッパースクリプトにポイントできます。

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

    添付ファイルが有効な場合の推奨設定:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "~/.openclaw/scripts/imsg-ssh",
      remoteHost: "user@gateway-host", // SCP添付ファイル取得に使用
      includeAttachments: true,
      // オプション: 許可された添付ファイルルートのオーバーライド。
      // デフォルトには/Users/*/Library/Messages/Attachmentsが含まれます
      attachmentRoots: ["/Users/*/Library/Messages/Attachments"],
      remoteAttachmentRoots: ["/Users/*/Library/Messages/Attachments"],
    },
  },
}
```

    `remoteHost`が設定されていない場合、OpenClawはSSHラッパースクリプトを解析して自動検出を試みます。
    `remoteHost`は`host`または`user@host`でなければなりません（スペースやSSHオプションは不可）。
    OpenClawはSCPに厳密なホストキーチェックを使用するため、リレーホストキーが`~/.ssh/known_hosts`に既に存在する必要があります。
    添付ファイルのパスは許可されたルート（`attachmentRoots` / `remoteAttachmentRoots`）に対してバリデーションされます。

  </Tab>
</Tabs>

## 要件と権限（macOS）

- `imsg`を実行するMacでメッセージにサインインしている必要があります。
- OpenClaw/`imsg`を実行するプロセスコンテキストにフルディスクアクセスが必要です（メッセージDBアクセス）。
- Messages.appを通じてメッセージを送信するためにオートメーション権限が必要です。

<Tip>
権限はプロセスコンテキストごとに付与されます。Gatewayがヘッドレス（LaunchAgent/SSH）で実行される場合、同じコンテキストでインタラクティブなコマンドを1回実行してプロンプトをトリガーしてください:

```bash
imsg chats --limit 1
# または
imsg send <handle> "test"
```

</Tip>

## アクセス制御とルーティング

<Tabs>
  <Tab title="DMポリシー">
    `channels.imessage.dmPolicy`はダイレクトメッセージを制御します:

    - `pairing`（デフォルト）
    - `allowlist`
    - `open`（`allowFrom`に`"*"`が必要）
    - `disabled`

    許可リストフィールド: `channels.imessage.allowFrom`。

    許可リストエントリにはハンドルまたはチャットターゲット（`chat_id:*`、`chat_guid:*`、`chat_identifier:*`）を使用できます。

  </Tab>

  <Tab title="グループポリシー + メンション">
    `channels.imessage.groupPolicy`はグループ処理を制御します:

    - `allowlist`（設定されている場合のデフォルト）
    - `open`
    - `disabled`

    グループ送信者許可リスト: `channels.imessage.groupAllowFrom`。

    ランタイムフォールバック: `groupAllowFrom`が未設定の場合、iMessageグループ送信者チェックは利用可能な`allowFrom`にフォールバックします。
    ランタイムの注意: `channels.imessage`が完全に欠けている場合、ランタイムは`groupPolicy="allowlist"`にフォールバックし警告を記録します（`channels.defaults.groupPolicy`が設定されていても）。

    グループのメンションゲーティング:

    - iMessageにはネイティブのメンションメタデータがありません
    - メンション検出は正規表現パターンを使用します（`agents.list[].groupChat.mentionPatterns`、フォールバック`messages.groupChat.mentionPatterns`）
    - パターンが設定されていない場合、メンションゲーティングは適用できません

    認可された送信者からの制御コマンドはグループのメンションゲーティングをバイパスできます。

  </Tab>

  <Tab title="セッションと決定論的返信">
    - DMはダイレクトルーティングを使用します。グループはグループルーティングを使用します。
    - デフォルトの`session.dmScope=main`では、iMessage DMはエージェントメインセッションに統合されます。
    - グループセッションは分離されます（`agent:<agentId>:imessage:group:<chat_id>`）。
    - 返信は元のチャンネル/ターゲットメタデータを使用してiMessageにルーティングされます。

    グループ的なスレッド動作:

    一部の複数参加者iMessageスレッドは`is_group=false`で到着することがあります。
    その`chat_id`が`channels.imessage.groups`で明示的に設定されている場合、OpenClawはグループトラフィックとして扱います（グループゲーティング + グループセッション分離）。

  </Tab>
</Tabs>

## デプロイメントパターン

<AccordionGroup>
  <Accordion title="専用ボットmacOSユーザー（別のiMessage ID）">
    ボットトラフィックを個人のメッセージプロファイルから分離するため、専用のApple IDとmacOSユーザーを使用します。

    一般的なフロー:

    1. 専用のmacOSユーザーを作成/サインインします。
    2. そのユーザーでボットApple IDでメッセージにサインインします。
    3. そのユーザーに`imsg`をインストールします。
    4. OpenClawがそのユーザーコンテキストで`imsg`を実行できるようにSSHラッパーを作成します。
    5. `channels.imessage.accounts.<id>.cliPath`と`.dbPath`をそのユーザープロファイルにポイントします。

    初回実行時にGUI承認（オートメーション + フルディスクアクセス）がそのボットユーザーセッションで必要になる場合があります。

  </Accordion>

  <Accordion title="Tailscale経由のリモートMac（例）">
    一般的なトポロジー:

    - GatewayはLinux/VMで実行
    - iMessage + `imsg`はtailnet内のMacで実行
    - `cliPath`ラッパーはSSHを使用して`imsg`を実行
    - `remoteHost`はSCP添付ファイル取得を有効化

    例:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "~/.openclaw/scripts/imsg-ssh",
      remoteHost: "bot@mac-mini.tailnet-1234.ts.net",
      includeAttachments: true,
      dbPath: "/Users/bot/Library/Messages/chat.db",
    },
  },
}
```

```bash
#!/usr/bin/env bash
exec ssh -T bot@mac-mini.tailnet-1234.ts.net imsg "$@"
```

    SSHとSCPの両方が非インタラクティブになるようにSSHキーを使用してください。
    `known_hosts`が設定されるように、最初にホストキーが信頼されていることを確認してください（例: `ssh bot@mac-mini.tailnet-1234.ts.net`）。

  </Accordion>

  <Accordion title="マルチアカウントパターン">
    iMessageは`channels.imessage.accounts`でアカウントごとの設定をサポートしています。

    各アカウントは`cliPath`、`dbPath`、`allowFrom`、`groupPolicy`、`mediaMaxMb`、履歴設定、添付ファイルルート許可リストなどのフィールドをオーバーライドできます。

  </Accordion>
</AccordionGroup>

## メディア、チャンキング、配信ターゲット

<AccordionGroup>
  <Accordion title="添付ファイルとメディア">
    - 受信添付ファイルの取り込みはオプションです: `channels.imessage.includeAttachments`
    - `remoteHost`が設定されている場合、SCP経由でリモート添付ファイルパスを取得できます
    - 添付ファイルのパスは許可されたルートに一致する必要があります:
      - `channels.imessage.attachmentRoots`（ローカル）
      - `channels.imessage.remoteAttachmentRoots`（リモートSCPモード）
      - デフォルトのルートパターン: `/Users/*/Library/Messages/Attachments`
    - SCPは厳密なホストキーチェックを使用します（`StrictHostKeyChecking=yes`）
    - 送信メディアサイズは`channels.imessage.mediaMaxMb`を使用します（デフォルト16 MB）
  </Accordion>

  <Accordion title="送信チャンキング">
    - テキストチャンク制限: `channels.imessage.textChunkLimit`（デフォルト4000）
    - チャンクモード: `channels.imessage.chunkMode`
      - `length`（デフォルト）
      - `newline`（段落優先分割）
  </Accordion>

  <Accordion title="アドレス形式">
    推奨される明示的ターゲット:

    - `chat_id:123`（安定したルーティングに推奨）
    - `chat_guid:...`
    - `chat_identifier:...`

    ハンドルターゲットもサポートされています:

    - `imessage:+1555...`
    - `sms:+1555...`
    - `user@example.com`

```bash
imsg chats --limit 20
```

  </Accordion>
</AccordionGroup>

## 設定の書き込み

iMessageはデフォルトでチャンネル起動の設定書き込みを許可します（`commands.config: true`の場合の`/config set|unset`）。

無効化:

```json5
{
  channels: {
    imessage: {
      configWrites: false,
    },
  },
}
```

## トラブルシューティング

<AccordionGroup>
  <Accordion title="imsgが見つからないまたはRPCがサポートされていない">
    バイナリとRPCサポートを検証します:

```bash
imsg rpc --help
openclaw channels status --probe
```

    プローブがRPCサポートされていないと報告する場合、`imsg`を更新してください。

  </Accordion>

  <Accordion title="DMが無視される">
    確認:

    - `channels.imessage.dmPolicy`
    - `channels.imessage.allowFrom`
    - ペアリング承認（`openclaw pairing list imessage`）

  </Accordion>

  <Accordion title="グループメッセージが無視される">
    確認:

    - `channels.imessage.groupPolicy`
    - `channels.imessage.groupAllowFrom`
    - `channels.imessage.groups`の許可リスト動作
    - メンションパターン設定（`agents.list[].groupChat.mentionPatterns`）

  </Accordion>

  <Accordion title="リモート添付ファイルが失敗する">
    確認:

    - `channels.imessage.remoteHost`
    - `channels.imessage.remoteAttachmentRoots`
    - Gatewayホストからの SSH/SCPキー認証
    - Gatewayホストの`~/.ssh/known_hosts`にホストキーが存在するか
    - メッセージを実行するMac上のリモートパスの読み取り可能性

  </Accordion>

  <Accordion title="macOSの権限プロンプトを見逃した">
    同じユーザー/セッションコンテキストのインタラクティブGUIターミナルで再実行し、プロンプトを承認します:

```bash
imsg chats --limit 1
imsg send <handle> "test"
```

    OpenClaw/`imsg`を実行するプロセスコンテキストにフルディスクアクセス + オートメーションが付与されていることを確認してください。

  </Accordion>
</AccordionGroup>

## 設定リファレンスポインター

- [設定リファレンス - iMessage](/gateway/configuration-reference#imessage)
- [Gateway設定](/gateway/configuration)
- [ペアリング](/channels/pairing)
- [BlueBubbles](/channels/bluebubbles)
