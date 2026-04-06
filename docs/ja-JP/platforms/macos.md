---
read_when:
    - macOSアプリの機能を実装する場合
    - macOSでの Gateway ゲートウェイのライフサイクルやノードブリッジングを変更する場合
summary: OpenClaw macOSコンパニオンアプリ（メニューバー + Gateway ゲートウェイブローカー）
title: macOSアプリ
x-i18n:
    generated_at: "2026-04-02T08:35:01Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 0f52b9872ee54cedc2bb7ae735162d26d1a6f04c5c36233499677c09a7e99f1a
    source_path: platforms/macos.md
    workflow: 15
---

# OpenClaw macOSコンパニオン（メニューバー + Gateway ゲートウェイブローカー）

macOSアプリはOpenClawの**メニューバーコンパニオン**です。権限を管理し、
Gateway ゲートウェイをローカルで管理・接続し（launchdまたは手動）、macOSの
機能をノードとしてエージェントに公開します。

## 機能概要

- メニューバーにネイティブ通知とステータスを表示します。
- TCCプロンプト（通知、アクセシビリティ、画面収録、マイク、
  音声認識、オートメーション/AppleScript）を管理します。
- Gateway ゲートウェイに接続または起動します（ローカルまたはリモート）。
- macOS専用ツール（Canvas、カメラ、画面収録、`system.run`）を公開します。
- **リモート**モードではローカルノードホストサービスを起動し（launchd）、**ローカル**モードでは停止します。
- オプションでUI自動化のための**PeekabooBridge**をホストします。
- リクエストに応じてnpm/pnpm経由でグローバルCLI（`openclaw`）をインストールします（Gateway ゲートウェイランタイムにはbunは推奨されません）。

## ローカルモードとリモートモード

- **ローカル**（デフォルト）: アプリは実行中のローカル Gateway ゲートウェイがあればそれに接続し、
  なければ`openclaw gateway install`でlaunchdサービスを有効にします。
- **リモート**: アプリはSSH/Tailscale経由で Gateway ゲートウェイに接続し、ローカルプロセスは起動しません。
  アプリはローカル**ノードホストサービス**を起動し、リモート Gateway ゲートウェイがこのMacに到達できるようにします。
  アプリは Gateway ゲートウェイを子プロセスとして起動しません。
  Gateway ゲートウェイのディスカバリーは生のtailnet IPよりもTailscale MagicDNS名を優先するようになったため、
  tailnet IPが変更された際のMacアプリの回復がより安定しています。

## launchd制御

アプリは`ai.openclaw.gateway`というラベルのユーザー単位のLaunchAgentを管理します
（`--profile`/`OPENCLAW_PROFILE`使用時は`ai.openclaw.<profile>`、レガシーの`com.openclaw.*`も引き続きアンロードされます）。

```bash
launchctl kickstart -k gui/$UID/ai.openclaw.gateway
launchctl bootout gui/$UID/ai.openclaw.gateway
```

名前付きプロファイルを実行する場合は、ラベルを`ai.openclaw.<profile>`に置き換えてください。

LaunchAgentがインストールされていない場合は、アプリから有効にするか、
`openclaw gateway install`を実行してください。

## ノード機能（mac）

macOSアプリはノードとして自身を提示します。一般的なコマンド:

- Canvas: `canvas.present`、`canvas.navigate`、`canvas.eval`、`canvas.snapshot`、`canvas.a2ui.*`
- カメラ: `camera.snap`、`camera.clip`
- 画面: `screen.record`
- システム: `system.run`、`system.notify`

ノードは`permissions`マップを報告し、エージェントが許可されている操作を判断できるようにします。

ノードサービス + アプリIPC:

- ヘッドレスノードホストサービスが実行中（リモートモード）の場合、Gateway ゲートウェイWSにノードとして接続します。
- `system.run`はmacOSアプリ内（UI/TCCコンテキスト）でローカルUnixソケット経由で実行されます。プロンプトと出力はアプリ内に留まります。

ダイアグラム（SCI）:

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + TCC + system.run)
```

## 実行承認（system.run）

`system.run`はmacOSアプリの**実行承認**（設定 → 実行承認）で制御されます。
セキュリティ + 確認 + 許可リストはMac上のローカルに保存されます:

```
~/.openclaw/exec-approvals.json
```

例:

```json
{
  "version": 1,
  "defaults": {
    "security": "deny",
    "ask": "on-miss"
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [{ "pattern": "/opt/homebrew/bin/rg" }]
    }
  }
}
```

注意:

- `allowlist`エントリは解決済みバイナリパスのglobパターンです。
- シェル制御や展開構文（`&&`、`||`、`;`、`|`、`` ` ``、`$`、`<`、`>`、`(`、`)`）を含む生のシェルコマンドテキストは許可リストミスとして扱われ、明示的な承認（またはシェルバイナリの許可リスト登録）が必要です。
- プロンプトで「Always Allow」を選択すると、そのコマンドが許可リストに追加されます。
- `system.run`の環境変数オーバーライドはフィルタリングされ（`PATH`、`DYLD_*`、`LD_*`、`NODE_OPTIONS`、`PYTHON*`、`PERL*`、`RUBYOPT`、`SHELLOPTS`、`PS4`を除外）、その後アプリの環境とマージされます。
- シェルラッパー（`bash|sh|zsh ... -c/-lc`）の場合、リクエストスコープの環境変数オーバーライドは小さな明示的許可リスト（`TERM`、`LANG`、`LC_*`、`COLORTERM`、`NO_COLOR`、`FORCE_COLOR`）に縮小されます。
- 許可リストモードでの常時許可の決定では、既知のディスパッチラッパー（`env`、`nice`、`nohup`、`stdbuf`、`timeout`）はラッパーパスではなく内部の実行可能ファイルパスを永続化します。アンラップが安全でない場合、許可リストエントリは自動的に永続化されません。

