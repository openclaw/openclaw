---
summary: "テストキット：unit/e2e/live スイート、Docker ランナー、および各テストがカバーする内容"
read_when:
  - テストをローカルまたは CI で実行する場合
  - モデル／プロバイダーのバグに対するリグレッションを追加する場合
  - ゲートウェイ + エージェントの挙動をデバッグする場合
title: "テスト"
---

# テスト

OpenClaw には、3 つの Vitest スイート（unit/integration、e2e、live）と、少数の Docker ランナーがあります。

このドキュメントは「どのようにテストしているか」を説明するガイドです。

- 各スイートが何をカバーし（そして意図的に何をカバーしないか）
- 一般的なワークフロー（ローカル、プッシュ前、デバッグ）で実行するコマンド
- live テストがどのように認証情報を検出し、モデル／プロバイダーを選択するか
- 実世界のモデル／プロバイダー問題に対するリグレッションの追加方法

## クイックスタート

通常の日常作業では：

- フルゲート（プッシュ前に想定）：`pnpm build && pnpm check && pnpm test`

テストに手を入れた場合や、より高い確信が欲しい場合：

- カバレッジゲート：`pnpm test:coverage`
- E2E スイート：`pnpm test:e2e`

実在のプロバイダー／モデルをデバッグする場合（実際の認証情報が必要）：

- live スイート（モデル + ゲートウェイのツール／イメージプローブ）：`pnpm test:live`

ヒント：失敗ケースを 1 つだけ確認したい場合は、後述の許可リスト環境変数を使って live テストを絞り込む方が適しています。

## テストスイート（どこで何が動くか）

スイートは「現実度が高くなる順」（そしてフレーク性／コストも増加）と考えてください。

### Unit / integration（デフォルト）

- コマンド：`pnpm test`
- 設定：`vitest.config.ts`
- ファイル：`src/**/*.test.ts`
- スコープ：
  - 純粋なユニットテスト
  - プロセス内統合テスト（ゲートウェイ認証、ルーティング、ツール処理、パース、設定）
  - 既知バグに対する決定的なリグレッション
- 期待値：
  - CI で実行される
  - 実際のキーは不要
  - 高速かつ安定していること

### E2E（ゲートウェイスモーク）

- コマンド：`pnpm test:e2e`
- 設定：`vitest.e2e.config.ts`
- ファイル：`src/**/*.e2e.test.ts`
- スコープ：
  - 複数インスタンスのゲートウェイによるエンドツーエンド挙動
  - WebSocket / HTTP インターフェース、ノードのペアリング、より重いネットワーク処理
- 期待値：
  - CI で実行される（パイプラインで有効化されている場合）
  - 実際のキーは不要
  - unit テストより可動部分が多く、遅くなる可能性がある

### Live（実在のプロバイダー + 実在のモデル）

- コマンド：`pnpm test:live`
- 設定：`vitest.live.config.ts`
- ファイル：`src/**/*.live.test.ts`
- デフォルト：`pnpm test:live` により **有効**（`OPENCLAW_LIVE_TEST=1` を設定）
- スコープ：
  - 「このプロバイダー／モデルは、今日、実際の認証情報で本当に動作するか？」
  - プロバイダーのフォーマット変更、ツール呼び出しの癖、認証問題、レート制限挙動の検出
- 期待値：
  - 設計上 CI 安定ではない（実ネットワーク、実プロバイダーポリシー、クォータ、障害）
  - コストがかかる／レート制限を消費する
  - 「すべて」を実行するより、絞り込んだサブセットを推奨
  - live 実行では、不足する API キーを取得するために `~/.profile` を参照する
  - Anthropic のキー・ローテーション：`OPENCLAW_LIVE_ANTHROPIC_KEYS="sk-...,sk-..."`（または `OPENCLAW_LIVE_ANTHROPIC_KEY=sk-...`）や複数の `ANTHROPIC_API_KEY*` 変数を設定可能。テストはレート制限時にリトライする

## どのスイートを実行すべきか？

