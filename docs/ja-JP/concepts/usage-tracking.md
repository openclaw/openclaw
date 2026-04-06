---
read_when:
    - プロバイダーの使用量/クォータ表示を実装する場合
    - 使用量トラッキングの動作や認証要件を説明する必要がある場合
summary: 使用量トラッキングの表示場所と認証要件
title: 使用量トラッキング
x-i18n:
    generated_at: "2026-04-02T07:40:14Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 6f6ed2a70329b2a6206c327aa749a84fbfe979762caca5f0e7fb556f91631cbb
    source_path: concepts/usage-tracking.md
    workflow: 15
---

# 使用量トラッキング

## 概要

- プロバイダーの使用量/クォータを、各プロバイダーの使用量エンドポイントから直接取得します。
- 推定コストではなく、プロバイダーが報告するウィンドウのみを表示します。

## 表示される場所

- チャット内の `/status`: セッショントークンと推定コスト（APIキーのみ）を含む絵文字付きステータスカード。プロバイダー使用量は、利用可能な場合に**現在のモデルプロバイダー**について表示されます。
- チャット内の `/usage off|tokens|full`: レスポンスごとの使用量フッター（OAuthの場合はトークンのみ表示）。
- チャット内の `/usage cost`: OpenClawのセッションログから集計されたローカルコストサマリー。
- CLI: `openclaw status --usage` はプロバイダーごとの詳細な内訳を表示します。
- CLI: `openclaw channels list` はプロバイダー設定と同じ使用量スナップショットを表示します（スキップするには `--no-usage` を使用）。
- macOSメニューバー: コンテキストの下の「Usage」セクション（利用可能な場合のみ）。

## プロバイダーと認証情報

- **Anthropic (Claude)**: 認証プロファイル内のOAuthトークン。
- **GitHub Copilot**: 認証プロファイル内のOAuthトークン。
- **Gemini CLI**: 認証プロファイル内のOAuthトークン。
- **Antigravity**: 認証プロファイル内のOAuthトークン。
- **OpenAI Codex**: 認証プロファイル内のOAuthトークン（存在する場合はaccountIdを使用）。
- **MiniMax**: APIキー（コーディングプランキー; `MINIMAX_CODE_PLAN_KEY` または `MINIMAX_API_KEY`）; 5時間のコーディングプランウィンドウを使用します。
- **z.ai**: env/config/認証ストア経由のAPIキー。

一致するOAuth/API認証情報が存在しない場合、使用量は非表示になります。
