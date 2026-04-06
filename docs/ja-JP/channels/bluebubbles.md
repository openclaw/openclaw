---
summary: "BlueBubbles macOS サーバー経由の iMessage（REST 送受信、タイピング、リアクション、ペアリング、高度なアクション）。"
read_when:
  - BlueBubbles チャンネルのセットアップ時
  - Webhook ペアリングのトラブルシューティング時
  - macOS での iMessage 設定時
title: "BlueBubbles"
x-i18n:
    generated_at: "2026-04-03T00:00:00Z"
    model: claude-sonnet-4-6
    provider: anthropic
    source_hash: ea7fe05ecbe2472e324587e306253f98d901b5b491ab32b9f630d6d13433d067
    source_path: channels/bluebubbles.md
    workflow: 15
---

# BlueBubbles（macOS REST）

ステータス: BlueBubbles macOS サーバーと HTTP 通信するバンドル済みプラグインです。レガシーの imsg チャンネルと比較してより豊富な API と簡単なセットアップが可能なため、**iMessage 統合に推奨**されます。

## 概要

- macOS 上の BlueBubbles ヘルパーアプリ（[bluebubbles.app](https://bluebubbles.app)）を介して動作します。
- 推奨・テスト済み: macOS Sequoia (15)。macOS Tahoe (26) も動作しますが、Tahoe では現在 edit が壊れており、グループアイコンの更新は成功と報告されても同期されない場合があります。
- OpenClaw は REST API（`GET /api/v1/ping`、`POST /message/text`、`POST /chat/:id/*`）を通じて通信します。
- 受信メッセージは Webhook 経由で届きます。返信、タイピングインジケーター、既読レシート、タップバックは REST 呼び出しです。
- 添付ファイルとステッカーはインバウンドメディアとして取り込まれます（可能な場合にエージェントに表示されます）。
- ペアリング/許可リストは他のチャンネルと同様に機能します（`/channels/pairing` など）。`channels.bluebubbles.allowFrom` とペアリングコードを使用します。
- リアクションは Slack/Telegram と同様にシステムイベントとして表示されるため、エージェントは返信前に「メンション」できます。
- 高度な機能: 編集、送信取り消し、返信スレッド、メッセージエフェクト、グループ管理。

## クイックスタート

1. Mac に BlueBubbles サーバーをインストールします（[bluebubbles.app/install](https://bluebubbles.app/install) の指示に従ってください）。
2. BlueBubbles の設定で Web API を有効にし、パスワードを設定します。
3. `openclaw onboard` を実行して BlueBubbles を選択するか、手動で設定します:

   ```json5
   {
     channels: {
       bluebubbles: {
         enabled: true,
         serverUrl: "http://192.168.1.100:1234",
         password: "example-password",
         webhookPath: "/bluebubbles-webhook",
       },
     },
   }
   ```

4. BlueBubbles の Webhook を Gateway ゲートウェイに向けます（例: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`）。
5. Gateway ゲートウェイを起動すると、Webhook ハンドラーを登録してペアリングを開始します。

セキュリティに関する注意:

- 必ず Webhook パスワードを設定してください。
- Webhook 認証は常に必要です。OpenClaw は、`channels.bluebubbles.password` と一致するパスワード/GUID（例: `?password=<password>` または `x-password`）が含まれていない BlueBubbles Webhook リクエストをループバック/プロキシのトポロジーに関係なく拒否します。
- パスワード認証は Webhook ボディの読み取り/パースの前にチェックされます。

## Messages.app を維持する（VM / ヘッドレス環境）

macOS VM や常時起動環境では、Messages.app が「アイドル」状態になることがあります（アプリを開いたりフォアグラウンドにするまで受信イベントが停止します）。簡単な回避策として、AppleScript と LaunchAgent を使用して **5 分ごとに Messages にアクセス**します。

### 1) AppleScript を保存

以下のファイルとして保存してください:

- `~/Scripts/poke-messages.scpt`

スクリプト例（非対話型; フォーカスを奪いません）:

```applescript
try
  tell application "Messages"
    if not running then
      launch
    end if

    -- Touch the scripting interface to keep the process responsive.
    set _chatCount to (count of chats)
  end tell
on error
  -- Ignore transient failures (first-run prompts, locked session, etc).
end try
```

### 2) LaunchAgent をインストール

以下のファイルとして保存してください:

- `~/Library/LaunchAgents/com.user.poke-messages.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.user.poke-messages</string>

    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>-lc</string>
      <string>/usr/bin/osascript &quot;$HOME/Scripts/poke-messages.scpt&quot;</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>StartInterval</key>
    <integer>300</integer>

    <key>StandardOutPath</key>
    <string>/tmp/poke-messages.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/poke-messages.err</string>
  </dict>
</plist>
```

注意:

- これは **300 秒ごと**および**ログイン時**に実行されます。
- 初回実行時に macOS の**オートメーション**プロンプト（`osascript` → Messages）が表示される場合があります。LaunchAgent を実行する同じユーザーセッションで承認してください。

ロードする:

```bash
launchctl unload ~/Library/LaunchAgents/com.user.poke-messages.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.user.poke-messages.plist
```

## オンボーディング

BlueBubbles はインタラクティブなオンボーディングで使用できます:

```
openclaw onboard
```

ウィザードで以下を入力します:

- **Server URL**（必須）: BlueBubbles サーバーアドレス（例: `http://192.168.1.100:1234`）
- **Password**（必須）: BlueBubbles サーバー設定の API パスワード
- **Webhook path**（オプション）: デフォルトは `/bluebubbles-webhook`
- **DM policy**: pairing、allowlist、open、または disabled
- **Allow list**: 電話番号、メールアドレス、またはチャットターゲット

CLI からも BlueBubbles を追加できます:

```
openclaw channels add bluebubbles --http-url http://192.168.1.100:1234 --password <password>
```

## アクセス制御（DM + グループ）

DM:

- デフォルト: `channels.bluebubbles.dmPolicy = "pairing"`
- 未知の送信者にはペアリングコードが届き、承認されるまでメッセージは無視されます（コードは 1 時間後に期限切れ）。
- 以下で承認します:
  - `openclaw pairing list bluebubbles`
  - `openclaw pairing approve bluebubbles <CODE>`
- ペアリングはデフォルトのトークン交換です。詳細: [Pairing](/channels/pairing)

グループ:

- `channels.bluebubbles.groupPolicy = open | allowlist | disabled`（デフォルト: `allowlist`）。
- `channels.bluebubbles.groupAllowFrom` は `allowlist` が設定されている場合にグループでトリガーできる人を制御します。

### 連絡先名のエンリッチメント（macOS、オプション）

BlueBubbles グループ Webhook には生の参加者アドレスしか含まれない場合があります。`GroupMembers` コンテキストにローカルの連絡先名を表示したい場合は、macOS でのローカル Contacts エンリッチメントをオプトインできます:

- `channels.bluebubbles.enrichGroupParticipantsFromContacts = true` でルックアップを有効にします。デフォルト: `false`。
- ルックアップはグループアクセス、コマンド認証、メンションゲートがメッセージを通過した後にのみ実行されます。
- 名前のない電話番加入者のみがエンリッチされます。
- ローカルの一致が見つからない場合は生の電話番号がフォールバックとして残ります。

```json5
{
  channels: {
    bluebubbles: {
      enrichGroupParticipantsFromContacts: true,
    },
  },
}
```

### メンションゲート（グループ）

BlueBubbles はグループチャットのメンションゲートをサポートしており、iMessage/WhatsApp の動作に合わせています:

- `agents.list[].groupChat.mentionPatterns`（または `messages.groupChat.mentionPatterns`）を使用してメンションを検出します。
- グループで `requireMention` が有効になっている場合、エージェントはメンションされたときのみ応答します。
- 承認された送信者からのコントロールコマンドはメンションゲートをバイパスします。

グループごとの設定:

```json5
{
  channels: {
    bluebubbles: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true }, // すべてのグループのデフォルト
        "iMessage;-;chat123": { requireMention: false }, // 特定グループの上書き
      },
    },
  },
}
```

### コマンドゲート

- コントロールコマンド（例: `/config`、`/model`）には認証が必要です。
- `allowFrom` と `groupAllowFrom` を使用してコマンドの認証を決定します。
- 認証された送信者はグループでメンションなしでもコントロールコマンドを実行できます。

## ACP 会話バインディング

BlueBubbles チャットはトランスポートレイヤーを変更せずに永続的な ACP ワークスペースにすることができます。

高速オペレーターフロー:

- DM または許可されたグループチャット内で `/acp spawn codex --bind here` を実行します。
- その BlueBubbles 会話の将来のメッセージはスポーンされた ACP セッションにルーティングされます。
- `/new` と `/reset` は同じバインドされた ACP セッションをリセットします。
- `/acp close` は ACP セッションを閉じてバインディングを削除します。

設定された永続的なバインディングは、`type: "acp"` と `match.channel: "bluebubbles"` を持つトップレベルの `bindings[]` エントリを通じてもサポートされます。

`match.peer.id` はサポートされる BlueBubbles ターゲット形式を使用できます:

- `+15555550123` や `user@example.com` などの正規化された DM ハンドル
- `chat_id:<id>`
- `chat_guid:<guid>`
- `chat_identifier:<identifier>`

安定したグループバインディングには `chat_id:*` または `chat_identifier:*` を推奨します。

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
        channel: "bluebubbles",
        accountId: "default",
        peer: { kind: "dm", id: "+15555550123" },
      },
      acp: { label: "codex-imessage" },
    },
  ],
}
```

共有 ACP バインディングの動作については [ACP Agents](/tools/acp-agents) を参照してください。

## タイピング + 既読レシート

- **タイピングインジケーター**: 応答生成の前後に自動送信されます。
- **既読レシート**: `channels.bluebubbles.sendReadReceipts`（デフォルト: `true`）で制御されます。
- **タイピングインジケーター**: OpenClaw はタイピング開始イベントを送信します。BlueBubbles は送信またはタイムアウト時に自動的にタイピングをクリアします（DELETE による手動停止は不安定です）。

```json5
{
  channels: {
    bluebubbles: {
      sendReadReceipts: false, // 既読レシートを無効化
    },
  },
}
```

## 高度なアクション

BlueBubbles は設定で有効にすると高度なメッセージアクションをサポートします:

```json5
{
  channels: {
    bluebubbles: {
      actions: {
        reactions: true, // タップバック（デフォルト: true）
        edit: true, // 送信済みメッセージを編集（macOS 13+、macOS 26 Tahoe では壊れている）
        unsend: true, // メッセージを送信取り消し（macOS 13+）
        reply: true, // メッセージ GUID による返信スレッド
        sendWithEffect: true, // メッセージエフェクト（slam、loud など）
        renameGroup: true, // グループチャットの名前変更
        setGroupIcon: true, // グループチャットのアイコン/写真設定（macOS 26 Tahoe では不安定）
        addParticipant: true, // グループへの参加者追加
        removeParticipant: true, // グループからの参加者削除
        leaveGroup: true, // グループチャットを退出
        sendAttachment: true, // 添付ファイル/メディアの送信
      },
    },
  },
}
```

利用可能なアクション:

- **react**: タップバックリアクションの追加/削除（`messageId`、`emoji`、`remove`）
- **edit**: 送信済みメッセージの編集（`messageId`、`text`）
- **unsend**: メッセージの送信取り消し（`messageId`）
- **reply**: 特定のメッセージへの返信（`messageId`、`text`、`to`）
- **sendWithEffect**: iMessage エフェクト付きで送信（`text`、`to`、`effectId`）
- **renameGroup**: グループチャットの名前変更（`chatGuid`、`displayName`）
- **setGroupIcon**: グループチャットのアイコン/写真設定（`chatGuid`、`media`）— macOS 26 Tahoe では不安定（API が成功を返してもアイコンが同期されないことがある）。
- **addParticipant**: グループへのユーザー追加（`chatGuid`、`address`）
- **removeParticipant**: グループからのユーザー削除（`chatGuid`、`address`）
- **leaveGroup**: グループチャットを退出（`chatGuid`）
- **upload-file**: メディア/ファイルの送信（`to`、`buffer`、`filename`、`asVoice`）
  - ボイスメモ: iMessage ボイスメッセージとして送信するには **MP3** または **CAF** オーディオで `asVoice: true` を設定します。BlueBubbles はボイスメモ送信時に MP3 → CAF に変換します。
- レガシーエイリアス: `sendAttachment` も機能しますが、`upload-file` が正規のアクション名です。

### メッセージ ID（短縮形 vs 完全形）

OpenClaw はトークンを節約するために_短縮_メッセージ ID（例: `1`、`2`）を表示する場合があります。

- `MessageSid` / `ReplyToId` は短縮 ID の場合があります。
- `MessageSidFull` / `ReplyToIdFull` にはプロバイダーの完全な ID が含まれます。
- 短縮 ID はメモリ内にあり、再起動またはキャッシュの立ち退きで期限切れになる可能性があります。
- アクションは短縮または完全な `messageId` を受け付けますが、短縮 ID が使用できない場合はエラーになります。

永続的なオートメーションとストレージには完全な ID を使用してください:

- テンプレート: `{{MessageSidFull}}`、`{{ReplyToIdFull}}`
- コンテキスト: インバウンドペイロードの `MessageSidFull` / `ReplyToIdFull`

テンプレート変数については [Configuration](/gateway/configuration) を参照してください。

## ブロックストリーミング

応答を単一のメッセージとして送信するか、ブロックでストリーミングするかを制御します:

```json5
{
  channels: {
    bluebubbles: {
      blockStreaming: true, // ブロックストリーミングを有効化（デフォルトはオフ）
    },
  },
}
```

## メディア + 制限

- インバウンド添付ファイルはダウンロードされてメディアキャッシュに保存されます。
- `channels.bluebubbles.mediaMaxMb` でインバウンドおよびアウトバウンドメディアのキャップを設定します（デフォルト: 8 MB）。
- アウトバウンドテキストは `channels.bluebubbles.textChunkLimit` でチャンク分割されます（デフォルト: 4000 文字）。

## 設定リファレンス

完全な設定: [Configuration](/gateway/configuration)

プロバイダーオプション:

- `channels.bluebubbles.enabled`: チャンネルを有効/無効にします。
- `channels.bluebubbles.serverUrl`: BlueBubbles REST API ベース URL。
- `channels.bluebubbles.password`: API パスワード。
- `channels.bluebubbles.webhookPath`: Webhook エンドポイントパス（デフォルト: `/bluebubbles-webhook`）。
- `channels.bluebubbles.dmPolicy`: `pairing | allowlist | open | disabled`（デフォルト: `pairing`）。
- `channels.bluebubbles.allowFrom`: DM 許可リスト（ハンドル、メール、E.164 番号、`chat_id:*`、`chat_guid:*`）。
- `channels.bluebubbles.groupPolicy`: `open | allowlist | disabled`（デフォルト: `allowlist`）。
- `channels.bluebubbles.groupAllowFrom`: グループ送信者許可リスト。
- `channels.bluebubbles.enrichGroupParticipantsFromContacts`: macOS で、ゲート通過後に名前のないグループ参加者をローカル Contacts からオプションでエンリッチします。デフォルト: `false`。
- `channels.bluebubbles.groups`: グループごとの設定（`requireMention` など）。
- `channels.bluebubbles.sendReadReceipts`: 既読レシートを送信します（デフォルト: `true`）。
- `channels.bluebubbles.blockStreaming`: ブロックストリーミングを有効にします（デフォルト: `false`。ストリーミング返信に必要）。
- `channels.bluebubbles.textChunkLimit`: アウトバウンドチャンクサイズ（文字単位、デフォルト: 4000）。
- `channels.bluebubbles.chunkMode`: `length`（デフォルト）は `textChunkLimit` を超えた場合のみ分割。`newline` は長さのチャンク処理の前に空白行（段落区切り）で分割します。
- `channels.bluebubbles.mediaMaxMb`: インバウンド/アウトバウンドメディアキャップ（MB 単位、デフォルト: 8）。
- `channels.bluebubbles.mediaLocalRoots`: アウトバウンドローカルメディアパスに許可される絶対ローカルディレクトリの明示的な許可リスト。ローカルパス送信はこれが設定されていない限りデフォルトで拒否されます。アカウントごとの上書き: `channels.bluebubbles.accounts.<accountId>.mediaLocalRoots`。
- `channels.bluebubbles.historyLimit`: コンテキストの最大グループメッセージ数（0 で無効）。
- `channels.bluebubbles.dmHistoryLimit`: DM 履歴制限。
- `channels.bluebubbles.actions`: 特定のアクションを有効/無効にします。
- `channels.bluebubbles.accounts`: マルチアカウント設定。

関連するグローバルオプション:

- `agents.list[].groupChat.mentionPatterns`（または `messages.groupChat.mentionPatterns`）。
- `messages.responsePrefix`。

## アドレス指定 / 配信ターゲット

安定したルーティングには `chat_guid` を推奨します:

- `chat_guid:iMessage;-;+15555550123`（グループに推奨）
- `chat_id:123`
- `chat_identifier:...`
- 直接ハンドル: `+15555550123`、`user@example.com`
  - 直接ハンドルに既存の DM チャットがない場合、OpenClaw は `POST /api/v1/chat/new` で新しく作成します。これには BlueBubbles Private API が有効になっている必要があります。

## セキュリティ

- Webhook リクエストは、`guid`/`password` クエリパラメーターまたはヘッダーを `channels.bluebubbles.password` と比較して認証されます。`localhost` からのリクエストも受け付けます。
- API パスワードと Webhook エンドポイントを秘密に保ってください（認証情報のように扱ってください）。
- localhost の信頼は、同一ホストのリバースプロキシが意図せずパスワードをバイパスできることを意味します。Gateway ゲートウェイをプロキシする場合は、プロキシで認証を必須にし、`gateway.trustedProxies` を設定してください。[Gateway security](/gateway/security#reverse-proxy-configuration) を参照してください。
- LAN 外に公開する場合は、BlueBubbles サーバーで HTTPS + ファイアウォールルールを有効にしてください。

## トラブルシューティング

- タイピング/既読イベントが動作しない場合は、BlueBubbles Webhook ログを確認し、Gateway ゲートウェイのパスが `channels.bluebubbles.webhookPath` と一致しているか確認してください。
- ペアリングコードは 1 時間後に期限切れになります。`openclaw pairing list bluebubbles` と `openclaw pairing approve bluebubbles <code>` を使用してください。
- リアクションには BlueBubbles プライベート API（`POST /api/v1/message/react`）が必要です。サーバーバージョンがそれを公開していることを確認してください。
- 編集/送信取り消しには macOS 13+ と互換性のある BlueBubbles サーバーバージョンが必要です。macOS 26（Tahoe）では、プライベート API の変更により edit が現在壊れています。
- macOS 26（Tahoe）では グループアイコンの更新が不安定な場合があります: API が成功を返しても新しいアイコンが同期されないことがあります。
- OpenClaw は BlueBubbles サーバーの macOS バージョンに基づいて既知の壊れたアクションを自動的に非表示にします。macOS 26（Tahoe）で edit がまだ表示される場合は、`channels.bluebubbles.actions.edit=false` で手動で無効にしてください。
- ステータス/ヘルス情報: `openclaw status --all` または `openclaw status --deep`。

一般的なチャンネルワークフローについては [Channels](/channels) と [Plugins](/tools/plugin) ガイドを参照してください。

## 関連項目

- [Channels Overview](/channels) — サポートされているすべてのチャンネル
- [Pairing](/channels/pairing) — DM 認証とペアリングフロー
- [Groups](/channels/groups) — グループチャットの動作とメンションゲート
- [Channel Routing](/channels/channel-routing) — メッセージのセッションルーティング
- [Security](/gateway/security) — アクセスモデルとハードニング
