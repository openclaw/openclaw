---
summary: "Models CLI：一覧表示、設定、エイリアス、フォールバック、スキャン、ステータス"
read_when:
  - Models CLI（models list/set/scan/aliases/fallbacks）を追加または変更する場合
  - モデルのフォールバック挙動や選択 UX を変更する場合
  - モデルスキャンのプローブ（ツール／画像）を更新する場合
title: "Models CLI"
---

# Models CLI

認証プロファイルのローテーション、クールダウン、およびそれらがフォールバックとどのように連携するかについては、[/concepts/model-failover](/concepts/model-failover) を参照してください。  
プロバイダーの簡単な概要と例については、[/concepts/model-providers](/concepts/model-providers) を参照してください。
クイックプロバイダーの概要 + 例: [/concepts/model-providers](/concepts/model-providers)

## モデル選択の仕組み

OpenClaw は次の順序でモデルを選択します。

1. **Primary** モデル（`agents.defaults.model.primary` または `agents.defaults.model`）。
2. `agents.defaults.model.fallbacks` に定義された **Fallbacks**（順序どおり）。
3. **プロバイダー認証のフェイルオーバー** は、次のモデルに移る前に、同一プロバイダー内で行われます。

関連事項:

- `agents.defaults.models` は、OpenClaw が使用できるモデル（およびエイリアス）の許可リスト／カタログです。
- `agents.defaults.imageModel` は、Primary モデルが画像を受け付けられない **場合にのみ** 使用されます。
- エージェントごとのデフォルトは、`agents.list[].model` とバインディングを通じて `agents.defaults.model` を上書きできます（[/concepts/multi-agent](/concepts/multi-agent) を参照）。

## クイックなモデル選択（経験談）

- **GLM**: コーディングやツール呼び出しでやや優れています。
- **MiniMax**: 文章作成や雰囲気表現に向いています。

## セットアップウィザード（推奨）

設定を手動で編集したくない場合は、オンボーディングウィザードを実行してください。

```bash
openclaw onboard
```

一般的なプロバイダー向けに、モデルと認証を設定できます。これには **OpenAI Code（Codex）サブスクリプション**（OAuth）および **Anthropic**（API キー推奨。`claude setup-token` もサポート）が含まれます。

## 設定キー（概要）

- `agents.defaults.model.primary` と `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` と `agents.defaults.imageModel.fallbacks`
- `agents.defaults.models`（許可リスト＋エイリアス＋プロバイダーのパラメータ）
- `models.providers`（`models.json` に書き込まれるカスタムプロバイダー）

モデル refは小文字に正規化されます。 モデル参照は小文字に正規化されます。`z.ai/*` のようなプロバイダーエイリアスは `zai/*` に正規化されます。