次の判断表を使用してください。

- ロジック／テストを編集：`pnpm test`（大きく変更した場合は `pnpm test:coverage` も）
- ゲートウェイのネットワーク／WS プロトコル／ペアリングに触れた：`pnpm test:e2e` を追加
- 「ボットが落ちている」／プロバイダー固有の障害／ツール呼び出しのデバッグ：絞り込んだ `pnpm test:live` を実行

## Live：モデルスモーク（プロファイルキー）

live テストは、失敗の切り分けができるよう 2 層に分かれています。

- 「Direct model」は、そのキーでプロバイダー／モデルが最低限応答できるかを示します。
- 「Gateway smoke」は、ゲートウェイ + エージェントの完全なパイプライン（セッション、履歴、ツール、サンドボックスポリシーなど）が、そのモデルで機能するかを示します。

### レイヤー 1：Direct model completion（ゲートウェイなし）

- テスト：`src/agents/models.profiles.live.test.ts`
- 目的：
  - 検出されたモデルを列挙
  - `getApiKeyForModel` を使用して、認証情報を持つモデルを選択
  - 各モデルで小さな completion を実行（必要に応じて対象リグレッションも実行）
- 有効化方法：
  - `pnpm test:live`（Vitest を直接呼ぶ場合は `OPENCLAW_LIVE_TEST=1`）
- 実際にこのスイートを実行するには `OPENCLAW_LIVE_MODELS=modern`（またはモダン向けエイリアスの `all`）を設定します。未設定の場合、`pnpm test:live` をゲートウェイスモークに集中させるためスキップされます。
- モデルの選択方法：
  - `OPENCLAW_LIVE_MODELS=modern` でモダン許可リスト（Opus/Sonnet/Haiku 4.5、GPT-5.x + Codex、Gemini 3、GLM 4.7、MiniMax M2.1、Grok 4）を実行
  - `OPENCLAW_LIVE_MODELS=all` はモダン許可リストのエイリアス
  - または `OPENCLAW_LIVE_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,..."`（カンマ区切りの許可リスト）
- プロバイダーの選択方法：
  - `OPENCLAW_LIVE_PROVIDERS="google,google-antigravity,google-gemini-cli"`（カンマ区切りの許可リスト）
- キーの取得元：
  - デフォルト：プロファイルストアおよび環境変数フォールバック
  - **プロファイルストアのみ**を強制するには `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` を設定
- これが存在する理由:
  - 「プロバイダー API が壊れている／キーが無効」と「ゲートウェイのエージェントパイプラインが壊れている」を分離する
  - 小さく独立したリグレッションを含める（例：OpenAI Responses/Codex Responses の推論リプレイ + ツール呼び出しフロー）

### レイヤー 2：Gateway + dev エージェントスモーク（「@openclaw」が実際に行うこと）

- テスト：`src/gateway/gateway-models.profiles.live.test.ts`
- 目的：
  - プロセス内ゲートウェイを起動
  - `agent:dev:*` セッションを作成／パッチ（実行ごとのモデル上書き）
  - キー付きモデルを反復し、以下を検証：
    - 「意味のある」応答（ツールなし）
    - 実際のツール呼び出しが機能すること（read プローブ）
    - 追加のツールプローブ（exec + read プローブ、任意）
    - OpenAI のリグレッション経路（ツール呼び出しのみ → フォローアップ）が継続して動作すること
- プローブ詳細（失敗を素早く説明するため）：
  - `read` プローブ：テストがワークスペースに nonce ファイルを書き込み、エージェントにそれを `read` して nonce を返すよう依頼します。
  - `exec+read` プローブ：テストがエージェントに `exec` 書き込みで一時ファイルに nonce を書かせ、その後 `read` して返させます。
  - image プローブ：生成した PNG（猫 + ランダムコード）を添付し、モデルが `cat <CODE>` を返すことを期待します。
  - 実装参照：`src/gateway/gateway-models.profiles.live.test.ts` および `src/gateway/live-image-probe.ts`。
