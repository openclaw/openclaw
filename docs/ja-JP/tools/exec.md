---
read_when:
    - execツールを使用または変更する場合
    - stdinまたはTTYの動作をデバッグする場合
summary: Execツールの使い方、stdinモード、TTYサポート
title: Execツール
x-i18n:
    generated_at: "2026-04-02T09:02:48Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 833a0c645b2b4dff112751568d5f78b62e04ae72a004fa5a2646278836f0fb74
    source_path: tools/exec.md
    workflow: 15
---

# Execツール

ワークスペースでシェルコマンドを実行します。`process`を介してフォアグラウンド+バックグラウンド実行をサポートします。
`process`が許可されていない場合、`exec`は同期的に実行され、`yieldMs`/`background`は無視されます。
バックグラウンドセッションはエージェントごとにスコープされます。`process`は同じエージェントからのセッションのみを参照できます。

## パラメータ

- `command`（必須）
- `workdir`（デフォルトはcwd）
- `env`（キー/値のオーバーライド）
- `yieldMs`（デフォルト10000）：遅延後に自動バックグラウンド化
- `background`（bool）：即時バックグラウンド化
- `timeout`（秒、デフォルト1800）：期限切れ時にkill
- `pty`（bool）：利用可能な場合に擬似端末で実行（TTY専用CLI、コーディングエージェント、ターミナルUI）
- `host`（`auto | sandbox | gateway | node`）：実行場所
- `security`（`deny | allowlist | full`）：`gateway`/`node`の適用モード
- `ask`（`off | on-miss | always`）：`gateway`/`node`の承認プロンプト
- `node`（文字列）：`host=node`の場合のノードID/名前
- `elevated`（bool）：昇格モードをリクエスト（Gateway ゲートウェイホスト）；`security=full`はelevatedが`full`に解決される場合にのみ強制されます

注意事項：

- `host`のデフォルトは`auto`：セッションでサンドボックスランタイムがアクティブな場合はサンドボックス、それ以外はGateway ゲートウェイ。
- `elevated`は`host=gateway`を強制します。現在のセッション/プロバイダーで昇格アクセスが有効な場合にのみ利用できます。
- `gateway`/`node`の承認は`~/.openclaw/exec-approvals.json`で制御されます。
- `node`にはペアリングされたノード（コンパニオンアプリまたはヘッドレスノードホスト）が必要です。
- 複数のノードが利用可能な場合は、`exec.node`または`tools.exec.node`で選択してください。
- `exec host=node`はノードの唯一のシェル実行パスです。レガシーの`nodes.run`ラッパーは削除されました。
- Windows以外のホストでは、`SHELL`が設定されている場合にそれを使用します。`SHELL`が`fish`の場合、fish非互換スクリプトを避けるため`PATH`から`bash`（または`sh`）を優先し、どちらも存在しない場合は`SHELL`にフォールバックします。
- Windowsホストでは、PowerShell 7（`pwsh`）のディスカバリー（Program Files、ProgramW6432、次にPATH）を優先し、Windows PowerShell 5.1にフォールバックします。
- ホスト実行（`gateway`/`node`）はバイナリハイジャックやインジェクトされたコードを防ぐため、`env.PATH`とローダーオーバーライド（`LD_*`/`DYLD_*`）を拒否します。
- OpenClawは、スポーンされたコマンド環境（PTYおよびサンドボックス実行を含む）に`OPENCLAW_SHELL=exec`を設定するため、シェル/プロファイルルールでexecツールのコンテキストを検出できます。
- 重要：サンドボックス化は**デフォルトでオフ**です。サンドボックス化がオフの場合、暗黙の`host=auto`は`gateway`に解決されます。明示的な`host=sandbox`は、Gateway ゲートウェイホストでサイレントに実行されるのではなく、クローズドに失敗します。サンドボックス化を有効にするか、承認付きの`host=gateway`を使用してください。
- スクリプトのプリフライトチェック（一般的なPython/Nodeのシェル構文ミスの検出）は、有効な`workdir`境界内のファイルのみを検査します。スクリプトパスが`workdir`の外に解決される場合、そのファイルのプリフライトはスキップされます。

## 設定

