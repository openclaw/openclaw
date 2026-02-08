---
summary: "サブエージェント: 要求元のチャットに結果を通知する、分離されたエージェント実行の生成"
read_when:
  - エージェントによるバックグラウンド／並列作業が必要な場合
  - sessions_spawn または sub-agent のツールポリシーを変更する場合
title: "サブエージェント"
x-i18n:
  source_path: tools/subagents.md
  source_hash: 3c83eeed69a65dbb
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:23:45Z
---

# サブエージェント

サブエージェントは、既存のエージェント実行から生成されるバックグラウンドのエージェント実行です。独自のセッション（`agent:<agentId>:subagent:<uuid>`）で実行され、完了すると要求元のチャットチャンネルに結果を**通知**します。

## スラッシュコマンド

**現在のセッション**に対するサブエージェント実行を確認または制御するには、`/subagents` を使用します。

- `/subagents list`
- `/subagents stop <id|#|all>`
- `/subagents log <id|#> [limit] [tools]`
- `/subagents info <id|#>`
- `/subagents send <id|#> <message>`

`/subagents info` は、実行メタデータ（ステータス、タイムスタンプ、セッション ID、トランスクリプトのパス、クリーンアップ）を表示します。

主な目的:

- メイン実行をブロックせずに「調査／長時間タスク／低速ツール」の作業を並列化すること。
- 既定でサブエージェントを分離すること（セッション分離 + 任意のサンドボックス化）。
- ツールの利用面を誤用しにくく保つこと。サブエージェントは既定でセッションツールを**取得しません**。
- 入れ子のファンアウトを回避すること。サブエージェントはサブエージェントを生成できません。

コストに関する注意: 各サブエージェントは**独自**のコンテキストとトークン使用量を持ちます。負荷が高い、または反復的なタスクでは、サブエージェントに安価なモデルを設定し、メインエージェントは高品質なモデルのままにしてください。これは `agents.defaults.subagents.model` またはエージェントごとのオーバーライドで設定できます。

## ツール

`sessions_spawn` を使用します。

- サブエージェント実行を開始します（`deliver: false`、グローバルレーン: `subagent`）。
- その後、アナウンス手順を実行し、要求元のチャットチャンネルにアナウンス返信を投稿します。
- 既定のモデル: 呼び出し元を継承します。ただし `agents.defaults.subagents.model`（またはエージェントごとの `agents.list[].subagents.model`）を設定した場合はそちらが使用されます。明示的な `sessions_spawn.model` がある場合はそれが優先されます。
- 既定の思考レベル: 呼び出し元を継承します。ただし `agents.defaults.subagents.thinking`（またはエージェントごとの `agents.list[].subagents.thinking`）を設定した場合はそちらが使用されます。明示的な `sessions_spawn.thinking` がある場合はそれが優先されます。

ツールパラメータ:

- `task`（必須）
- `label?`（任意）
- `agentId?`（任意。許可されている場合、別のエージェント ID の配下で生成します）
- `model?`（任意。サブエージェントのモデルを上書きします。無効な値はスキップされ、警告がツール結果に含まれたうえで既定モデルで実行されます）
- `thinking?`（任意。サブエージェント実行の思考レベルを上書きします）
- `runTimeoutSeconds?`（既定 `0`。設定すると N 秒後にサブエージェント実行が中止されます）
- `cleanup?`（`delete|keep`、既定 `keep`）

許可リスト:

- `agents.list[].subagents.allowAgents`: `agentId` で指定可能なエージェント ID の一覧（`["*"]` で任意を許可）。既定: 要求元エージェントのみ。

検出:

- `agents_list` を使用して、現在 `sessions_spawn` に許可されているエージェント ID を確認します。

自動アーカイブ:

