---
read_when:
    - モデル CLI の追加・変更時（models list/set/scan/aliases/fallbacks）
    - モデルのフォールバック動作や選択 UX の変更時
    - モデルスキャンプローブ（tools/images）の更新時
summary: 'モデル CLI: list、set、aliases、fallbacks、scan、status'
title: モデル CLI
x-i18n:
    generated_at: "2026-04-02T07:38:42Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: a0a54c17be4adca6eb270da16bb30d3dcd8642e2b72e9d3c982ecec0b421cd17
    source_path: concepts/models.md
    workflow: 15
---

# モデル CLI

認証プロファイルのローテーション、クールダウン、およびフォールバックとの連携については、[/concepts/model-failover](/concepts/model-failover) を参照してください。
プロバイダーの概要と例については、[/concepts/model-providers](/concepts/model-providers) を参照してください。

## モデル選択の仕組み

OpenClaw は以下の順序でモデルを選択します：

1. **プライマリ**モデル（`agents.defaults.model.primary` または `agents.defaults.model`）。
2. `agents.defaults.model.fallbacks` の**フォールバック**（順番通り）。
3. **プロバイダー認証フェイルオーバー**は、次のモデルに移る前にプロバイダー内で発生します。

関連：

- `agents.defaults.models` は OpenClaw が使用できるモデルの許可リスト/カタログ（エイリアスを含む）です。
- `agents.defaults.imageModel` はプライマリモデルが画像を受け付けられない場合**のみ**使用されます。
- `agents.defaults.imageGenerationModel` は共有画像生成機能で使用されます。省略した場合でも、`image_generate` は互換性のある認証済み画像生成プラグインからプロバイダーのデフォルトを推定できます。特定のプロバイダー/モデルを設定する場合は、そのプロバイダーの認証/API キーも設定してください。
- エージェントごとのデフォルトは `agents.list[].model` とバインディングで `agents.defaults.model` をオーバーライドできます（[/concepts/multi-agent](/concepts/multi-agent) を参照）。

## モデルポリシーの簡易ガイド

- プライマリには、利用可能な最新世代の最も強力なモデルを設定してください。
- コスト/レイテンシーを重視するタスクや重要度の低いチャットにはフォールバックを使用してください。
- ツール対応エージェントや信頼できない入力の場合は、古い/弱いモデルティアの使用を避けてください。

## オンボーディング（推奨）

設定を手動で編集したくない場合は、オンボーディングを実行してください：

```bash
openclaw onboard
```

**OpenAI Code（Codex）サブスクリプション**（OAuth）や **Anthropic**（API キーまたは `claude setup-token`）を含む一般的なプロバイダーのモデル + 認証を設定できます。

## 設定キー（概要）

- `agents.defaults.model.primary` と `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` と `agents.defaults.imageModel.fallbacks`
- `agents.defaults.imageGenerationModel.primary` と `agents.defaults.imageGenerationModel.fallbacks`
- `agents.defaults.models`（許可リスト + エイリアス + プロバイダーパラメーター）
- `models.providers`（`models.json` に書き込まれるカスタムプロバイダー）

モデル参照は小文字に正規化されます。`z.ai/*` のようなプロバイダーエイリアスは `zai/*` に正規化されます。

プロバイダーの設定例（OpenCode を含む）は [/providers/opencode](/providers/opencode) にあります。

## 「Model is not allowed」（返信が止まる理由）

`agents.defaults.models` が設定されている場合、それは `/model` およびセッションオーバーライドの**許可リスト**になります。ユーザーが許可リストにないモデルを選択すると、OpenClaw は以下を返します：

```
Model "provider/model" is not allowed. Use /model to list available models.
```

これは通常の返信が生成される**前**に発生するため、メッセージが「応答しなかった」ように感じることがあります。修正方法は以下のいずれかです：

- モデルを `agents.defaults.models` に追加する
- 許可リストをクリアする（`agents.defaults.models` を削除する）
- `/model list` からモデルを選択する

許可リスト設定の例：

```json5
{
  agent: {
    model: { primary: "anthropic/claude-sonnet-4-6" },
    models: {
      "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
      "anthropic/claude-opus-4-6": { alias: "Opus" },
    },
  },
}
```

## チャットでのモデル切り替え（`/model`）

再起動せずに現在のセッションのモデルを切り替えることができます：

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model status
```

注意：

- `/model`（および `/model list`）はコンパクトな番号付きピッカーです（モデルファミリー + 利用可能なプロバイダー）。
- Discord では、`/model` と `/models` がプロバイダーとモデルのドロップダウン、および Submit ステップ付きのインタラクティブピッカーを開きます。
- `/model <#>` でそのピッカーから選択します。
- `/model` はセッションの選択を即座に更新します。エージェントがアイドル状態の場合、次の実行で新しいモデルがすぐに使用されます。エージェントがビジー状態の場合、実行中の処理が先に完了し、キューに入っている/今後の処理はその後に新しいモデルを使用します。
- `/model status` は詳細ビューです（認証候補、および設定されている場合はプロバイダーエンドポイントの `baseUrl` + `api` モード）。
- モデル参照は**最初の** `/` で分割して解析されます。`/model <ref>` と入力する際は `provider/model` を使用してください。
- モデル ID 自体に `/` が含まれる場合（OpenRouter スタイル）、プロバイダープレフィックスを含める必要があります（例：`/model openrouter/moonshotai/kimi-k2`）。
- プロバイダーを省略した場合、OpenClaw は入力を**デフォルトプロバイダー**のエイリアスまたはモデルとして扱います（モデル ID に `/` が含まれていない場合のみ機能します）。

コマンドの完全な動作/設定：[スラッシュコマンド](/tools/slash-commands)。

