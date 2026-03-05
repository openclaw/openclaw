---
summary: "OpenClawが接続できるメッセージングプラットフォーム"
read_when:
  - OpenClawのチャットチャンネルを選択したい場合
  - サポートされているメッセージングプラットフォームの概要が必要な場合
title: "チャットチャンネル"
x-i18n:
  source_path: docs/channels/index.md
  generated_at: "2026-03-05T10:01:00Z"
  model: claude-opus-4-6
  provider: pi
---

# チャットチャンネル

OpenClawは、あなたが既に使用しているチャットアプリで会話できます。各チャンネルはゲートウェイ経由で接続します。テキストはすべてのチャンネルでサポートされています。メディアとリアクションはチャンネルによって異なります。

## サポートされているチャンネル

- [BlueBubbles](/channels/bluebubbles) — **iMessageに推奨**。BlueBubbles macOSサーバーREST APIを使用し、フル機能をサポート（編集、送信取消、エフェクト、リアクション、グループ管理 — 編集は現在macOS 26 Tahoeで不具合あり）。
- [Discord](/channels/discord) — Discord Bot API + Gateway。サーバー、チャンネル、DMをサポート。
- [Feishu](/channels/feishu) — WebSocket経由のFeishu/Larkボット（プラグイン、別途インストール）。
- [Google Chat](/channels/googlechat) — HTTPウェブフック経由のGoogle Chat APIアプリ。
- [iMessage (レガシー)](/channels/imessage) — imsg CLI経由のレガシーmacOS統合（非推奨、新規セットアップにはBlueBubblesを使用）。
- [IRC](/channels/irc) — クラシックIRCサーバー。ペアリング/許可リスト制御付きのチャンネル + DM。
- [LINE](/channels/line) — LINE Messaging APIボット（プラグイン、別途インストール）。
- [Matrix](/channels/matrix) — Matrixプロトコル（プラグイン、別途インストール）。
- [Mattermost](/channels/mattermost) — Bot API + WebSocket。チャンネル、グループ、DM（プラグイン、別途インストール）。
- [Microsoft Teams](/channels/msteams) — Bot Framework。エンタープライズサポート（プラグイン、別途インストール）。
- [Nextcloud Talk](/channels/nextcloud-talk) — Nextcloud Talk経由のセルフホストチャット（プラグイン、別途インストール）。
- [Nostr](/channels/nostr) — NIP-04経由の分散型DM（プラグイン、別途インストール）。
- [Signal](/channels/signal) — signal-cli。プライバシー重視。
- [Synology Chat](/channels/synology-chat) — 送受信ウェブフック経由のSynology NAS Chat（プラグイン、別途インストール）。
- [Slack](/channels/slack) — Bolt SDK。ワークスペースアプリ。
- [Telegram](/channels/telegram) — grammY経由のBot API。グループをサポート。
- [Tlon](/channels/tlon) — Urbitベースのメッセンジャー（プラグイン、別途インストール）。
- [Twitch](/channels/twitch) — IRC接続経由のTwitchチャット（プラグイン、別途インストール）。
- [WebChat](/web/webchat) — WebSocket経由のゲートウェイWebChat UI。
- [WhatsApp](/channels/whatsapp) — 最も人気。Baileysを使用し、QRペアリングが必要。
- [Zalo](/channels/zalo) — Zalo Bot API。ベトナムで人気のメッセンジャー（プラグイン、別途インストール）。
- [Zalo Personal](/channels/zalouser) — QRログイン経由のZalo個人アカウント（プラグイン、別途インストール）。

## 注意事項

- チャンネルは同時に実行でき、複数を設定するとOpenClawがチャットごとにルーティングします。
- 最も簡単なセットアップは通常**Telegram**です（シンプルなボットトークン）。WhatsAppはQRペアリングが必要で、ディスク上により多くの状態を保存します。
- グループの動作はチャンネルによって異なります。[グループ](/channels/groups)を参照してください。
- DMのペアリングと許可リストは安全性のために適用されます。[セキュリティ](/gateway/security)を参照してください。
- トラブルシューティング：[チャンネルのトラブルシューティング](/channels/troubleshooting)。
- モデルプロバイダーは別途ドキュメント化されています。[モデルプロバイダー](/providers/models)を参照してください。
