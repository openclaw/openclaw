---
summary: "モデルCLI: リスト、設定、エイリアス、フォールバック、スキャン、ステータス"
read_when:
  - Adding or modifying models CLI (models list/set/scan/aliases/fallbacks)
  - Changing model fallback behavior or selection UX
  - Updating model scan probes (tools/images)
title: "モデルCLI"
---

# モデルCLI

認証プロファイルのローテーション、クールダウン、フォールバックとの連携については[/concepts/model-failover](/concepts/model-failover)を参照してください。
プロバイダーの概要 + 例: [/concepts/model-providers](/concepts/model-providers)。

## モデル選択の仕組み

OpenClawは以下の順序でモデルを選択します:

1. **プライマリ**モデル（`agents.defaults.model.primary`または`agents.defaults.model`）。
2. **フォールバック**（`agents.defaults.model.fallbacks`の順序で）。
3. **プロバイダー認証フェイルオーバー**は、次のモデルに移行する前にプロバイダー内で発生します。

関連:

- `agents.defaults.models`はOpenClawが使用できるモデルの許可リスト/カタログです（エイリアスを含む）。
- `agents.defaults.imageModel`はプライマリモデルが画像を受け入れられない場合に**のみ**使用されます。
- エージェントごとのデフォルトは`agents.list[].model`とバインディングで`agents.defaults.model`をオーバーライドできます（[/concepts/multi-agent](/concepts/multi-agent)を参照）。

## クイックモデル選択（経験的）

- **GLM**: コーディング/ツール呼び出しにやや優れています。
- **MiniMax**: ライティングや雰囲気に優れています。

## セットアップウィザード（推奨）

設定を手動で編集したくない場合は、オンボーディングウィザードを実行してください:

```bash
openclaw onboard
```

一般的なプロバイダーのモデル + 認証を設定できます。**OpenAI Code (Codex)サブスクリプション**（OAuth）や**Anthropic**（APIキー推奨、`claude setup-token`もサポート）が含まれます。

## 設定キー（概要）

- `agents.defaults.model.primary`および`agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary`および`agents.defaults.imageModel.fallbacks`
- `agents.defaults.models`（許可リスト + エイリアス + プロバイダーパラメータ）
- `models.providers`（`models.json`に書き込まれるカスタムプロバイダー）

モデル参照は小文字に正規化されます。`z.ai/*`のようなプロバイダーエイリアスは`zai/*`に正規化されます。

