---
summary: "バックグラウンド exec の実行とプロセス管理"
read_when:
  - バックグラウンド exec の動作を追加または変更する場合
  - 長時間実行される exec タスクをデバッグする場合
title: "バックグラウンド Exec とプロセスツール"
---

# バックグラウンド Exec + プロセスツール

OpenClaw は `exec` ツールを通じてシェルコマンドを実行し、長時間実行されるタスクをメモリ内に保持します。`process` ツールは、これらのバックグラウンドセッションを管理します。 `process` ツールはこれらのバックグラウンドセッションを管理します。

## exec ツール

主なパラメーター:

- `command`（必須）
- `yieldMs`（デフォルト 10000）: この遅延後に自動でバックグラウンド化します
- `background`（bool）: 即座にバックグラウンド化します
- `timeout`（秒、デフォルト 1800）: このタイムアウト後にプロセスを終了します
- `elevated`（bool）: 特権モードが有効／許可されている場合にホスト上で実行します
- 実際の TTY が必要ですか？ `pty: true` を設定してください。 実 TTY が必要な場合は `pty: true` を設定します。
- `workdir`、`env`

挙動:

- フォアグラウンド実行は出力を直接返します。
- バックグラウンド化された場合（明示的、またはタイムアウト時）、ツールは `status: "running"` + `sessionId` と短い末尾出力を返します。
- 出力は、セッションがポーリングされるかクリアされるまでメモリ内に保持されます。
- `process` ツールが許可されていない場合、`exec` は同期的に実行され、`yieldMs`/`background` は無視されます。

## 子プロセスのブリッジ

exec／process ツール外で長時間実行される子プロセスを生成する場合（例: CLI の再スポーンやゲートウェイヘルパー）、子プロセスブリッジヘルパーをアタッチして、終了シグナルが転送され、終了／エラー時にリスナーがデタッチされるようにしてください。これにより systemd 上での孤立したプロセスを防ぎ、プラットフォーム間で一貫したシャットダウン挙動を維持できます。 これにより、systemd 上で孤立したプロセスが回避され、プラットフォーム間でシャットダウンの動作が一貫しています。

環境変数による上書き:

- `PI_BASH_YIELD_MS`: 既定の yield（ms）
- `PI_BASH_MAX_OUTPUT_CHARS`: メモリ内出力の上限（文字数）
- `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS`: ストリームごとの保留 stdout/stderr の上限（文字数）
- `PI_BASH_JOB_TTL_MS`: 完了済みセッションの TTL（ms、1 分～ 3 時間に制限）

設定（推奨）:

- `tools.exec.backgroundMs`（デフォルト 10000）
- `tools.exec.timeoutSec`（デフォルト 1800）
- `tools.exec.cleanupMs`（デフォルト 1800000）
- `tools.exec.notifyOnExit`（デフォルト true）: バックグラウンド化された exec が終了した際に、システムイベントをキューに入れ、リクエストのハートビートを送信します。

## process ツール

アクション:

- `list`: 実行中および完了済みのセッション
- `poll`: セッションの新しい出力をドレインします（終了ステータスも報告）
- `log`: 集約された出力を読み取ります（`offset` + `limit` をサポート）
- `write`: stdin を送信します（`data`、任意で `eof`）
- `kill`: バックグラウンドセッションを終了します
- `clear`: 完了済みセッションをメモリから削除します
- `remove`: 実行中であれば kill、完了済みであればクリアします

注記:

- バックグラウンド化されたセッションのみが一覧表示され、メモリ内に保持されます。
- プロセスの再起動時にセッションは失われます（ディスクへの永続化はありません）。
- セッションログは、`process poll/log` を実行し、ツール結果が記録された場合にのみ、チャット履歴へ保存されます。
- `process` はエージェント単位でスコープされており、そのエージェントが開始したセッションのみを参照します。
- `process list` には、簡易確認用として派生した `name`（コマンド動詞 + 対象）が含まれます。
- `process log` は行ベースの `offset`/`limit` を使用します（`offset` を省略すると直近 N 行を取得します）。

## 例

長時間タスクを実行し、後でポーリングする場合:

```json
{ "tool": "exec", "command": "sleep 5 && echo done", "yieldMs": 1000 }
```

```json
{ "tool": "process", "action": "poll", "sessionId": "<id>" }
```

即座にバックグラウンドで開始する場合:

```json
{ "tool": "exec", "command": "npm run build", "background": true }
```

stdin を送信する場合:

```json
{ "tool": "process", "action": "write", "sessionId": "<id>", "data": "y\n" }
```
