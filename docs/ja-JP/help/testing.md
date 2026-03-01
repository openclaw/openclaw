---
summary: "テストキット: ユニット/E2E/ライブスイート、Docker ランナー、各テストの対象"
read_when:
  - ローカルまたは CI でテストを実行するとき
  - モデル/プロバイダーのバグに対するリグレッションを追加するとき
  - Gateway とエージェントの動作をデバッグするとき
title: "テスト"
---

# テスト

OpenClaw には 3 つの Vitest スイート（ユニット/インテグレーション、E2E、ライブ）と少数の Docker ランナーがあります。

このドキュメントは「テストの方法」ガイドです:

- 各スイートが対象とするもの（そして意図的に対象としない _もの_）
- よくあるワークフロー（ローカル、プッシュ前、デバッグ）で実行するコマンド
- ライブテストでクレデンシャルを検出し、モデル/プロバイダーを選択する方法
- 実際のモデル/プロバイダーの問題に対するリグレッションを追加する方法

## クイックスタート

普段の作業:

- フルゲート（プッシュ前に実行すること）: `pnpm build && pnpm check && pnpm test`

テストを変更したり、より高い確信が必要なとき:

- カバレッジゲート: `pnpm test:coverage`
- E2E スイート: `pnpm test:e2e`

実際のプロバイダー/モデルをデバッグするとき（実際のクレデンシャルが必要）:

- ライブスイート（モデル + Gateway ツール/イメージプローブ）: `pnpm test:live`

ヒント: 1 件の失敗ケースだけが必要な場合は、以下で説明する許可リスト環境変数でライブテストを絞り込むことをお勧めします。

## テストスイート（どこで何を実行するか）

スイートは「現実性の増加」（そしてフレーキーさ/コストの増加）として考えてください:

### ユニット / インテグレーション（デフォルト）

- コマンド: `pnpm test`
- 設定: `scripts/test-parallel.mjs`（`vitest.unit.config.ts`、`vitest.extensions.config.ts`、`vitest.gateway.config.ts` を実行）
- ファイル: `src/**/*.test.ts`、`extensions/**/*.test.ts`
- スコープ:
  - 純粋なユニットテスト
  - インプロセスのインテグレーションテスト（Gateway 認証、ルーティング、ツール、パース、設定）
  - 既知バグの決定論的リグレッション
- 期待値:
  - CI で実行
  - 実際のキー不要
  - 高速で安定していること
- プールに関する注意:
  - OpenClaw は Node 22/23 でより高速なユニットシャード向けに Vitest の `vmForks` を使用します。
  - Node 24+ では、OpenClaw は Node VM リンクエラー（`ERR_VM_MODULE_LINK_FAILURE` / `module is already linked`）を回避するために自動的に通常の `forks` にフォールバックします。
  - `OPENCLAW_TEST_VM_FORKS=0`（`forks` を強制）または `OPENCLAW_TEST_VM_FORKS=1`（`vmForks` を強制）で手動でオーバーライドできます。

### E2E（Gateway スモーク）

- コマンド: `pnpm test:e2e`
- 設定: `vitest.e2e.config.ts`
- ファイル: `src/**/*.e2e.test.ts`
- ランタイムのデフォルト:
  - より高速なファイル起動のために Vitest の `vmForks` を使用します。
  - アダプティブワーカーを使用します（CI: 2-4、ローカル: 4-8）。
  - コンソール I/O のオーバーヘッドを削減するため、デフォルトでサイレントモードで実行します。
- 便利なオーバーライド:
  - `OPENCLAW_E2E_WORKERS=<n>` でワーカー数を強制します（上限 16）。
  - `OPENCLAW_E2E_VERBOSE=1` で詳細なコンソール出力を再度有効にします。
- スコープ:
  - マルチインスタンス Gateway のエンドツーエンドの動作
  - WebSocket/HTTP サーフェス、ノードペアリング、より重いネットワーキング
