---
title: アウトバウンドセッションミラーリングリファクタリング（Issue #1520）
description: アウトバウンドセッションミラーリングのリファクタリングメモ、決定事項、テスト、未解決アイテムを追跡します。
summary: "アウトバウンド送信をターゲットチャンネルセッションにミラーリングするためのリファクタリングメモ"
read_when:
  - アウトバウンドトランスクリプト/セッションミラーリング動作に取り組む場合
  - send/message ツールパスの sessionKey 導出をデバッグする場合
---

# アウトバウンドセッションミラーリングリファクタリング（Issue #1520）

## ステータス

- 進行中。
- コア + プラグインチャンネルルーティングがアウトバウンドミラーリング用に更新済み。
- Gateway の send は、sessionKey が省略された場合にターゲットセッションを導出するようになりました。

## コンテキスト

アウトバウンド送信は、ターゲットチャンネルセッションではなく、_現在の_エージェントセッション（ツールセッションキー）にミラーリングされていました。インバウンドルーティングはチャンネル/ピアセッションキーを使用するため、アウトバウンドレスポンスが誤ったセッションに届き、ファーストコンタクトのターゲットにはセッションエントリが存在しないことが多かったです。

## 目標

- アウトバウンドメッセージをターゲットチャンネルのセッションキーにミラーリングします。
- 欠如している場合、アウトバウンド時にセッションエントリを作成します。
- スレッド/トピックのスコープをインバウンドセッションキーと整合させます。
- コアチャンネルとバンドルされた拡張機能をカバーします。

## 実装まとめ

- 新しいアウトバウンドセッションルーティングヘルパー:
  - `src/infra/outbound/outbound-session.ts`
  - `resolveOutboundSessionRoute` が `buildAgentSessionKey`（dmScope + identityLinks）を使用してターゲット sessionKey を構築。
  - `ensureOutboundSessionEntry` が `recordSessionMetaFromInbound` を介して最小限の `MsgContext` を書き込む。
- `runMessageAction`（send）がターゲット sessionKey を導出し、ミラーリングのために `executeSendAction` に渡す。
- `message-tool` は直接ミラーリングせず、現在のセッションキーから agentId を解決するだけです。
- プラグイン送信パスは導出された sessionKey を使用して `appendAssistantMessageToSessionTranscript` 経由でミラーリング。
- Gateway の send は、提供されない場合（デフォルトエージェント）にターゲットセッションキーを導出し、セッションエントリを確保します。

## スレッド/トピック処理

- Slack: replyTo/threadId → `resolveThreadSessionKeys`（サフィックス）。
- Discord: threadId/replyTo → `resolveThreadSessionKeys`（`useSuffix=false`）でインバウンドと一致（スレッドチャンネル ID がすでにセッションをスコープ）。
- Telegram: トピック ID は `buildTelegramGroupPeerId` 経由で `chatId:topic:<id>` にマッピング。

## カバーされた拡張機能

- Matrix、MS Teams、Mattermost、BlueBubbles、Nextcloud Talk、Zalo、Zalo Personal、Nostr、Tlon。
- メモ:
  - Mattermost のターゲットは、DM セッションキールーティングのために `@` を除去するようになりました。
  - Zalo Personal は 1:1 ターゲットに DM ピアカインドを使用（`group:` が存在する場合のみグループ）。
  - BlueBubbles グループターゲットは、インバウンドセッションキーと一致させるために `chat_*` プレフィックスを除去。
  - Slack 自動スレッドミラーリングはチャンネル ID を大文字小文字を区別せずに一致。
  - Gateway の send は、ミラーリング前に提供されたセッションキーを小文字に変換。

## 決定事項

- **Gateway send のセッション導出**: `sessionKey` が提供された場合はそれを使用。省略された場合、ターゲット + デフォルトエージェントから sessionKey を導出してそこにミラーリング。
- **セッションエントリ作成**: 常に `recordSessionMetaFromInbound` を使用し、`Provider/From/To/ChatType/AccountId/Originating*` をインバウンドフォーマットに合わせる。
- **ターゲット正規化**: アウトバウンドルーティングは、利用可能な場合に解決されたターゲット（`resolveChannelTarget` 後）を使用。
- **セッションキーケーシング**: 書き込み時および移行時にセッションキーを小文字に正規化。

## 追加/更新されたテスト

- `src/infra/outbound/outbound.test.ts`
  - Slack スレッドセッションキー。
  - Telegram トピックセッションキー。
  - Discord との dmScope identityLinks。
- `src/agents/tools/message-tool.test.ts`
  - セッションキーから agentId を導出（sessionKey をスルーしない）。
- `src/gateway/server-methods/send.test.ts`
  - 省略時にセッションキーを導出し、セッションエントリを作成。

## 未解決アイテム / フォローアップ

- Voice-call プラグインはカスタムの `voice:<phone>` セッションキーを使用。アウトバウンドマッピングはここでは標準化されていません。message-tool が voice-call 送信をサポートすべき場合、明示的なマッピングを追加してください。
- バンドルセットを超えた非標準の `From/To` フォーマットを使用する外部プラグインがあるかどうかを確認。

## 変更されたファイル

- `src/infra/outbound/outbound-session.ts`
- `src/infra/outbound/outbound-send-service.ts`
- `src/infra/outbound/message-action-runner.ts`
- `src/agents/tools/message-tool.ts`
- `src/gateway/server-methods/send.ts`
- テスト:
  - `src/infra/outbound/outbound.test.ts`
  - `src/agents/tools/message-tool.test.ts`
  - `src/gateway/server-methods/send.test.ts`
