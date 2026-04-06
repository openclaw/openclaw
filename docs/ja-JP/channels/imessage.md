---
summary: "imsg 経由のレガシー iMessage サポート（stdio 上の JSON-RPC）。新規セットアップには BlueBubbles を使用してください。"
read_when:
  - iMessage サポートのセットアップ時
  - iMessage 送受信のデバッグ時
title: "iMessage"
x-i18n:
    generated_at: "2026-04-03T00:00:00Z"
    model: claude-sonnet-4-6
    provider: anthropic
    source_hash: 086d85bead49f75d12ae6b14ac917af52375b6afd28f6af1a0dcbbc7fcb628a0
    source_path: channels/imessage.md
    workflow: 15
---

# iMessage（レガシー: imsg）

<Warning>
新規の iMessage デプロイには <a href="/channels/bluebubbles">BlueBubbles</a> を使用してください。

`imsg` 統合はレガシーであり、将来のリリースで削除される可能性があります。
</Warning>

ステータス: レガシーな外部 CLI 統合。Gateway ゲートウェイは `imsg rpc` を起動し、stdio 上の JSON-RPC で通信します（別途デーモン/ポートは不要）。

<CardGroup cols={3}>
  <Card title="BlueBubbles（推奨）" icon="message-circle" href="/channels/bluebubbles">
    新規セットアップの推奨 iMessage パス。
  </Card>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    iMessage DM はデフォルトでペアリングモードです。
  </Card>
  <Card title="設定リファレンス" icon="settings" href="/gateway/configuration-reference#imessage">
    完全な iMessage フィールドリファレンス。
  </Card>
</CardGroup>

## クイックセットアップ

<Tabs>
  <Tab title="ローカル Mac（高速パス）">
    <Steps>
      <Step title="imsg をインストールして確認">

```bash
brew install steipete/tap/imsg
imsg rpc --help
```

      </Step>

      <Step title="OpenClaw を設定">

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

      <Step title="Gateway ゲートウェイを起動">

```bash
openclaw gateway
```

      </Step>

      <Step title="最初の DM ペアリングを承認（デフォルト dmPolicy）">

