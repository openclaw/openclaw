---
summary: "ローカルでテスト（Vitest）を実行する方法と、force／coverage モードを使用するタイミング"
read_when:
  - テストを実行または修正するとき
title: "テスト"
x-i18n:
  source_path: reference/test.md
  source_hash: 814cc52aae0788eb
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:23:11Z
---

# テスト

- 完全なテストキット（スイート、ライブ、Docker）: [Testing](/help/testing)

- `pnpm test:force`: 既定の制御ポートを保持している残存ゲートウェイ プロセスをすべて終了し、分離されたゲートウェイ ポートで完全な Vitest スイートを実行します。これにより、実行中のインスタンスとサーバー テストが衝突しません。以前のゲートウェイ 実行でポート 18789 が占有されたままの場合に使用します。
- `pnpm test:coverage`: V8 カバレッジ付きで Vitest を実行します。グローバルしきい値は、行／分岐／関数／ステートメントの各 70% です。カバレッジからは、統合依存度の高いエントリーポイント（CLI 配線、gateway/telegram ブリッジ、webchat 静的サーバー）を除外し、ユニットテスト可能なロジックに焦点を当てます。
- `pnpm test:e2e`: ゲートウェイのエンドツーエンド スモークテスト（複数インスタンスの WS/HTTP/ノード ペアリング）を実行します。
- `pnpm test:live`: プロバイダーのライブテスト（minimax/zai）を実行します。API キーと、スキップ解除のために `LIVE=1`（またはプロバイダー固有の `*_LIVE_TEST=1`）が必要です。

## モデル レイテンシ ベンチ（ローカル キー）

スクリプト: [`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

使用方法:

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- 任意の環境変数: `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `ANTHROPIC_API_KEY`
- 既定のプロンプト: 「単語を 1 つだけで返信してください: ok。句読点や余分なテキストは不要です。」

最終実行（2025-12-31、20 回）:

- minimax 中央値 1279ms（最小 1114、最大 2431）
- opus 中央値 2454ms（最小 1224、最大 3170）

## オンボーディング E2E（Docker）

Docker は任意です。これは、コンテナ化されたオンボーディング スモークテストにのみ必要です。

クリーンな Linux コンテナでの完全なコールドスタート フロー:

```bash
scripts/e2e/onboard-docker.sh
```

このスクリプトは疑似 tty を介して対話型ウィザードを駆動し、設定／ワークスペース／セッション ファイルを検証した後、ゲートウェイを起動して `openclaw health` を実行します。

## QR インポート スモーク（Docker）

Docker 内の Node 22+ で `qrcode-terminal` が読み込まれることを確認します:

```bash
pnpm test:docker:qr
```
