---
read_when:
    - 明示的な承認を伴う決定論的なマルチステップワークフローが必要な場合
    - 以前のステップを再実行せずにワークフローを再開する必要がある場合
summary: 再開可能な承認ゲートを備えた OpenClaw の型付きワークフローランタイム。
title: Lobster
x-i18n:
    generated_at: "2026-04-02T07:56:58Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 737ecd26d21e1fe92f7a23fc92b71187ca1df702e3076bd614414f0f2c893b4f
    source_path: tools/lobster.md
    workflow: 15
---

# Lobster

Lobster は、OpenClaw がマルチステップのツールシーケンスを、明示的な承認チェックポイントを備えた単一の決定論的操作として実行できるようにするワークフローシェルである。

Lobster は、デタッチされたバックグラウンド作業の上位にある1つのオーサリングレイヤーである。古い `ClawFlow` という用語を見かけた場合は、同じタスク指向ランタイム領域に関する歴史的な命名として扱うこと。現在のオペレーター向け CLI サーフェスは [`openclaw tasks`](/automation/tasks) である。

## フック

アシスタントは自分自身を管理するツールを構築できる。ワークフローを依頼すると、30分後には CLI とパイプラインが1回の呼び出しで実行される。Lobster はその欠けていたピースである：決定論的パイプライン、明示的な承認、再開可能な状態。

## なぜ Lobster か

現在、複雑なワークフローには多くのやり取りを伴うツール呼び出しが必要である。各呼び出しにはトークンがかかり、LLM がすべてのステップをオーケストレーションしなければならない。Lobster はそのオーケストレーションを型付きランタイムに移す：

- **多数の呼び出しの代わりに1回の呼び出し**: OpenClaw は1回の Lobster ツール呼び出しを実行し、構造化された結果を得る。
- **承認が組み込み済み**: 副作用（メール送信、コメント投稿）は明示的に承認されるまでワークフローを停止する。
- **再開可能**: 停止したワークフローはトークンを返し、すべてを再実行せずに承認して再開できる。

## なぜ通常のプログラムではなく DSL なのか？

Lobster は意図的に小さい。目標は「新しい言語」ではなく、ファーストクラスの承認と再開トークンを備えた予測可能で AI フレンドリーなパイプライン仕様である。

- **承認/再開が組み込み済み**: 通常のプログラムは人間にプロンプトを表示できるが、自分でそのランタイムを発明しない限り、永続的なトークンで_一時停止して再開する_ことはできない。
- **決定論性 + 監査可能性**: パイプラインはデータであるため、ログ記録、差分比較、リプレイ、レビューが容易である。
- **AI 向けの制約されたサーフェス**: 小さな文法 + JSON パイプラインにより「創造的な」コードパスが減り、バリデーションが現実的になる。
- **安全ポリシーが組み込み済み**: タイムアウト、出力上限、サンドボックスチェック、許可リストはランタイムによって強制され、各スクリプトに委ねられない。
- **それでもプログラマブル**: 各ステップは任意の CLI やスクリプトを呼び出せる。JS/TS を使いたい場合は、コードから `.lobster` ファイルを生成できる。

## 仕組み

OpenClaw はローカルの `lobster` CLI を**ツールモード**で起動し、stdout から JSON エンベロープをパースする。
パイプラインが承認のために一時停止した場合、ツールは `resumeToken` を返し、後で続行できるようにする。

## パターン: 小さな CLI + JSON パイプ + 承認

JSON を出力する小さなコマンドを構築し、それらを1回の Lobster 呼び出しにチェーンする。（以下のコマンド名は例 — 自分のものに置き換えること。）

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

パイプラインが承認を要求した場合、トークンで再開する：

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

AI がワークフローをトリガーし、Lobster がステップを実行する。承認ゲートにより副作用が明示的かつ監査可能になる。

例: 入力アイテムをツール呼び出しにマッピングする：

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## JSON のみの LLM ステップ (llm-task)

**構造化された LLM ステップ**が必要なワークフローの場合、オプションの
`llm-task` プラグインツールを有効にして Lobster から呼び出す。これによりワークフローの
決定論性を保ちながら、モデルを使った分類/要約/ドラフト作成が可能になる。

ツールを有効にする：

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

パイプラインで使用する：

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "thinking": "low",
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

詳細と設定オプションについては [LLM Task](/tools/llm-task) を参照。

## ワークフローファイル (.lobster)

Lobster は `name`、`args`、`steps`、`env`、`condition`、`approval` フィールドを持つ YAML/JSON ワークフローファイルを実行できる。OpenClaw のツール呼び出しでは、`pipeline` にファイルパスを設定する。

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

注意事項：

- `stdin: $step.stdout` と `stdin: $step.json` は前のステップの出力を渡す。
- `condition`（または `when`）は `$step.approved` でステップをゲートできる。

## Lobster のインストール

