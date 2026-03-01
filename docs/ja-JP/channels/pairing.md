---
summary: "ペアリングの概要: DMの許可対象とノード参加の承認"
read_when:
  - DMアクセス制御を設定するとき
  - 新しいiOS/Androidノードをペアリングするとき
  - OpenClawのセキュリティ体制を確認するとき
title: "ペアリング"
---

# ペアリング

「ペアリング」はOpenClawの明示的な**オーナー承認**ステップです。
以下の2か所で使用されます:

1. **DMペアリング**（ボットと会話できる人を制御）
2. **ノードペアリング**（Gatewayネットワークに参加できるデバイス/ノードを制御）

セキュリティコンテキスト: [セキュリティ](/gateway/security)

## 1) DMペアリング（受信チャットアクセス）

チャンネルがDMポリシー`pairing`で設定されている場合、未知の送信者にはショートコードが提示され、承認されるまでメッセージは**処理されません**。

デフォルトのDMポリシーは以下に記載されています: [セキュリティ](/gateway/security)

ペアリングコード:

- 8文字、大文字、紛らわしい文字なし（`0O1I`）。
- **1時間後に期限切れ**になります。ボットは新しいリクエストが作成されたときにのみペアリングメッセージを送信します（送信者ごとにおよそ1時間に1回）。
- 保留中のDMペアリングリクエストはデフォルトで**チャンネルごとに3件**が上限です。1件が期限切れになるか承認されるまで、追加のリクエストは無視されます。

### 送信者を承認する

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

サポートされているチャンネル: `telegram`、`whatsapp`、`signal`、`imessage`、`discord`、`slack`、`feishu`。

### 状態の保存場所

`~/.openclaw/credentials/`に保存されます:

- 保留中のリクエスト: `<channel>-pairing.json`
- 承認済み許可リストストア:
  - デフォルトアカウント: `<channel>-allowFrom.json`
  - デフォルト以外のアカウント: `<channel>-<accountId>-allowFrom.json`

アカウントスコープの動作:

- デフォルト以外のアカウントは、スコープされた許可リストファイルのみを読み書きします。
- デフォルトアカウントは、チャンネルスコープのスコープなし許可リストファイルを使用します。

これらはアシスタントへのアクセスを制御するため、機密情報として扱ってください。

## 2) ノードデバイスペアリング（iOS/Android/macOS/ヘッドレスノード）

ノードは`role: node`の**デバイス**としてGatewayに接続します。Gatewayは
承認が必要なデバイスペアリングリクエストを作成します。

### Telegram経由でペアリング（iOS推奨）

`device-pair`プラグインを使用している場合、初回デバイスペアリングをTelegramから完全に行えます:

1. Telegramでボットにメッセージを送信: `/pair`
2. ボットが2つのメッセージで返信します: 説明メッセージと別の**セットアップコード**メッセージ（Telegramでコピー＆ペーストが簡単です）。
3. スマートフォンでOpenClaw iOSアプリを開く → 設定 → Gateway。
4. セットアップコードを貼り付けて接続。
5. Telegramに戻る: `/pair approve`

セットアップコードは以下を含むbase64エンコードされたJSONペイロードです:

- `url`: GatewayのWebSocket URL（`ws://...`または`wss://...`）
- `token`: 短期間有効なペアリングトークン

セットアップコードは有効な間、パスワードと同様に扱ってください。

### ノードデバイスを承認する

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

### ノードペアリング状態の保存場所

`~/.openclaw/devices/`に保存されます:

- `pending.json`（短期間有効。保留中のリクエストは期限切れになります）
- `paired.json`（ペアリング済みデバイス + トークン）

### 注意事項

- レガシーの`node.pair.*` API（CLI: `openclaw nodes pending/approve`）は
  Gatewayが管理する別のペアリングストアです。WSノードにはデバイスペアリングが依然として必要です。

## 関連ドキュメント

- セキュリティモデル + プロンプトインジェクション: [セキュリティ](/gateway/security)
- 安全なアップデート（doctorを実行）: [アップデート](/install/updating)
- チャンネル設定:
  - Telegram: [Telegram](/channels/telegram)
  - WhatsApp: [WhatsApp](/channels/whatsapp)
  - Signal: [Signal](/channels/signal)
  - BlueBubbles (iMessage): [BlueBubbles](/channels/bluebubbles)
  - iMessage (レガシー): [iMessage](/channels/imessage)
  - Discord: [Discord](/channels/discord)
  - Slack: [Slack](/channels/slack)
