---
summary: "Exec ツールの使用方法、stdin モード、および TTY サポート"
read_when:
  - Exec ツールを使用または変更する場合
  - stdin または TTY の挙動をデバッグする場合
title: "Exec ツール"
x-i18n:
  source_path: tools/exec.md
  source_hash: 3b32238dd8dce93d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:23:41Z
---

# Exec ツール

ワークスペースでシェルコマンドを実行します。 `process` により、フォアグラウンドおよびバックグラウンド実行をサポートします。
`process` が許可されていない場合、 `exec` は同期的に実行され、 `yieldMs` / `background` は無視されます。
バックグラウンドセッションはエージェント単位でスコープされます。 `process` は同一エージェントのセッションのみを表示します。

## Parameters

- `command`（必須）
- `workdir`（デフォルトは cwd）
- `env`（キー / 値のオーバーライド）
- `yieldMs`（デフォルト 10000）：遅延後に自動でバックグラウンド化
- `background`（bool）：即時にバックグラウンド化
- `timeout`（秒、デフォルト 1800）：期限到達時に終了
- `pty`（bool）：利用可能な場合は疑似端末で実行（TTY 専用 CLI、コーディングエージェント、ターミナル UI）
- `host`（`sandbox | gateway | node`）：実行場所
- `security`（`deny | allowlist | full`）： `gateway` / `node` の強制モード
- `ask`（`off | on-miss | always`）： `gateway` / `node` の承認プロンプト
- `node`（string）： `host=node` 用のノード id / 名称
- `elevated`（bool）：昇格モード（Gateway ホスト）を要求。 `security=full` は、昇格が `full` に解決される場合にのみ強制されます

注記:

- `host` のデフォルトは `sandbox` です。
- サンドボックス化が無効な場合、 `elevated` は無視されます（exec はすでにホスト上で実行されます）。
- `gateway` / `node` の承認は `~/.openclaw/exec-approvals.json` により制御されます。
- `node` には、ペアリングされたノード（コンパニオンアプリまたはヘッドレスノードホスト）が必要です。
- 複数のノードが利用可能な場合、 `exec.node` または `tools.exec.node` を設定して 1 つを選択します。
- Windows 以外のホストでは、設定されている場合 exec は `SHELL` を使用します。 `SHELL` が `fish` の場合、 fish 非互換スクリプトを避けるため、 `PATH` から `bash`（または `sh`）を優先し、どちらも存在しない場合は `SHELL` にフォールバックします。
- ホスト実行（`gateway` / `node`）では、バイナリのハイジャックや注入コードを防ぐため、 `env.PATH` およびローダーのオーバーライド（`LD_*` / `DYLD_*`）を拒否します。
- 重要: サンドボックス化は **デフォルトで無効** です。サンドボックス化が無効な場合、 `host=sandbox` は
  Gateway ホスト上で直接（コンテナなし）実行され、 **承認は不要** です。承認を必須にするには、
  `host=gateway` で実行し、 exec の実行承認を設定する（またはサンドボックス化を有効にする）必要があります。

## Config

- `tools.exec.notifyOnExit`（デフォルト: true）： true の場合、バックグラウンド化された exec セッションはシステムイベントをキューに入れ、終了時にハートビートを要求します。
- `tools.exec.approvalRunningNoticeMs`（デフォルト: 10000）：承認ゲート付き exec がこれを超えて実行された場合に、単一の「実行中」通知を発行します（0 で無効）。
- `tools.exec.host`（デフォルト: `sandbox`）
- `tools.exec.security`（デフォルト: サンドボックスでは `deny`、未設定時の Gateway + ノードでは `allowlist`）
- `tools.exec.ask`（デフォルト: `on-miss`）
- `tools.exec.node`（デフォルト: 未設定）
- `tools.exec.pathPrepend`： exec 実行時に `PATH` の先頭に追加するディレクトリの一覧。
- `tools.exec.safeBins`：明示的な許可リストのエントリがなくても実行できる、 stdin 専用の安全なバイナリ。

例:

```json5
{
  tools: {
    exec: {
      pathPrepend: ["~/bin", "/opt/oss/bin"],
    },
  },
}
```

### PATH の取り扱い

