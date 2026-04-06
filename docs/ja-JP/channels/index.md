---
summary: "OpenClaw が接続できるメッセージングプラットフォーム"
read_when:
  - OpenClaw のチャットチャンネルを選びたい場合
  - サポートされているメッセージングプラットフォームの概要が必要な場合
title: "チャットチャンネル"
x-i18n:
    generated_at: "2026-04-03T00:00:00Z"
    model: claude-sonnet-4-6
    provider: anthropic
    source_hash: 995ce796a910793d13d937b4e6c828ca9be1d86e55dd8f18a8b78d77ed435499
    source_path: channels/index.md
    workflow: 15
---

# チャットチャンネル

OpenClaw はすでに使用しているチャットアプリで話しかけることができます。各チャンネルは Gateway ゲートウェイを介して接続されます。
テキストはどこでもサポートされています；メディアとリアクションはチャンネルによって異なります。

## サポートされているチャンネル

- [BlueBubbles](/channels/bluebubbles) — **iMessage に推奨**；BlueBubbles macOS サーバー REST API を使用した完全な機能サポート（編集、送信取消、エフェクト、リアクション、グループ管理 — 編集は現在 macOS 26 Tahoe で壊れています）。
- [Discord](/channels/discord) — Discord Bot API + Gateway ゲートウェイ；サーバー、チャンネル、DM をサポート。
- [Feishu](/channels/feishu) — WebSocket 経由の Feishu/Lark ボット（プラグイン、別途インストール）。
- [Google Chat](/channels/googlechat) — HTTP Webhook 経由の Google Chat API アプリ。
- [iMessage（レガシー）](/channels/imessage) — imsg CLI 経由のレガシー macOS 統合（非推奨、新規セットアップには BlueBubbles を使用）。
- [IRC](/channels/irc) — クラシック IRC サーバー；ペアリング/許可リスト制御付きのチャンネルと DM。
- [LINE](/channels/line) — LINE Messaging API ボット（プラグイン、別途インストール）。
- [Matrix](/channels/matrix) — Matrix プロトコル（プラグイン、別途インストール）。
- [Mattermost](/channels/mattermost) — Bot API + WebSocket；チャンネル、グループ、DM（プラグイン、別途インストール）。
- [Microsoft Teams](/channels/msteams) — Bot Framework；エンタープライズサポート（プラグイン、別途インストール）。
- [Nextcloud Talk](/channels/nextcloud-talk) — Nextcloud Talk 経由のセルフホストチャット（プラグイン、別途インストール）。
- [Nostr](/channels/nostr) — NIP-04 経由の分散型 DM（プラグイン、別途インストール）。
- [QQ Bot](/channels/qqbot) — QQ Bot API；プライベートチャット、グループチャット、リッチメディア。
- [Signal](/channels/signal) — signal-cli；プライバシー重視。
- [Slack](/channels/slack) — Bolt SDK；ワークスペースアプリ。
- [Synology Chat](/channels/synology-chat) — 送受信 Webhook 経由の Synology NAS チャット（プラグイン、別途インストール）。
- [Telegram](/channels/telegram) — grammY 経由の Bot API；グループをサポート。
- [Tlon](/channels/tlon) — Urbit ベースのメッセンジャー（プラグイン、別途インストール）。
- [Twitch](/channels/twitch) — IRC 接続経由の Twitch チャット（プラグイン、別途インストール）。
- [Voice Call](/plugins/voice-call) — Plivo または Twilio 経由のテレフォニー（プラグイン、別途インストール）。
- [WebChat](/web/webchat) — WebSocket 経由の Gateway ゲートウェイ WebChat UI。
- [WeChat](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin) — QR ログイン経由の Tencent iLink ボットプラグイン；プライベートチャットのみ。
- [WhatsApp](/channels/whatsapp) — 最も人気が高い；Baileys を使用し QR ペアリングが必要。
- [Zalo](/channels/zalo) — Zalo Bot API；ベトナムの人気メッセンジャー（プラグイン、別途インストール）。
- [Zalo パーソナル](/channels/zalouser) — QR ログイン経由の Zalo 個人アカウント（プラグイン、別途インストール）。

## 注意事項

- チャンネルは同時に実行できます；複数設定すると OpenClaw はチャットごとにルーティングします。
- 最速セットアップは通常 **Telegram**（シンプルなボットトークン）。WhatsApp は QR ペアリングが必要でディスクにより多くの状態を保存します。
- グループ動作はチャンネルによって異なります；[グループ](/channels/groups) を参照してください。
- DM ペアリングと許可リストは安全のために強制されます；[セキュリティ](/gateway/security) を参照してください。
- トラブルシューティング：[チャンネルトラブルシューティング](/channels/troubleshooting)。
- モデルプロバイダーは別途ドキュメント化されています；[モデルプロバイダー](/providers/models) を参照してください。