- 有効化方法：
  - `pnpm test:live`（Vitest を直接呼ぶ場合は `OPENCLAW_LIVE_TEST=1`）
- モデルの選択方法：
  - デフォルト：モダン許可リスト（Opus/Sonnet/Haiku 4.5、GPT-5.x + Codex、Gemini 3、GLM 4.7、MiniMax M2.1、Grok 4）
  - `OPENCLAW_LIVE_GATEWAY_MODELS=all` はモダン許可リストのエイリアス
  - または `OPENCLAW_LIVE_GATEWAY_MODELS="provider/model"`（またはカンマ区切りリスト）で絞り込み
- プロバイダーの選択方法（「OpenRouter 全部」を避ける）：
  - `OPENCLAW_LIVE_GATEWAY_PROVIDERS="google,google-antigravity,google-gemini-cli,openai,anthropic,zai,minimax"`（カンマ区切りの許可リスト）
- ツール + image プローブは、この live テストでは常に有効です：
  - `read` プローブ + `exec+read` プローブ（ツールストレス）
  - image プローブは、モデルが image 入力対応を広告している場合に実行されます
  - フロー（高レベル）：
    - テストが「CAT」+ ランダムコードの小さな PNG を生成（`src/gateway/live-image-probe.ts`）
    - `agent` `attachments: [{ mimeType: "image/png", content: "<base64>" }]` 経由で送信
    - ゲートウェイが添付ファイルを `images[]`（`src/gateway/server-methods/agent.ts` + `src/gateway/chat-attachments.ts`）にパース
    - 組み込みエージェントがマルチモーダルなユーザーメッセージをモデルへ転送
    - アサーション：返信に `cat` とコードが含まれること（OCR 許容：軽微な誤りは可）

ヒント：自分のマシンで何がテスト可能か（および正確な `provider/model` ID）を確認するには、次を実行してください。

```bash
openclaw models list
openclaw models list --json
```

## Live：Anthropic setup-token スモーク

- テスト：`src/agents/anthropic.setup-token.live.test.ts`
- 目的：Claude Code CLI の setup-token（または貼り付けた setup-token プロファイル）で Anthropic のプロンプトが完了できることを検証します。
- 有効化：
  - `pnpm test:live`（Vitest を直接呼ぶ場合は `OPENCLAW_LIVE_TEST=1`）
  - `OPENCLAW_LIVE_SETUP_TOKEN=1`
- トークンの取得元（いずれか 1 つ）：
  - プロファイル：`OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test`
  - 生トークン：`OPENCLAW_LIVE_SETUP_TOKEN_VALUE=sk-ant-oat01-...`
- モデル上書き（任意）：
  - `OPENCLAW_LIVE_SETUP_TOKEN_MODEL=anthropic/claude-opus-4-6`

セットアップ例：

```bash
openclaw models auth paste-token --provider anthropic --profile-id anthropic:setup-token-test
OPENCLAW_LIVE_SETUP_TOKEN=1 OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test pnpm test:live src/agents/anthropic.setup-token.live.test.ts
```

## Live：CLI バックエンドスモーク（Claude Code CLI または他のローカル CLI）

- テスト：`src/gateway/gateway-cli-backend.live.test.ts`
- 目的：デフォルト設定に触れずに、ローカル CLI バックエンドを用いて Gateway + エージェントパイプラインを検証します。
- 有効化：
  - `pnpm test:live`（Vitest を直接呼ぶ場合は `OPENCLAW_LIVE_TEST=1`）
  - `OPENCLAW_LIVE_CLI_BACKEND=1`
- デフォルト：
  - モデル：`claude-cli/claude-sonnet-4-5`
  - コマンド：`claude`
  - 引数：`["-p","--output-format","json","--dangerously-skip-permissions"]`
