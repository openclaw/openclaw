---
title: "テスト"
summary: "テストキット: ユニット/E2E/ライブスイート、Dockerランナー、各テストの対象範囲"
read_when:
  - ローカルまたはCIでテストを実行する
  - モデル/プロバイダーのバグに対するリグレッションを追加する
  - Gateway とエージェントの動作をデバッグする
x-i18n:
    generated_at: "2026-04-03T00:00:00Z"
    model: claude-sonnet-4-6
    provider: anthropic
    source_hash: 0507093be7e64101b4a4fdcd20d3b1536f3480a1d6b33ce6ea0fa1e53d149cb0
    source_path: help/testing.md
    workflow: 15
---

# テスト

OpenClaw には3つの Vitest スイート（ユニット/インテグレーション、E2E、ライブ）と少数の Docker ランナーがあります。

このドキュメントは「テストの方法」ガイドです：

- 各スイートがカバーする内容（および意図的にカバーしない内容）
- よくあるワークフローで実行するコマンド（ローカル、プッシュ前、デバッグ）
- ライブテストがクレデンシャルを検出してモデル/プロバイダーを選択する方法
- 実際のモデル/プロバイダーの問題に対するリグレッションの追加方法

## クイックスタート

普段の作業：

- フルゲート（プッシュ前に推奨）: `pnpm build && pnpm check && pnpm test`
- 余裕のあるマシンでの高速なフルスイート実行: `pnpm test:max`

テストに触れたり、より高い信頼性が必要な場合：

- カバレッジゲート: `pnpm test:coverage`
- E2E スイート: `pnpm test:e2e`

実際のプロバイダー/モデルのデバッグ時（実際のクレデンシャルが必要）：

- ライブスイート（モデル + Gateway ゲートウェイのツール/イメージプローブ）: `pnpm test:live`
- 1つのライブファイルを静かにターゲット: `pnpm test:live -- src/agents/models.profiles.live.test.ts`

ヒント：1つの失敗ケースのみが必要な場合は、以下で説明する許可リスト環境変数を使ってライブテストを絞り込むことをお勧めします。

## テストスイート（どこで何が実行されるか）

スイートを「増大するリアリティ」（および増大するフレーキー性/コスト）として考えてください：

### ユニット / インテグレーション（デフォルト）

- コマンド: `pnpm test`
- 設定: `scripts/test-parallel.mjs`（`vitest.unit.config.ts`、`vitest.extensions.config.ts`、`vitest.gateway.config.ts` を実行）
- ファイル: `src/**/*.test.ts`、バンドルプラグインの `**/*.test.ts`
- スコープ：
  - 純粋なユニットテスト
  - インプロセスのインテグレーションテスト（Gateway ゲートウェイ認証、ルーティング、ツール、パース、設定）
  - 既知のバグに対する決定的なリグレッション
- 期待事項：
  - CI で実行
  - 実際のキーは不要
  - 高速かつ安定している
- スケジューラー注意：
  - `pnpm test` は、真のプール/分離オーバーライドのための小さなチェックイン済み動作マニフェストと、最も遅いユニットファイルの別個のタイミングスナップショットを保持します。
  - 拡張機能のみのローカル実行も、チェックイン済みの拡張機能タイミングスナップショットと高メモリホストでの若干粗い共有バッチターゲットを使用するようになりました。
  - 共有ユニット、拡張機能、チャンネル、Gateway ゲートウェイの実行はすべて Vitest `forks` を使用します。
  - ラッパーは、測定されたフォーク分離例外と重いシングルトンレーンを `test/fixtures/test-parallel.behavior.json` に明示的に保持します。
- 組み込みランナー注意：
  - メッセージツールの検出入力またはコンパクションランタイムコンテキストを変更する場合は、両方のカバレッジレベルを維持してください。
  - 純粋なルーティング/正規化境界のための集中したヘルパーリグレッションを追加してください。
  - 組み込みランナーのインテグレーションスイートも健全に保ってください。
- プールの注意：
  - 基本の Vitest 設定はデフォルトで `forks` のまま。
  - ユニット、チャンネル、拡張機能、Gateway ゲートウェイのラッパーレーンはすべてデフォルトで `forks`。
  - `pnpm test` もラッパーレベルで `--isolate=false` を渡します。
  - `OPENCLAW_TEST_ISOLATE=1 pnpm test` で Vitest ファイル分離に戻せます。

