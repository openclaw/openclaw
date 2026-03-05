---
summary: "使用量トラッキングの表示画面と認証要件"
read_when:
  - プロバイダーの使用量/クォータ画面を実装する場合
  - 使用量トラッキングの動作や認証要件を説明する必要がある場合
title: "使用量トラッキング"
x-i18n:
  source_path: "docs/concepts/usage-tracking.md"
  generated_at: "2026-03-05T10:01:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
---

# 使用量トラッキング

## 概要

- プロバイダーの使用量/クォータを、各プロバイダーの使用量エンドポイントから直接取得します。
- 推定コストではなく、プロバイダーが報告するウィンドウのみを表示します。

## 表示される場所

- チャットの `/status`: 絵文字付きのステータスカード。セッショントークン + 推定コスト（APIキーのみ）を表示。利用可能な場合、**現在のモデルプロバイダー**のプロバイダー使用量が表示されます。
- チャットの `/usage off|tokens|full`: レスポンスごとの使用量フッター（OAuthではトークンのみ表示）。
- チャットの `/usage cost`: OpenClawセッションログから集計されたローカルコストサマリー。
- CLI: `openclaw status --usage` でプロバイダーごとの完全な内訳を表示。
- CLI: `openclaw channels list` でプロバイダー設定と共に同じ使用量スナップショットを表示（`--no-usage` でスキップ可能）。
- macOSメニューバー: コンテキスト内の「Usage」セクション（利用可能な場合のみ）。

## プロバイダーと認証情報

- **Anthropic (Claude)**: 認証プロファイル内のOAuthトークン。
- **GitHub Copilot**: 認証プロファイル内のOAuthトークン。
- **Gemini CLI**: 認証プロファイル内のOAuthトークン。
- **Antigravity**: 認証プロファイル内のOAuthトークン。
- **OpenAI Codex**: 認証プロファイル内のOAuthトークン（存在する場合はaccountIdを使用）。
- **MiniMax**: APIキー（コーディングプランキー、`MINIMAX_CODE_PLAN_KEY` または `MINIMAX_API_KEY`）。5時間のコーディングプランウィンドウを使用。
- **z.ai**: env/config/認証ストア経由のAPIキー。

一致するOAuth/API認証情報が存在しない場合、使用量は非表示になります。
