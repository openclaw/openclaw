---
summary: "使用状況のトラッキングの表示箇所と認証情報の要件"
read_when:
  - プロバイダーの使用状況／クォータの表示を配線しているとき
  - 使用状況のトラッキングの挙動や認証要件を説明する必要があるとき
title: "使用状況のトラッキング"
x-i18n:
  source_path: concepts/usage-tracking.md
  source_hash: 6f6ed2a70329b2a6
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:21:37Z
---

# 使用状況のトラッキング

## 概要

- プロバイダーの使用状況／クォータを、それぞれの使用状況エンドポイントから直接取得します。
- 推定コストは算出しません。プロバイダーが報告する期間のみを表示します。

## 表示される場所

- チャット内の `/status`: セッショントークンと推定コスト（API キーのみ）を含む、絵文字が豊富なステータスカード。利用可能な場合、**現在のモデルプロバイダー**の使用状況が表示されます。
- チャット内の `/usage off|tokens|full`: 応答ごとの使用状況フッター（OAuth はトークン数のみ表示）。
- チャット内の `/usage cost`: OpenClaw のセッションログから集計したローカルコストの要約。
- CLI: `openclaw status --usage` がプロバイダー別の詳細な内訳を出力します。
- CLI: `openclaw channels list` が、プロバイダー設定と並べて同じ使用状況スナップショットを出力します（`--no-usage` を使用するとスキップできます）。
- macOS メニューバー: Context 配下の「Usage」セクション（利用可能な場合のみ）。

## プロバイダーと認証情報

- **Anthropic（Claude）**: 認証プロファイル内の OAuth トークン。
- **GitHub Copilot**: 認証プロファイル内の OAuth トークン。
- **Gemini CLI**: 認証プロファイル内の OAuth トークン。
- **Antigravity**: 認証プロファイル内の OAuth トークン。
- **OpenAI Codex**: 認証プロファイル内の OAuth トークン（存在する場合は accountId を使用）。
- **MiniMax**: API キー（コーディングプランのキー；`MINIMAX_CODE_PLAN_KEY` または `MINIMAX_API_KEY`）。5 時間のコーディングプラン期間を使用します。
- **z.ai**: 環境変数／設定／認証ストア経由の API キー。

一致する OAuth／API の認証情報が存在しない場合、使用状況は非表示になります。