## ディープリンク

アプリはローカルアクション用に`openclaw://`URLスキームを登録します。

### `openclaw://agent`

Gateway ゲートウェイの`agent`リクエストをトリガーします。

```bash
open 'openclaw://agent?message=Hello%20from%20deep%20link'
```

クエリパラメータ:

- `message`（必須）
- `sessionKey`（オプション）
- `thinking`（オプション）
- `deliver` / `to` / `channel`（オプション）
- `timeoutSeconds`（オプション）
- `key`（オプション、無人モードキー）

安全性:

- `key`なしの場合、アプリは確認プロンプトを表示します。
- `key`なしの場合、アプリは確認プロンプトに短いメッセージ制限を適用し、`deliver` / `to` / `channel`を無視します。
- 有効な`key`がある場合、実行は無人で行われます（個人用オートメーション向け）。

## オンボーディングフロー（一般的な手順）

1. **OpenClaw.app**をインストールして起動します。
2. 権限チェックリストを完了します（TCCプロンプト）。
3. **ローカル**モードがアクティブで Gateway ゲートウェイが実行中であることを確認します。
4. ターミナルアクセスが必要な場合はCLIをインストールします。

## 状態ディレクトリの配置（macOS）

OpenClawの状態ディレクトリをiCloudやその他のクラウド同期フォルダに配置しないでください。
同期対象のパスはレイテンシを増加させ、セッションや認証情報のファイルロック/同期競合を
引き起こすことがあります。

ローカルの非同期状態パスを推奨します:

```bash
OPENCLAW_STATE_DIR=~/.openclaw
```

`openclaw doctor`が以下のパス配下の状態を検出した場合:

- `~/Library/Mobile Documents/com~apple~CloudDocs/...`
- `~/Library/CloudStorage/...`

警告を表示し、ローカルパスへの移動を推奨します。

## ビルド＆開発ワークフロー（ネイティブ）

- `cd apps/macos && swift build`
- `swift run OpenClaw`（またはXcode）
- アプリのパッケージ化: `scripts/package-mac-app.sh`

## Gateway ゲートウェイ接続のデバッグ（macOS CLI）

デバッグCLIを使用して、macOSアプリと同じ Gateway ゲートウェイWebSocketハンドシェイクおよびディスカバリー
ロジックをアプリを起動せずに実行できます。

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

接続オプション:

- `--url <ws://host:port>`: 設定をオーバーライド
- `--mode <local|remote>`: 設定から解決（デフォルト: 設定値またはlocal）
- `--probe`: ヘルスプローブを強制実行
- `--timeout <ms>`: リクエストタイムアウト（デフォルト: `15000`）
- `--json`: diff用の構造化出力

ディスカバリーオプション:

- `--include-local`:「ローカル」としてフィルタリングされる Gateway ゲートウェイを含める
- `--timeout <ms>`: 全体のディスカバリーウィンドウ（デフォルト: `2000`）
- `--json`: diff用の構造化出力

ヒント: `openclaw gateway discover --json`と比較して、macOSアプリのディスカバリーパイプライン
（NWBrowser + tailnet DNS‑SDフォールバック）がNode CLIの`dns-sd`ベースのディスカバリーと
異なるかどうかを確認してください。

## リモート接続の仕組み（SSHトンネル）

macOSアプリが**リモート**モードで動作する場合、SSHトンネルを開いてローカルUI
コンポーネントがリモート Gateway ゲートウェイをlocalhostのように通信できるようにします。

### 制御トンネル（Gateway ゲートウェイWebSocketポート）

- **用途:** ヘルスチェック、ステータス、Web Chat、設定、その他のコントロールプレーン呼び出し。
- **ローカルポート:** Gateway ゲートウェイポート（デフォルト`18789`）、常に固定。
- **リモートポート:** リモートホスト上の同じ Gateway ゲートウェイポート。
- **動作:** ランダムなローカルポートは使用しません。アプリは既存の正常なトンネルを再利用するか、
  必要に応じて再起動します。
- **SSHの形式:** `ssh -N -L <local>:127.0.0.1:<remote>` にBatchMode +
  ExitOnForwardFailure + キープアライブオプション付き。
- **IPレポート:** SSHトンネルはループバックを使用するため、Gateway ゲートウェイからはノード
  IPが`127.0.0.1`として表示されます。実際のクライアントIPを表示したい場合は
  **Direct (ws/wss)**トランスポートを使用してください（[macOSリモートアクセス](/platforms/mac/remote)を参照）。

セットアップ手順については、[macOSリモートアクセス](/platforms/mac/remote)を参照してください。プロトコルの
詳細については、[Gateway ゲートウェイプロトコル](/gateway/protocol)を参照してください。

## 関連ドキュメント

- [Gateway ゲートウェイランブック](/gateway)
- [Gateway ゲートウェイ（macOS）](/platforms/mac/bundled-gateway)
- [macOS権限](/platforms/mac/permissions)
- [Canvas](/platforms/mac/canvas)