- 期待値:
  - CI で実行（パイプラインで有効な場合）
  - 実際のキー不要
  - ユニットテストより多くの可動部品があります（遅くなる可能性があります）

### ライブ（実際のプロバイダー + 実際のモデル）

- コマンド: `pnpm test:live`
- 設定: `vitest.live.config.ts`
- ファイル: `src/**/*.live.test.ts`
- デフォルト: `pnpm test:live` で**有効**（`OPENCLAW_LIVE_TEST=1` を設定）
- スコープ:
  - 「このプロバイダー/モデルは実際のクレデンシャルで_今日_実際に動作するか？」
  - プロバイダーのフォーマット変更、ツール呼び出しの癖、認証の問題、レート制限の動作を検出
- 期待値:
  - 設計上 CI では安定しません（実際のネットワーク、実際のプロバイダーポリシー、クォータ、障害）
  - お金がかかる / レート制限を使用します
  - 「すべて」ではなく絞り込まれたサブセットを実行することを優先してください
  - ライブ実行は `~/.profile` を読み込んで不足している API キーを取得します
- API キーのローテーション（プロバイダー固有）: カンマ/セミコロン形式の `*_API_KEYS` または `*_API_KEY_1`、`*_API_KEY_2`（例: `OPENAI_API_KEYS`、`ANTHROPIC_API_KEYS`、`GEMINI_API_KEYS`）、あるいはライブごとのオーバーライド `OPENCLAW_LIVE_*_KEY` を設定します。テストはレート制限レスポンスに対してリトライします。

## どのスイートを実行すべきか

この判断表を使用してください:

- ロジック/テストを編集する: `pnpm test` を実行します（多く変更した場合は `pnpm test:coverage` も）
- Gateway ネットワーキング / WS プロトコル / ペアリングを変更する: `pnpm test:e2e` を追加します
- 「ボットがダウンしている」のデバッグ / プロバイダー固有の障害 / ツール呼び出し: 絞り込んだ `pnpm test:live` を実行します

## ライブ: Android ノードのケイパビリティスイープ

- テスト: `src/gateway/android-node.capabilities.live.test.ts`
- スクリプト: `pnpm android:test:integration`
- 目標: 接続された Android ノードで**現在アドバタイズされているすべてのコマンド**を呼び出し、コマンドコントラクトの動作をアサートします。
- スコープ:
  - 事前条件/手動セットアップ（スイートはアプリのインストール/実行/ペアリングは行いません）。
  - 選択した Android ノードに対するコマンドごとの Gateway `node.invoke` のバリデーション。
- 必要な事前セットアップ:
  - Android アプリがすでに Gateway に接続・ペアリングされていること。
  - アプリをフォアグラウンドに保つこと。
  - 合格を期待するケイパビリティに対してパーミッション/キャプチャの同意が付与されていること。
- オプションのターゲットオーバーライド:
  - `OPENCLAW_ANDROID_NODE_ID` または `OPENCLAW_ANDROID_NODE_NAME`。
  - `OPENCLAW_ANDROID_GATEWAY_URL` / `OPENCLAW_ANDROID_GATEWAY_TOKEN` / `OPENCLAW_ANDROID_GATEWAY_PASSWORD`。
- Android セットアップの詳細: [Android アプリ](/platforms/android)

## ライブ: モデルスモーク（プロファイルキー）

ライブテストは障害を切り離せるように 2 つのレイヤーに分かれています:

- 「ダイレクトモデル」は、プロバイダー/モデルが指定のキーでまったく答えられるかどうかを示します。
- 「Gateway スモーク」は、そのモデルに対して完全な Gateway + エージェントパイプラインが動作するかどうかを示します（セッション、履歴、ツール、サンドボックスポリシーなど）。

### レイヤー 1: ダイレクトモデル補完（Gateway なし）

- テスト: `src/agents/models.profiles.live.test.ts`
- 目標:
  - 検出されたモデルを列挙する
  - `getApiKeyForModel` を使用してクレデンシャルを持つモデルを選択する
  - モデルごとに小さな補完を実行する（必要に応じてターゲットを絞ったリグレッションも）
