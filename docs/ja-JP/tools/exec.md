---
summary: "Execツールの使用方法、stdinモード、TTYサポート"
read_when:
  - execツールの使用または変更時
  - stdinまたはTTYの動作のデバッグ時
title: "Execツール"
---

# Execツール

ワークスペースでシェルコマンドを実行します。`process` を通じてフォアグラウンドとバックグラウンド実行をサポートします。
`process` が許可されていない場合、`exec` は同期的に実行され、`yieldMs`/`background` を無視します。
バックグラウンドセッションはエージェントごとにスコープされます。`process` は同じエージェントのセッションのみを参照できます。

## パラメーター

- `command`（必須）
- `workdir`（デフォルト: cwd）
- `env`（キー/バリューオーバーライド）
- `yieldMs`（デフォルト: 10000）: 遅延後の自動バックグラウンド化
- `background`（bool）: 即時バックグラウンド化
- `timeout`（秒、デフォルト: 1800）: 期限切れで強制終了
- `pty`（bool）: 利用可能な場合に擬似ターミナルで実行します（TTY専用CLI、コーディングエージェント、ターミナルUI）
- `host`（`sandbox | gateway | node`）: 実行場所
- `security`（`deny | allowlist | full`）: `gateway`/`node` の適用モード
- `ask`（`off | on-miss | always`）: `gateway`/`node` の承認プロンプト
- `node`（string）: `host=node` のノードID/名前
- `elevated`（bool）: elevatedモードをリクエストします（Gatewayホスト）。`security=full` はelevatedが `full` に解決された場合のみ強制されます

注意事項:

- `host` はデフォルトで `sandbox` です。
- サンドボックス化がオフの場合、`elevated` は無視されます（execはすでにホストで実行されています）。
- `gateway`/`node` の承認は `~/.openclaw/exec-approvals.json` で制御されます。
- `node` にはペアリングされたノード（コンパニオンアプリまたはヘッドレスノードホスト）が必要です。
- 複数のノードが利用可能な場合は、`exec.node` または `tools.exec.node` を設定して選択してください。
- Windows以外のホストでは、`SHELL` が設定されている場合にexecが使用します。`SHELL` が `fish` の場合、fishと非互換なスクリプトを避けるため `PATH` から `bash`（または `sh`）を優先し、どちらも存在しない場合は `SHELL` にフォールバックします。
- Windowsホストでは、execはPowerShell 7（`pwsh`）の検索（Program Files、ProgramW6432、次にPATH）を優先し、Windows PowerShell 5.1にフォールバックします。
- ホスト実行（`gateway`/`node`）は、バイナリのハイジャックやコード注入を防ぐために `env.PATH` とローダーオーバーライド（`LD_*`/`DYLD_*`）を拒否します。
- 重要: サンドボックス化はデフォルトで**オフ**です。サンドボックス化がオフで `host=sandbox` が明示的に設定/リクエストされている場合、execはGatewayホストで静かに実行するのではなく、フェールクローズになります。サンドボックス化を有効にするか、承認付きで `host=gateway` を使用してください。
- スクリプトのプリフライトチェック（一般的なPython/Nodeのシェル構文の誤りに対して）は、実効的な `workdir` 境界内のファイルのみを検査します。スクリプトパスが `workdir` の外に解決される場合、そのファイルのプリフライトはスキップされます。

## 設定

