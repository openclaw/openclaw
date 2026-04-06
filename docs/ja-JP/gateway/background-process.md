---
read_when:
    - バックグラウンドexecの動作を追加または変更する場合
    - 長時間実行されるexecタスクのデバッグ
summary: バックグラウンドexec実行とプロセス管理
title: バックグラウンドExecとProcessツール
x-i18n:
    generated_at: "2026-04-02T07:40:50Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 57df5ed2f0552ccffce66339a5bf94e8fa2743e043cfc79a7b53dc044e22bcd2
    source_path: gateway/background-process.md
    workflow: 15
---

# バックグラウンドExec + Processツール

OpenClawは `exec` ツールを通じてシェルコマンドを実行し、長時間実行されるタスクをメモリ内に保持します。`process` ツールがこれらのバックグラウンドセッションを管理します。

## execツール

主要なパラメータ：

- `command`（必須）
- `yieldMs`（デフォルト 10000）：この遅延後に自動的にバックグラウンド化
- `background`（bool）：即座にバックグラウンド化
- `timeout`（秒、デフォルト 1800）：このタイムアウト後にプロセスを強制終了
- `elevated`（bool）：elevatedモードが有効/許可されている場合、ホスト上で実行
- 実際のTTYが必要な場合は `pty: true` を設定してください。
- `workdir`、`env`

動作：

- フォアグラウンド実行は出力を直接返します。
- バックグラウンド化された場合（明示的またはタイムアウトによる）、ツールは `status: "running"` + `sessionId` と短い末尾出力を返します。
- 出力はセッションがポーリングまたはクリアされるまでメモリ内に保持されます。
- `process` ツールが無効化されている場合、`exec` は同期的に実行され、`yieldMs`/`background` を無視します。
- 生成されたexecコマンドはコンテキストに応じたシェル/プロファイルルールのために `OPENCLAW_SHELL=exec` を受け取ります。

## 子プロセスブリッジング

exec/processツール外で長時間実行される子プロセスを生成する場合（例: CLIの再起動やGateway ゲートウェイヘルパー）、子プロセスブリッジヘルパーをアタッチして、終了シグナルが転送され、終了/エラー時にリスナーがデタッチされるようにしてください。これにより、systemd上での孤立プロセスを回避し、プラットフォーム間で一貫したシャットダウン動作を維持できます。

環境変数によるオーバーライド：

- `PI_BASH_YIELD_MS`：デフォルトのyield（ミリ秒）
- `PI_BASH_MAX_OUTPUT_CHARS`：メモリ内出力の上限（文字数）
- `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS`：ストリームごとの保留中stdout/stderrの上限（文字数）
- `PI_BASH_JOB_TTL_MS`：完了したセッションのTTL（ミリ秒、1分〜3時間の範囲内）

設定（推奨）：

- `tools.exec.backgroundMs`（デフォルト 10000）
- `tools.exec.timeoutSec`（デフォルト 1800）
- `tools.exec.cleanupMs`（デフォルト 1800000）
- `tools.exec.notifyOnExit`（デフォルト true）：バックグラウンド化されたexecが終了した際にシステムイベントをキューに入れ、ハートビートをリクエストします。
- `tools.exec.notifyOnExitEmptySuccess`（デフォルト false）：trueの場合、出力のない成功したバックグラウンド実行についても完了イベントをキューに入れます。

## processツール

アクション：

- `list`：実行中 + 完了したセッションの一覧
- `poll`：セッションの新しい出力を取得（終了ステータスも報告）
- `log`：集約された出力を読み取り（`offset` + `limit` をサポート）
- `write`：stdinを送信（`data`、オプションで `eof`）
- `kill`：バックグラウンドセッションを終了
- `clear`：完了したセッションをメモリから削除
- `remove`：実行中の場合はkill、完了している場合はclear

注意事項：

- バックグラウンド化されたセッションのみがメモリ内に一覧/保持されます。
- セッションはプロセス再起動時に失われます（ディスク永続化なし）。
- セッションログは、`process poll/log` を実行してツール結果が記録された場合にのみ、チャット履歴に保存されます。
- `process` はエージェントごとにスコープされており、そのエージェントが開始したセッションのみが表示されます。
- `process list` にはクイックスキャン用の派生 `name`（コマンド動詞 + ターゲット）が含まれます。
- `process log` は行ベースの `offset`/`limit` を使用します。
- `offset` と `limit` の両方が省略された場合、末尾200行を返し、ページングヒントを含みます。
- `offset` が指定され `limit` が省略された場合、`offset` から末尾まで返します（200行に制限されません）。

## 例

長時間タスクを実行し、後でポーリング：

```json
{ "tool": "exec", "command": "sleep 5 && echo done", "yieldMs": 1000 }
```

```json
{ "tool": "process", "action": "poll", "sessionId": "<id>" }
```

即座にバックグラウンドで開始：

```json
{ "tool": "exec", "command": "npm run build", "background": true }
```

stdinを送信：

```json
{ "tool": "process", "action": "write", "sessionId": "<id>", "data": "y\n" }
```