- 有効にする方法:
  - `pnpm test:live`（または Vitest を直接呼び出す場合は `OPENCLAW_LIVE_TEST=1`）
- このスイートを実際に実行するには `OPENCLAW_LIVE_MODELS=modern`（または `all`、`modern` のエイリアス）を設定します。設定しない場合は `pnpm test:live` を Gateway スモークに集中させるためにスキップされます
- モデルの選択方法:
  - `OPENCLAW_LIVE_MODELS=modern` でモダン許可リスト（Opus/Sonnet/Haiku 4.5、GPT-5.x + Codex、Gemini 3、GLM 4.7、MiniMax M2.1、Grok 4）を実行します
  - `OPENCLAW_LIVE_MODELS=all` はモダン許可リストのエイリアスです
  - または `OPENCLAW_LIVE_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,..."` でカンマ区切りの許可リストを使用します
- プロバイダーの選択方法:
  - `OPENCLAW_LIVE_PROVIDERS="google,google-antigravity,google-gemini-cli"` でカンマ区切りの許可リストを使用します
- キーの取得元:
  - デフォルト: プロファイルストアと環境変数のフォールバック
  - `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` を設定するとプロファイルストアのみを使用します
- 存在理由:
  - 「プロバイダー API が壊れている / キーが無効」と「Gateway エージェントパイプラインが壊れている」を分離します
  - 小さく隔離されたリグレッションを含みます（例: OpenAI Responses/Codex Responses の推論リプレイ + ツール呼び出しフロー）

### レイヤー 2: Gateway + Dev エージェントスモーク（「@openclaw」が実際に行うこと）

- テスト: `src/gateway/gateway-models.profiles.live.test.ts`
- 目標:
  - インプロセスの Gateway を起動する
  - `agent:dev:*` セッションを作成/パッチする（実行ごとにモデルオーバーライド）
  - クレデンシャルを持つモデルを反復し、以下をアサートする:
    - 「意味のある」レスポンス（ツールなし）
    - 実際のツール呼び出しが機能する（読み取りプローブ）
    - オプションの追加ツールプローブ（exec+read プローブ）
    - OpenAI リグレッションパス（ツール呼び出しのみ → フォローアップ）が機能し続けること
- プローブの詳細（障害を素早く説明できるように）:
  - `read` プローブ: テストはワークスペースにナンスファイルを書き込み、エージェントに `read` させてナンスをエコーバックするよう依頼します。
  - `exec+read` プローブ: テストはエージェントに `exec` でナンスを一時ファイルに書き込み、それを `read` させるよう依頼します。
  - image プローブ: テストは生成した PNG（猫 + ランダム化されたコード）を添付し、モデルが `cat <CODE>` を返すことを期待します。
  - 実装リファレンス: `src/gateway/gateway-models.profiles.live.test.ts` と `src/gateway/live-image-probe.ts`。
- 有効にする方法:
  - `pnpm test:live`（または Vitest を直接呼び出す場合は `OPENCLAW_LIVE_TEST=1`）
- モデルの選択方法:
  - デフォルト: モダン許可リスト（Opus/Sonnet/Haiku 4.5、GPT-5.x + Codex、Gemini 3、GLM 4.7、MiniMax M2.1、Grok 4）
  - `OPENCLAW_LIVE_GATEWAY_MODELS=all` はモダン許可リストのエイリアスです
  - または `OPENCLAW_LIVE_GATEWAY_MODELS="provider/model"`（またはカンマ区切りリスト）を設定して絞り込みます
- プロバイダーの選択方法（「OpenRouter で全部」を避けるために）:
  - `OPENCLAW_LIVE_GATEWAY_PROVIDERS="google,google-antigravity,google-gemini-cli,openai,anthropic,zai,minimax"` でカンマ区切りの許可リストを使用します