### E2E（Gateway ゲートウェイスモーク）

- コマンド: `pnpm test:e2e`
- 設定: `vitest.e2e.config.ts`
- ファイル: `src/**/*.e2e.test.ts`、`test/**/*.e2e.test.ts`
- スコープ：
  - マルチインスタンス Gateway ゲートウェイのエンドツーエンドの動作
  - WebSocket/HTTP サーフェス、ノードペアリング、より重いネットワーキング
- 期待事項：
  - CI で実行（パイプラインで有効な場合）
  - 実際のキーは不要
  - ユニットテストよりも動くパーツが多い（低速になる場合あり）

### E2E: OpenShell バックエンドスモーク

- コマンド: `pnpm test:e2e:openshell`
- ファイル: `test/openshell-sandbox.e2e.test.ts`
- スコープ：
  - Docker 経由でホスト上に分離された OpenShell Gateway ゲートウェイを起動
  - 一時的なローカル Dockerfile からサンドボックスを作成
  - 実際の `sandbox ssh-config` + SSH exec を通じた OpenClaw の OpenShell バックエンドを実行
  - サンドボックス fs ブリッジ経由でリモート正規ファイルシステムの動作を検証
- 期待事項：
  - オプトインのみ；デフォルトの `pnpm test:e2e` 実行には含まれない
  - ローカルの `openshell` CLI と動作する Docker デーモンが必要

### ライブ（実際のプロバイダー + 実際のモデル）

- コマンド: `pnpm test:live`
- 設定: `vitest.live.config.ts`
- ファイル: `src/**/*.live.test.ts`
- デフォルト: `pnpm test:live` によって**有効化**（`OPENCLAW_LIVE_TEST=1` を設定）
- スコープ：
  - 「このプロバイダー/モデルは今日も実際のクレデンシャルで動作するか？」
  - プロバイダーのフォーマット変更、ツール呼び出しの癖、認証問題、レート制限の動作を検出
- 期待事項：
  - 設計上 CI に対して安定していない（実際のネットワーク、実際のプロバイダーポリシー、クォータ、障害）
  - お金がかかる / レート制限を使用する
  - 「すべて」ではなく絞り込んだサブセットの実行を推奨
- ライブ実行は欠落している API キーを選択するために `~/.profile` をソースします。
- デフォルトでは、ライブ実行は `HOME` を分離し、設定/認証マテリアルを一時的なテストホームにコピーするので、ユニットフィクスチャが実際の `~/.openclaw` を変更できません。
- API キーローテーション（プロバイダー固有）: `*_API_KEYS` をカンマ/セミコロン形式で設定するか、`*_API_KEY_1`、`*_API_KEY_2` を使用します。

## どのスイートを実行すべきか？

この決定テーブルを使用してください：

- ロジック/テストの編集: `pnpm test` を実行（多くを変更した場合は `pnpm test:coverage` も）
- Gateway ゲートウェイのネットワーキング / WS プロトコル / ペアリングに触れる場合: `pnpm test:e2e` を追加
- 「ボットがダウンしている」/ プロバイダー固有の失敗 / ツール呼び出しのデバッグ: 絞り込んだ `pnpm test:live` を実行

## ライブ: Android ノード機能スイープ

- テスト: `src/gateway/android-node.capabilities.live.test.ts`
- スクリプト: `pnpm android:test:integration`
- 目的: 接続された Android ノードが現在アドバタイズしている**すべてのコマンド**を呼び出し、コマンドコントラクトの動作をアサート。

## ライブ: モデルスモーク（プロファイルキー）

ライブテストは2つのレイヤーに分割されているため、障害を切り分けられます：

- 「ダイレクトモデル」は、プロバイダー/モデルが指定されたキーでまったく応答できるかどうかを示します。
- 「Gateway ゲートウェイスモーク」は、そのモデルに対してフル Gateway ゲートウェイ+エージェントパイプラインが機能するかどうかを示します（セッション、履歴、ツール、サンドボックスポリシーなど）。

### レイヤー1: ダイレクトモデル完了（Gateway ゲートウェイなし）

- テスト: `src/agents/models.profiles.live.test.ts`
- 有効化: `pnpm test:live`（または直接 Vitest を呼び出す場合は `OPENCLAW_LIVE_TEST=1`）

### レイヤー2: Gateway ゲートウェイ + dev エージェントスモーク