## CLI コマンド

```bash
openclaw models list
openclaw models status
openclaw models set <provider/model>
openclaw models set-image <provider/model>

openclaw models aliases list
openclaw models aliases add <alias> <provider/model>
openclaw models aliases remove <alias>

openclaw models fallbacks list
openclaw models fallbacks add <provider/model>
openclaw models fallbacks remove <provider/model>
openclaw models fallbacks clear

openclaw models image-fallbacks list
openclaw models image-fallbacks add <provider/model>
openclaw models image-fallbacks remove <provider/model>
openclaw models image-fallbacks clear
```

`openclaw models`（サブコマンドなし）は `models status` のショートカットです。

### `models list`

デフォルトでは設定済みモデルを表示します。便利なフラグ：

- `--all`：完全なカタログ
- `--local`：ローカルプロバイダーのみ
- `--provider <name>`：プロバイダーでフィルタ
- `--plain`：1 行に 1 モデル
- `--json`：機械可読な出力

### `models status`

解決されたプライマリモデル、フォールバック、画像モデル、および設定済みプロバイダーの認証概要を表示します。認証ストアで見つかったプロファイルの OAuth 有効期限ステータスも表示します（デフォルトでは 24 時間以内に警告）。`--plain` は解決されたプライマリモデルのみを出力します。
OAuth ステータスは常に表示されます（`--json` 出力にも含まれます）。設定済みプロバイダーに認証情報がない場合、`models status` は **Missing auth** セクションを出力します。
JSON には `auth.oauth`（警告期間 + プロファイル）と `auth.providers`（プロバイダーごとの有効な認証）が含まれます。
自動化には `--check` を使用してください（欠落/期限切れの場合は終了コード `1`、期限切れ間近の場合は `2`）。

認証の選択はプロバイダー/アカウントに依存します。常時稼働の Gateway ゲートウェイホストでは、API キーが最も予測可能な方法です。サブスクリプショントークンフローもサポートされています。

例（Anthropic setup-token）：

```bash
claude setup-token
openclaw models status
```

## スキャン（OpenRouter 無料モデル）

`openclaw models scan` は OpenRouter の**無料モデルカタログ**を検査し、オプションでモデルのツールおよび画像サポートをプローブできます。

主要なフラグ：

- `--no-probe`：ライブプローブをスキップ（メタデータのみ）
- `--min-params <b>`：最小パラメーターサイズ（10 億単位）
- `--max-age-days <days>`：古いモデルをスキップ
- `--provider <name>`：プロバイダープレフィックスフィルタ
- `--max-candidates <n>`：フォールバックリストサイズ
- `--set-default`：最初の選択を `agents.defaults.model.primary` に設定
- `--set-image`：最初の画像選択を `agents.defaults.imageModel.primary` に設定

プローブには OpenRouter API キー（認証プロファイルまたは `OPENROUTER_API_KEY` から）が必要です。キーがない場合は、`--no-probe` を使用して候補のみをリスト表示してください。

スキャン結果は以下の順でランク付けされます：

1. 画像サポート
2. ツールレイテンシー
3. コンテキストサイズ
4. パラメーター数

入力

- OpenRouter `/models` リスト（`:free` フィルタ）
- 認証プロファイルまたは `OPENROUTER_API_KEY` からの OpenRouter API キーが必要（[/environment](/help/environment) を参照）
- オプションのフィルタ：`--max-age-days`、`--min-params`、`--provider`、`--max-candidates`
- プローブ制御：`--timeout`、`--concurrency`

TTY で実行する場合は、フォールバックをインタラクティブに選択できます。非インタラクティブモードでは、`--yes` を渡してデフォルトを受け入れてください。

## モデルレジストリ（`models.json`）

`models.providers` のカスタムプロバイダーは、エージェントディレクトリ配下の `models.json`（デフォルト `~/.openclaw/agents/<agentId>/agent/models.json`）に書き込まれます。`models.mode` が `replace` に設定されていない限り、このファイルはデフォルトでマージされます。

一致するプロバイダー ID のマージモード優先順位：

- エージェント `models.json` に既に存在する空でない `baseUrl` が優先されます。
- エージェント `models.json` の空でない `apiKey` は、そのプロバイダーが現在の設定/認証プロファイルコンテキストで SecretRef 管理されていない場合にのみ優先されます。
- SecretRef 管理されたプロバイダーの `apiKey` 値は、解決済みシークレットを永続化する代わりに、ソースマーカー（環境変数参照の場合は `ENV_VAR_NAME`、ファイル/exec 参照の場合は `secretref-managed`）からリフレッシュされます。
- SecretRef 管理されたプロバイダーのヘッダー値は、ソースマーカー（環境変数参照の場合は `secretref-env:ENV_VAR_NAME`、ファイル/exec 参照の場合は `secretref-managed`）からリフレッシュされます。
- 空または欠落しているエージェントの `apiKey`/`baseUrl` は設定の `models.providers` にフォールバックします。
- その他のプロバイダーフィールドは設定および正規化されたカタログデータからリフレッシュされます。

マーカーの永続化はソース権限的です：OpenClaw は解決済みのランタイムシークレット値からではなく、アクティブなソース設定スナップショット（解決前）からマーカーを書き込みます。
これは `openclaw agent` のようなコマンド駆動パスを含め、OpenClaw が `models.json` を再生成するたびに適用されます。

## 関連

- [モデルプロバイダー](/concepts/model-providers) — プロバイダールーティングと認証
- [モデルフェイルオーバー](/concepts/model-failover) — フォールバックチェーン
- [画像生成](/tools/image-generation) — 画像モデルの設定
- [設定リファレンス](/gateway/configuration-reference#agent-defaults) — モデル設定キー