- `tools.exec.notifyOnExit`（デフォルト: true）: trueの場合、バックグラウンド化されたexecセッションは終了時にシステムイベントをエンキューしてハートビートをリクエストします。
- `tools.exec.approvalRunningNoticeMs`（デフォルト: 10000）: 承認ゲートされたexecがこれより長く実行された場合に単一の「実行中」通知を発行します（0で無効化）。
- `tools.exec.host`（デフォルト: `sandbox`）
- `tools.exec.security`（デフォルト: サンドボックスでは `deny`、未設定の場合GatewayとノードでA`allowlist`）
- `tools.exec.ask`（デフォルト: `on-miss`）
- `tools.exec.node`（デフォルト: 未設定）
- `tools.exec.pathPrepend`: execの実行（GatewayとサンドボックスのみA）のために `PATH` の先頭に追加するディレクトリのリスト。
- `tools.exec.safeBins`: 明示的な許可リストエントリなしに実行できるstdin専用のセーフバイナリ。動作の詳細は [セーフbin](/tools/exec-approvals#safe-bins-stdin-only) を参照してください。
- `tools.exec.safeBinTrustedDirs`: `safeBins` パスチェックのための追加の明示的な信頼済みディレクトリ。`PATH` エントリは自動的に信頼されません。組み込みデフォルトは `/bin` と `/usr/bin` です。
- `tools.exec.safeBinProfiles`: セーフbinごとのオプションのカスタムargvポリシー（`minPositional`、`maxPositional`、`allowedValueFlags`、`deniedFlags`）。

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

### PATHの処理

- `host=gateway`: ログインシェルの `PATH` をexec環境にマージします。`env.PATH` オーバーライドはホスト実行で拒否されます。デーモン自体は最小限の `PATH` で実行されます:
  - macOS: `/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`、`/bin`
  - Linux: `/usr/local/bin`、`/usr/bin`、`/bin`
- `host=sandbox`: コンテナ内で `sh -lc`（ログインシェル）を実行するため、`/etc/profile` が `PATH` をリセットする場合があります。OpenClawは内部環境変数を通じてプロファイルソーシング後に `env.PATH` を先頭に追加します（シェル補間なし）。`tools.exec.pathPrepend` もここで適用されます。
- `host=node`: 渡すブロックされていない環境オーバーライドのみがノードに送信されます。`env.PATH` オーバーライドはホスト実行で拒否され、ノードホストに無視されます。ノードに追加のPATHエントリが必要な場合は、ノードホストサービス環境（systemd/launchd）を設定するか、標準の場所にツールをインストールしてください。

エージェントごとのノードバインディング（コンフィグのエージェントリストインデックスを使用）:

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

Control UI: Nodesタブに同じ設定のための小さな「Execノードバインディング」パネルが含まれています。

## セッションオーバーライド（`/exec`）

`/exec` を使用して `host`、`security`、`ask`、`node` の**セッションごとの**デフォルトを設定します。
引数なしで `/exec` を送信すると現在の値が表示されます。

例:

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## 認証モデル

`/exec` は**認証済み送信者**（チャンネル許可リスト/ペアリングおよび `commands.useAccessGroups`）のみが使用できます。
**セッション状態のみを**更新し、コンフィグを書き込みません。execを完全に無効化するには、ツールポリシー（`tools.deny: ["exec"]` またはエージェントごと）で拒否してください。明示的に `security=full` と `ask=off` を設定しない限り、ホスト承認は引き続き適用されます。

## Exec承認（コンパニオンアプリ / ノードホスト）

サンドボックス化されたエージェントは、Gatewayまたはノードホストでexecを実行する前にリクエストごとの承認を要求できます。
ポリシー、許可リスト、UIフローについては [Exec承認](/tools/exec-approvals) を参照してください。

承認が必要な場合、execツールは `status: "approval-pending"` と承認IDとともに即座に返されます。承認（または拒否/タイムアウト）後、GatewayはシステムイベントA（`Exec finished` / `Exec denied`）を発行します。コマンドが `tools.exec.approvalRunningNoticeMs` 後もまだ実行中の場合、単一の `Exec running` 通知が発行されます。

## 許可リストとセーフbin

手動許可リストの適用は**解決済みバイナリパスのみ**に一致します（ベース名マッチなし）。`security=allowlist` の場合、シェルコマンドはすべてのパイプラインセグメントが許可リストに登録されているかセーフbinである場合にのみ自動許可されます。チェーン（`;`、`&&`、`||`）とリダイレクトは、すべてのトップレベルセグメントが許可リストを満たす場合を除き、許可リストモードで拒否されます。リダイレクトは引き続きサポートされません。

`autoAllowSkills` はexec承認の別の便宜パスです。手動パス許可リストエントリと同じではありません。厳格な明示的トラストには `autoAllowSkills` を無効のままにしてください。

2つのコントロールを異なる用途に使用してください:

- `tools.exec.safeBins`: 小さなstdin専用ストリームフィルター。
- `tools.exec.safeBinTrustedDirs`: セーフbin実行ファイルパスの追加の明示的な信頼済みディレクトリ。
- `tools.exec.safeBinProfiles`: カスタムセーフbinの明示的なargvポリシー。
- 許可リスト: 実行ファイルパスの明示的なトラスト。

`safeBins` を汎用許可リストとして扱わないでください。インタープリター/ランタイムバイナリ（例: `python3`、`node`、`ruby`、`bash`）を追加しないでください。これらが必要な場合は、明示的な許可リストエントリを使用して承認プロンプトを有効のままにしてください。
`openclaw security audit` はインタープリター/ランタイムの `safeBins` エントリが明示的なプロファイルなしの場合に警告し、`openclaw doctor --fix` は欠落しているカスタム `safeBinProfiles` エントリをスキャフォールドできます。

完全なポリシーの詳細と例については、[Exec承認](/tools/exec-approvals#safe-bins-stdin-only) と [セーフbin vs 許可リスト](/tools/exec-approvals#safe-bins-versus-allowlist) を参照してください。

## 使用例

フォアグラウンド:

```json
{ "tool": "exec", "command": "ls -la" }
```

バックグラウンド + ポーリング:

```json
{"tool":"exec","command":"npm run build","yieldMs":1000}
{"tool":"process","action":"poll","sessionId":"<id>"}
```

キーの送信（tmuxスタイル）:

```json
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Enter"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["C-c"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Up","Up","Enter"]}
```

送信（CRのみを送信）:

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

貼り付け（デフォルトでブラケット）:

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## apply_patch（実験的）

`apply_patch` は構造化された複数ファイル編集のための `exec` のサブツールです。
明示的に有効化してください:

```json5
{
  tools: {
    exec: {
      applyPatch: { enabled: true, workspaceOnly: true, allowModels: ["gpt-5.2"] },
    },
  },
}
```

注意事項:

- OpenAI/OpenAI Codexモデルのみで利用可能です。
- ツールポリシーは引き続き適用されます。`allow: ["exec"]` は暗黙的に `apply_patch` を許可します。
- 設定は `tools.exec.applyPatch` 下にあります。
- `tools.exec.applyPatch.workspaceOnly` はデフォルトで `true`（ワークスペース内に限定）です。`apply_patch` がワークスペースディレクトリ外への書き込み/削除を意図的に行いたい場合にのみ `false` に設定してください。