- 上書き（任意）：
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-opus-4-6"`
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="codex-cli/gpt-5.3-codex"`
  - `OPENCLAW_LIVE_CLI_BACKEND_COMMAND="/full/path/to/claude"`
  - `OPENCLAW_LIVE_CLI_BACKEND_ARGS='["-p","--output-format","json","--permission-mode","bypassPermissions"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV='["ANTHROPIC_API_KEY","ANTHROPIC_API_KEY_OLD"]'`
  - 実際の画像添付を送信するには `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE=1`（パスはプロンプトに注入されます）
  - 画像ファイルパスをプロンプト注入ではなく CLI 引数として渡すには `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG="--image"`
  - `IMAGE_ARG` が設定されている場合の画像引数の渡し方を制御するには `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE="repeat"`（または `"list"`）
  - 2 ターン目を送信して再開フローを検証するには `OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE=1`
- Claude Code CLI の MCP 設定を有効にしたままにするには `OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG=0`（デフォルトでは一時的な空ファイルで MCP 設定を無効化します）

例：

```bash
OPENCLAW_LIVE_CLI_BACKEND=1 \
  OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-sonnet-4-5" \
  pnpm test:live src/gateway/gateway-cli-backend.live.test.ts
```

### 推奨される live レシピ

狭く明示的な許可リストが最速かつ最も安定します。

- 単一モデル、direct（ゲートウェイなし）：
  - `OPENCLAW_LIVE_MODELS="openai/gpt-5.2" pnpm test:live src/agents/models.profiles.live.test.ts`

- 単一モデル、ゲートウェイスモーク：
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- 複数プロバイダーにまたがるツール呼び出し：
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,google/gemini-3-flash-preview,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Google フォーカス（Gemini API キー + Antigravity）：
  - Gemini（API キー）：`OPENCLAW_LIVE_GATEWAY_MODELS="google/gemini-3-flash-preview" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`
  - Antigravity（OAuth）：`OPENCLAW_LIVE_GATEWAY_MODELS="google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-pro-high" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

注記：

- `google/...` は Gemini API（API キー）を使用します。
- `google-antigravity/...` は Antigravity OAuth ブリッジ（Cloud Code Assist 風のエージェントエンドポイント）を使用します。
- `google-gemini-cli/...` は、ローカルマシン上の Gemini CLI を使用します（別の認証 + ツールの癖）。
- Gemini API と Gemini CLI の違い：
  - API：OpenClaw が Google ホストの Gemini API を HTTP 経由で呼び出します（API キー／プロファイル認証）。一般に「Gemini」と言う場合はこちらです。
  - CLI：OpenClaw がローカルの `gemini` バイナリを実行します。独自の認証を持ち、挙動が異なる場合があります（ストリーミング／ツール対応／バージョン差異）。

## Live：モデルマトリクス（カバー範囲）

固定の「CI モデルリスト」はありません（live はオプトイン）ですが、以下はキーを持つ開発マシンで定期的にカバーすることを推奨するモデルです。

### モダンスモークセット（ツール呼び出し + image）

「一般的なモデル」として、動作し続けることを期待するセットです。

- OpenAI（非 Codex）：`openai/gpt-5.2`（任意：`openai/gpt-5.1`）
- OpenAI Codex：`openai-codex/gpt-5.3-codex`（任意：`openai-codex/gpt-5.3-codex-codex`）
- Anthropic：`anthropic/claude-opus-4-6`（または `anthropic/claude-sonnet-4-5`）
- Google（Gemini API）：`google/gemini-3-pro-preview` および `google/gemini-3-flash-preview`（古い Gemini 2.x モデルは避けてください）
- Google（Antigravity）：`google-antigravity/claude-opus-4-6-thinking` および `google-antigravity/gemini-3-flash`
- Z.AI（GLM）：`zai/glm-4.7`
- MiniMax：`minimax/minimax-m2.1`

ツール + image 付きでゲートウェイスモークを実行：
`OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,openai-codex/gpt-5.3-codex,anthropic/claude-opus-4-6,google/gemini-3-pro-preview,google/gemini-3-flash-preview,google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-flash,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

### ベースライン：ツール呼び出し（Read + 任意の Exec）

各プロバイダーファミリーから少なくとも 1 つ選択してください。

