---
summary: "テストをローカルで実行する方法（vitest）と強制/カバレッジモードを使う場面"
read_when:
  - テストの実行または修正をするとき
title: "テスト"
---

# テスト

- テストキット全体（スイート、ライブ、Docker）: [テスト](/help/testing)

- `pnpm test:force`: デフォルトのコントロールポートを占有しているゾンビ Gateway プロセスを強制終了し、分離された Gateway ポートで完全な Vitest スイートを実行します。これにより、サーバーテストが実行中のインスタンスと衝突しません。前の Gateway 実行でポート 18789 が占有されていた場合にこれを使用してください。
- `pnpm test:coverage`: V8 カバレッジ（`vitest.unit.config.ts` 経由）でユニットスイートを実行します。グローバル閾値は行/ブランチ/関数/ステートメントで 70% です。カバレッジはインテグレーション重視のエントリポイント（CLI 配線、Gateway/Telegram ブリッジ、Web チャット静的サーバー）を除外し、ユニットテスト可能なロジックに焦点を当てます。
- Node 24+ での `pnpm test`: OpenClaw は `ERR_VM_MODULE_LINK_FAILURE` / `module is already linked` を避けるために Vitest の `vmForks` を自動的に無効にし、`forks` を使用します。`OPENCLAW_TEST_VM_FORKS=0|1` で動作を強制できます。
- `pnpm test:e2e`: Gateway のエンドツーエンドスモークテストを実行します（マルチインスタンス WS/HTTP/ノードペアリング）。デフォルトは `vitest.e2e.config.ts` の `vmForks` + 適応ワーカーです。`OPENCLAW_E2E_WORKERS=<n>` で調整し、`OPENCLAW_E2E_VERBOSE=1` で詳細ログを有効にしてください。
- `pnpm test:live`: プロバイダーのライブテスト（minimax/zai）を実行します。API キーと `LIVE=1`（またはプロバイダー固有の `*_LIVE_TEST=1`）でスキップを解除する必要があります。

## ローカル PR ゲート

ローカルの PR ランド/ゲートチェックには、以下を実行してください:

- `pnpm check`
- `pnpm build`
- `pnpm test`
- `pnpm check:docs`

負荷のかかったホストで `pnpm test` が不安定な場合は、リグレッションとして扱う前に一度再実行し、`pnpm vitest run <path/to/test>` で分離してください。メモリに制約のあるホストには以下を使用してください:

- `OPENCLAW_TEST_PROFILE=low OPENCLAW_TEST_SERIAL_GATEWAY=1 pnpm test`

## モデルレイテンシーベンチ（ローカルキー）

スクリプト: [`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

使用方法:

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- オプションの環境変数: `MINIMAX_API_KEY`、`MINIMAX_BASE_URL`、`MINIMAX_MODEL`、`ANTHROPIC_API_KEY`
- デフォルトプロンプト: "Reply with a single word: ok. No punctuation or extra text."

最後の実行（2025-12-31、20 回実行）:

- minimax 中央値 1279ms（最小 1114、最大 2431）
- opus 中央値 2454ms（最小 1224、最大 3170）

## オンボーディング E2E（Docker）

Docker はオプションです。これはコンテナ化されたオンボーディングスモークテストにのみ必要です。

クリーンな Linux コンテナでのフルコールドスタートフロー:

```bash
scripts/e2e/onboard-docker.sh
```

このスクリプトは擬似 tty を介してインタラクティブウィザードを駆動し、設定/ワークスペース/セッションファイルを検証してから Gateway を起動して `openclaw health` を実行します。

## QR インポートスモーク（Docker）

Docker の Node 22+ で `qrcode-terminal` が読み込まれることを確認します:

```bash
pnpm test:docker:qr
```