- このライブテストではツール + イメージプローブが常に有効です:
  - `read` プローブ + `exec+read` プローブ（ツールストレス）
  - イメージプローブはモデルがイメージ入力サポートをアドバタイズしている場合に実行されます
  - フロー（ハイレベル）:
    - テストは「CAT」+ ランダムコードを含む小さな PNG を生成します（`src/gateway/live-image-probe.ts`）
    - `agent` の `attachments: [{ mimeType: "image/png", content: "<base64>" }]` 経由で送信します
    - Gateway は添付ファイルを `images[]` に解析します（`src/gateway/server-methods/agent.ts` + `src/gateway/chat-attachments.ts`）
    - 組み込みエージェントはマルチモーダルユーザーメッセージをモデルに転送します
    - アサーション: 返信に `cat` + コードが含まれること（OCR 許容度: 軽微なミスは許可）

ヒント: お使いのマシンでテストできるもの（および正確な `provider/model` ID）を確認するには、以下を実行してください:

```bash
openclaw models list
openclaw models list --json
```

## ライブ: Anthropic セットアップトークンのスモーク

- テスト: `src/agents/anthropic.setup-token.live.test.ts`
- 目標: Claude Code CLI のセットアップトークン（またはペーストしたセットアップトークンプロファイル）が Anthropic のプロンプトを完了できることを確認します。
- 有効にする方法:
  - `pnpm test:live`（または Vitest を直接呼び出す場合は `OPENCLAW_LIVE_TEST=1`）
  - `OPENCLAW_LIVE_SETUP_TOKEN=1`
- トークンソース（いずれか 1 つ）:
  - プロファイル: `OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test`
  - 未加工トークン: `OPENCLAW_LIVE_SETUP_TOKEN_VALUE=sk-ant-oat01-...`
- モデルオーバーライド（オプション）:
  - `OPENCLAW_LIVE_SETUP_TOKEN_MODEL=anthropic/claude-opus-4-6`

セットアップ例:

```bash
openclaw models auth paste-token --provider anthropic --profile-id anthropic:setup-token-test
OPENCLAW_LIVE_SETUP_TOKEN=1 OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test pnpm test:live src/agents/anthropic.setup-token.live.test.ts
```

## ライブ: CLI バックエンドスモーク（Claude Code CLI またはその他のローカル CLI）

- テスト: `src/gateway/gateway-cli-backend.live.test.ts`
- 目標: デフォルト設定に触れずに、ローカル CLI バックエンドを使用して Gateway + エージェントパイプラインを検証します。
- 有効にする方法:
  - `pnpm test:live`（または Vitest を直接呼び出す場合は `OPENCLAW_LIVE_TEST=1`）
  - `OPENCLAW_LIVE_CLI_BACKEND=1`
- デフォルト:
  - モデル: `claude-cli/claude-sonnet-4-6`
  - コマンド: `claude`
  - 引数: `["-p","--output-format","json","--dangerously-skip-permissions"]`