- OpenAI：`openai/gpt-5.2`（または `openai/gpt-5-mini`）
- Anthropic：`anthropic/claude-opus-4-6`（または `anthropic/claude-sonnet-4-5`）
- Google：`google/gemini-3-flash-preview`（または `google/gemini-3-pro-preview`）
- Z.AI（GLM）：`zai/glm-4.7`
- MiniMax：`minimax/minimax-m2.1`

追加の任意カバレッジ（あると良い）：

- xAI：`xai/grok-4`（または利用可能な最新）
- ミストラル: `mistral/`… Mistral：`mistral/`…（ツール対応モデルを 1 つ選択）
- Cerebras：`cerebras/`…（アクセスがある場合） (アクセス権がある場合)
- LMスタジオ: `lmstudio/`… LM Studio：`lmstudio/`…（ローカル；ツール呼び出しは API モードに依存）

### Vision：image 送信（添付 → マルチモーダルメッセージ）

image プローブを実行するため、`OPENCLAW_LIVE_GATEWAY_MODELS` には少なくとも 1 つの image 対応モデル（Claude／Gemini／OpenAI の vision 対応バリアントなど）を含めてください。 画像プローブを行使することです

### アグリゲーター／代替ゲートウェイ

キーが有効であれば、以下経由のテストもサポートしています。

- OpenRouter：`openrouter/...`（数百モデル。ツール + image 対応候補を見つけるには `openclaw models scan` を使用）
- OpenCode Zen：`opencode/...`（`OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY` による認証）

live マトリクスに含められる他のプロバイダー（認証情報／設定がある場合）：

- 組み込み：`openai`, `openai-codex`, `anthropic`, `google`, `google-vertex`, `google-antigravity`, `google-gemini-cli`, `zai`, `openrouter`, `opencode`, `xai`, `groq`, `cerebras`, `mistral`, `github-copilot`
- `models.providers` 経由（カスタムエンドポイント）：`minimax`（クラウド／API）、および OpenAI／Anthropic 互換プロキシ（LM Studio、vLLM、LiteLLM など）

ヒント：「すべてのモデル」をドキュメントでハードコードしようとしないでください。 ヒント：ドキュメントに「すべてのモデル」をハードコードしないでください。権威あるリストは、あなたのマシンで `discoverModels(...)` が返す内容と、利用可能なキーです。

## 認証情報（絶対にコミットしない）

live テストは、CLI と同じ方法で認証情報を検出します。実務上の意味は次のとおりです。 実際の意味:

- CLI が動作するなら、live テストも同じキーを見つけるはずです。

- live テストで「no creds」と出る場合は、`openclaw models list` やモデル選択をデバッグするのと同じ手順で調査してください。

- プロファイルストア：`~/.openclaw/credentials/`（推奨。テスト内で言う「プロファイルキー」とはこれを指します）

- 設定：`~/.openclaw/openclaw.json`（または `OPENCLAW_CONFIG_PATH`）

環境変数キー（例：`~/.profile` でエクスポート）に依存したい場合は、`source ~/.profile` 後にローカルテストを実行するか、以下の Docker ランナーを使用してください（コンテナ内に `~/.profile` をマウントできます）。

## Deepgram live（音声文字起こし）

- テスト：`src/media-understanding/providers/deepgram/audio.live.test.ts`
- 有効化：`DEEPGRAM_API_KEY=... DEEPGRAM_LIVE_TEST=1 pnpm test:live src/media-understanding/providers/deepgram/audio.live.test.ts`

## Docker ランナー（任意の「Linux で動く」チェック）

これらは、リポジトリの Docker イメージ内で `pnpm test:live` を実行し、ローカルの設定ディレクトリとワークスペースをマウントします（マウントされていれば `~/.profile` を読み込みます）。

