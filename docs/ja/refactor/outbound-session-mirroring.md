---
title: "アウトバウンド セッション ミラーリングのリファクタリング（Issue #1520）" #1520)
description: Track outbound session mirroring refactor notes, decisions, tests, and open items.
---

# アウトバウンド セッション ミラーリングのリファクタリング（Issue #1520）

## ステータス

- 進行中です。
- アウトバウンド ミラーリング向けに、コアおよびプラグインのチャンネル ルーティングを更新しました。
- Gateway 送信は、sessionKey が省略された場合にターゲット セッションを導出するようになりました。

## コンテキスト

アウトバウンド送信は、ターゲット チャンネル セッションではなく「現在の」エージェント セッション（ツールのセッション キー）にミラーリングされていました。インバウンド ルーティングはチャンネル／ピアのセッション キーを使用するため、アウトバウンド応答が誤ったセッションに着地し、初回接触のターゲットではセッション エントリが欠落することが多くありました。 インバウンドルーティングはチャネル/ピアセッションキーを使用するため、アウトバウンドレスポンスは間違ったセッションに上陸し、ファーストコンタクトターゲットはしばしばセッションエントリが不足していました。

## 目標

- アウトバウンド メッセージをターゲット チャンネルのセッション キーにミラーリングします。
- 不足している場合、アウトバウンド時にセッション エントリを作成します。
- スレッド／トピックのスコープをインバウンドのセッション キーと整合させます。
- コア チャンネルおよび同梱の拡張を網羅します。

## 実装概要

- 新しいアウトバウンド セッション ルーティング ヘルパー:
  - `src/infra/outbound/outbound-session.ts`
  - `resolveOutboundSessionRoute` は、`buildAgentSessionKey`（dmScope + identityLinks）を使用してターゲットの sessionKey を構築します。
  - `ensureOutboundSessionEntry` は、`recordSessionMetaFromInbound` を介して最小限の `MsgContext` を書き込みます。
- `runMessageAction`（send）はターゲットの sessionKey を導出し、ミラーリングのために `executeSendAction` に渡します。
- `message-tool` は直接ミラーリングしなくなり、現在のセッション キーから agentId を解決するのみになります。
- プラグインの send パスは、導出された sessionKey を使用して `appendAssistantMessageToSessionTranscript` 経由でミラーリングします。
- Gateway 送信は、指定がない場合（デフォルト エージェント）にターゲットのセッション キーを導出し、セッション エントリを保証します。

## スレッド／トピックの取り扱い

- Slack: replyTo/threadId -> `resolveThreadSessionKeys`（サフィックス）。
- Discord: threadId/replyTo -> `resolveThreadSessionKeys` に `useSuffix=false` を適用してインバウンドと一致させます（スレッド チャンネル ID が既にセッションをスコープします）。
- Telegram: トピック ID は `buildTelegramGroupPeerId` を介して `chatId:topic:<id>` にマップされます。

## 対応済み拡張

- Matrix、MS Teams、Mattermost、BlueBubbles、Nextcloud Talk、Zalo、Zalo Personal、Nostr、Tlon。
- 注記:
  - Mattermost のターゲットは、DM のセッション キー ルーティングのために `@` を削除します。
  - Zalo Personal は、1:1 ターゲットに DM ピア種別を使用します（`group:` が存在する場合のみグループ）。
  - BlueBubbles のグループ ターゲットは、インバウンドのセッション キーに合わせるために `chat_*` プレフィックスを削除します。
  - Slack の自動スレッド ミラーリングは、チャンネル ID を大文字小文字を区別せずに一致させます。
  - Gateway 送信は、ミラーリング前に提供されたセッション キーを小文字化します。

## 決定事項

- **Gateway 送信のセッション導出**: `sessionKey` が提供されている場合はそれを使用します。省略時は、ターゲット + デフォルト エージェントから sessionKey を導出し、そこへミラーリングします。 省略された場合は、ターゲット+デフォルトエージェントからsessionKeyを派生し、そこにミラーリングします。
- **セッション エントリの作成**: 常に `recordSessionMetaFromInbound` を使用し、`Provider/From/To/ChatType/AccountId/Originating*` をインバウンド形式に合わせます。
- **ターゲットの正規化**: アウトバウンド ルーティングでは、利用可能な場合に解決済みターゲット（`resolveChannelTarget` 後）を使用します。
- **セッション キーの大文字小文字**: 書き込み時およびマイグレーション中に、セッション キーを小文字へ正規化します。

## 追加／更新されたテスト

- `src/infra/outbound/outbound-session.test.ts`
  - Slack のスレッド セッション キー。
  - Telegram のトピック セッション キー。
  - Discord における dmScope identityLinks。
- `src/agents/tools/message-tool.test.ts`
  - セッション キーから agentId を導出（sessionKey を引き回さない）。
- `src/gateway/server-methods/send.test.ts`
  - 省略時にセッション キーを導出し、セッション エントリを作成します。

## アイテム/フォローアップを開く

- Voice-call プラグインは、カスタム `voice:<phone>` セッションキーを使用します。 音声通話プラグインはカスタムの `voice:<phone>` セッション キーを使用します。アウトバウンドのマッピングはここでは標準化されていません。message-tool が音声通話の送信をサポートする必要がある場合は、明示的なマッピングを追加してください。
- 同梱セット以外で、外部プラグインが非標準の `From/To` 形式を使用していないかを確認します。

## 変更されたファイル

- `src/infra/outbound/outbound-session.ts`
- `src/infra/outbound/outbound-send-service.ts`
- `src/infra/outbound/message-action-runner.ts`
- `src/agents/tools/message-tool.ts`
- `src/gateway/server-methods/send.ts`
- テスト:
  - `src/infra/outbound/outbound-session.test.ts`
  - `src/agents/tools/message-tool.test.ts`
  - `src/gateway/server-methods/send.test.ts`