プロバイダー設定の例（OpenCode Zen を含む）は、[/gateway/configuration](/gateway/configuration#opencode-zen-multi-model-proxy) にあります。

## 「Model is not allowed」（および返信が止まる理由）

`agents.defaults.models` が設定されている場合、それは `/model` およびセッション上書きに対する **許可リスト** になります。  
ユーザーがその許可リストに含まれていないモデルを選択すると、OpenClaw は次を返します。 ユーザーがその許容リストにないモデルを選択すると、
OpenClawは以下を返します。

```
Model "provider/model" is not allowed. Use /model to list available models.
```

これは通常の返信が生成される **前** に発生するため、「応答しなかった」ように感じられることがあります。対処方法は次のいずれかです。 修正は次のいずれかになります。

- モデルを `agents.defaults.models` に追加する、または
- 許可リストをクリアする（`agents.defaults.models` を削除する）、または
- `/model list` からモデルを選択する。

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

## チャット内でのモデル切り替え（`/model`）

再起動せずに、現在のセッションのモデルを切り替えられます。

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model status
```

注記:

- `/model`（および `/model list`）は、コンパクトな番号付きピッカー（モデルファミリー＋利用可能なプロバイダー）です。
- `/model <#>` は、そのピッカーから選択します。
- `/model status` は詳細表示です（認証候補、および設定されている場合はプロバイダーエンドポイント `baseUrl`＋`api` モード）。
- モデル参照は**first** `/`で分割することによって解析されます。 モデル参照は **最初の** `/` で分割して解析されます。`/model <ref>` を入力する際は `provider/model` を使用してください。
- モデル ID 自体に `/`（OpenRouter 形式）が含まれる場合は、プロバイダー接頭辞を含める必要があります（例: `/model openrouter/moonshotai/kimi-k2`）。
- プロバイダーを省略した場合、OpenClaw は入力をエイリアス、または **デフォルトプロバイダー** のモデルとして扱います（モデル ID に `/` が含まれていない場合にのみ有効）。

コマンドの完全な挙動および設定については、[Slash commands](/tools/slash-commands) を参照してください。

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

`openclaw models`（サブコマンドなし）は、`models status` のショートカットです。

### `models list`

デフォルトでは設定済みモデルを表示します。便利なフラグ: 有用なフラグ:

- `--all`: 完全なカタログ
- `--local`: ローカルプロバイダーのみ
- `--provider <name>`: プロバイダーでフィルタ
- `--plain`: 1 行につき 1 モデル
- `--json`: 機械可読な出力

### `models status`

設定されたプロバイダの解決済みプライマリモデル、フォールバック、イメージモデル、認証概要
を表示します。 また、認証ストアで
見つかったプロファイルのOAuth有効期限ステータスもサーフェスします (デフォルトでは24時間以内に警告します)。 `--plain` は、
解決されたプライマリモデルのみを出力します。
OAuth ステータスは常に表示されます (`--json` 出力に含まれます)。 設定された
プロバイダに資格情報がない場合、`models status` は **Missing auth** セクションを表示します。
JSON には `auth.oauth` (window + profileに警告) と `auth.providers`
(providerあたりの実効認証) が含まれています。
オートメーションに `--check` を使用します(失効/有効期限が切れた場合は `1` を終了します)。

推奨される Anthropic の認証方法は、Claude Code CLI の setup-token です（どこでも実行可能。必要に応じて Gateway ホストに貼り付けてください）。

```bash
claude setup-token
openclaw models status
```

## スキャン（OpenRouter の無料モデル）

`openclaw models scan` は OpenRouter の **無料モデルカタログ** を調査し、必要に応じてツールおよび画像サポートのためにモデルをプローブします。

主なフラグ:

- `--no-probe`: ライブプローブをスキップ（メタデータのみ）
- `--min-params <b>`: 最小パラメータサイズ（十億単位）
- `--max-age-days <days>`: 古いモデルをスキップ
- `--provider <name>`: プロバイダー接頭辞フィルタ
- `--max-candidates <n>`: フォールバックリストのサイズ
- `--set-default`: `agents.defaults.model.primary` を最初の選択に設定
- `--set-image`: `agents.defaults.imageModel.primary` を最初の画像選択に設定

プローブには OpenRouter API キーが必要です（認証プロファイル、または `OPENROUTER_API_KEY`）。キーがない場合は、`--no-probe` を使用して候補のみを一覧表示してください。 キーがなければ、`--no-probe` を使って候補者のみをリストします。

スキャン結果は次の基準でランク付けされます。

1. 画像サポート
2. ツールのレイテンシ
3. コンテキストサイズ
4. パラメータ数

入力

- OpenRouter の `/models` リスト（`:free` でフィルタ）
- 認証プロファイル、または `OPENROUTER_API_KEY` からの OpenRouter API キーが必要（[/environment](/help/environment) を参照）
- 任意のフィルタ: `--max-age-days`、`--min-params`、`--provider`、`--max-candidates`
- プローブ制御: `--timeout`、`--concurrency`

TTY で実行した場合、対話的にフォールバックを選択できます。非対話モードでは、`--yes` を指定してデフォルトを受け入れてください。 非対話型
モードでは、 `--yes` を渡してデフォルトを受け入れます。

## モデルレジストリ（`models.json`）

`models.providers` に定義されたカスタムプロバイダーは、エージェントディレクトリ（デフォルトは `~/.openclaw/agents/<agentId>/models.json`）配下の `models.json` に書き込まれます。このファイルは、`models.mode` が `replace` に設定されていない限り、デフォルトでマージされます。 このファイル
は`models.mode`が`replace`に設定されていない限り、デフォルトでマージされます。
