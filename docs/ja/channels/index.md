---
summary: "OpenClaw が接続できるメッセージングプラットフォーム"
read_when:
  - OpenClaw のチャットチャンネルを選択したい場合
  - 対応しているメッセージングプラットフォームの概要をすばやく確認したい場合
title: "チャットチャンネル"
---

# チャットチャンネル

OpenClaw は、すでに利用している任意のチャットアプリで対話できます。各チャンネルは Gateway（ゲートウェイ）経由で接続されます。
テキストはすべてのチャンネルでサポートされていますが、メディアやリアクションはチャンネルごとに異なります。 各チャンネルはゲートウェイ経由で接続されます。
テキストはどこでもサポートされています。メディアやリアクションはチャンネルごとに異なります。

## 対応チャンネル

- [WhatsApp](/channels/whatsapp) — 最も普及しており、Baileys を使用し、QR ペアリングが必要です。
- [Telegram](/channels/telegram) — grammY 経由の Bot API。グループをサポートします。
- [Discord](/channels/discord) — Discord Bot API + Gateway（ゲートウェイ）。サーバー、チャンネル、DM をサポートします。
- [Slack](/channels/slack) — Bolt SDK。ワークスペースアプリ。
- [Feishu](/channels/feishu) — WebSocket 経由の Feishu/Lark ボット（プラグイン、別途インストール）。
- [Google Chat](/channels/googlechat) — HTTP webhook 経由の Google Chat API アプリ。
- [Mattermost](/channels/mattermost) — Bot API + WebSocket。チャンネル、グループ、DM（プラグイン、別途インストール）。
- [Signal](/channels/signal) — signal-cli。プライバシー重視。
- [BlueBubbles](/channels/bluebubbles) — **iMessage に推奨**。BlueBubbles macOS サーバーの REST API を使用し、完全な機能をサポート（編集、送信取消、エフェクト、リアクション、グループ管理 — 編集は現在 macOS 26 Tahoe で不具合があります）。
- [iMessage (legacy)](/channels/imessage) — imsg CLI によるレガシーな macOS 連携（非推奨。新規セットアップには BlueBubbles を使用してください）。
- [Microsoft Teams](/channels/msteams) — Bot Framework。エンタープライズ向けサポート（プラグイン、別途インストール）。
- [LINE](/channels/line) — LINE Messaging API ボット（プラグイン、別途インストール）。
- [Nextcloud Talk](/channels/nextcloud-talk) — Nextcloud Talk によるセルフホスト型チャット（プラグイン、別途インストール）。
- [Matrix](/channels/matrix) — Matrix プロトコル（プラグイン、別途インストール）。
- [Nostr](/channels/nostr) — NIP-04 による分散型 DM（プラグイン、別途インストール）。
- [Tlon](/channels/tlon) — Urbit ベースのメッセンジャー（プラグイン、別途インストール）。
- [Twitch](/channels/twitch) — IRC 接続による Twitch チャット（プラグイン、別途インストール）。
- [Zalo](/channels/zalo) — Zalo Bot API。ベトナムで人気のメッセンジャー（プラグイン、別途インストール）。
- [Zalo Personal](/channels/zalouser) — QR ログインによる Zalo 個人アカウント（プラグイン、別途インストール）。
- [WebChat](/web/webchat) — WebSocket 上の Gateway（ゲートウェイ） WebChat UI。

## 注記

- チャンネルは同時に実行できます。複数を設定すると、OpenClaw がチャットごとにルーティングします。
- 最も迅速にセットアップできるのは通常 **Telegram**（シンプルなボットトークン）です。WhatsApp は QR ペアリングが必要で、ディスク上により多くの状態を保存します。 WhatsAppはQRペアリングを必要とし、
  はディスク上にさらに状態を保存します。
- グループの挙動はチャンネルによって異なります。詳しくは [Groups](/channels/groups) を参照してください。
- 安全性のため、DM のペアリングと許可リストが適用されます。詳しくは [Security](/gateway/security) を参照してください。
- Telegram の内部仕様については [grammY notes](/channels/grammy) を参照してください。
- トラブルシューティング: [Channel troubleshooting](/channels/troubleshooting)。
- モデルプロバイダーは別途ドキュメント化されています。詳しくは [Model Providers](/providers/models) を参照してください。
