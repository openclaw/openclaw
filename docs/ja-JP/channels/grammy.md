---
read_when:
  - TelegramやgrammY関連の機能を開発する時
summary: grammYを使用したTelegram Bot APIの統合とセットアップ手順
title: grammY
---

# grammY統合（Telegram Bot API）

# なぜgrammYを選ぶのか

- TypeScript中心のBot APIクライアントで、ロングポーリング + Webhookヘルパー、ミドルウェア、エラーハンドリング、レートリミッターが組み込まれています。
- メディア処理ヘルパーは手動でfetch + FormDataを書くよりも簡潔です。すべてのBot APIメソッドをサポートしています。
- 拡張性：カスタムfetchによるプロキシサポート、オプションのセッションミドルウェア、型安全なコンテキスト。

# リリースした内容

- **単一クライアントパス：** fetchベースの実装を削除し、grammYがTelegramの唯一のクライアント（送信 + Gatewayゲートウェイ）になりました。grammY throttlerがデフォルトで有効です。
- **Gatewayゲートウェイ：** `monitorTelegramProvider`がgrammY `Bot`を構築し、mention/allowlistゲートウェイ制御に接続し、`getFile`/`download`でメディアをダウンロードし、`sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument`で返信を送信します。`webhookCallback`によるロングポーリングまたはWebhookをサポートしています。
- **プロキシ：** オプションの`channels.telegram.proxy`がgrammYの`client.baseFetch`を通じて`undici.ProxyAgent`を使用します。
- **Webhookサポート：** `webhook-set.ts`が`setWebhook/deleteWebhook`をラップし、`webhook.ts`がヘルスチェックとグレースフルシャットダウン付きのコールバックをホストします。`channels.telegram.webhookUrl` + `channels.telegram.webhookSecret`が設定されている場合、GatewayはWebhookモードを有効にします（それ以外はロングポーリング）。
- **セッション：** DMはエージェントのメインセッション（`agent:<agentId>:<mainKey>`）に集約されます。グループは`agent:<agentId>:telegram:group:<chatId>`を使用します。返信は同じチャンネルにルーティングされます。
- **設定オプション：** `channels.telegram.botToken`、`channels.telegram.dmPolicy`、`channels.telegram.groups`（allowlist + mentionのデフォルト）、`channels.telegram.allowFrom`、`channels.telegram.groupAllowFrom`、`channels.telegram.groupPolicy`、`channels.telegram.mediaMaxMb`、`channels.telegram.linkPreview`、`channels.telegram.proxy`、`channels.telegram.webhookSecret`、`channels.telegram.webhookUrl`。
- **ドラフトストリーミング：** オプションの`channels.telegram.streamMode`がプライベートトピックチャットで`sendMessageDraft`（Bot API 9.3+）を使用します。これはチャンネルブロックストリーミングとは別です。
- **テスト：** grammYモックがDM + グループmentionゲートウェイ制御と送信をカバーしています。メディア/Webhookのテストケース追加を歓迎します。

未解決の問題

- Bot API 429エラーが発生した場合、オプションのgrammYプラグイン（throttler）の使用を検討してください。
- 構造化メディアテスト（ステッカー、音声メッセージ）を追加する。
- Webhookリスンポートを設定可能にする（現在はGateway設定経由でない限り8787に固定）。