- テスト: `src/gateway/gateway-models.profiles.live.test.ts`
- 目的:
  - インプロセス Gateway ゲートウェイを起動
  - `agent:dev:*` セッションを作成/パッチ（実行ごとにモデルオーバーライド）
  - キーを持つモデルを反復し、以下をアサート：
    - 「意味のある」応答（ツールなし）
    - 実際のツール呼び出しが機能する（読み取りプローブ）
    - オプションの追加ツールプローブ（exec+読み取りプローブ）

## ライブ: ライブ ACP バインドスモーク（`/acp spawn ... --bind here`）

- テスト: `src/gateway/gateway-acp-bind.live.test.ts`
- 目的: ライブ ACP エージェントを使用した実際の ACP 会話バインドフローを検証
- 有効化: `OPENCLAW_LIVE_ACP_BIND=1 pnpm test:live src/gateway/gateway-acp-bind.live.test.ts`

## ライブ: モデルマトリックス（対象）

推奨される「一般的なモデル」実行：

- OpenAI（非Codex）: `openai/gpt-5.2`
- OpenAI Codex: `openai-codex/gpt-5.4`
- Anthropic: `anthropic/claude-opus-4-6`（または `anthropic/claude-sonnet-4-6`）
- Google（Gemini API）: `google/gemini-3.1-pro-preview` および `google/gemini-3-flash-preview`
- Z.AI（GLM）: `zai/glm-4.7`
- MiniMax: `minimax/MiniMax-M2.7`

## クレデンシャル（コミットしないこと）

ライブテストは CLI と同じ方法でクレデンシャルを検出します：

- プロファイルストア: `~/.openclaw/credentials/`（推奨）
- 設定: `~/.openclaw/openclaw.json`（または `OPENCLAW_CONFIG_PATH`）

## Docker ランナー（オプションの「Linux で動作するか」チェック）

- ライブモデルランナー: `test:docker:live-models` および `test:docker:live-gateway`
- コンテナスモークランナー: `test:docker:openwebui`、`test:docker:onboard`、`test:docker:gateway-network`、`test:docker:mcp-channels`、`test:docker:plugins`

## ドキュメントの健全性

ドキュメントの編集後にドキュメントチェックを実行: `pnpm check:docs`。

## オフラインリグレッション（CI セーフ）

これらは「実際のパイプライン」リグレッションですが、実際のプロバイダーは使いません：

- Gateway ゲートウェイのツール呼び出し（モックの OpenAI、実際の Gateway ゲートウェイ + エージェントループ）: `src/gateway/gateway.test.ts`
- Gateway ゲートウェイウィザード: `src/gateway/gateway.test.ts`

## エージェント信頼性評価（スキル）

現在、CI セーフなテストがいくつかあり、「エージェント信頼性評価」のように動作します：

- 実際の Gateway ゲートウェイ + エージェントループを通じたモックツール呼び出し。
- セッションの配線と設定の影響を検証するエンドツーエンドのウィザードフロー。

## コントラクトテスト（プラグインとチャンネルの形状）

コントラクトテストは、すべての登録済みプラグインとチャンネルがインターフェースコントラクトに準拠していることを検証します。

### コマンド

- すべてのコントラクト: `pnpm test:contracts`
- チャンネルコントラクトのみ: `pnpm test:contracts:channels`
- プロバイダーコントラクトのみ: `pnpm test:contracts:plugins`

### 実行タイミング

- plugin-sdk のエクスポートやサブパスを変更した後
- チャンネルまたはプロバイダープラグインを追加または変更した後
- プラグインの登録または検出をリファクタリングした後

コントラクトテストは CI で実行され、実際の API キーは不要です。

## リグレッションの追加（ガイダンス）

ライブで発見されたプロバイダー/モデルの問題を修正するとき：

- 可能であれば CI セーフなリグレッションを追加する（モック/スタブプロバイダー、または正確なリクエスト形状変換をキャプチャ）
- 本質的にライブのみの場合（レート制限、認証ポリシー）は、ライブテストを狭く保ち、環境変数によるオプトインにする
- バグを検出する最小のレイヤーをターゲットにすることを推奨：
  - プロバイダーのリクエスト変換/リプレイのバグ → ダイレクトモデルテスト
  - Gateway ゲートウェイのセッション/履歴/ツールパイプラインのバグ → Gateway ゲートウェイのライブスモークまたは CI セーフな Gateway ゲートウェイモックテスト
