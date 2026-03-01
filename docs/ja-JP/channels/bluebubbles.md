---
summary: "BlueBubbles macOSサーバー経由のiMessage（REST送受信、タイピング、リアクション、ペアリング、高度なアクション）"
read_when:
  - BlueBubblesチャンネルをセットアップするとき
  - ウェブフックペアリングのトラブルシューティング
  - macOSでiMessageを設定するとき
title: "BlueBubbles"
---

# BlueBubbles（macOS REST）

ステータス: BlueBubbles macOSサーバーとHTTP経由で通信するバンドルプラグインです。レガシーimsgチャンネルと比較して、より豊富なAPIと簡単なセットアップのため、**iMessage統合に推奨**されます。

## 概要

- BlueBubblesヘルパーアプリ（[bluebubbles.app](https://bluebubbles.app)）を介してmacOSで実行されます。
- 推奨/テスト済み: macOS Sequoia (15)。macOS Tahoe (26)でも動作しますが、Tahoeでは編集が現在動作せず、グループアイコンの更新は成功を報告しても同期されない場合があります。
- OpenClawはREST API（`GET /api/v1/ping`、`POST /message/text`、`POST /chat/:id/*`）を介して通信します。
- 受信メッセージはウェブフック経由で到着します。送信返信、タイピングインジケーター、既読レシート、タップバックはRESTコールです。
- 添付ファイルとステッカーは受信メディアとして取り込まれます（可能な場合はエージェントに表示されます）。
- ペアリング/許可リストは他のチャンネルと同様に機能します（`/channels/pairing`など）。`channels.bluebubbles.allowFrom` + ペアリングコードを使用します。
- リアクションはSlack/Telegramと同様にシステムイベントとして表示されるため、エージェントは返信前に「メンション」できます。
- 高度な機能: 編集、送信取り消し、返信スレッド、メッセージエフェクト、グループ管理。

## クイックスタート

1. Macに BlueBubblesサーバーをインストールします（[bluebubbles.app/install](https://bluebubbles.app/install)の手順に従ってください）。
2. BlueBubblesの設定で、Web APIを有効にしてパスワードを設定します。
3. `openclaw onboard`を実行してBlueBubblesを選択するか、手動で設定します:

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

4. BlueBubblesのウェブフックをGatewayに向けます（例: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`）。
5. Gatewayを起動します。ウェブフックハンドラーが登録され、ペアリングが開始されます。

セキュリティに関する注意:

- 必ずウェブフックパスワードを設定してください。
- ウェブフック認証は常に必要です。OpenClawは、ループバック/プロキシのトポロジーに関係なく、`channels.bluebubbles.password`と一致するpassword/guidを含まないBlueBubblesウェブフックリクエストを拒否します（例: `?password=<password>`または`x-password`）。

## Messages.appを維持する（VM / ヘッドレス環境）

一部のmacOS VM / 常時稼働環境では、Messages.appが「アイドル」状態になることがあります（アプリを開く/前面に持ってくるまで受信イベントが停止します）。簡単な回避策は、AppleScript + LaunchAgentを使用して**5分ごとにMessagesをポーク**することです。

### 1) AppleScriptを保存

以下として保存します:

- `~/Scripts/poke-messages.scpt`

スクリプト例（非インタラクティブ、フォーカスを奪いません）:

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

### 2) LaunchAgentをインストール

以下として保存します:

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

- **300秒ごと**および**ログイン時**に実行されます。
- 初回実行時にmacOSの**Automation**プロンプト（`osascript` → Messages）がトリガーされる場合があります。LaunchAgentを実行する同じユーザーセッションで承認してください。

ロード:

```bash
launchctl unload ~/Library/LaunchAgents/com.user.poke-messages.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.user.poke-messages.plist
```

## オンボーディング

BlueBubblesはインタラクティブセットアップウィザードで利用可能です:

```
openclaw onboard
```

ウィザードは以下を要求します:

- **Server URL**（必須）: BlueBubblesサーバーアドレス（例: `http://192.168.1.100:1234`）
- **Password**（必須）: BlueBubbles Server設定からのAPIパスワード
- **Webhook path**（オプション）: デフォルトは`/bluebubbles-webhook`
- **DM policy**: pairing、allowlist、open、またはdisabled
- **Allow list**: 電話番号、メール、またはチャットターゲット

CLIでBlueBubblesを追加することもできます:

```
openclaw channels add bluebubbles --http-url http://192.168.1.100:1234 --password <password>
```

## アクセス制御（DM + グループ）

DM:

- デフォルト: `channels.bluebubbles.dmPolicy = "pairing"`。
- 未知の送信者にはペアリングコードが送信されます。承認されるまでメッセージは無視されます（コードは1時間後に期限切れ）。
- 承認方法:
  - `openclaw pairing list bluebubbles`
  - `openclaw pairing approve bluebubbles <CODE>`
- ペアリングはデフォルトのトークン交換です。詳細: [ペアリング](/channels/pairing)

グループ:

- `channels.bluebubbles.groupPolicy = open | allowlist | disabled`（デフォルト: `allowlist`）。
- `channels.bluebubbles.groupAllowFrom`は`allowlist`設定時にグループでトリガーできる人を制御します。

### メンションゲーティング（グループ）

BlueBubblesはグループチャットのメンションゲーティングをサポートしており、iMessage/WhatsAppの動作と一致します:

- `agents.list[].groupChat.mentionPatterns`（または`messages.groupChat.mentionPatterns`）を使用してメンションを検出します。
- グループで`requireMention`が有効な場合、エージェントはメンションされた場合のみ応答します。
- 承認された送信者からの制御コマンドはメンションゲーティングをバイパスします。

グループごとの設定:

```json5
{
  channels: {
    bluebubbles: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true }, // すべてのグループのデフォルト
        "iMessage;-;chat123": { requireMention: false }, // 特定グループのオーバーライド
      },
    },
  },
}
```

### コマンドゲーティング

- 制御コマンド（例: `/config`、`/model`）は認可が必要です。
- `allowFrom`と`groupAllowFrom`を使用してコマンドの認可を判定します。
- 認可された送信者はグループでメンションなしでも制御コマンドを実行できます。

## タイピング + 既読レシート

- **タイピングインジケーター**: レスポンス生成前および生成中に自動的に送信されます。
- **既読レシート**: `channels.bluebubbles.sendReadReceipts`で制御されます（デフォルト: `true`）。
- **タイピングインジケーター**: OpenClawはタイピング開始イベントを送信します。BlueBubblesは送信時またはタイムアウト時に自動的にタイピングをクリアします（DELETE経由の手動停止は信頼性が低い）。

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

BlueBubblesは設定で有効にすると高度なメッセージアクションをサポートします:

```json5
{
  channels: {
    bluebubbles: {
      actions: {
        reactions: true, // タップバック（デフォルト: true）
        edit: true, // 送信済みメッセージの編集（macOS 13+、macOS 26 Tahoeでは動作しない）
        unsend: true, // メッセージの送信取り消し（macOS 13+）
        reply: true, // メッセージGUIDによる返信スレッド
        sendWithEffect: true, // メッセージエフェクト（slam、loudなど）
        renameGroup: true, // グループチャットの名前変更
        setGroupIcon: true, // グループチャットのアイコン/写真設定（macOS 26 Tahoeでは不安定）
        addParticipant: true, // グループへの参加者追加
        removeParticipant: true, // グループからの参加者削除
        leaveGroup: true, // グループチャットから退出
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
- **reply**: 特定メッセージへの返信（`messageId`、`text`、`to`）
- **sendWithEffect**: iMessageエフェクト付き送信（`text`、`to`、`effectId`）
- **renameGroup**: グループチャットの名前変更（`chatGuid`、`displayName`）
- **setGroupIcon**: グループチャットのアイコン/写真設定（`chatGuid`、`media`） -- macOS 26 Tahoeでは不安定（APIは成功を返しますがアイコンが同期されない場合があります）。
- **addParticipant**: グループへの参加者追加（`chatGuid`、`address`）
- **removeParticipant**: グループからの参加者削除（`chatGuid`、`address`）
- **leaveGroup**: グループチャットから退出（`chatGuid`）
- **sendAttachment**: メディア/ファイルの送信（`to`、`buffer`、`filename`、`asVoice`）
  - ボイスメモ: **MP3**または**CAF**オーディオで`asVoice: true`を設定すると、iMessageボイスメッセージとして送信されます。BlueBubblesはボイスメモ送信時にMP3をCAFに変換します。

### メッセージID（短縮 vs フル）

OpenClawはトークンを節約するために_短縮_メッセージID（例: `1`、`2`）を表示する場合があります。

- `MessageSid` / `ReplyToId`は短縮IDの場合があります。
- `MessageSidFull` / `ReplyToIdFull`にはプロバイダーのフルIDが含まれます。
- 短縮IDはメモリ内に保持されます。再起動時やキャッシュ削除時に期限切れになる可能性があります。
- アクションは短縮または完全な`messageId`を受け入れますが、短縮IDは利用できなくなった場合にエラーになります。

永続的なオートメーションやストレージにはフルIDを使用してください:

- テンプレート: `{{MessageSidFull}}`、`{{ReplyToIdFull}}`
- コンテキスト: 受信ペイロードの`MessageSidFull` / `ReplyToIdFull`

テンプレート変数については[設定](/gateway/configuration)を参照してください。

## ブロックストリーミング

レスポンスを単一メッセージとして送信するか、ブロック単位でストリーミングするかを制御します:

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

- 受信添付ファイルはダウンロードされ、メディアキャッシュに保存されます。
- メディア上限: `channels.bluebubbles.mediaMaxMb`（デフォルト: 8 MB）。
- 送信テキストは`channels.bluebubbles.textChunkLimit`で分割されます（デフォルト: 4000文字）。

## 設定リファレンス

完全な設定: [設定](/gateway/configuration)

プロバイダーオプション:

- `channels.bluebubbles.enabled`: チャンネルの有効/無効。
- `channels.bluebubbles.serverUrl`: BlueBubbles REST APIベースURL。
- `channels.bluebubbles.password`: APIパスワード。
- `channels.bluebubbles.webhookPath`: ウェブフックエンドポイントパス（デフォルト: `/bluebubbles-webhook`）。
- `channels.bluebubbles.dmPolicy`: `pairing | allowlist | open | disabled`（デフォルト: `pairing`）。
- `channels.bluebubbles.allowFrom`: DM許可リスト（ハンドル、メール、E.164番号、`chat_id:*`、`chat_guid:*`）。
- `channels.bluebubbles.groupPolicy`: `open | allowlist | disabled`（デフォルト: `allowlist`）。
- `channels.bluebubbles.groupAllowFrom`: グループ送信者許可リスト。
- `channels.bluebubbles.groups`: グループごとの設定（`requireMention`など）。
- `channels.bluebubbles.sendReadReceipts`: 既読レシートの送信（デフォルト: `true`）。
- `channels.bluebubbles.blockStreaming`: ブロックストリーミングの有効化（デフォルト: `false`。ストリーミング返信に必要）。
- `channels.bluebubbles.textChunkLimit`: 送信チャンクサイズ（文字数、デフォルト: 4000）。
- `channels.bluebubbles.chunkMode`: `length`（デフォルト）は`textChunkLimit`を超えた場合のみ分割。`newline`は長さ分割前に空行（段落境界）で分割。
- `channels.bluebubbles.mediaMaxMb`: 受信メディア上限（MB、デフォルト: 8）。
- `channels.bluebubbles.mediaLocalRoots`: 送信ローカルメディアパスに許可されるローカルディレクトリの明示的許可リスト。設定されていない限り、ローカルパス送信はデフォルトで拒否されます。アカウントごとのオーバーライド: `channels.bluebubbles.accounts.<accountId>.mediaLocalRoots`。
- `channels.bluebubbles.historyLimit`: コンテキストの最大グループメッセージ数（0で無効）。
- `channels.bluebubbles.dmHistoryLimit`: DM履歴制限。
- `channels.bluebubbles.actions`: 特定アクションの有効/無効。
- `channels.bluebubbles.accounts`: マルチアカウント設定。

関連するグローバルオプション:

- `agents.list[].groupChat.mentionPatterns`（または`messages.groupChat.mentionPatterns`）。
- `messages.responsePrefix`。

## アドレッシング / 配信ターゲット

安定したルーティングには`chat_guid`を推奨します:

- `chat_guid:iMessage;-;+15555550123`（グループに推奨）
- `chat_id:123`
- `chat_identifier:...`
- 直接ハンドル: `+15555550123`、`user@example.com`
  - 直接ハンドルに既存のDMチャットがない場合、OpenClawは`POST /api/v1/chat/new`で作成します。これにはBlueBubbles Private APIの有効化が必要です。

## セキュリティ

- ウェブフックリクエストは、`guid`/`password`クエリパラメータまたはヘッダーを`channels.bluebubbles.password`と比較して認証されます。`localhost`からのリクエストも受け入れられます。
- APIパスワードとウェブフックエンドポイントを秘密に保管してください（認証情報と同様に扱ってください）。
- Localhostの信頼は、同一ホストのリバースプロキシが意図せずパスワードをバイパスする可能性があることを意味します。Gatewayをプロキシする場合は、プロキシで認証を要求し、`gateway.trustedProxies`を設定してください。[Gatewayセキュリティ](/gateway/security#reverse-proxy-configuration)を参照してください。
- BlueBubblesサーバーをLAN外に公開する場合は、HTTPS + ファイアウォールルールを有効にしてください。

## トラブルシューティング

- タイピング/既読イベントが機能しなくなった場合は、BlueBubblesのウェブフックログを確認し、Gatewayパスが`channels.bluebubbles.webhookPath`と一致していることを確認してください。
- ペアリングコードは1時間後に期限切れになります。`openclaw pairing list bluebubbles`と`openclaw pairing approve bluebubbles <code>`を使用してください。
- リアクションにはBlueBubbles Private API（`POST /api/v1/message/react`）が必要です。サーバーバージョンがそれを公開していることを確認してください。
- 編集/送信取り消しにはmacOS 13+と互換性のあるBlueBubblesサーバーバージョンが必要です。macOS 26（Tahoe）では、Private APIの変更により編集が現在動作しません。
- グループアイコンの更新はmacOS 26（Tahoe）で不安定になることがあります: APIは成功を返しますが、新しいアイコンが同期されません。
- OpenClawはBlueBubblesサーバーのmacOSバージョンに基づいて、既知の動作しないアクションを自動的に非表示にします。macOS 26（Tahoe）で編集がまだ表示される場合は、`channels.bluebubbles.actions.edit=false`で手動で無効にしてください。
- ステータス/ヘルス情報: `openclaw status --all`または`openclaw status --deep`。

一般的なチャンネルワークフローリファレンスについては、[チャンネル](/channels)と[プラグイン](/tools/plugin)ガイドを参照してください。
