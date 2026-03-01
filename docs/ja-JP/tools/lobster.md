---
title: Lobster
summary: "承認ゲートを備えた再開可能な OpenClaw 向け型付きワークフローランタイム。"
description: OpenClaw 向け型付きワークフローランタイム — 承認ゲートを持つコンポーザブルなパイプライン。
read_when:
  - 明示的な承認を持つ決定論的なマルチステップワークフローが必要な場合
  - 以前のステップを再実行せずにワークフローを再開する必要がある場合
---

# Lobster

Lobster は、OpenClaw がマルチステップのツールシーケンスを、明示的な承認チェックポイントを持つ単一の決定論的な操作として実行できるようにするワークフローシェルです。

## フック

アシスタントは自身を管理するツールを構築できます。ワークフローを依頼すると、30 分後には 1 回の呼び出しで実行される CLI とパイプラインが完成します。Lobster はその欠けていたピースです: 決定論的なパイプライン、明示的な承認、そして再開可能なステート。

## なぜ必要か

現在、複雑なワークフローには多くのやり取りのあるツール呼び出しが必要です。各呼び出しはトークンを消費し、LLM がすべてのステップをオーケストレートする必要があります。Lobster はそのオーケストレーションを型付きランタイムに移します:

- **多くの呼び出しの代わりに 1 回**: OpenClaw は 1 回の Lobster ツール呼び出しを実行し、構造化された結果を取得します。
- **承認が組み込まれている**: 副作用（メール送信、コメント投稿）は明示的に承認されるまでワークフローを停止します。
- **再開可能**: 停止したワークフローはトークンを返します。すべてを再実行せずに承認して再開できます。

## なぜプレーンなプログラムではなく DSL なのか

Lobster は意図的に小さく設計されています。目標は「新しい言語」ではなく、ファーストクラスの承認と再開トークンを持つ予測可能で AI フレンドリーなパイプライン仕様です。

- **承認/再開が組み込まれている**: 通常のプログラムは人間に問い合わせることができますが、自分でランタイムを発明しなければ、耐久性のあるトークンで_一時停止して再開_することはできません。
- **決定論性 + 監査可能性**: パイプラインはデータなので、ログ記録、差分比較、リプレイ、レビューが容易です。
- **AI 向けの制約されたサーフェス**: 小さな文法と JSON パイピングにより「創造的な」コードパスが減り、検証が現実的になります。
- **安全ポリシーが組み込まれている**: タイムアウト、出力上限、サンドボックスチェック、アローリストはランタイムによって強制されます。各スクリプトではありません。
- **それでもプログラマブル**: 各ステップは任意の CLI やスクリプトを呼び出せます。JS/TS が必要な場合は、コードから `.lobster` ファイルを生成してください。

## 仕組み

OpenClaw はローカルの `lobster` CLI を**ツールモード**で起動し、stdout から JSON エンベロープを解析します。
パイプラインが承認のために一時停止した場合、ツールは後で続行できるように `resumeToken` を返します。

## パターン: 小さな CLI + JSON パイプ + 承認

JSON を話す小さなコマンドを構築し、それらを単一の Lobster 呼び出しにチェーンします（以下のコマンド名は例です。独自のものに置き換えてください）。

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

パイプラインが承認を要求した場合、トークンで再開します:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

AI がワークフローをトリガーし、Lobster がステップを実行します。承認ゲートにより副作用が明示的かつ監査可能になります。

例: 入力アイテムをツール呼び出しにマッピングする:

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## JSON のみの LLM ステップ（llm-task）

**構造化された LLM ステップ**を必要とするワークフローのために、オプションの
`llm-task` プラグインツールを有効化して Lobster から呼び出します。これにより、
モデルで分類・要約・下書きを行いながらも、ワークフローを決定論的に保つことができます。

ツールの有効化:

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

パイプラインでの使用:

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

詳細と設定オプションについては [LLM Task](/tools/llm-task) を参照してください。

## ワークフローファイル（.lobster）

Lobster は `name`、`args`、`steps`、`env`、`condition`、`approval` フィールドを持つ YAML/JSON ワークフローファイルを実行できます。OpenClaw ツール呼び出しでは、`pipeline` にファイルパスを設定してください。

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

注意事項:

- `stdin: $step.stdout` と `stdin: $step.json` は先のステップの出力を渡します。
- `condition`（または `when`）は `$step.approved` でステップをゲートできます。

## Lobster のインストール

