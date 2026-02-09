---
title: Lobster
summary: "OpenClaw 向けの型付きワークフローランタイム。再開可能な承認ゲートを備えています。"
description: OpenClaw 向けの型付きワークフローランタイム — 承認ゲートを備えた合成可能なパイプライン。
read_when:
  - 明示的な承認を伴う決定論的なマルチステップワークフローが必要な場合
  - 以前のステップを再実行せずにワークフローを再開する必要がある場合
---

# Lobster

Lobster は、OpenClaw がマルチステップのツールシーケンスを、明示的な承認チェックポイントを備えた単一の決定論的オペレーションとして実行できるようにするワークフローシェルです。

## Hook

アシスタントは自身を管理するツールを構築できます。 ワークフローを要求すると、30 分後には、1 つのコールとして実行される CLI とパイプラインがあります。 ロブスターは欠けている部分である:決定的なパイプライン、明示的な承認、および再開可能な状態。

## Why

今日、複雑なワークフローでは、多くの前後のツールコールが必要となります。 各コールにトークンがかかり、LLMはすべてのステップをオーケストレーションしなければなりません。 ロブスターはオーケストレーションを型付きランタイムに移動します:

- **多数ではなく 1 回の呼び出し**: OpenClaw は 1 回の Lobster ツール呼び出しを実行し、構造化された結果を取得します。
- **承認を内蔵**: 副作用（メール送信、コメント投稿など）は、明示的に承認されるまでワークフローを停止します。
- **再開可能**: 停止したワークフローはトークンを返します。承認後、すべてを再実行せずに再開できます。

## Why a DSL instead of plain programs?

ロブスターは意図的に小さいです。 目標は「新しい言語」ではなく、予測可能なAIに優しいパイプライン仕様であり、ファーストクラスの承認と再開トークンを備えています。

- **承認／再開を内蔵**: 通常のプログラムでも人に確認を促すことはできますが、耐久性のあるトークンで「一時停止と再開」を実現するには、自前でランタイムを発明する必要があります。
- **決定論性 + 監査性**: パイプラインはデータであるため、ログ記録、差分、再生、レビューが容易です。
- **AI 向けに制約された表面**: 小さな文法と JSON パイピングにより、「創造的」なコードパスを減らし、現実的な検証を可能にします。
- **安全ポリシーを組み込み**: タイムアウト、出力上限、サンドボックスチェック、許可リストは、各スクリプトではなくランタイムによって強制されます。
- **まだプログラム可能**: 各ステップは任意の CLI またはスクリプトを呼び出すことができます。 **それでもプログラム可能**: 各ステップは任意の CLI やスクリプトを呼び出せます。JS/TS を使いたい場合は、コードから `.lobster` ファイルを生成してください。

## How it works

OpenClaw は **tool mode** でローカルの `lobster` CLI を起動し、stdout から JSON エンベロープを解析します。
パイプラインが承認待ちで停止した場合、ツールは `resumeToken` を返し、後で続行できます。
パイプラインが承認を一時停止すると、ツールは `resumeToken` を返します。

## Pattern: small CLI + JSON pipes + approvals

JSON を話す小さなコマンドを構築し、それらを 1 回の Lobster 呼び出しにチェーンします。（以下のコマンド名は例です。独自のものに置き換えてください。） (以下のコマンド名の例 — 自分でスワップします。

```bash
inbox list --json
inbox categorize --json
inbox apply --json
```

```json
{
  "action": "run",
  "pipeline": "exec --json --shell 'inbox list --json' | exec --stdin json --shell 'inbox categorize --json' | exec --stdin json --shell 'inbox apply --json' | approve --preview-from-stdin --limit 5 --prompt 'Apply changes?'",
  "timeoutMs": 30000
}
```

パイプラインが承認を要求した場合、トークンで再開します。

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

AIはワークフローをトリガーし、ロブスターはステップを実行します。 承認ゲートは、副作用を明示的かつ監査可能保ちます。

例: 入力アイテムをツール呼び出しにマッピングする場合。

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## JSON-only LLM steps (llm-task)

**構造化された LLM ステップ** が必要なワークフローでは、オプションの
`llm-task` プラグインツールを有効化し、Lobster から呼び出します。これにより、モデルを用いた分類・要約・下書きを行いながら、ワークフローの決定論性を維持できます。 これにより、ワークフロー
を決定的に保ち、モデルで分類/要約/下書きを行うことができます。

ツールを有効化します。

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  },
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "allow": ["llm-task"] }
      }
    ]
  }
}
```

パイプラインで使用します。

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "input": { "subject": "Hello", "body": "Can you help?" },
  "schema": {
    "type": "object",
    "properties": {
      "intent": { "type": "string" },
      "draft": { "type": "string" }
    },
    "required": ["intent", "draft"],
    "additionalProperties": false
  }
}'
```