プロバイダー設定の例（OpenCode Zenを含む）は[/gateway/configuration](/gateway/configuration#opencode-zen-multi-model-proxy)にあります。

## 「Model is not allowed」（応答が停止する理由）

`agents.defaults.models`が設定されている場合、`/model`やセッションのオーバーライドの**許可リスト**になります。ユーザーが許可リストにないモデルを選択すると、OpenClawは以下を返します:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

これは通常の返信が生成される**前に**発生するため、メッセージに「応答がない」ように見えることがあります。修正方法:

- モデルを`agents.defaults.models`に追加する、または
- 許可リストをクリアする（`agents.defaults.models`を削除）、または
- `/model list`からモデルを選択する。

許可リスト設定の例:

```json5
{
  agent: {
    model: { primary: "anthropic/claude-sonnet-4-5" },
    models: {
      "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
      "anthropic/claude-opus-4-6": { alias: "Opus" },
    },
  },
}
```

## チャットでのモデル切り替え（`/model`）

再起動せずに現在のセッションのモデルを切り替えられます:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model status
```

注意事項:

- `/model`（および`/model list`）はコンパクトな番号付きピッカーです（モデルファミリー + 利用可能なプロバイダー）。
- Discordでは、`/model`と`/models`がプロバイダーとモデルのドロップダウン + 送信ステップを持つインタラクティブピッカーを開きます。
- `/model <#>`はそのピッカーから選択します。
- `/model status`は詳細ビューです（認証候補と、設定されている場合はプロバイダーエンドポイントの`baseUrl` + `api`モード）。
- モデル参照は**最初の**`/`で分割してパースされます。`/model <ref>`を入力する際は`provider/model`を使用してください。
- モデルID自体に`/`が含まれる場合（OpenRouterスタイル）、プロバイダープレフィックスを含める必要があります（例: `/model openrouter/moonshotai/kimi-k2`）。
- プロバイダーを省略した場合、OpenClawは入力をエイリアスまたは**デフォルトプロバイダー**のモデルとして扱います（モデルIDに`/`がない場合のみ機能します）。

完全なコマンド動作/設定: [スラッシュコマンド](/tools/slash-commands)。

## CLIコマンド

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

`openclaw models`（サブコマンドなし）は`models status`のショートカットです。

### `models list`

デフォルトでは設定済みモデルを表示します。便利なフラグ:

- `--all`: 完全カタログ
- `--local`: ローカルプロバイダーのみ
- `--provider <name>`: プロバイダーでフィルタリング
- `--plain`: 1行に1モデル
- `--json`: マシンリーダブル出力

### `models status`

解決済みのプライマリモデル、フォールバック、画像モデル、および設定済みプロバイダーの認証概要を表示します。認証ストアで見つかったプロファイルのOAuth有効期限ステータスも表示します（デフォルトでは24時間以内に警告）。`--plain`は解決済みのプライマリモデルのみを出力します。
OAuthステータスは常に表示されます（`--json`出力にも含まれます）。設定済みプロバイダーに認証情報がない場合、`models status`は**Missing auth**セクションを出力します。
JSONには`auth.oauth`（警告ウィンドウ + プロファイル）と`auth.providers`（プロバイダーごとの有効な認証）が含まれます。
自動化には`--check`を使用してください（欠落/期限切れの場合は終了コード`1`、期限切れ間近の場合は`2`）。

推奨されるAnthropic認証はClaude Code CLIのセットアップトークンです（どこでも実行可能。必要に応じてGatewayホストに貼り付けてください）:

```bash
claude setup-token
openclaw models status
```

## スキャン（OpenRouterフリーモデル）

`openclaw models scan`はOpenRouterの**フリーモデルカタログ**を検査し、オプションでモデルのツールと画像サポートをプローブできます。

主なフラグ:

- `--no-probe`: ライブプローブをスキップ（メタデータのみ）
- `--min-params <b>`: 最小パラメータサイズ（十億単位）
- `--max-age-days <days>`: 古いモデルをスキップ
- `--provider <name>`: プロバイダープレフィックスフィルター
- `--max-candidates <n>`: フォールバックリストサイズ
- `--set-default`: 最初の選択を`agents.defaults.model.primary`に設定
- `--set-image`: 最初の画像選択を`agents.defaults.imageModel.primary`に設定

プローブにはOpenRouter APIキー（認証プロファイルまたは`OPENROUTER_API_KEY`から）が必要です。キーがない場合は`--no-probe`を使用して候補のみをリストしてください。

スキャン結果は以下でランク付けされます:

1. 画像サポート
2. ツールレイテンシ
3. コンテキストサイズ
4. パラメータ数

入力

- OpenRouter `/models`リスト（`:free`でフィルター）
- 認証プロファイルまたは`OPENROUTER_API_KEY`からのOpenRouter APIキーが必要（[/environment](/help/environment)を参照）
- オプションフィルター: `--max-age-days`、`--min-params`、`--provider`、`--max-candidates`
- プローブ制御: `--timeout`、`--concurrency`

TTYで実行する場合、フォールバックをインタラクティブに選択できます。非インタラクティブモードでは`--yes`を渡してデフォルトを受け入れてください。

## モデルレジストリ（`models.json`）

`models.providers`のカスタムプロバイダーはエージェントディレクトリ配下の`models.json`に書き込まれます（デフォルト`~/.openclaw/agents/<agentId>/models.json`）。このファイルは`models.mode`が`replace`に設定されていない限り、デフォルトでマージされます。

一致するプロバイダーIDのマージモード優先順位:

- エージェントの`models.json`に既に存在する空でない`apiKey`/`baseUrl`が優先されます。
- エージェントの空または欠落している`apiKey`/`baseUrl`は設定の`models.providers`にフォールバックします。
- その他のプロバイダーフィールドは設定と正規化されたカタログデータから更新されます。
