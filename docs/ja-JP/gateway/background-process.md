---
summary: "バックグラウンドexec実行とプロセス管理"
read_when:
  - Adding or modifying background exec behavior
  - Debugging long-running exec tasks
title: "バックグラウンドExecとプロセスツール"
---

# バックグラウンドExec + プロセスツール

OpenClawは`exec`ツールを通じてシェルコマンドを実行し、長時間実行タスクをメモリに保持します。`process`ツールはこれらのバックグラウンドセッションを管理します。

## execツール

主要パラメータ：

- `command`（必須）
- `yieldMs`（デフォルト10000）：この遅延後に自動バックグラウンド化
- `background`（bool）：即座にバックグラウンド化
- `timeout`（秒、デフォルト1800）：このタイムアウト後にプロセスを終了
- `elevated`（bool）：昇格モードが有効/許可されている場合にホストで実行
- 実際のTTYが必要な場合は`pty: true`を設定してください。
- `workdir`、`env`

動作：

- フォアグラウンド実行は出力を直接返します。
- バックグラウンド化された場合（明示的またはタイムアウト）、ツールは`status: "running"` + `sessionId`と短い末尾部分を返します。
- 出力はセッションがポーリングまたはクリアされるまでメモリに保持されます。
- `process`ツールが許可されていない場合、`exec`は同期的に実行され、`yieldMs`/`background`を無視します。

## 子プロセスブリッジング

exec/processツールの外部で長時間実行の子プロセスを生成する場合（例：CLIの再生成やGatewayヘルパー）、子プロセスブリッジヘルパーをアタッチして、終了シグナルが転送され、終了/エラー時にリスナーがデタッチされるようにします。これにより、systemd上の孤立プロセスを回避し、プラットフォーム間でシャットダウン動作を一貫させます。

環境変数オーバーライド：

- `PI_BASH_YIELD_MS`：デフォルトyield（ms）
- `PI_BASH_MAX_OUTPUT_CHARS`：メモリ内出力上限（文字数）
- `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS`：ストリームごとの保留中stdout/stderr上限（文字数）
- `PI_BASH_JOB_TTL_MS`：完了セッションのTTL（ms、1分〜3時間に制限）

設定（推奨）：

- `tools.exec.backgroundMs`（デフォルト10000）
- `tools.exec.timeoutSec`（デフォルト1800）
- `tools.exec.cleanupMs`（デフォルト1800000）
- `tools.exec.notifyOnExit`（デフォルトtrue）：バックグラウンドexecが終了したときにシステムイベントをキューに入れ、ハートビートを要求します。
- `tools.exec.notifyOnExitEmptySuccess`（デフォルトfalse）：trueの場合、出力がなかった成功したバックグラウンド実行の完了イベントもキューに入れます。

## processツール

アクション：

- `list`：実行中 + 完了したセッション
- `poll`：セッションの新しい出力を取得（終了ステータスも報告）
- `log`：集約された出力を読み取り（`offset` + `limit`をサポート）
- `write`：stdinを送信（`data`、オプションの`eof`）
- `kill`：バックグラウンドセッションを終了
- `clear`：完了したセッションをメモリから削除
- `remove`：実行中の場合はkill、完了している場合はclear

注意：

- バックグラウンド化されたセッションのみがメモリにリスト/保持されます。
- セッションはプロセス再起動時に失われます（ディスク永続化なし）。
- セッションログは`process poll/log`を実行し、ツール結果が記録された場合にのみチャット履歴に保存されます。
- `process`はエージェントごとにスコープされ、そのエージェントが開始したセッションのみが表示されます。
- `process list`にはクイックスキャン用の派生`name`（コマンド動詞 + ターゲット）が含まれます。
- `process log`は行ベースの`offset`/`limit`を使用します。
- `offset`と`limit`の両方が省略された場合、最後の200行を返し、ページングヒントを含みます。
- `offset`が指定され`limit`が省略された場合、`offset`から最後まで返します（200行に制限されません）。

## 例

長時間タスクを実行して後でポーリング：

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