詳細および設定オプションについては [LLM Task](/tools/llm-task) を参照してください。

## Workflow files (.lobster)

Lobster は、`name`、`args`、`steps`、`env`、`condition`、`approval` フィールドを持つ YAML/JSON のワークフローファイルを実行できます。OpenClaw のツール呼び出しでは、ファイルパスを `pipeline` に設定します。 OpenClawツール呼び出しで、ファイルパスに`pipeline`を設定します。

```yaml
name: inbox-triage
args:
  tag:
    default: "family"
steps:
  - id: collect
    command: inbox list --json
  - id: categorize
    command: inbox categorize --json
    stdin: $collect.stdout
  - id: approve
    command: inbox apply --approve
    stdin: $categorize.stdout
    approval: required
  - id: execute
    command: inbox apply --execute
    stdin: $categorize.stdout
    condition: $approve.approved
```

注記:

- `stdin: $step.stdout` と `stdin: $step.json` は、前のステップの出力を渡します。
- `condition`（または `when`）は、`$step.approved` に基づいてステップをゲートできます。

## Install Lobster

OpenClaw Gateway（ゲートウェイ）を実行している **同一ホスト** に Lobster CLI をインストールし（[Lobster repo](https://github.com/openclaw/lobster) を参照）、`lobster` が `PATH` 上にあることを確認してください。
カスタムのバイナリ位置を使用したい場合は、ツール呼び出しで **絶対パス** の `lobsterPath` を指定します。
カスタムバイナリの場所を使用したい場合は、ツール呼び出しに **absolute** `lobsterPath` を渡してください。

## Enable the tool

Lobster は **オプション** のプラグインツールです（デフォルトでは有効ではありません）。

推奨（追加的で安全）:

```json
{
  "tools": {
    "alsoAllow": ["lobster"]
  }
}
```

またはエージェント単位で設定します。

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "alsoAllow": ["lobster"]
        }
      }
    ]
  }
}
```

制限的な許可リストモードで実行する意図がない限り、`tools.allow: ["lobster"]` の使用は避けてください。

注意: 許容リストはオプションのプラグインのオプトインです。 注記: 許可リストはオプションプラグインに対してオプトインです。許可リストに
`lobster` のようなプラグインツールのみを指定した場合、OpenClaw はコアツールを有効のままにします。コアツールを制限したい場合は、許可したいコアツールやグループも許可リストに含めてください。 コア
ツールを制限するには、許容リストにもコアツールまたはグループを含めてください。

## Example: Email triage

Lobster を使わない場合:

```
User: "Check my email and draft replies"
→ openclaw calls gmail.list
→ LLM summarizes
→ User: "draft replies to #2 and #5"
→ LLM drafts
→ User: "send #2"
→ openclaw calls gmail.send
(repeat daily, no memory of what was triaged)
```

Lobster を使う場合:

```json
{
  "action": "run",
  "pipeline": "email.triage --limit 20",
  "timeoutMs": 30000
}
```

JSON エンベロープが返されます（抜粋）:

```json
{
  "ok": true,
  "status": "needs_approval",
  "output": [{ "summary": "5 need replies, 2 need action" }],
  "requiresApproval": {
    "type": "approval_request",
    "prompt": "Send 2 draft replies?",
    "items": [],
    "resumeToken": "..."
  }
}
```

ユーザーが承認 → 再開:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

1つのワークフロー 確固たるものです 金庫。

## Tool parameters

### `run`

tool mode でパイプラインを実行します。

```json
{
  "action": "run",
  "pipeline": "gog.gmail.search --query 'newer_than:1d' | email.triage",
  "cwd": "/path/to/workspace",
  "timeoutMs": 30000,
  "maxStdoutBytes": 512000
}
```

引数付きでワークフローファイルを実行します。

```json
{
  "action": "run",
  "pipeline": "/path/to/inbox-triage.lobster",
  "argsJson": "{\"tag\":\"family\"}"
}
```

### `resume`

承認後に停止したワークフローを継続します。

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

### Optional inputs

- `lobsterPath`: Lobster バイナリへの絶対パス（省略時は `PATH` を使用）。
- `cwd`: パイプラインの作業ディレクトリ（デフォルトは現在のプロセスの作業ディレクトリ）。
- `timeoutMs`: この時間を超えた場合にサブプロセスを強制終了します（デフォルト: 20000）。
- `maxStdoutBytes`: stdout がこのサイズを超えた場合にサブプロセスを強制終了します（デフォルト: 512000）。
- `argsJson`: `lobster run --args-json` に渡される JSON 文字列（ワークフローファイルのみ）。

## Output envelope

Lobster は、次の 3 つのステータスのいずれかを持つ JSON エンベロープを返します。

- `ok` → 正常に完了
- `needs_approval` → 一時停止中。再開には `requiresApproval.resumeToken` が必要
- `cancelled` → 明示的に拒否、またはキャンセル

ツールは、エンベロープを `content`（整形された JSON）と `details`（生オブジェクト）の両方で公開します。

## Approvals

`requiresApproval` が存在する場合、プロンプトを確認して判断します。

- `approve: true` → 再開し、副作用を続行
- `approve: false` → キャンセルしてワークフローを確定

`approve --preview-from-stdin --limit N` を使用すると、カスタムの jq や heredoc のグルーコードなしで、承認リクエストに JSON プレビューを添付できます。再開トークンはコンパクトになりました。Lobster はワークフローの再開状態を自身の state ディレクトリに保存し、小さなトークンキーを返します。 トークンを再開するには: ロブスターはワークフローの再開状態を状態ディレクトリの下に保存し、小さなトークンキーを返します。

## OpenProse

OpenProse は Lobster と相性が良好です。`/prose` を使ってマルチエージェントの準備をオーケストレーションし、その後、決定論的な承認のために Lobster パイプラインを実行します。Prose プログラムが Lobster を必要とする場合は、`tools.subagents.tools` を介してサブエージェントに `lobster` ツールを許可してください。[OpenProse](/prose) を参照してください。 Proseプログラムにロブスターが必要な場合は、`tools.subagents.tools` を介してサブエージェント用の `lobster` ツールを許可します。 [OpenProse](/prose) を参照してください。

## Safety

- **ローカルサブプロセスのみ** — プラグイン自体からのネットワーク呼び出しはありません。
- **シークレットなし** — Lobster は OAuth を管理しません。OAuth を扱う OpenClaw ツールを呼び出します。
- **サンドボックス認識** — ツールコンテキストがサンドボックス化されている場合は無効化されます。
- **堅牢化** — 指定する場合、`lobsterPath` は絶対パスでなければなりません。タイムアウトと出力上限が強制されます。

## Troubleshooting

- **`lobster subprocess timed out`** → `timeoutMs` を増やすか、長いパイプラインを分割してください。
- **`lobster output exceeded maxStdoutBytes`** → `maxStdoutBytes` を引き上げるか、出力サイズを削減してください。
- **`lobster returned invalid JSON`** → パイプラインが tool mode で実行され、JSON のみを出力していることを確認してください。
- **`lobster failed (code …)`** → 同じパイプラインをターミナルで実行し、stderr を確認してください。

## Learn more

- [Plugins](/tools/plugin)
- [Plugin tool authoring](/plugins/agent-tools)

## Case study: community workflows

1つの公開例: 「セカンドブレイン」CLIとロブスターパイプライン。マークダウンの3つの保管庫(個人、パートナー、共有)を管理します。 公開されている例の 1 つは、「第二の脳」CLI と Lobster パイプラインで、3 つの Markdown ボールト（個人、パートナー、共有）を管理するものです。CLI は統計、受信箱一覧、陳腐化スキャン用の JSON を出力し、Lobster はそれらのコマンドを `weekly-review`、`inbox-triage`、`memory-consolidation`、`shared-task-sync` といったワークフローにチェーンします。それぞれに承認ゲートがあり、AI が利用可能な場合は判断（分類）を担当し、利用できない場合は決定論的ルールにフォールバックします。 AIは、利用可能な場合に判断(分類)を処理し、そうでない場合には決定的なルールに戻ります。

- スレッド: [https://x.com/plattenschieber/status/2014508656335770033](https://x.com/plattenschieber/status/2014508656335770033)
- リポジトリ: [https://github.com/bloomedai/brain-cli](https://github.com/bloomedai/brain-cli)