- サブエージェントのセッションは `agents.defaults.subagents.archiveAfterMinutes` 後に自動的にアーカイブされます（既定: 60）。
- アーカイブでは `sessions.delete` を使用し、トランスクリプトを `*.deleted.<timestamp>` にリネームします（同一フォルダ）。
- `cleanup: "delete"` は、アナウンス直後に即時アーカイブします（リネームによりトランスクリプトは保持されます）。
- 自動アーカイブはベストエフォートです。ゲートウェイが再起動すると、保留中のタイマーは失われます。
- `runTimeoutSeconds` は自動アーカイブしません。実行を停止するのみです。セッションは自動アーカイブまで残ります。

## 認証

サブエージェントの認証は、セッション種別ではなく**エージェント ID** により解決されます。

- サブエージェントのセッションキーは `agent:<agentId>:subagent:<uuid>` です。
- 認証ストアは、そのエージェントの `agentDir` から読み込まれます。
- メインエージェントの認証プロファイルは**フォールバック**としてマージされます。競合時はエージェントのプロファイルが優先されます。

注記: マージは加算的であるため、メインのプロファイルは常にフォールバックとして利用可能です。エージェントごとに完全に分離された認証は、現時点では未対応です。

## アナウンス

サブエージェントはアナウンス手順を通じて結果を報告します。

- アナウンス手順はサブエージェントのセッション内で実行されます（要求元セッションではありません）。
- サブエージェントが正確に `ANNOUNCE_SKIP` と返信した場合、何も投稿されません。
- それ以外の場合、アナウンス返信はフォローアップの `agent` 呼び出し（`deliver=true`）により、要求元のチャットチャンネルに投稿されます。
- 利用可能な場合、アナウンス返信はスレッド／トピックのルーティングを保持します（Slack スレッド、Telegram トピック、Matrix スレッド）。
- アナウンスメッセージは安定したテンプレートに正規化されます。
  - 実行結果（`success`、`error`、`timeout`、または `unknown`）から導出される `Status:`。
  - アナウンス手順の要約内容である `Result:`（欠落時は `(not available)`）。
  - エラー詳細およびその他の有用なコンテキストである `Notes:`。
- `Status` はモデル出力から推論されません。実行時の結果シグナルに基づきます。

アナウンスペイロードには、（ラップされている場合でも）末尾に統計行が含まれます。

- 実行時間（例: `runtime 5m12s`）
- トークン使用量（入力／出力／合計）
- モデルの価格設定が構成されている場合の推定コスト（`models.providers.*.models[].cost`）
- `sessionKey`、`sessionId`、およびトランスクリプトのパス（メインエージェントが `sessions_history` を介して履歴を取得したり、ディスク上のファイルを確認したりできるようにするため）

## ツールポリシー（サブエージェントのツール）

既定では、サブエージェントは**セッションツールを除くすべてのツール**を取得します。

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

設定で上書きします。

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxConcurrent: 1,
      },
    },
  },
  tools: {
    subagents: {
      tools: {
        // deny wins
        deny: ["gateway", "cron"],
        // if allow is set, it becomes allow-only (deny still wins)
        // allow: ["read", "exec", "process"]
      },
    },
  },
}
```

## 同時実行

サブエージェントは専用のインプロセスキューレーンを使用します。

- レーン名: `subagent`
- 同時実行数: `agents.defaults.subagents.maxConcurrent`（既定 `8`）

## 停止

- 要求元のチャットに `/stop` を送信すると、要求元セッションが中止され、そこから生成されたアクティブなサブエージェント実行も停止します。

## 制限事項

- サブエージェントのアナウンスは**ベストエフォート**です。ゲートウェイが再起動すると、保留中の「通知して戻す」作業は失われます。
- サブエージェントは同一のゲートウェイプロセスのリソースを共有します。`maxConcurrent` は安全弁として扱ってください。
- `sessions_spawn` は常にノンブロッキングです。即座に `{ status: "accepted", runId, childSessionKey }` を返します。
- サブエージェントのコンテキストには `AGENTS.md` と `TOOLS.md` のみが注入されます（`SOUL.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md`、または `BOOTSTRAP.md` は含まれません）。