- `tools.exec.notifyOnExit`（デフォルト：true）：trueの場合、バックグラウンド化されたexecセッションは終了時にシステムイベントをキューに入れ、ハートビートをリクエストします。
- `tools.exec.approvalRunningNoticeMs`（デフォルト：10000）：承認ゲート付きのexecがこの時間より長く実行された場合に、単一の「running」通知を発行します（0で無効化）。
- `tools.exec.host`（デフォルト：`auto`；サンドボックスランタイムがアクティブな場合は`sandbox`に、それ以外は`gateway`に解決）
- `tools.exec.security`（デフォルト：サンドボックスの場合は`deny`、未設定時のGateway ゲートウェイ+ノードの場合は`allowlist`）
- `tools.exec.ask`（デフォルト：`on-miss`）
- `tools.exec.node`（デフォルト：未設定）
- `tools.exec.strictInlineEval`（デフォルト：false）：trueの場合、`python -c`、`node -e`、`ruby -e`、`perl -e`、`php -r`、`lua -e`、`osascript -e`などのインラインインタープリターeval形式は常に明示的な承認を必要とします。`allow-always`は無害なインタープリター/スクリプトの呼び出しを永続化できますが、インラインeval形式は毎回プロンプトを表示します。
- `tools.exec.pathPrepend`：exec実行時に`PATH`の先頭に追加するディレクトリのリスト（Gateway ゲートウェイ+サンドボックスのみ）。
- `tools.exec.safeBins`：明示的なallowlistエントリなしで実行できるstdin専用の安全なバイナリ。動作の詳細は[Safe bins](/tools/exec-approvals#safe-bins-stdin-only)を参照してください。
- `tools.exec.safeBinTrustedDirs`：`safeBins`のパスチェックで信頼される追加の明示的ディレクトリ。`PATH`エントリは自動的に信頼されません。組み込みデフォルトは`/bin`と`/usr/bin`です。
- `tools.exec.safeBinProfiles`：安全なバイナリごとのオプションのカスタムargvポリシー（`minPositional`、`maxPositional`、`allowedValueFlags`、`deniedFlags`）。

例：

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

- `host=gateway`：ログインシェルの`PATH`をexec環境にマージします。`env.PATH`オーバーライドはホスト実行では拒否されます。デーモン自体は最小限の`PATH`で実行されます：
  - macOS：`/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`、`/bin`
  - Linux：`/usr/local/bin`、`/usr/bin`、`/bin`
- `host=sandbox`：コンテナ内で`sh -lc`（ログインシェル）を実行するため、`/etc/profile`が`PATH`をリセットする場合があります。OpenClawはプロファイルソーシング後に内部環境変数経由で`env.PATH`を先頭に追加します（シェル展開なし）。`tools.exec.pathPrepend`もここで適用されます。
- `host=node`：渡した非ブロックのenvオーバーライドのみがノードに送信されます。`env.PATH`オーバーライドはホスト実行では拒否され、ノードホストでは無視されます。ノードで追加のPATHエントリが必要な場合は、ノードホストのサービス環境（systemd/launchd）を設定するか、標準的な場所にツールをインストールしてください。

エージェントごとのノードバインディング（設定でエージェントリストのインデックスを使用）：

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

コントロールUI：ノードタブには同じ設定用の小さな「Execノードバインディング」パネルがあります。

## セッションオーバーライド（`/exec`）

`/exec`を使用して、`host`、`security`、`ask`、`node`の**セッションごと**のデフォルトを設定します。
引数なしで`/exec`を送信すると、現在の値が表示されます。

例：

```
/exec host=auto security=allowlist ask=on-miss node=mac-1
```

## 認可モデル

`/exec`は**認可された送信者**（チャネルのallowlist/ペアリングおよび`commands.useAccessGroups`）に対してのみ有効です。
**セッション状態のみ**を更新し、設定は書き込みません。execを完全に無効にするには、ツールポリシーで拒否してください（`tools.deny: ["exec"]`またはエージェントごと）。`security=full`と`ask=off`を明示的に設定しない限り、ホスト承認は引き続き適用されます。

## Exec承認（コンパニオンアプリ / ノードホスト）

サンドボックス化されたエージェントは、Gateway ゲートウェイまたはノードホストで`exec`を実行する前にリクエストごとの承認を要求できます。
ポリシー、allowlist、UIフローについては[Exec承認](/tools/exec-approvals)を参照してください。

承認が必要な場合、execツールは`status: "approval-pending"`と承認IDを即座に返します。承認（または拒否/タイムアウト）されると、Gateway ゲートウェイはシステムイベント（`Exec finished` / `Exec denied`）を発行します。コマンドが`tools.exec.approvalRunningNoticeMs`の後もまだ実行中の場合、単一の`Exec running`通知が発行されます。

## Allowlist + safe bins

手動allowlistの適用は**解決済みバイナリパスのみ**に一致します（ベース名の一致はありません）。
`security=allowlist`の場合、シェルコマンドはすべてのパイプラインセグメントがallowlistまたはsafe binに登録されている場合にのみ自動許可されます。チェーン（`;`、`&&`、`||`）とリダイレクトは、すべてのトップレベルセグメントがallowlist（safe binsを含む）を満たさない限り、allowlistモードでは拒否されます。
リダイレクトはサポートされていません。
永続的な`allow-always`の信頼はこのルールをバイパスしません：チェーンされたコマンドでも、すべてのトップレベルセグメントが一致する必要があります。

`autoAllowSkills`はexec承認における別の便利パスです。手動パスallowlistエントリとは同じではありません。厳格な明示的信頼を維持するには、`autoAllowSkills`を無効にしてください。

2つのコントロールを異なる用途に使用してください：

- `tools.exec.safeBins`：小さなstdin専用のストリームフィルター。
- `tools.exec.safeBinTrustedDirs`：safe binの実行パスに対する明示的な追加信頼ディレクトリ。
- `tools.exec.safeBinProfiles`：カスタムsafe binの明示的なargvポリシー。
- allowlist：実行パスに対する明示的な信頼。

`safeBins`を汎用的なallowlistとして扱わないでください。また、インタープリター/ランタイムバイナリ（例：`python3`、`node`、`ruby`、`bash`）を追加しないでください。それらが必要な場合は、明示的なallowlistエントリを使用し、承認プロンプトを有効にしてください。
`openclaw security audit`は、インタープリター/ランタイムの`safeBins`エントリに明示的なプロファイルがない場合に警告し、`openclaw doctor --fix`は不足しているカスタム`safeBinProfiles`エントリをスキャフォールドできます。
`openclaw security audit`と`openclaw doctor`は、`jq`などの広範な動作を持つバイナリを明示的に`safeBins`に追加し直した場合にも警告します。
インタープリターを明示的にallowlistに追加する場合は、`tools.exec.strictInlineEval`を有効にして、インラインコード評価形式が引き続き新しい承認を要求するようにしてください。

ポリシーの詳細と例については、[Exec承認](/tools/exec-approvals#safe-bins-stdin-only)と[Safe bins対allowlist](/tools/exec-approvals#safe-bins-versus-allowlist)を参照してください。

## 例

フォアグラウンド：

```json
{ "tool": "exec", "command": "ls -la" }
```

バックグラウンド+ポーリング：

```json
{"tool":"exec","command":"npm run build","yieldMs":1000}
{"tool":"process","action":"poll","sessionId":"<id>"}
```

キー送信（tmuxスタイル）：

```json
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Enter"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["C-c"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Up","Up","Enter"]}
```

送信（CRのみ送信）：

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

ペースト（デフォルトでブラケット付き）：

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## apply_patch

`apply_patch`は構造化されたマルチファイル編集用の`exec`のサブツールです。
OpenAIおよびOpenAI Codexモデルではデフォルトで有効です。無効にしたい場合や特定のモデルに制限したい場合にのみ設定を使用してください：

```json5
{
  tools: {
    exec: {
      applyPatch: { workspaceOnly: true, allowModels: ["gpt-5.2"] },
    },
  },
}
```

注意事項：

- OpenAI/OpenAI Codexモデルでのみ利用可能です。
- ツールポリシーは引き続き適用されます。`allow: ["write"]`は暗黙的に`apply_patch`を許可します。
- 設定は`tools.exec.applyPatch`の下にあります。
- `tools.exec.applyPatch.enabled`のデフォルトは`true`です。OpenAIモデルでツールを無効にするには`false`に設定してください。
- `tools.exec.applyPatch.workspaceOnly`のデフォルトは`true`（ワークスペース内のみ）です。意図的に`apply_patch`でワークスペースディレクトリ外への書き込み/削除を許可したい場合にのみ`false`に設定してください。

## 関連

- [Exec承認](/tools/exec-approvals) — シェルコマンドの承認ゲート
- [サンドボックス化](/gateway/sandboxing) — サンドボックス化された環境でのコマンド実行
- [バックグラウンドプロセス](/gateway/background-process) — 長時間実行のexecとprocessツール
- [セキュリティ](/gateway/security) — ツールポリシーと昇格アクセス