OpenClaw Gateway ゲートウェイを実行しているのと**同じホスト**に Lobster CLI をインストールし（[Lobster リポジトリ](https://github.com/openclaw/lobster)を参照）、`lobster` が `PATH` に含まれていることを確認する。

## ツールの有効化

Lobster は**オプション**のプラグインツールである（デフォルトでは有効化されていない）。

推奨（追加的、安全）：

```json
{
  "tools": {
    "alsoAllow": ["lobster"]
  }
}
```

またはエージェントごとに設定：

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

制限的な許可リストモードで実行する意図がない限り、`tools.allow: ["lobster"]` の使用は避けること。

注意: 許可リストはオプションプラグインに対してオプトインである。許可リストに
プラグインツール（`lobster` など）のみが含まれている場合、OpenClaw はコアツールを有効のままにする。コアツールを制限するには、許可リストに必要なコアツールまたはグループも含めること。

## 例: メールトリアージ

Lobster なしの場合：

```
ユーザー: 「メールをチェックして返信のドラフトを作って」
→ openclaw が gmail.list を呼び出す
→ LLM が要約する
→ ユーザー: 「#2 と #5 に返信のドラフトを作って」
→ LLM がドラフトを作成する
→ ユーザー: 「#2 を送信して」
→ openclaw が gmail.send を呼び出す
（毎日繰り返し、トリアージした内容の記憶なし）
```

Lobster ありの場合：

```json
{
  "action": "run",
  "pipeline": "email.triage --limit 20",
  "timeoutMs": 30000
}
```

JSON エンベロープを返す（省略）：

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

ユーザーが承認 → 再開：

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

1つのワークフロー。決定論的。安全。

## ツールパラメータ

### `run`

パイプラインをツールモードで実行する。

```json
{
  "action": "run",
  "pipeline": "gog.gmail.search --query 'newer_than:1d' | email.triage",
  "cwd": "workspace",
  "timeoutMs": 30000,
  "maxStdoutBytes": 512000
}
```

引数付きでワークフローファイルを実行する：

```json
{
  "action": "run",
  "pipeline": "/path/to/inbox-triage.lobster",
  "argsJson": "{\"tag\":\"family\"}"
}
```

### `resume`

承認後に停止したワークフローを続行する。

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

### オプションの入力

- `cwd`: パイプラインの相対作業ディレクトリ（現在のプロセスの作業ディレクトリ内に収まる必要がある）。
- `timeoutMs`: この時間を超えた場合にサブプロセスを強制終了する（デフォルト: 20000）。
- `maxStdoutBytes`: stdout がこのサイズを超えた場合にサブプロセスを強制終了する（デフォルト: 512000）。
- `argsJson`: `lobster run --args-json` に渡される JSON 文字列（ワークフローファイルのみ）。

## 出力エンベロープ

Lobster は3つのステータスのいずれかを持つ JSON エンベロープを返す：

- `ok` → 正常に完了
- `needs_approval` → 一時停止中。再開には `requiresApproval.resumeToken` が必要
- `cancelled` → 明示的に拒否またはキャンセル

ツールはエンベロープを `content`（整形された JSON）と `details`（生のオブジェクト）の両方で公開する。

## 承認

`requiresApproval` が存在する場合、プロンプトを確認して判断する：

- `approve: true` → 再開して副作用を続行する
- `approve: false` → キャンセルしてワークフローを終了する

`approve --preview-from-stdin --limit N` を使用すると、カスタムの jq/heredoc グルーなしで承認リクエストに JSON プレビューを添付できる。再開トークンはコンパクトになった：Lobster はワークフローの再開状態をステートディレクトリに保存し、小さなトークンキーを返す。

## OpenProse

OpenProse は Lobster とよく組み合わせられる：`/prose` を使ってマルチエージェントの準備をオーケストレーションし、次に決定論的な承認のために Lobster パイプラインを実行する。Prose プログラムが Lobster を必要とする場合、`tools.subagents.tools` を介してサブエージェントに `lobster` ツールを許可する。[OpenProse](/prose) を参照。

## 安全性

- **ローカルサブプロセスのみ** — プラグイン自体からのネットワーク呼び出しはない。
- **シークレットなし** — Lobster は OAuth を管理しない。OAuth を管理する OpenClaw ツールを呼び出す。
- **サンドボックス対応** — ツールコンテキストがサンドボックス化されている場合は無効になる。
- **堅牢化済み** — `PATH` 上の固定実行可能ファイル名（`lobster`）。タイムアウトと出力上限が強制される。

## トラブルシューティング

- **`lobster subprocess timed out`** → `timeoutMs` を増やすか、長いパイプラインを分割する。
- **`lobster output exceeded maxStdoutBytes`** → `maxStdoutBytes` を引き上げるか、出力サイズを削減する。
- **`lobster returned invalid JSON`** → パイプラインがツールモードで実行され、JSON のみを出力していることを確認する。
- **`lobster failed (code …)`** → ターミナルで同じパイプラインを実行して stderr を確認する。

## 詳細情報

- [プラグイン](/tools/plugin)
- [プラグインツールのオーサリング](/plugins/building-plugins#registering-agent-tools)

## ケーススタディ: コミュニティワークフロー

公開されている一例：3つの Markdown ボールト（個人、パートナー、共有）を管理する「セカンドブレイン」CLI + Lobster パイプライン。CLI は統計、受信リスト、古い項目のスキャンのために JSON を出力し、Lobster はそれらのコマンドを `weekly-review`、`inbox-triage`、`memory-consolidation`、`shared-task-sync` などのワークフローにチェーンし、それぞれ承認ゲートを備えている。AI が利用可能な場合は判断（分類）を処理し、利用できない場合は決定論的ルールにフォールバックする。

- スレッド: [https://x.com/plattenschieber/status/2014508656335770033](https://x.com/plattenschieber/status/2014508656335770033)
- リポジトリ: [https://github.com/bloomedai/brain-cli](https://github.com/bloomedai/brain-cli)

## 関連項目

- [Cron vs Heartbeat](/automation/cron-vs-heartbeat) — Lobster ワークフローのスケジューリング
- [自動化の概要](/automation) — すべての自動化メカニズム
- [ツールの概要](/tools) — 利用可能なすべてのエージェントツール