- オーバーライド（オプション）:
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-opus-4-6"`
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="codex-cli/gpt-5.3-codex"`
  - `OPENCLAW_LIVE_CLI_BACKEND_COMMAND="/full/path/to/claude"`
  - `OPENCLAW_LIVE_CLI_BACKEND_ARGS='["-p","--output-format","json","--permission-mode","bypassPermissions"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV='["ANTHROPIC_API_KEY","ANTHROPIC_API_KEY_OLD"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE=1` で実際の画像添付ファイルを送信します（パスはプロンプトに注入されます）。
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG="--image"` でプロンプト注入の代わりに CLI 引数として画像ファイルパスを渡します。
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE="repeat"`（または `"list"`）で `IMAGE_ARG` が設定された場合の画像引数の渡し方を制御します。
  - `OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE=1` で第 2 ターンを送信してレジュームフローを検証します。
- `OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG=0` で Claude Code CLI の MCP 設定を有効に保ちます（デフォルトでは一時的な空ファイルで MCP 設定を無効化します）。

例:

```bash
OPENCLAW_LIVE_CLI_BACKEND=1 \
  OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-sonnet-4-6" \
  pnpm test:live src/gateway/gateway-cli-backend.live.test.ts
```

### 推奨ライブレシピ

絞り込まれた明示的な許可リストが最も高速でフレーキーになりにくいです:

- シングルモデル、ダイレクト（Gateway なし）:
  - `OPENCLAW_LIVE_MODELS="openai/gpt-5.2" pnpm test:live src/agents/models.profiles.live.test.ts`

- シングルモデル、Gateway スモーク:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- 複数プロバイダーでのツール呼び出し:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,google/gemini-3-flash-preview,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Google フォーカス（Gemini API キー + Antigravity）:
  - Gemini（API キー）: `OPENCLAW_LIVE_GATEWAY_MODELS="google/gemini-3-flash-preview" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`
  - Antigravity（OAuth）: `OPENCLAW_LIVE_GATEWAY_MODELS="google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-pro-high" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

注意:

- `google/...` は Gemini API（API キー）を使用します。
- `google-antigravity/...` は Antigravity OAuth ブリッジ（Cloud Code Assist スタイルのエージェントエンドポイント）を使用します。
- `google-gemini-cli/...` はマシン上のローカル Gemini CLI を使用します（別の認証 + ツールの癖があります）。
- Gemini API vs Gemini CLI:
  - API: OpenClaw は Google のホスト型 Gemini API を HTTP 経由で呼び出します（API キー / プロファイル認証）。これが多くのユーザーが「Gemini」と呼ぶものです。
  - CLI: OpenClaw はローカルの `gemini` バイナリをシェルアウトで呼び出します。独自の認証があり、動作が異なる場合があります（ストリーミング/ツールサポート/バージョンの差異）。

## ライブ: モデルマトリックス（対象範囲）

CI に固定された「モデルリスト」はありません（ライブはオプトイン）が、これらはキーを持つ Dev マシンで定期的にカバーすることが推奨されるモデルです。

### モダンスモークセット（ツール呼び出し + イメージ）

これが「一般的なモデル」の実行であり、機能し続けることが期待されます:

- OpenAI（非 Codex）: `openai/gpt-5.2`（オプション: `openai/gpt-5.1`）
- OpenAI Codex: `openai-codex/gpt-5.3-codex`（オプション: `openai-codex/gpt-5.3-codex-codex`）
- Anthropic: `anthropic/claude-opus-4-6`（または `anthropic/claude-sonnet-4-5`）
- Google（Gemini API）: `google/gemini-3-pro-preview` と `google/gemini-3-flash-preview`（古い Gemini 2.x モデルは避けてください）
- Google（Antigravity）: `google-antigravity/claude-opus-4-6-thinking` と `google-antigravity/gemini-3-flash`
- Z.AI（GLM）: `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

ツール + イメージ付きで Gateway スモークを実行します:
`OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,openai-codex/gpt-5.3-codex,anthropic/claude-opus-4-6,google/gemini-3-pro-preview,google/gemini-3-flash-preview,google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-flash,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

### ベースライン: ツール呼び出し（Read + オプションの Exec）

プロバイダーファミリーごとに少なくとも 1 つを選んでください:

- OpenAI: `openai/gpt-5.2`（または `openai/gpt-5-mini`）
- Anthropic: `anthropic/claude-opus-4-6`（または `anthropic/claude-sonnet-4-5`）
- Google: `google/gemini-3-flash-preview`（または `google/gemini-3-pro-preview`）
- Z.AI（GLM）: `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

追加のオプションカバレッジ（あると良い）:

- xAI: `xai/grok-4`（または最新の利用可能なもの）
- Mistral: `mistral/`...（ツール対応の有効なモデルを 1 つ選ぶ）
- Cerebras: `cerebras/`...（アクセスがある場合）
- LM Studio: `lmstudio/`...（ローカル; ツール呼び出しは API モードによります）

### ビジョン: イメージ送信（添付ファイル → マルチモーダルメッセージ）

`OPENCLAW_LIVE_GATEWAY_MODELS` にイメージ対応モデル（Claude/Gemini/OpenAI のビジョン対応バリアントなど）を少なくとも 1 つ含めて、イメージプローブを実行してください。

### アグリゲーター / 代替 Gateway

キーが有効な場合、以下も経由でテストをサポートしています:

- OpenRouter: `openrouter/...`（数百のモデル; `openclaw models scan` を使用してツール + イメージ対応候補を見つけてください）
- OpenCode Zen: `opencode/...`（`OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY` で認証）

ライブマトリックスに含めることができるその他のプロバイダー（クレデンシャル/設定がある場合）:

- ビルトイン: `openai`、`openai-codex`、`anthropic`、`google`、`google-vertex`、`google-antigravity`、`google-gemini-cli`、`zai`、`openrouter`、`opencode`、`xai`、`groq`、`cerebras`、`mistral`、`github-copilot`
- `models.providers` 経由（カスタムエンドポイント）: `minimax`（クラウド/API）、さらに OpenAI/Anthropic 互換プロキシ（LM Studio、vLLM、LiteLLM など）

ヒント: ドキュメントに「全モデル」をハードコードしようとしないでください。権威あるリストは、お使いのマシンで `discoverModels(...)` が返すものと、利用可能なキーによって決まります。

## クレデンシャル（コミットしないこと）

ライブテストは CLI と同じ方法でクレデンシャルを検出します。実用的な意味:

- CLI が動作すれば、ライブテストも同じキーを見つけられるはずです。
- ライブテストが「クレデンシャルなし」と言う場合は、`openclaw models list` / モデル選択のデバッグと同じ方法でデバッグしてください。

- プロファイルストア: `~/.openclaw/credentials/`（優先; テストでの「プロファイルキー」の意味）
- 設定: `~/.openclaw/openclaw.json`（または `OPENCLAW_CONFIG_PATH`）

環境キー（例: `~/.profile` でエクスポートされたもの）に依存したい場合は、`source ~/.profile` の後にローカルテストを実行するか、以下の Docker ランナーを使用してください（コンテナに `~/.profile` をマウントできます）。

## Deepgram ライブ（音声転写）

- テスト: `src/media-understanding/providers/deepgram/audio.live.test.ts`
- 有効にする方法: `DEEPGRAM_API_KEY=... DEEPGRAM_LIVE_TEST=1 pnpm test:live src/media-understanding/providers/deepgram/audio.live.test.ts`

## BytePlus コーディングプランのライブ

- テスト: `src/agents/byteplus.live.test.ts`
- 有効にする方法: `BYTEPLUS_API_KEY=... BYTEPLUS_LIVE_TEST=1 pnpm test:live src/agents/byteplus.live.test.ts`
- オプションのモデルオーバーライド: `BYTEPLUS_CODING_MODEL=ark-code-latest`

## Docker ランナー（オプションの「Linux で動作する」チェック）

これらはリポジトリの Docker イメージ内で `pnpm test:live` を実行し、ローカルの設定ディレクトリとワークスペースをマウントします（マウントされている場合は `~/.profile` も読み込みます）:

- ダイレクトモデル: `pnpm test:docker:live-models`（スクリプト: `scripts/test-live-models-docker.sh`）
- Gateway + Dev エージェント: `pnpm test:docker:live-gateway`（スクリプト: `scripts/test-live-gateway-models-docker.sh`）
- オンボーディングウィザード（TTY、フルスキャフォールディング）: `pnpm test:docker:onboard`（スクリプト: `scripts/e2e/onboard-docker.sh`）
- Gateway ネットワーキング（2 つのコンテナ、WS 認証 + ヘルス）: `pnpm test:docker:gateway-network`（スクリプト: `scripts/e2e/gateway-network-docker.sh`）
- プラグイン（カスタム拡張機能の読み込み + レジストリスモーク）: `pnpm test:docker:plugins`（スクリプト: `scripts/e2e/plugins-docker.sh`）

手動 ACP 平文スレッドスモーク（CI ではない）:

- `bun scripts/dev/discord-acp-plain-language-smoke.ts --channel <discord-channel-id> ...`
- このスクリプトはリグレッション/デバッグワークフロー用に保持してください。ACP スレッドルーティングの検証に再度必要になる可能性があるため、削除しないでください。

便利な環境変数:

- `OPENCLAW_CONFIG_DIR=...`（デフォルト: `~/.openclaw`）が `/home/node/.openclaw` にマウントされます
- `OPENCLAW_WORKSPACE_DIR=...`（デフォルト: `~/.openclaw/workspace`）が `/home/node/.openclaw/workspace` にマウントされます
- `OPENCLAW_PROFILE_FILE=...`（デフォルト: `~/.profile`）が `/home/node/.profile` にマウントされ、テスト実行前に読み込まれます
- `OPENCLAW_LIVE_GATEWAY_MODELS=...` / `OPENCLAW_LIVE_MODELS=...` で実行を絞り込みます
- `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` でクレデンシャルがプロファイルストアから来ることを保証します（env からではない）

## ドキュメントのサニティチェック

ドキュメントを編集した後はドキュメントチェックを実行してください: `pnpm docs:list`。

## オフラインリグレッション（CI セーフ）

これらは実際のプロバイダーなしの「実際のパイプライン」リグレッションです:

- Gateway ツール呼び出し（モック OpenAI、実際の Gateway + エージェントループ）: `src/gateway/gateway.test.ts`（ケース: 「runs a mock OpenAI tool call end-to-end via gateway agent loop」）
- Gateway ウィザード（WS `wizard.start`/`wizard.next`、設定を書き込み + 認証が強制される）: `src/gateway/gateway.test.ts`（ケース: 「runs wizard over ws and writes auth token config」）

## エージェント信頼性の評価（スキル）

CI セーフなテストのうち、「エージェント信頼性の評価」のように動作するものがすでにいくつかあります:

- 実際の Gateway + エージェントループを通じたモックツール呼び出し（`src/gateway/gateway.test.ts`）。
- セッション配線と設定効果を検証するエンドツーエンドウィザードフロー（`src/gateway/gateway.test.ts`）。

スキルでまだ不足しているもの（[スキル](/tools/skills) を参照）:

- **意思決定:** スキルがプロンプトにリストされている場合、エージェントは正しいスキルを選ぶ（または無関係なスキルを避ける）か？
- **コンプライアンス:** エージェントは使用前に `SKILL.md` を読み、必要な手順/引数に従うか？
- **ワークフローコントラクト:** ツールの順序、セッション履歴の引き継ぎ、サンドボックスの境界をアサートするマルチターンシナリオ。

将来の評価は最初に決定論的であるべきです:

- モックプロバイダーを使用してツール呼び出し + 順序、スキルファイルの読み込み、セッション配線をアサートするシナリオランナー。
- スキルに焦点を当てたシナリオの小さなスイート（使用 vs 回避、ゲーティング、プロンプトインジェクション）。
- CI セーフなスイートが整備された後にのみ、オプションのライブ評価（オプトイン、環境変数ゲート）を追加。

## リグレッションの追加（ガイダンス）

ライブで発見されたプロバイダー/モデルの問題を修正する際:

- 可能であれば CI セーフなリグレッションを追加してください（モック/スタブプロバイダー、または正確なリクエスト変換をキャプチャ）
- 本質的にライブのみの場合（レート制限、認証ポリシー）、ライブテストを絞り込み、環境変数でオプトインにしてください
- バグを検出する最小のレイヤーをターゲットにすることを優先してください:
  - プロバイダーのリクエスト変換/リプレイバグ → ダイレクトモデルテスト
  - Gateway セッション/履歴/ツールパイプラインバグ → Gateway ライブスモークまたは CI セーフの Gateway モックテスト
