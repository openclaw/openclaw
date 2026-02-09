---
summary: "BlueBubbles macOS サーバー経由の iMessage（REST による送受信、入力中表示、リアクション、ペアリング、高度なアクション）。"
read_when:
  - BlueBubbles チャンネルのセットアップ
  - Webhook ペアリングのトラブルシューティング
  - macOS での iMessage 設定
title: "BlueBubbles"
---

# BlueBubbles（macOS REST）

ステータス: BlueBubbles macOS サーバーと HTTP で通信する同梱プラグインです。レガシーの imsg チャンネルと比較して API がより豊富でセットアップが容易なため、**iMessage 連携には推奨**されます。 \*\*iMessage 統合に推奨されます。API が豊富で、従来の imsg チャネルと比較して簡単にセットアップできます。

## 概要

- BlueBubbles ヘルパーアプリ（[bluebubbles.app](https://bluebubbles.app)）経由で macOS 上で動作します。
- 推奨/テスト: macOS Sequoia (15). 推奨／検証済み: macOS Sequoia（15）。macOS Tahoe（26）も動作しますが、Tahoe では現在 edit が壊れており、グループアイコン更新は成功と表示されても同期されない場合があります。
- OpenClaw は REST API（`GET /api/v1/ping`, `POST /message/text`, `POST /chat/:id/*`）を通じて通信します。
- 受信メッセージは webhooks で到着し、送信返信、入力中インジケーター、既読通知、Tapback は REST 呼び出しです。
- 添付ファイルとステッカーはインバウンドメディアとして取り込まれ（可能な場合はエージェントに表示されます）。
- ペアリング／許可リストは他のチャンネル（`/channels/pairing` など）と同様に、`channels.bluebubbles.allowFrom` + ペアリングコードで動作します。
- リアクションは Slack／Telegram と同様にシステムイベントとして表面化され、返信前にエージェントがそれらを「メンション」できます。
- 高度な機能: 編集、送信取り消し、スレッド返信、メッセージエフェクト、グループ管理。

## クイックスタート

1. Mac に BlueBubbles サーバーをインストールします（[bluebubbles.app/install](https://bluebubbles.app/install) の手順に従ってください）。

2. BlueBubbles の設定で Web API を有効化し、パスワードを設定します。

3. `openclaw onboard` を実行して BlueBubbles を選択するか、手動で設定します。

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

4. BlueBubbles の webhooks をゲートウェイに向けます（例: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`）。

5. ゲートウェイを起動します。Webhook ハンドラーが登録され、ペアリングが開始されます。

## Messages.app を起動状態に保つ（VM／ヘッドレス環境）

一部の macOS VM／常時稼働環境では、Messages.app が「アイドル」状態になり（アプリを開く／フォアグラウンドにするまで受信イベントが停止）、問題が発生することがあります。簡単な回避策として、AppleScript + LaunchAgent を使って **5 分ごとに Messages を刺激**します。 簡単な回避策として、AppleScript + LaunchAgent を使用して 5 分ごとにメッセージを送信することができます。

### 1. AppleScript を保存

名前を付けて保存:

- `~/Scripts/poke-messages.scpt`

サンプルスクリプト（非対話式。フォーカスを奪いません）:

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

### 2. LaunchAgent をインストール

名前を付けて保存:

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

注記:

- **300 秒ごと**および**ログイン時**に実行されます。
- 初回実行時に macOS の **Automation** プロンプト（`osascript` → Messages）が表示される場合があります。LaunchAgent を実行する同一ユーザーセッションで承認してください。 LaunchAgent を実行するのと同じユーザーセッションでそれらを承認します。

読み込み:

```bash
launchctl unload ~/Library/LaunchAgents/com.user.poke-messages.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.user.poke-messages.plist
```

## オンボーディング

BlueBubbles は対話型セットアップウィザードで利用できます。

```
openclaw onboard
```

ウィザードのプロンプト:

- **Server URL**（必須）: BlueBubbles サーバーのアドレス（例: `http://192.168.1.100:1234`）
- **Password**（必須）: BlueBubbles Server 設定の API パスワード
- **Webhook path**（任意）: 既定は `/bluebubbles-webhook`
- **DM ポリシー**: ペアリング、許可リスト、オープン、または無効
- **許可リスト**: 電話番号、メール、またはチャットターゲット

CLI から BlueBubbles を追加することもできます。

```
openclaw channels add bluebubbles --http-url http://192.168.1.100:1234 --password <password>
```

## アクセス制御（DM + グループ）

DM:

- 既定: `channels.bluebubbles.dmPolicy = "pairing"`。
- 不明な送信者にはペアリングコードが送信され、承認されるまでメッセージは無視されます（コードは 1 時間で失効）。
- 承認方法:
  - `openclaw pairing list bluebubbles`
  - `openclaw pairing approve bluebubbles <CODE>`
- ペアリングはデフォルトのトークン交換です。 詳細: [Pairing](/channels/pairing)

グループ:

- `channels.bluebubbles.groupPolicy = open | allowlist | disabled`（既定: `allowlist`）。
- `channels.bluebubbles.groupAllowFrom` は、`allowlist` が設定されている場合に、グループ内で誰がトリガーできるかを制御します。

### メンション制御（グループ）

BlueBubbles は、iMessage／WhatsApp の挙動に合わせたグループチャットのメンション制御をサポートします。

- メンション検出に `agents.list[].groupChat.mentionPatterns`（または `messages.groupChat.mentionPatterns`）を使用します。
- グループで `requireMention` が有効な場合、メンションされたときのみエージェントが応答します。
- 許可された送信者からの制御コマンドは、メンション制御をバイパスします。

グループ別設定:

```json5
{
  channels: {
    bluebubbles: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true }, // default for all groups
        "iMessage;-;chat123": { requireMention: false }, // override for specific group
      },
    },
  },
}
```

### コマンド制御

- 制御コマンド（例: `/config`, `/model`）には認可が必要です。
- コマンド認可の判定に `allowFrom` と `groupAllowFrom` を使用します。
- 許可された送信者は、グループでメンションがなくても制御コマンドを実行できます。

## 入力+開封通知

- **入力中インジケーター**: 応答生成の前後で自動送信されます。
- **既読通知**: `channels.bluebubbles.sendReadReceipts` で制御します（既定: `true`）。
- **入力中インジケーター**: OpenClaw は入力開始イベントを送信します。BlueBubbles は送信時またはタイムアウトで自動的にクリアします（DELETE による手動停止は不安定です）。

```json5
{
  channels: {
    bluebubbles: {
      sendReadReceipts: false, // disable read receipts
    },
  },
}
```

## 高度なアクション

BlueBubbles は、設定で有効化すると高度なメッセージアクションをサポートします。

```json5
{
  channels: {
    bluebubbles: {
      actions: {
        reactions: true, // tapbacks (default: true)
        edit: true, // edit sent messages (macOS 13+, broken on macOS 26 Tahoe)
        unsend: true, // unsend messages (macOS 13+)
        reply: true, // reply threading by message GUID
        sendWithEffect: true, // message effects (slam, loud, etc.)
        renameGroup: true, // rename group chats
        setGroupIcon: true, // set group chat icon/photo (flaky on macOS 26 Tahoe)
        addParticipant: true, // add participants to groups
        removeParticipant: true, // remove participants from groups
        leaveGroup: true, // leave group chats
        sendAttachment: true, // send attachments/media
      },
    },
  },
}
```

利用可能なアクション:

- **react**: Tapback リアクションの追加／削除（`messageId`, `emoji`, `remove`）
- **edit**: 送信済みメッセージの編集（`messageId`, `text`）
- **unsend**: メッセージの送信取り消し（`messageId`）
- **reply**: 特定メッセージへの返信（`messageId`, `text`, `to`）
- **sendWithEffect**: iMessage エフェクト付きで送信（`text`, `to`, `effectId`）
- **renameGroup**: グループチャットの名称変更（`chatGuid`, `displayName`）
- **setGroupIcon**: グループチャットのアイコン／写真を設定（`chatGuid`, `media`）— macOS 26 Tahoe では不安定（API は成功を返しても同期されない場合があります）。
- **addParticipant**: グループに参加者を追加（`chatGuid`, `address`）
- **removeParticipant**: グループから参加者を削除（`chatGuid`, `address`）
- **leaveGroup**: グループチャットから退出（`chatGuid`）
- **sendAttachment**: メディア／ファイルを送信（`to`, `buffer`, `filename`, `asVoice`）
  - ボイスメモ: **MP3** または **CAF** 音声を iMessage のボイスメッセージとして送信するには `asVoice: true` を設定します。BlueBubbles は送信時に MP3 → CAF に変換します。 BlueBubbles はボイスメモの送信時に MP3 → CAF を変換します。

### メッセージ ID（短縮 vs 完全）

OpenClaw は、トークン節約のために _短縮_ メッセージ ID（例: `1`, `2`）を表面化することがあります。

- `MessageSid` / `ReplyToId` は短縮 ID の場合があります。
- `MessageSidFull` / `ReplyToIdFull` にはプロバイダーの完全 ID が含まれます。
- 短縮 ID はインメモリで、再起動やキャッシュ削除で失効する場合があります。
- アクションは短縮または完全な `messageId` を受け付けますが、短縮 ID が利用不可の場合はエラーになります。

耐久性が必要な自動化や保存には完全 ID を使用してください。

- テンプレート: `{{MessageSidFull}}`, `{{ReplyToIdFull}}`
- コンテキスト: インバウンドペイロード内の `MessageSidFull` / `ReplyToIdFull`

テンプレート変数については [Configuration](/gateway/configuration) を参照してください。

## ブロックストリーミング

応答を単一メッセージで送信するか、ブロック単位でストリーミングするかを制御します。

```json5
{
  channels: {
    bluebubbles: {
      blockStreaming: true, // enable block streaming (off by default)
    },
  },
}
```

## メディア + 制限

- インバウンド添付ファイルはダウンロードされ、メディアキャッシュに保存されます。
- メディア上限は `channels.bluebubbles.mediaMaxMb`（既定: 8 MB）。
- アウトバウンドテキストは `channels.bluebubbles.textChunkLimit`（既定: 4000 文字）に分割されます。

## 設定リファレンス

全設定: [Configuration](/gateway/configuration)

プロバイダーオプション:

- `channels.bluebubbles.enabled`: チャンネルの有効化／無効化。
- `channels.bluebubbles.serverUrl`: BlueBubbles REST API のベース URL。
- `channels.bluebubbles.password`: API パスワード。
- `channels.bluebubbles.webhookPath`: Webhook エンドポイントのパス（既定: `/bluebubbles-webhook`）。
- `channels.bluebubbles.dmPolicy`: `pairing | allowlist | open | disabled`（既定: `pairing`）。
- `channels.bluebubbles.allowFrom`: DM 許可リスト（ハンドル、メール、E.164 番号、`chat_id:*`, `chat_guid:*`）。
- `channels.bluebubbles.groupPolicy`: `open | allowlist | disabled`（既定: `allowlist`）。
- `channels.bluebubbles.groupAllowFrom`: グループ送信者の許可リスト。
- `channels.bluebubbles.groups`: グループ別設定（`requireMention` など）。
- `channels.bluebubbles.sendReadReceipts`: 既読通知を送信（既定: `true`）。
- `channels.bluebubbles.blockStreaming`: ブロックストリーミングを有効化（既定: `false`; ストリーミング返信に必須）。
- `channels.bluebubbles.textChunkLimit`: アウトバウンド分割サイズ（文字数）（既定: 4000）。
- `channels.bluebubbles.chunkMode`: `length`（既定）は `textChunkLimit` 超過時のみ分割。`newline` は長さ分割前に空行（段落境界）で分割。
- `channels.bluebubbles.mediaMaxMb`: インバウンドメディア上限（MB）（既定: 8）。
- `channels.bluebubbles.historyLimit`: コンテキストに含める最大グループメッセージ数（0 で無効）。
- `channels.bluebubbles.dmHistoryLimit`: DM 履歴の上限。
- `channels.bluebubbles.actions`: 特定アクションの有効化／無効化。
- `channels.bluebubbles.accounts`: マルチアカウント設定。

関連するグローバルオプション:

- `agents.list[].groupChat.mentionPatterns`（または `messages.groupChat.mentionPatterns`）。
- `messages.responsePrefix`。

## 宛先／配信ターゲット

安定したルーティングのため、`chat_guid` を推奨します。

- `chat_guid:iMessage;-;+15555550123`（グループでは推奨）
- `chat_id:123`
- `chat_identifier:...`
- 直接ハンドル: `+15555550123`, `user@example.com`
  - 直接ハンドルに既存の DM チャットがない場合、OpenClaw は `POST /api/v1/chat/new` を介して作成します。これには BlueBubbles Private API を有効化する必要があります。 BlueBubbles Private API を有効にする必要があります。

## セキュリティ

- Webhook リクエストは、`guid`/`password` のクエリパラメータまたはヘッダーを `channels.bluebubbles.password` と比較して認証されます。`localhost` からのリクエストも受け付けられます。 `localhost` からのリクエストも受け付けます。
- API パスワードと Webhook エンドポイントは機密情報として厳重に管理してください。
- localhost 信頼により、同一ホストのリバースプロキシが意図せずパスワードをバイパスする可能性があります。ゲートウェイをプロキシする場合は、プロキシ側で認証を必須にし、`gateway.trustedProxies` を設定してください。詳細は [Gateway security](/gateway/security#reverse-proxy-configuration) を参照してください。 ゲートウェイをプロキシする場合は、プロキシで認証を行い、`gateway.trustedProxies` を設定する必要があります。 [Gateway security](/gateway/security#reverse-proxy-configuration) を参照してください。
- LAN 外に公開する場合は、BlueBubbles サーバーで HTTPS とファイアウォールルールを有効化してください。

## トラブルシューティング

- 入力中／既読イベントが動作しなくなった場合は、BlueBubbles の webhook ログを確認し、ゲートウェイのパスが `channels.bluebubbles.webhookPath` と一致していることを確認してください。
- ペアリングコードは 1 時間で失効します。`openclaw pairing list bluebubbles` と `openclaw pairing approve bluebubbles <code>` を使用してください。
- リアクションには BlueBubbles Private API（`POST /api/v1/message/react`）が必要です。サーバーバージョンが公開していることを確認してください。
- 編集／送信取り消しには macOS 13 以降と互換性のある BlueBubbles サーバーバージョンが必要です。macOS 26（Tahoe）では、Private API の変更により edit は現在壊れています。 macOS 26 (Tahoe) では、プライベート API の変更により現在編集が中断されています。
- macOS 26（Tahoe）ではグループアイコン更新が不安定な場合があります。API は成功を返しても、新しいアイコンが同期されないことがあります。
- OpenClaw は、BlueBubbles サーバーの macOS バージョンに基づいて既知の不具合があるアクションを自動的に非表示にします。macOS 26（Tahoe）で edit が表示され続ける場合は、`channels.bluebubbles.actions.edit=false` で手動で無効化してください。 macOS 26 (Tahoe) でまだ編集が表示されている場合は、`channels.bluebubbles.actions.edit=false` で手動で無効にします。
- ステータス／ヘルス情報: `openclaw status --all` または `openclaw status --deep`。

一般的なチャンネルのワークフローについては、[Channels](/channels) および [Plugins](/tools/plugin) ガイドを参照してください。
