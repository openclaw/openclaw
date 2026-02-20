# 実装ログ: 自律エージェント設定・Ollama/OpenAI Codexメタモデルの構成 (2026-02-20)

## 目的

既存のセキュリティ機能を維持したまま、エージェントの自律動作（Heartbeat, ツール自律実行）を有効化し、自己修復・進化を司る Evo Daemon の稼働を確認する。また、運用モデルの中枢をOpenAI Codex(GPT-5.2; OAuth2認証)に切り替え、バックアップとしてOllama (rnj-1-instruct) を設定する。

## 実装内容

1. **設定ファイルの整理とスキーマエラー修正 (`config.json`, `openclaw.json`)**
   - 設定の競合となっていた古い `openclaw.json` を退避し、Doctor コマンドを用いて最新の環境にマージ。
   - `config.json` の `agents.defaults` へ `heartbeat` (5分間隔、安定稼働確認のプロンプト) を新設し、自律的な状態監視を有効化。
   - `AgentDefaultsSchema` で許可されていなかった `tools` (ツール利用「full」およびエラー時「on-miss」承認プロファイル) を `agents.list` 下のエージェント定義部分に移動。

2. **環境変数展開バグの修正 (`.env`)**
   - 設定した環境変数パスに `%USERPROFILE%` がそのまま文字列として展開される現象を解消。
   - パス定義（`CLAWDBOT_STATE_DIR`, `CLAWDBOT_WORKSPACE_DIR` 等）を `C:\Users\downl` で始まる絶対パスに安全に置換。

3. **自律操作の基礎プロセスの起動確認**
   - 認証トークン (`gateway.auth.token: "test-token-autonomy"`) を設定。
   - `node openclaw.mjs gateway` コマンドにてポート3000番でGatewayサーバーが稼働中。

4. **モデル設定の更新 (OpenAI Codex OAuth2対応)**
   - `config.json` に `openai-codex` プロバイダ（OAuth2認証使用）として `gpt-5.2` モデルを追加。
   - `agents.defaults.model.primary` を `openai-codex/gpt-5.2` に設定。
   - バックアップ (`fallbacks`) として `ollama/rnj-1-instruct` を指定（ユーザによるマニュアル調整を反映）。
   - ※OAuth2認証自体は、対話的なブラウザでのログインが必要なため `node openclaw.mjs configure` によりユーザー側で認証を通していただく形式としています。

## 現在の課題・次への引継ぎ事項

- `src/cli/evo-cli.ts` にて `evo daemon` コマンドが定義されているものの、CLI上から `node openclaw.mjs evo daemon status` 等を実行すると `unknown command 'daemon'` エラーが発生している。
- `tsdown` でのTypeScriptコンパイルは通ったが、Commanderのサブコマンド登録構造か `command-registry.ts` 付近の遅延ロード設計が影響してコマンドが露出していない可能性が高い。
