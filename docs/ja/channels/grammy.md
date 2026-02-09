---
summary: "grammY を介した Telegram Bot API の統合とセットアップに関する注記"
read_when:
  - Telegram または grammY の経路に取り組むとき
title: grammY
---

# grammY Integration（Telegram Bot API）

# Why grammY

- TS ファーストの Bot API クライアントで、組み込みのロングポーリング + webhook ヘルパー、ミドルウェア、エラーハンドリング、レートリミッターを備えています。
- fetch + FormData を手作業で実装するよりもクリーンなメディアヘルパーを提供し、すべての Bot API メソッドをサポートします。
- 拡張可能: カスタムフェッチ、セッションミドルウェア(オプション)、タイプセーフコンテキストを介したプロキシサポート。

# What we shipped

- **Single client path:** fetch ベースの実装を削除しました。grammY は現在、送信 + ゲートウェイの両方における唯一の Telegram クライアントであり、grammY のスロットラーがデフォルトで有効です。
- **Gateway:** `monitorTelegramProvider` は grammY の `Bot` を構築し、メンション/許可リストのゲーティング、`getFile`/`download` によるメディアダウンロードを配線し、`sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument` で返信を配信します。`webhookCallback` を介してロングポーリングまたは webhook をサポートします。 `webhookCallback`を介してロングポールまたはwebhookをサポートします。
- **Proxy:** 任意の `channels.telegram.proxy` は、grammY の `client.baseFetch` を通じて `undici.ProxyAgent` を使用します。
- **Webhook support:** `webhook-set.ts` は `setWebhook/deleteWebhook` をラップします。`webhook.ts` は、ヘルスチェック + グレースフルシャットダウン付きでコールバックをホストします。`channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` が設定されている場合、Gateway は webhook モードを有効化します（それ以外はロングポーリングです）。 Gateway は `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` が設定されている場合、Webhookモードを有効にします（そうでない場合はロングポーリング）。
- **Sessions:** ダイレクトチャットはエージェントのメインセッション（`agent:<agentId>:<mainKey>`）に集約されます。グループは `agent:<agentId>:telegram:group:<chatId>` を使用します。返信は同じチャンネルにルーティングされます。
- **Config knobs:** `channels.telegram.botToken`, `channels.telegram.dmPolicy`, `channels.telegram.groups`（許可リスト + メンションのデフォルト）, `channels.telegram.allowFrom`, `channels.telegram.groupAllowFrom`, `channels.telegram.groupPolicy`, `channels.telegram.mediaMaxMb`, `channels.telegram.linkPreview`, `channels.telegram.proxy`, `channels.telegram.webhookSecret`, `channels.telegram.webhookUrl`。
- **Draft streaming:** 任意の `channels.telegram.streamMode` は、プライベートトピックチャット（Bot API 9.3+）で `sendMessageDraft` を使用します。これはチャンネルのブロックストリーミングとは別物です。 これはチャンネルブロックストリーミングとは別のものです。
- **Tests:** grammY のモックは、DM + グループのメンションゲーティングと送信をカバーします。より多くのメディア/webhook のフィクスチャは引き続き歓迎します。

Open questions

- Bot API の 429 に遭遇した場合、任意の grammY プラグイン（スロットラー）を検討します。
- より構造化されたメディアテスト（ステッカー、ボイスノート）を追加します。
- webhook のリッスンポートを設定可能にします（現在はゲートウェイ経由で配線しない限り 8787 に固定されています）。