- Direct models：`pnpm test:docker:live-models`（スクリプト：`scripts/test-live-models-docker.sh`）
- Gateway + dev エージェント：`pnpm test:docker:live-gateway`（スクリプト：`scripts/test-live-gateway-models-docker.sh`）
- オンボーディングウィザード（TTY、完全スキャフォールディング）：`pnpm test:docker:onboard`（スクリプト：`scripts/e2e/onboard-docker.sh`）
- ゲートウェイネットワーク（2 コンテナ、WS 認証 + ヘルス）：`pnpm test:docker:gateway-network`（スクリプト：`scripts/e2e/gateway-network-docker.sh`）
- プラグイン（カスタム拡張のロード + レジストリスモーク）：`pnpm test:docker:plugins`（スクリプト：`scripts/e2e/plugins-docker.sh`）

有用なenvvvar:

- `OPENCLAW_CONFIG_DIR=...`（デフォルト：`~/.openclaw`）を `/home/node/.openclaw` にマウント
- `OPENCLAW_WORKSPACE_DIR=...`（デフォルト：`~/.openclaw/workspace`）を `/home/node/.openclaw/workspace` にマウント
- `OPENCLAW_PROFILE_FILE=...`（デフォルト：`~/.profile`）を `/home/node/.profile` にマウントし、テスト実行前に読み込み
- 実行を絞り込むための `OPENCLAW_LIVE_GATEWAY_MODELS=...` / `OPENCLAW_LIVE_MODELS=...`
- 認証情報を環境変数ではなくプロファイルストアから取得することを保証する `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1`

## ドキュメントの健全性

ドキュメント編集後は、次を実行してください：`pnpm docs:list`。

## オフラインリグレッション（CI セーフ）

これらは実際のプロバイダを持たない「本物のパイプライン」回帰です。

- ゲートウェイのツール呼び出し（OpenAI をモック、実ゲートウェイ + エージェントループ）：`src/gateway/gateway.tool-calling.mock-openai.test.ts`
- ゲートウェイウィザード（WS `wizard.start`/`wizard.next`、設定書き込み + 認証強制）：`src/gateway/gateway.wizard.e2e.test.ts`

## エージェント信頼性 eval（Skills）

すでに、CI セーフで「エージェント信頼性 eval」のように振る舞うテストがいくつかあります。

- 実ゲートウェイ + エージェントループを通したモックツール呼び出し（`src/gateway/gateway.tool-calling.mock-openai.test.ts`）。
- セッション配線と設定効果を検証するエンドツーエンドのウィザードフロー（`src/gateway/gateway.wizard.e2e.test.ts`）。

Skills に関してまだ不足している点（[Skills](/tools/skills) 参照）：

- **意思決定**：プロンプトに Skills が列挙されたとき、エージェントは正しい Skill を選択するか（または無関係なものを避けるか）。
- **コンプライアンス**：使用前に `SKILL.md` を読み、必要な手順／引数に従っているか。
- **ワークフロー契約**：ツール順序、セッション履歴の引き継ぎ、サンドボックス境界を検証するマルチターンシナリオ。

将来の回避は、最初に決定的なものを維持する必要があります:

- モックプロバイダーを使用し、ツール呼び出し + 順序、Skill ファイルの読み取り、セッション配線を検証するシナリオランナー。
- Skill に焦点を当てた小規模シナリオ群（使用／回避、ゲーティング、プロンプトインジェクション）。
- CI セーフなスイートが整ってからのみ、任意（オプトイン、環境変数制御）の live eval を追加。

## リグレッションの追加（ガイダンス）

live で発見されたプロバイダー／モデル問題を修正した場合：

- 可能であれば CI セーフなリグレッションを追加してください（プロバイダーのモック／スタブ、または正確なリクエスト形状変換のキャプチャ）。
- 本質的に live 専用（レート制限、認証ポリシーなど）の場合は、live テストを狭く保ち、環境変数でオプトインにしてください。
- バグを捕捉できる最小のレイヤーを優先してください：
  - プロバイダーのリクエスト変換／リプレイのバグ → direct models テスト
  - ゲートウェイのセッション／履歴／ツールパイプラインのバグ → ゲートウェイ live スモーク、または CI セーフなゲートウェイモックテスト
