---
read_when:
    - テストの実行または修正時
summary: テストをローカルで実行する方法（vitest）と、force/coverageモードを使用するタイミング
title: テスト
x-i18n:
    generated_at: "2026-04-02T07:54:12Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: d8fd224b30861a5f07459332d09bc515fa73822572f2fe756587eba27bed6dcf
    source_path: reference/test.md
    workflow: 15
---

# テスト

- 完全なテストキット（スイート、ライブ、Docker）: [テスト](/help/testing)

- `pnpm test:force`: デフォルトのコントロールポートを占有しているGateway ゲートウェイプロセスを強制終了し、分離されたGateway ゲートウェイポートで完全なVitestスイートを実行します。これにより、サーバーテストが実行中のインスタンスと衝突しなくなります。以前のGateway ゲートウェイ実行がポート18789を占有したままの場合に使用してください。
- `pnpm test:coverage`: V8カバレッジ付きでユニットスイートを実行します（`vitest.unit.config.ts`経由）。グローバル閾値は行/分岐/関数/ステートメントで70%です。カバレッジは統合重視のエントリーポイント（CLIワイヤリング、Gateway ゲートウェイ/Telegramブリッジ、ウェブチャット静的サーバー）を除外し、ユニットテスト可能なロジックにターゲットを集中させます。
- `pnpm test:coverage:changed`: `origin/main`以降に変更されたファイルのみユニットカバレッジを実行します。
- `pnpm test:changed`: `--changed origin/main`付きでラッパーを実行します。基本のVitest設定はラッパーのマニフェスト/設定ファイルを`forceRerunTriggers`として扱うため、スケジューラの変更時には必要に応じて広範に再実行されます。
- `pnpm test`: 完全なラッパーを実行します。gitには小さな動作オーバーライドマニフェストのみを保持し、チェックインされたタイミングスナップショットを使用して、最も重い計測済みユニットファイルを専用レーンに分離します。
- ユニットファイルはラッパーでデフォルトで`threads`を使用します。fork限定の例外は`test/fixtures/test-parallel.behavior.json`に記載してください。
- `pnpm test:channels`は`vitest.channels.config.ts`経由でデフォルトが`threads`になりました。2026年3月22日の直接フルスイート制御実行は、チャネル固有のfork例外なしでクリーンに通過しました。
- `pnpm test:extensions`はラッパーを通して実行され、文書化されたプラグインのfork限定例外を`test/fixtures/test-parallel.behavior.json`に保持します。共有プラグインレーンはデフォルトで`threads`のままです。
- `pnpm test:extensions`: プラグインスイートを実行します。
- `pnpm test:perf:imports`: ラッパーに対してVitestのインポート時間＋インポート内訳レポートを有効にします。
- `pnpm test:perf:imports:changed`: 同じインポートプロファイリングですが、`origin/main`以降に変更されたファイルのみ対象です。
- `pnpm test:perf:profile:main`: Vitestメインスレッドのcpuプロファイルを書き込みます（`.artifacts/vitest-main-profile`）。
- `pnpm test:perf:profile:runner`: ユニットランナーのCPU＋ヒーププロファイルを書き込みます（`.artifacts/vitest-runner-profile`）。
- `pnpm test:perf:update-timings`: `scripts/test-parallel.mjs`が使用するチェックインされた低速ファイルタイミングスナップショットを更新します。
- Gateway ゲートウェイ統合テスト: `OPENCLAW_TEST_INCLUDE_GATEWAY=1 pnpm test`または`pnpm test:gateway`でオプトイン。
- `pnpm test:e2e`: Gateway ゲートウェイのエンドツーエンドスモークテスト（マルチインスタンスWS/HTTP/ノードペアリング）を実行します。`vitest.e2e.config.ts`でデフォルトは`forks`＋アダプティブワーカーです。`OPENCLAW_E2E_WORKERS=<n>`で調整し、`OPENCLAW_E2E_VERBOSE=1`で詳細ログを出力します。
- `pnpm test:live`: プロバイダーライブテスト（minimax/zai）を実行します。APIキーと`LIVE=1`（またはプロバイダー固有の`*_LIVE_TEST=1`）がスキップ解除に必要です。
- `pnpm test:docker:openwebui`: Docker化されたOpenClaw＋Open WebUIを起動し、Open WebUIを通じてサインインし、`/api/models`を確認してから、`/api/chat/completions`を通じて実際のプロキシチャットを実行します。使用可能なライブモデルキー（例: `~/.profile`のOpenAI）が必要で、外部のOpen WebUIイメージをプルし、通常のユニット/e2eスイートのようにCI安定性は期待されません。
- `pnpm test:docker:mcp-channels`: シード済みGateway ゲートウェイコンテナと、`openclaw mcp serve`を起動する2番目のクライアントコンテナを起動し、ルーティングされた会話ディスカバリー、トランスクリプト読み取り、添付ファイルメタデータ、ライブイベントキュー動作、アウトバウンド送信ルーティング、およびClaude形式のチャネル＋権限通知を実際のstdioブリッジ上で検証します。Claude通知アサーションは生のstdio MCPフレームを直接読み取るため、スモークテストはブリッジが実際に発信する内容を反映します。

