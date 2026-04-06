---
title: "ACP エージェント"
summary: "Codex、Claude Code、Cursor、Gemini CLI、OpenClaw ACP、その他のハーネスエージェント向けの ACP ランタイムセッションを使用する"
read_when:
  - ACP を通じてコーディングハーネスを実行する
  - メッセージングチャンネルで会話バインドの ACP セッションを設定する
  - メッセージチャンネルの会話を永続的な ACP セッションにバインドする
  - ACP バックエンドとプラグイン配線のトラブルシューティング
  - チャットから /acp コマンドを操作する
x-i18n:
    generated_at: "2026-04-03T00:00:00Z"
    model: claude-sonnet-4-6
    provider: anthropic
    source_hash: 30c8ac965c950b891768496cd2cd290bbfa331540c10c2d889724c097f854e49
    source_path: tools/acp-agents.md
    workflow: 15
---

# ACP エージェント

[Agent Client Protocol (ACP)](https://agentclientprotocol.com/) セッションを使用すると、OpenClaw は ACP バックエンドプラグインを通じて外部コーディングハーネス（たとえば Pi、Claude Code、Codex、Cursor、Copilot、OpenClaw ACP、OpenCode、Gemini CLI、その他のサポートされている ACPX ハーネス）を実行できます。

OpenClaw に「これを Codex で実行して」または「スレッドで Claude Code を起動して」と平文で依頼すると、OpenClaw はそのリクエストを ACP ランタイム（ネイティブのサブエージェントランタイムではなく）にルーティングする必要があります。各 ACP セッションのスポーンは[バックグラウンドタスク](/automation/tasks)として追跡されます。

Codex または Claude Code を既存の OpenClaw チャンネル会話に外部 MCP クライアントとして直接接続したい場合は、ACP の代わりに [`openclaw mcp serve`](/cli/mcp) を使用してください。

## 高速オペレーターフロー

実用的な `/acp` ランブックが必要な場合はこちらを使用してください：

1. セッションをスポーン：
   - `/acp spawn codex --bind here`
   - `/acp spawn codex --mode persistent --thread auto`
2. バインドされた会話またはスレッドで作業（またはそのセッションキーを明示的にターゲットに）。
3. ランタイム状態を確認：
   - `/acp status`
4. 必要に応じてランタイムオプションを調整：
   - `/acp model <provider/model>`
   - `/acp permissions <profile>`
   - `/acp timeout <seconds>`
5. コンテキストを置き換えずにアクティブなセッションを誘導：
   - `/acp steer tighten logging and continue`
6. 作業を停止：
   - `/acp cancel`（現在のターンを停止）、または
   - `/acp close`（セッションを閉じてバインドを削除）

## 人間向けクイックスタート

自然なリクエストの例：

- 「この Discord チャンネルを Codex にバインドして。」
- 「ここでスレッドに永続的な Codex セッションを開始して、集中した状態を維持して。」
- 「これをワンショットの Claude Code ACP セッションとして実行して結果をまとめて。」
- 「この iMessage チャットを Codex にバインドして、フォローアップを同じワークスペースに保持して。」

OpenClaw が行うべきこと：

1. `runtime: "acp"` を選択。
2. リクエストされたハーネスターゲット（`agentId`、例：`codex`）を解決。
3. 現在の会話バインドが要求され、アクティブなチャンネルがサポートしている場合、ACP セッションをその会話にバインド。
4. そうでない場合、スレッドバインドが要求され、現在のチャンネルがサポートしている場合、ACP セッションをスレッドにバインド。
5. フォローアップのバインドされたメッセージを、フォーカスが外れる/閉じる/期限切れになるまで同じ ACP セッションにルーティング。

## ACP 対サブエージェント

外部ハーネスランタイムが必要な場合は ACP を使用してください。OpenClaw ネイティブの委任実行が必要な場合はサブエージェントを使用してください。

| 領域          | ACP セッション                          | サブエージェント実行                    |
| ------------- | --------------------------------------- | --------------------------------------- |
| ランタイム    | ACP バックエンドプラグイン（例：acpx）  | OpenClaw ネイティブサブエージェントランタイム |
| セッションキー | `agent:<agentId>:acp:<uuid>`           | `agent:<agentId>:subagent:<uuid>`       |
| メインコマンド | `/acp ...`                             | `/subagents ...`                        |
| スポーンツール | `sessions_spawn` with `runtime:"acp"` | `sessions_spawn`（デフォルトランタイム） |

[サブエージェント](/tools/subagents) も参照してください。

## バインドされたセッション

### 現在の会話バインド

子スレッドを作成せずに現在の会話を永続的な ACP ワークスペースにしたい場合は `/acp spawn <harness> --bind here` を使用してください。

動作：

- OpenClaw はチャンネルトランスポート、認証、安全性、配信を引き続き所有します。
- 現在の会話はスポーンされた ACP セッションキーにピン留めされます。
- その会話のフォローアップメッセージは同じ ACP セッションにルーティングされます。
- `/new` と `/reset` は同じバインドされた ACP セッションをその場でリセットします。
- `/acp close` はセッションを閉じて現在の会話バインドを削除します。

メンタルモデル：

- チャットサーフェス: 人々が引き続き話す場所（`Discord チャンネル`、`Telegram トピック`、`iMessage チャット`）
- ACP セッション: OpenClaw がルーティングする永続的な Codex/Claude/Gemini ランタイム状態
- 子スレッド/トピック: `--thread ...` によってのみ作成されるオプションの追加メッセージングサーフェス
- ランタイムワークスペース: ハーネスが実行されるファイルシステムの場所

### スレッドバインドセッション

スレッドバインドが有効な場合、ACP セッションはスレッドにバインドできます：

- OpenClaw はスレッドをターゲットの ACP セッションにバインドします。
- そのスレッドのフォローアップメッセージはバインドされた ACP セッションにルーティングされます。
- ACP 出力は同じスレッドに配信されます。

スレッドバインド ACP の必要な機能フラグ：

- `acp.enabled=true`
- `acp.dispatch.enabled` はデフォルトでオン（`false` に設定すると ACP ディスパッチを一時停止）
- チャンネルアダプター ACP スレッドスポーンフラグが有効（アダプター固有）
  - Discord: `channels.discord.threadBindings.spawnAcpSessions=true`
  - Telegram: `channels.telegram.threadBindings.spawnAcpSessions=true`

## チャンネル固有の設定

### バインディングモデル

- `bindings[].type="acp"` は永続的な ACP 会話バインドをマークします。
- `bindings[].match` はターゲット会話を識別します：
  - Discord チャンネルまたはスレッド: `match.channel="discord"` + `match.peer.id="<channelOrThreadId>"`
  - Telegram フォーラムトピック: `match.channel="telegram"` + `match.peer.id="<chatId>:topic:<topicId>"`

設定例：

```json5
{
  agents: {
    list: [
      {
        id: "codex",
        runtime: {
          type: "acp",
          acp: {
            agent: "codex",
            backend: "acpx",
            mode: "persistent",
            cwd: "/workspace/openclaw",
          },
        },
      },
    ],
  },
  bindings: [
    {
      type: "acp",
      agentId: "codex",
      match: {
        channel: "discord",
        accountId: "default",
        peer: { kind: "channel", id: "222222222222222222" },
      },
      acp: { label: "codex-main" },
    },
  ],
}
```

## ACP セッションの開始（インターフェース）

### `sessions_spawn` から

エージェントターンまたはツール呼び出しから ACP セッションを開始するには `runtime: "acp"` を使用してください。

```json
{
  "task": "リポジトリを開いて失敗したテストを要約する",
  "runtime": "acp",
  "agentId": "codex",
  "thread": true,
  "mode": "session"
}
```

パラメータ：

- `task`（必須）: ACP セッションに送信される初期プロンプト。
- `runtime`（ACP には必須）: `"acp"` でなければなりません。
- `agentId`（オプション）: ACP ターゲットハーネス ID。
- `thread`（オプション、デフォルト `false`）: サポートされている場合にスレッドバインドフローをリクエスト。
- `mode`（オプション）: `run`（ワンショット）または `session`（永続）。
- `resumeSessionId`（オプション）: 新しいものを作成する代わりに既存の ACP セッションを再開。

### 既存のセッションを再開

`resumeSessionId` を使用して、最初から始める代わりに以前の ACP セッションを継続します：

```json
{
  "task": "続きから始めよう — 残りのテスト失敗を修正して",
  "runtime": "acp",
  "agentId": "codex",
  "resumeSessionId": "<previous-session-id>"
}
```

### `/acp` コマンドから

必要に応じてチャットから明示的なオペレーターコントロールに `/acp spawn` を使用してください。

```text
/acp spawn codex --mode persistent --thread auto
/acp spawn codex --mode oneshot --thread off
/acp spawn codex --bind here
/acp spawn codex --thread here
```

主要なフラグ：

- `--mode persistent|oneshot`
- `--bind here|off`
- `--thread auto|here|off`
- `--cwd <absolute-path>`
- `--label <name>`

[スラッシュコマンド](/tools/slash-commands) を参照してください。

## ACP コントロール

利用可能なコマンドファミリー：

- `/acp spawn`
- `/acp cancel`
- `/acp steer`
- `/acp close`
- `/acp status`
- `/acp set-mode`
- `/acp set`
- `/acp cwd`
- `/acp permissions`
- `/acp timeout`
- `/acp model`
- `/acp reset-options`
- `/acp sessions`
- `/acp doctor`
- `/acp install`

## ACP コマンドクックブック

| コマンド              | 動作                                                      | 例                                                             |
| -------------------- | --------------------------------------------------------- | -------------------------------------------------------------- |
| `/acp spawn`         | ACP セッションを作成；オプションの現在バインドまたはスレッドバインド。 | `/acp spawn codex --bind here --cwd /repo`             |
| `/acp cancel`        | ターゲットセッションの実行中のターンをキャンセル。          | `/acp cancel agent:codex:acp:<uuid>`                           |
| `/acp steer`         | 実行中のセッションにステアリング指示を送信。               | `/acp steer --session support inbox prioritize failing tests`  |
| `/acp close`         | セッションを閉じてスレッドターゲットのバインドを解除。     | `/acp close`                                                   |
| `/acp status`        | バックエンド、モード、状態、ランタイムオプション、機能を表示。 | `/acp status`                                               |
| `/acp model`         | ランタイムモデルオーバーライドを設定。                     | `/acp model anthropic/claude-opus-4-6`                         |

## acpx ハーネスサポート（現在）

現在の acpx 組み込みハーネスエイリアス：

- `claude`、`codex`、`copilot`、`cursor`、`droid`、`gemini`、`iflow`、`kilocode`、`kimi`、`kiro`、`openclaw`、`opencode`、`pi`、`qwen`

## 必要な設定

コア ACP ベースライン：

```json5
{
  acp: {
    enabled: true,
    backend: "acpx",
    defaultAgent: "codex",
    allowedAgents: ["claude", "codex", "copilot", "cursor", "gemini", "pi"],
    maxConcurrentSessions: 8,
  },
}
```

## acpx バックエンドのプラグインセットアップ

インストールとプラグインの有効化：

```bash
openclaw plugins install acpx
openclaw config set plugins.entries.acpx.enabled true
```

その後、バックエンドの健全性を確認：

```text
/acp doctor
```

## 権限設定

ACP セッションは非インタラクティブに実行されます — ファイル書き込みとシェル実行の権限プロンプトを承認または拒否するための TTY がありません。

### `permissionMode`

| 値              | 動作                                                      |
| --------------- | --------------------------------------------------------- |
| `approve-all`   | すべてのファイル書き込みとシェルコマンドを自動承認。      |
| `approve-reads` | 読み取りのみを自動承認；書き込みと実行はプロンプトが必要。 |
| `deny-all`      | すべての権限プロンプトを拒否。                            |

### `nonInteractivePermissions`

| 値     | 動作                                                              |
| ------ | ----------------------------------------------------------------- |
| `fail` | `AcpRuntimeError` でセッションを中断。**（デフォルト）**          |
| `deny` | 権限を静かに拒否して継続（グレースフルデグラデーション）。         |

## トラブルシューティング

| 症状                                                                     | 考えられる原因                                                               | 修正                                                                                                                                   |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACP runtime backend is not configured`                                     | バックエンドプラグインが見つからないか無効。                                  | バックエンドプラグインをインストールして有効にし、`/acp doctor` を実行。                                                                                         |
| `ACP is disabled by policy (acp.enabled=false)`                             | ACP がグローバルに無効。                                                       | `acp.enabled=true` を設定。                                                                                                                                       |
| `ACP agent "<id>" is not allowed by policy`                                 | エージェントが許可リストにない。                                               | 許可された `agentId` を使用するか `acp.allowedAgents` を更新。                                                                                                    |
| `Unable to resolve session target: ...`                                     | 無効なキー/ID/ラベルトークン。                                                  | `/acp sessions` を実行し、正確なキー/ラベルをコピーして再試行。                                                                                                    |
| `Sandboxed sessions cannot spawn ACP sessions ...`                          | ACP ランタイムはホスト側；リクエスターセッションはサンドボックス化されている。  | サンドボックス化されたセッションからは `runtime="subagent"` を使用するか、非サンドボックス化されたセッションから ACP スポーンを実行。                               |
| `AcpRuntimeError: Permission prompt unavailable in non-interactive mode`    | `permissionMode` が非インタラクティブ ACP セッションで書き込み/実行をブロック。  | `plugins.entries.acpx.config.permissionMode` を `approve-all` に設定して Gateway ゲートウェイを再起動。[権限設定](#権限設定) を参照。                              |