```bash
openclaw pairing list imessage
openclaw pairing approve imessage <CODE>
```

        ペアリングリクエストは 1 時間後に期限切れになります。
      </Step>
    </Steps>

  </Tab>

  <Tab title="SSH 経由のリモート Mac">
    OpenClaw は stdio 互換の `cliPath` のみを必要とするため、`cliPath` をリモート Mac に SSH して `imsg` を実行するラッパースクリプトに向けることができます。

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
      remoteHost: "user@gateway-host", // SCP 添付ファイル取得に使用
      includeAttachments: true,
      // オプション: 許可された添付ファイルルートを上書き。
      // デフォルトは /Users/*/Library/Messages/Attachments を含む
      attachmentRoots: ["/Users/*/Library/Messages/Attachments"],
      remoteAttachmentRoots: ["/Users/*/Library/Messages/Attachments"],
    },
  },
}
```

    `remoteHost` が設定されていない場合、OpenClaw は SSH ラッパースクリプトを解析して自動検出を試みます。
    `remoteHost` は `host` または `user@host`（スペースや SSH オプションなし）である必要があります。
    OpenClaw は SCP に厳格なホストキーチェックを使用するため、リレーホストキーは `~/.ssh/known_hosts` に既に存在している必要があります。
    添付ファイルパスは許可されたルート（`attachmentRoots` / `remoteAttachmentRoots`）に対して検証されます。

  </Tab>
</Tabs>

## 要件と権限（macOS）

- `imsg` を実行している Mac で Messages にサインインしている必要があります。
- OpenClaw/`imsg` を実行しているプロセスコンテキストにはフルディスクアクセスが必要です（Messages DB アクセス）。
- Messages.app を通じてメッセージを送信するにはオートメーション権限が必要です。

<Tip>
権限はプロセスコンテキストごとに付与されます。Gateway ゲートウェイがヘッドレスで実行されている場合（LaunchAgent/SSH）、そのコンテキストでプロンプトをトリガーするために一度インタラクティブなコマンドを実行してください:

```bash
imsg chats --limit 1
# または
imsg send <handle> "test"
```

</Tip>

## アクセス制御とルーティング

<Tabs>
  <Tab title="DM ポリシー">
    `channels.imessage.dmPolicy` でダイレクトメッセージを制御します:

    - `pairing`（デフォルト）
    - `allowlist`
    - `open`（`allowFrom` に `"*"` が必要）
    - `disabled`

    許可リストフィールド: `channels.imessage.allowFrom`。

    許可リストエントリはハンドルまたはチャットターゲット（`chat_id:*`、`chat_guid:*`、`chat_identifier:*`）が使用できます。

  </Tab>

  <Tab title="グループポリシー + メンション">
    `channels.imessage.groupPolicy` でグループ処理を制御します:

    - `allowlist`（設定されている場合のデフォルト）
    - `open`
    - `disabled`

    グループ送信者許可リスト: `channels.imessage.groupAllowFrom`。

    ランタイムフォールバック: `groupAllowFrom` が未設定の場合、iMessage グループ送信者チェックは `allowFrom` が利用可能な場合にそちらにフォールバックします。
    ランタイムノート: `channels.imessage` が完全に欠落している場合、ランタイムは `groupPolicy="allowlist"` にフォールバックして警告をログに記録します（`channels.defaults.groupPolicy` が設定されていても）。

    グループのメンションゲート:

    - iMessage にはネイティブのメンションメタデータがありません
    - メンション検出には正規表現パターンを使用します（`agents.list[].groupChat.mentionPatterns`、フォールバックは `messages.groupChat.mentionPatterns`）
    - パターンが設定されていない場合、メンションゲートを強制できません

    認証された送信者からのコントロールコマンドはグループのメンションゲートをバイパスできます。

  </Tab>

  <Tab title="セッションと確定的な返信">
    - DM は直接ルーティングを使用し、グループはグループルーティングを使用します。
    - デフォルトの `session.dmScope=main` では、iMessage DM はエージェントのメインセッションに集約されます。
    - グループセッションは分離されています（`agent:<agentId>:imessage:group:<chat_id>`）。
    - 返信は元のチャンネル/ターゲットメタデータを使用して iMessage にルーティングされます。

    グループ的なスレッド動作:

    一部のマルチ参加者 iMessage スレッドは `is_group=false` で届く場合があります。
    その `chat_id` が `channels.imessage.groups` に明示的に設定されている場合、OpenClaw はそれをグループトラフィックとして扱います（グループゲート + グループセッション分離）。

  </Tab>
</Tabs>

## ACP 会話バインディング

レガシー iMessage チャットも ACP セッションにバインドできます。

高速オペレーターフロー:

- DM または許可されたグループチャット内で `/acp spawn codex --bind here` を実行します。
- その iMessage 会話の将来のメッセージはスポーンされた ACP セッションにルーティングされます。
- `/new` と `/reset` は同じバインドされた ACP セッションをリセットします。
- `/acp close` は ACP セッションを閉じてバインディングを削除します。

設定された永続的なバインディングは、`type: "acp"` と `match.channel: "imessage"` を持つトップレベルの `bindings[]` エントリを通じてサポートされます。

`match.peer.id` に使用できるもの:

- `+15555550123` や `user@example.com` などの正規化された DM ハンドル
- `chat_id:<id>`（安定したグループバインディングに推奨）
- `chat_guid:<guid>`
- `chat_identifier:<identifier>`

例:

```json5
{
  agents: {
    list: [
      {
        id: "codex",
        runtime: {
          type: "acp",
          acp: { agent: "codex", backend: "acpx", mode: "persistent" },
        },
      },
    ],
  },
  bindings: [
    {
      type: "acp",
      agentId: "codex",
      match: {
        channel: "imessage",
        accountId: "default",
        peer: { kind: "group", id: "chat_id:123" },
      },
      acp: { label: "codex-group" },
    },
  ],
}
```

共有 ACP バインディングの動作については [ACP Agents](/tools/acp-agents) を参照してください。

## デプロイメントパターン

<AccordionGroup>
  <Accordion title="専用ボット macOS ユーザー（独立した iMessage ID）">
    ボットトラフィックを個人の Messages プロファイルから分離するために、専用の Apple ID と macOS ユーザーを使用します。

    典型的なフロー:

    1. 専用の macOS ユーザーを作成/サインインします。
    2. そのユーザーの Messages にボット Apple ID でサインインします。
    3. そのユーザーに `imsg` をインストールします。
    4. OpenClaw がそのユーザーコンテキストで `imsg` を実行できるように SSH ラッパーを作成します。
    5. `channels.imessage.accounts.<id>.cliPath` と `.dbPath` をそのユーザープロファイルに向けます。

    初回実行時はそのボットユーザーセッションで GUI 承認（オートメーション + フルディスクアクセス）が必要な場合があります。

  </Accordion>

  <Accordion title="Tailscale 経由のリモート Mac（例）">
    一般的なトポロジー:

    - Gateway ゲートウェイは Linux/VM 上で実行
    - iMessage + `imsg` は tailnet 内の Mac 上で実行
    - `cliPath` ラッパーは SSH を使用して `imsg` を実行
    - `remoteHost` で SCP 添付ファイル取得を有効化

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

    SSH と SCP が非対話型になるように SSH キーを使用してください。
    `known_hosts` に入力されるように、まずホストキーを信頼してください（例: `ssh bot@mac-mini.tailnet-1234.ts.net`）。

  </Accordion>

  <Accordion title="マルチアカウントパターン">
    iMessage は `channels.imessage.accounts` でアカウントごとの設定をサポートします。

    各アカウントは `cliPath`、`dbPath`、`allowFrom`、`groupPolicy`、`mediaMaxMb`、履歴設定、添付ファイルルートの許可リストなどのフィールドを上書きできます。

  </Accordion>
</AccordionGroup>

## メディア、チャンク処理、および配信ターゲット

<AccordionGroup>
  <Accordion title="添付ファイルとメディア">
    - インバウンド添付ファイルの取り込みはオプション: `channels.imessage.includeAttachments`
    - `remoteHost` が設定されている場合、リモート添付ファイルパスは SCP 経由で取得できます
    - 添付ファイルパスは許可されたルートと一致する必要があります:
      - `channels.imessage.attachmentRoots`（ローカル）
      - `channels.imessage.remoteAttachmentRoots`（リモート SCP モード）
      - デフォルトのルートパターン: `/Users/*/Library/Messages/Attachments`
    - SCP は厳格なホストキーチェックを使用します（`StrictHostKeyChecking=yes`）
    - アウトバウンドメディアサイズは `channels.imessage.mediaMaxMb` を使用します（デフォルト 16 MB）
  </Accordion>

  <Accordion title="アウトバウンドチャンク処理">
    - テキストチャンク制限: `channels.imessage.textChunkLimit`（デフォルト 4000）
    - チャンクモード: `channels.imessage.chunkMode`
      - `length`（デフォルト）
      - `newline`（段落優先分割）
  </Accordion>

  <Accordion title="アドレス形式">
    推奨される明示的なターゲット:

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

## 設定書き込み

iMessage はデフォルトでチャンネル開始の設定書き込みを許可します（`commands.config: true` の場合の `/config set|unset`）。

無効にする:

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
  <Accordion title="imsg が見つからない、または RPC がサポートされていない">
    バイナリと RPC サポートを確認します:

```bash
imsg rpc --help
openclaw channels status --probe
```

    プローブが RPC 未サポートと報告する場合は `imsg` を更新してください。

  </Accordion>

  <Accordion title="DM が無視される">
    確認事項:

    - `channels.imessage.dmPolicy`
    - `channels.imessage.allowFrom`
    - ペアリングの承認（`openclaw pairing list imessage`）

  </Accordion>

  <Accordion title="グループメッセージが無視される">
    確認事項:

    - `channels.imessage.groupPolicy`
    - `channels.imessage.groupAllowFrom`
    - `channels.imessage.groups` 許可リストの動作
    - メンションパターンの設定（`agents.list[].groupChat.mentionPatterns`）

  </Accordion>

  <Accordion title="リモート添付ファイルが失敗する">
    確認事項:

    - `channels.imessage.remoteHost`
    - `channels.imessage.remoteAttachmentRoots`
    - Gateway ゲートウェイホストからの SSH/SCP キー認証
    - Gateway ゲートウェイホストの `~/.ssh/known_hosts` にホストキーが存在すること
    - Messages を実行している Mac 上でのリモートパスの読み取り可能性

  </Accordion>

  <Accordion title="macOS 権限プロンプトを見逃した">
    同じユーザー/セッションコンテキストでインタラクティブな GUI ターミナルで再実行してプロンプトを承認します:

```bash
imsg chats --limit 1
imsg send <handle> "test"
```

    OpenClaw/`imsg` を実行するプロセスコンテキストでフルディスクアクセス + オートメーションが付与されていることを確認してください。

  </Accordion>
</AccordionGroup>

## 設定リファレンスポインター

- [Configuration reference - iMessage](/gateway/configuration-reference#imessage)
- [Gateway configuration](/gateway/configuration)
- [Pairing](/channels/pairing)
- [BlueBubbles](/channels/bluebubbles)

## 関連項目

- [Channels Overview](/channels) — サポートされているすべてのチャンネル
- [Pairing](/channels/pairing) — DM 認証とペアリングフロー
- [Groups](/channels/groups) — グループチャットの動作とメンションゲート
- [Channel Routing](/channels/channel-routing) — メッセージのセッションルーティング
- [Security](/gateway/security) — アクセスモデルとハードニング
