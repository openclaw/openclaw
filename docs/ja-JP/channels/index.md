---
summary: "OpenClawが接続できるメッセージプラットフォームの一覧"
read_when:
  - OpenClawで使うチャットチャンネルを選びたい
  - 対応メッセージプラットフォームの概要を知りたい
title: "チャットチャンネル"
---

# チャットチャンネル

OpenClawは普段使っているチャットアプリから話しかけることができる。各チャンネルはGateway経由で接続される。
テキストはすべてのチャンネルで対応しているが、メディアやリアクションはチャンネルによって異なる。

## 対応チャンネル

- [WhatsApp](/channels/whatsapp) — 最も普及。Baileysを使用し、QRコードでのペアリングが必要。
- [Telegram](/channels/telegram) — grammY経由のBot API。グループにも対応。
- [Discord](/channels/discord) — Discord Bot API + Gateway。サーバー、チャンネル、DMに対応。
- [IRC](/channels/irc) — 従来のIRCサーバー。チャンネルとDMに対応し、ペアリングと許可リストで制御可能。
- [Slack](/channels/slack) — Bolt SDK。ワークスペースアプリとして動作。
- [Feishu](/channels/feishu) — Feishu/Lark botをWebSocket経由で接続（プラグイン、別途インストール）。
- [Google Chat](/channels/googlechat) — Google Chat APIアプリをHTTP webhook経由で接続。
- [Mattermost](/channels/mattermost) — Bot API + WebSocket。チャンネル、グループ、DMに対応（プラグイン、別途インストール）。
- [Signal](/channels/signal) — signal-cliを使用。プライバシー重視。
- [BlueBubbles](/channels/bluebubbles) — **iMessageを使うならこれ**。BlueBubbles macOSサーバーのREST APIを使い、編集、送信取り消し、エフェクト、リアクション、グループ管理に対応（macOS 26 Tahoeでは編集機能に問題あり）。
- [iMessage（レガシー）](/channels/imessage) — imsg CLIを使った従来のmacOS連携（非推奨、新規ではBlueBubblesを推奨）。
- [Microsoft Teams](/channels/msteams) — Bot Framework。企業向け（プラグイン、別途インストール）。
- [LINE](/channels/line) — LINE Messaging API bot（プラグイン、別途インストール）。
- [Nextcloud Talk](/channels/nextcloud-talk) — Nextcloud Talk経由のセルフホスト型チャット（プラグイン、別途インストール）。
- [Matrix](/channels/matrix) — Matrixプロトコル（プラグイン、別途インストール）。
- [Nostr](/channels/nostr) — NIP-04による分散型DM（プラグイン、別途インストール）。
- [Tlon](/channels/tlon) — Urbitベースのメッセンジャー（プラグイン、別途インストール）。
- [Twitch](/channels/twitch) — IRC接続経由のTwitchチャット（プラグイン、別途インストール）。
- [Zalo](/channels/zalo) — Zalo Bot API。ベトナムで人気のメッセンジャー（プラグイン、別途インストール）。
- [Zalo Personal](/channels/zalouser) — QRログインによるZalo個人アカウント接続（プラグイン、別途インストール）。
- [WebChat](/web/webchat) — Gateway WebChat UI（WebSocket経由）。

## 補足

- 複数のチャンネルを同時に稼働できる。設定しておけばOpenClawがチャットごとにルーティングする。
- 最も手軽に始められるのは**Telegram**（botトークンを発行するだけ）。WhatsAppはQRペアリングが必要で、ディスクに保存する状態も多い。
- グループの挙動はチャンネルによって異なる。詳細は[グループ](/channels/groups)を参照。
- 安全のため、DMのペアリングと許可リストが適用される。詳細は[セキュリティ](/gateway/security)を参照。
- Telegramの内部動作については[grammYノート](/channels/grammy)を参照。
- トラブルシューティングは[チャンネルのトラブルシューティング](/channels/troubleshooting)を参照。
- モデルプロバイダーは別ドキュメントで解説。[モデルプロバイダー](/providers/models)を参照。