OpenClaw Gateway を実行している**同じホスト**に Lobster CLI をインストールし（[Lobster リポジトリ](https://github.com/openclaw/lobster) を参照）、`lobster` が `PATH` 上にあることを確認してください。

## ツールの有効化

Lobster は**オプション**のプラグインツールです（デフォルトでは無効）。

推奨（追加的、安全）:

```json
{
  "tools": {
    "alsoAllow": ["lobster"]
  }
}
```

またはエージェントごとに:

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

制限的なアローリストモードで実行する意図がない限り、`tools.allow: ["lobster"]` の使用は避けてください。

注: アローリストはオプションプラグインにはオプトインです。アローリストにプラグインツール（`lobster` など）のみが含まれる場合、OpenClaw はコアツールを有効に保ちます。コアツールを制限するには、コアツールまたはグループもアローリストに含めてください。

## 例: メールトリアージ

Lobster なし:

```
ユーザー: "メールを確認して返信の下書きを作成してください"
→ openclaw が gmail.list を呼び出す
→ LLM が要約する
→ ユーザー: "#2 と #5 に返信の下書きを作成してください"
→ LLM が下書きを作成する
→ ユーザー: "#2 を送信してください"
→ openclaw が gmail.send を呼び出す
（毎日繰り返し、トリアージした内容の記憶なし）
```

Lobster あり:

```json
{
  "action": "run",
  "pipeline": "email.triage --limit 20",
  "timeoutMs": 30000
}
```

JSON エンベロープを返します（省略）:

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

1 つのワークフロー。決定論的。安全。

## ツールパラメーター

### `run`

パイプラインをツールモードで実行します。

```json
{
  "action": "run",
  "pipeline": "gog.gmail.search --query 'newer_than:1d' | email.triage",
  "cwd": "workspace",
  "timeoutMs": 30000,
  "maxStdoutBytes": 512000
}
```

引数付きでワークフローファイルを実行:

```json
{
  "action": "run",
  "pipeline": "/path/to/inbox-triage.lobster",
  "argsJson": "{\"tag\":\"family\"}"
}
```

### `resume`

承認後に停止したワークフローを続行します。

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

### オプション入力

- `cwd`: パイプラインの相対作業ディレクトリ（現在のプロセスの作業ディレクトリ内に留まる必要があります）。
- `timeoutMs`: この時間を超えた場合にサブプロセスを強制終了します（デフォルト: 20000）。
- `maxStdoutBytes`: stdout がこのサイズを超えた場合にサブプロセスを強制終了します（デフォルト: 512000）。
- `argsJson`: `lobster run --args-json` に渡される JSON 文字列（ワークフローファイルのみ）。

## 出力エンベロープ

Lobster は 3 つのステータスのいずれかを持つ JSON エンベロープを返します:

- `ok` → 正常に終了
- `needs_approval` → 一時停止中; 再開には `requiresApproval.resumeToken` が必要
- `cancelled` → 明示的に拒否またはキャンセルされた

ツールはエンベロープを `content`（整形済み JSON）と `details`（生のオブジェクト）の両方で提供します。

## 承認

`requiresApproval` が存在する場合、プロンプトを確認して決定します:

- `approve: true` → 再開して副作用を続行
- `approve: false` → キャンセルしてワークフローを終了

カスタムの jq/heredoc グルーなしで承認リクエストに JSON プレビューを添付するには `approve --preview-from-stdin --limit N` を使用してください。再開トークンはコンパクトになりました: Lobster はワークフローの再開ステートをステートディレクトリに保存し、小さなトークンキーを返します。

## OpenProse

OpenProse は Lobster と相性が良いです: `/prose` を使用してマルチエージェントの準備をオーケストレートし、その後 Lobster パイプラインを実行して決定論的な承認を行います。Prose プログラムが Lobster を必要とする場合、`tools.subagents.tools` でサブエージェント向けに `lobster` ツールを許可してください。[OpenProse](/prose) を参照してください。

## 安全性

- **ローカルサブプロセスのみ** — プラグイン自体からのネットワーク呼び出しはありません。
- **シークレットなし** — Lobster は OAuth を管理しません。それを処理する OpenClaw ツールを呼び出します。
- **サンドボックス対応** — ツールコンテキストがサンドボックス化されている場合は無効になります。
- **堅牢化済み** — `PATH` 上の固定実行ファイル名（`lobster`）; タイムアウトと出力上限が強制されます。

## トラブルシューティング

- **`lobster subprocess timed out`** → `timeoutMs` を増やすか、長いパイプラインを分割してください。
- **`lobster output exceeded maxStdoutBytes`** → `maxStdoutBytes` を増やすか、出力サイズを削減してください。
- **`lobster returned invalid JSON`** → パイプラインがツールモードで実行され、JSON のみを出力していることを確認してください。
- **`lobster failed (code …)`** → ターミナルで同じパイプラインを実行して stderr を確認してください。

## 詳細情報

- [プラグイン](/tools/plugin)
- [プラグインツール作成](/plugins/agent-tools)

## ケーススタディ: コミュニティワークフロー

公開の例として、「セカンドブレイン」CLI + Lobster パイプラインが 3 つの Markdown ボルト（個人、パートナー、共有）を管理するものがあります。CLI は統計情報、受信トレイの一覧、陳腐化スキャン向けに JSON を出力します。Lobster はそれらのコマンドを `weekly-review`、`inbox-triage`、`memory-consolidation`、`shared-task-sync` などのワークフローにチェーンし、それぞれに承認ゲートを設けています。AI は可能な場合に判断（分類）を処理し、そうでない場合は決定論的なルールにフォールバックします。

- スレッド: [https://x.com/plattenschieber/status/2014508656335770033](https://x.com/plattenschieber/status/2014508656335770033)
- リポジトリ: [https://github.com/bloomedai/brain-cli](https://github.com/bloomedai/brain-cli)