- `host=gateway`：ログインシェルの `PATH` を exec 環境にマージします。ホスト実行では `env.PATH` のオーバーライドは拒否されます。デーモン自体は引き続き最小限の `PATH` で実行されます:
  - macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
  - Linux: `/usr/local/bin`, `/usr/bin`, `/bin`
- `host=sandbox`：コンテナ内で `sh -lc`（ログインシェル）を実行するため、 `/etc/profile` により `PATH` がリセットされる場合があります。
  OpenClaw は、内部の env 変数（シェル展開なし）を介してプロファイル読み込み後に `env.PATH` を先頭に追加します。
  `tools.exec.pathPrepend` もここに適用されます。
- `host=node`：渡した非ブロックの環境変数オーバーライドのみがノードに送信されます。ホスト実行では `env.PATH` のオーバーライドは拒否されます。ヘッドレスノードホストは、ノードホストの PATH を先頭に追加する場合にのみ `PATH` を受け入れます（置換は不可）。 macOS ノードでは `PATH` のオーバーライドは完全に破棄されます。

エージェントごとのノードバインディング（config のエージェント一覧インデックスを使用）:

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

コントロール UI: Nodes タブには、同じ設定のための小さな「Exec ノードバインディング」パネルがあります。

## セッションオーバーライド（`/exec`）

`/exec` を使用して、 `host`、 `security`、 `ask`、および `node` の **セッション単位** のデフォルトを設定します。
引数なしで `/exec` を送信すると、現在の値が表示されます。

例:

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## 認可モデル

`/exec` は **許可された送信者**（チャンネルの許可リスト / ペアリングおよび `commands.useAccessGroups`）に対してのみ有効です。
これは **セッション状態のみ** を更新し、設定は書き込みません。 exec を完全に無効化するには、
ツールポリシー（`tools.deny: ["exec"]` またはエージェント単位）で拒否してください。 `security=full` と `ask=off` を明示的に設定しない限り、
ホスト承認は引き続き適用されます。

## Exec の実行承認（コンパニオンアプリ / ノードホスト）

サンドボックス化されたエージェントでは、 `exec` が Gateway またはノードホスト上で実行される前に、リクエストごとの承認を必須にできます。
ポリシー、許可リスト、および UI フローについては [Exec approvals](/tools/exec-approvals) を参照してください。

承認が必要な場合、 exec ツールは直ちに `status: "approval-pending"` と承認 id を返します。承認（または拒否 / タイムアウト）後、
Gateway はシステムイベント（`Exec finished` / `Exec denied`）を送出します。コマンドが
`tools.exec.approvalRunningNoticeMs` を超えても実行中の場合、単一の `Exec running` 通知が送出されます。

## 許可リスト + 安全なバイナリ

許可リストの強制は **解決済みのバイナリパスのみ** に一致します（ベース名一致は不可）。
`security=allowlist` の場合、シェルコマンドは、パイプラインの各セグメントが許可リストに含まれるか安全なバイナリである場合にのみ自動許可されます。
連結（`;`、 `&&`、 `||`）およびリダイレクトは、許可リストモードでは拒否されます。

## 例

フォアグラウンド:

```json
{ "tool": "exec", "command": "ls -la" }
```

バックグラウンド + ポーリング:

```json
{"tool":"exec","command":"npm run build","yieldMs":1000}
{"tool":"process","action":"poll","sessionId":"<id>"}
```

キー送信（tmux 形式）:

```json
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Enter"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["C-c"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Up","Up","Enter"]}
```

送信（CR のみ送信）:

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

貼り付け（デフォルトではブラケット付き）:

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## apply_patch（実験的）

`apply_patch` は、構造化された複数ファイル編集のための `exec` のサブツールです。
明示的に有効化してください:

```json5
{
  tools: {
    exec: {
      applyPatch: { enabled: true, allowModels: ["gpt-5.2"] },
    },
  },
}
```

注記:

- OpenAI / OpenAI Codex モデルでのみ利用可能です。
- ツールポリシーは引き続き適用されます。 `allow: ["exec"]` は暗黙的に `apply_patch` を許可します。
- 設定は `tools.exec.applyPatch` 配下にあります。
