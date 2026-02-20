# OpenAI Codex (OAuth2) ログイン・中枢設定の完了報告

## 達成事項

1. **中枢(Primary)モデルの確認**
   - 設定ファイル (`~/.openclaw/config.json`) において、すでに `agents.defaults.model.primary` が `openai-codex/gpt-5.2` に設定され、認証方式も `oauth` となっていることを確認しました。
2. **OAuth2ログインフローの開始**
   - OpenAIのOAuth2ログインは、ブラウザでのインタラクティブな承認（パスワードや2段階認証等）が必要な仕様です。
   - そのため、エージェント側から自動化する代わりに、ユーザーの画面上に認証用の新しいターミナルウィンドウ（`node openclaw.mjs models auth login --provider openai-codex` を実行する画面）を直接ポップアップ表示させました。

## ユーザー側での次ステップ

- 画面に表示された新しい黒い画面（ターミナル）の指示に従い、自動で開くブラウザ、もしくは表示されたURLからOpenAIにログインし、認証を完了させてください。
- 認証完了後、中枢モデルとして引き続き `openai-codex/gpt-5.2` が自律的に稼働できるようになります。