## ローカルPRゲート

ローカルPRランド/ゲートチェックには、以下を実行してください:

- `pnpm check`
- `pnpm build`
- `pnpm test`
- `pnpm check:docs`

`pnpm test`が負荷の高いホストでフレークする場合は、リグレッションとして扱う前に一度再実行し、`pnpm vitest run <path/to/test>`で分離してください。メモリ制約のあるホストでは以下を使用してください:

- `OPENCLAW_TEST_PROFILE=low OPENCLAW_TEST_SERIAL_GATEWAY=1 pnpm test`
- `OPENCLAW_VITEST_FS_MODULE_CACHE_PATH=/tmp/openclaw-vitest-cache pnpm test:changed`

## モデルレイテンシベンチ（ローカルキー）

スクリプト: [`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

使い方:

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- オプション環境変数: `MINIMAX_API_KEY`、`MINIMAX_BASE_URL`、`MINIMAX_MODEL`、`ANTHROPIC_API_KEY`
- デフォルトプロンプト: "Reply with a single word: ok. No punctuation or extra text."

最終実行（2025-12-31、20回）:

- minimax 中央値 1279ms（最小 1114、最大 2431）
- opus 中央値 2454ms（最小 1224、最大 3170）

## CLI起動ベンチ

スクリプト: [`scripts/bench-cli-startup.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-cli-startup.ts)

使い方:

- `pnpm test:startup:bench`
- `pnpm test:startup:bench:smoke`
- `pnpm test:startup:bench:save`
- `pnpm test:startup:bench:update`
- `pnpm test:startup:bench:check`
- `pnpm tsx scripts/bench-cli-startup.ts`
- `pnpm tsx scripts/bench-cli-startup.ts --runs 12`
- `pnpm tsx scripts/bench-cli-startup.ts --preset real`
- `pnpm tsx scripts/bench-cli-startup.ts --preset real --case status --case gatewayStatus --runs 3`
- `pnpm tsx scripts/bench-cli-startup.ts --entry openclaw.mjs --entry-secondary dist/entry.js --preset all`
- `pnpm tsx scripts/bench-cli-startup.ts --preset all --output .artifacts/cli-startup-bench-all.json`
- `pnpm tsx scripts/bench-cli-startup.ts --preset real --case gatewayStatusJson --output .artifacts/cli-startup-bench-smoke.json`
- `pnpm tsx scripts/bench-cli-startup.ts --preset real --cpu-prof-dir .artifacts/cli-cpu`
- `pnpm tsx scripts/bench-cli-startup.ts --json`

プリセット:

- `startup`: `--version`、`--help`、`health`、`health --json`、`status --json`、`status`
- `real`: `health`、`status`、`status --json`、`sessions`、`sessions --json`、`agents list --json`、`gateway status`、`gateway status --json`、`gateway health --json`、`config get gateway.port`
- `all`: 両方のプリセット

出力には各コマンドの`sampleCount`、平均、p50、p95、最小/最大、終了コード/シグナル分布、および最大RSSサマリーが含まれます。オプションの`--cpu-prof-dir` / `--heap-prof-dir`は実行ごとにV8プロファイルを書き込むため、タイミングとプロファイルキャプチャは同じハーネスを使用します。

保存出力の規約:

- `pnpm test:startup:bench:smoke`はターゲットスモークアーティファクトを`.artifacts/cli-startup-bench-smoke.json`に書き込みます
- `pnpm test:startup:bench:save`は`runs=5`と`warmup=1`を使用してフルスイートアーティファクトを`.artifacts/cli-startup-bench-all.json`に書き込みます
- `pnpm test:startup:bench:update`は`runs=5`と`warmup=1`を使用してチェックインされたベースラインフィクスチャ`test/fixtures/cli-startup-bench.json`を更新します

チェックインされたフィクスチャ:

- `test/fixtures/cli-startup-bench.json`
- `pnpm test:startup:bench:update`で更新
- `pnpm test:startup:bench:check`で現在の結果をフィクスチャと比較

## オンボーディングE2E（Docker）

Dockerはオプションです。これはコンテナ化されたオンボーディングスモークテストにのみ必要です。

クリーンなLinuxコンテナでの完全なコールドスタートフロー:

```bash
scripts/e2e/onboard-docker.sh
```

このスクリプトは擬似TTYを通じてインタラクティブウィザードを駆動し、設定/ワークスペース/セッションファイルを検証してから、Gateway ゲートウェイを起動し`openclaw health`を実行します。

## QRインポートスモーク（Docker）

サポートされているDocker Nodeランタイム（Node 24デフォルト、Node 22互換）で`qrcode-terminal`が読み込まれることを確認します:

```bash
pnpm test:docker:qr
```
