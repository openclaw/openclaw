---
summary: "OpenClawが接続できるメッセージングプラットフォーム"
read_when:
  - OpenClawのチャットチャンネルを選びたいとき
  - サポートされているメッセージングプラットフォームの概要を知りたいとき
title: "チャットチャンネル"
---

# チャットチャンネル

OpenClawは、あなたが普段使っているチャットアプリで会話できます。各チャンネルはGatewayを介して接続されます。
テキストはすべてのチャンネルでサポートされていますが、メディアやリアクションのサポートはチャンネルによって異なります。

## サポートされているチャンネル

- [WhatsApp](/channels/whatsapp) — 最も人気があり、Baileysを使用してQRペアリングが必要です。
- [Telegram](/channels/telegram) — grammYを利用したBot API。グループをサポートしています。
- [Discord](/channels/discord) — Discord Bot API + Gateway。サーバー、チャンネル、DMをサポートしています。
- [IRC](/channels/irc) — クラシックなIRCサーバー。チャンネル + DMでペアリング/許可リスト制御が可能です。
- [Slack](/channels/slack) — Bolt SDK。ワークスペースアプリです。
- [Feishu](/channels/feishu) — WebSocket経由のFeishu/Larkボット（プラグイン、別途インストールが必要）。
- [Google Chat](/channels/googlechat) — HTTPウェブフック経由のGoogle Chat APIアプリ。
- [Mattermost](/channels/mattermost) — Bot API + WebSocket。チャンネル、グループ、DM（プラグイン、別途インストールが必要）。
- [Signal](/channels/signal) — signal-cli。プライバシー重視です。
- [BlueBubbles](/channels/bluebubbles) — **iMessage推奨**。BlueBubbles macOSサーバーREST APIを使用し、フル機能をサポート（編集、送信取消、エフェクト、リアクション、グループ管理 — 編集はmacOS 26 Tahoeで現在動作しません）。
- [iMessage (レガシー)](/channels/imessage) — imsg CLI経由のレガシーmacOS統合（非推奨、新規セットアップにはBlueBubblesを使用してください）。
- [Microsoft Teams](/channels/msteams) — Bot Framework。エンタープライズサポート（プラグイン、別途インストールが必要）。
- [Synology Chat](/channels/synology-chat) — 送信+受信ウェブフック経由のSynology NASチャット（プラグイン、別途インストールが必要）。
- [LINE](/channels/line) — LINE Messaging APIボット（プラグイン、別途インストールが必要）。
- [Nextcloud Talk](/channels/nextcloud-talk) — Nextcloud Talk経由のセルフホスト型チャット（プラグイン、別途インストールが必要）。
- [Matrix](/channels/matrix) — Matrixプロトコル（プラグイン、別途インストールが必要）。
- [Nostr](/channels/nostr) — NIP-04経由の分散型DM（プラグイン、別途インストールが必要）。
- [Tlon](/channels/tlon) — Urbitベースのメッセンジャー（プラグイン、別途インストールが必要）。
- [Twitch](/channels/twitch) — IRC接続経由のTwitchチャット（プラグイン、別途インストールが必要）。
- [Zalo](/channels/zalo) — Zalo Bot API。ベトナムで人気のメッセンジャー（プラグイン、別途インストールが必要）。
- [Zalo Personal](/channels/zalouser) — QRログイン経由のZalo個人アカウント（プラグイン、別途インストールが必要）。
- [WebChat](/web/webchat) — WebSocket経由のGateway WebChat UI。

## 注意事項

- チャンネルは同時に実行できます。複数を設定すると、OpenClawはチャットごとにルーティングします。
- 最速のセットアップは通常 **Telegram**（シンプルなボットトークン）です。WhatsAppはQRペアリングが必要で、
  より多くの状態をディスクに保存します。
- グループの動作はチャンネルによって異なります。[グループ](/channels/groups)を参照してください。
- DMのペアリングと許可リストは安全性のために適用されます。[セキュリティ](/gateway/security)を参照してください。
- トラブルシューティング: [チャンネルのトラブルシューティング](/channels/troubleshooting)。
- モデルプロバイダーは別途文書化されています。[モデルプロバイダー](/providers/models)を参照してください。
