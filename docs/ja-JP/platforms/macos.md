---
summary: "OpenClaw macOS コンパニオンアプリ（メニューバー + Gateway ブローカー）"
read_when:
  - macOS アプリの機能を実装する
  - macOS での Gateway ライフサイクルやノードブリッジングを変更する
title: "macOS アプリ"
---

# OpenClaw macOS コンパニオン（メニューバー + Gateway ブローカー）

macOS アプリは OpenClaw の**メニューバーコンパニオン**です。パーミッションを管理し、
Gateway をローカルで管理/接続し（launchd または手動）、macOS の機能を
ノードとしてエージェントに公開します。

## 機能

- メニューバーにネイティブ通知とステータスを表示します。
- TCC プロンプトを管理します（通知、アクセシビリティ、スクリーンレコーディング、マイク、
  音声認識、Automation/AppleScript）。
- Gateway に接続します（ローカルまたはリモート）。
- macOS 専用ツールを公開します（Canvas、カメラ、スクリーンレコーディング、`system.run`）。
- **リモート**モードではローカルノードホストサービスを起動し（launchd）、**ローカル**モードでは停止します。
- オプションで UI 自動化のための **PeekabooBridge** をホストします。
- リクエストに応じて npm/pnpm 経由でグローバル CLI（`openclaw`）をインストールします（bun は Gateway ランタイムには推奨されません）。

## ローカル vs リモートモード

- **ローカル**（デフォルト）：ローカルで実行中の Gateway が存在すれば接続します。
  存在しない場合は `openclaw gateway install` で launchd サービスを有効にします。
- **リモート**：SSH/Tailscale 経由で Gateway に接続し、ローカルプロセスを
  起動しません。
  リモート Gateway がこの Mac に到達できるよう、ローカルの**ノードホストサービス**を起動します。
  アプリは Gateway を子プロセスとして生成しません。

## Launchd 制御

アプリはユーザーごとの LaunchAgent `ai.openclaw.gateway` を管理します
（`--profile`/`OPENCLAW_PROFILE` 使用時は `ai.openclaw.<profile>`。レガシーの `com.openclaw.*` はアンロードされます）。

```bash
launchctl kickstart -k gui/$UID/ai.openclaw.gateway
launchctl bootout gui/$UID/ai.openclaw.gateway
```

名前付きプロファイルを使用する場合はラベルを `ai.openclaw.<profile>` に置き換えてください。

LaunchAgent がインストールされていない場合は、アプリから有効にするか、
`openclaw gateway install` を実行してください。

## ノード機能（mac）

macOS アプリはノードとして自身を提示します。主なコマンド：

- Canvas：`canvas.present`、`canvas.navigate`、`canvas.eval`、`canvas.snapshot`、`canvas.a2ui.*`
- カメラ：`camera.snap`、`camera.clip`
- スクリーン：`screen.record`
- システム：`system.run`、`system.notify`

ノードは `permissions` マップを報告し、エージェントが許可内容を判断できるようにします。

ノードサービス + アプリ IPC：

- ヘッドレスノードホストサービスが実行中の場合（リモートモード）、Gateway WS にノードとして接続します。
- `system.run` は macOS アプリ（UI/TCC コンテキスト）内でローカル Unix ソケット経由で実行されます。プロンプトと出力はアプリ内に留まります。

ダイアグラム（SCI）：

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + TCC + system.run)
```

## 実行承認（system.run）

`system.run` は macOS アプリの**実行承認**で制御されます（設定 → 実行承認）。
セキュリティ + ask + 許可リストは Mac 上のローカルに保存されます：

```
~/.openclaw/exec-approvals.json
```

例：

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

注意：

- `allowlist` エントリは、解決されたバイナリパスの glob パターンです。
- シェル制御や展開構文（`&&`、`||`、`;`、`|`、`` ` ``、`$`、`<`、`>`、`(`、`)`）を含む生のシェルコマンドテキストは許可リストのミスとして扱われ、明示的な承認が必要です（またはシェルバイナリを許可リストに追加してください）。
- プロンプトで「常に許可」を選択すると、そのコマンドが許可リストに追加されます。
- `system.run` の環境変数のオーバーライドはフィルタリングされ（`PATH`、`DYLD_*`、`LD_*`、`NODE_OPTIONS`、`PYTHON*`、`PERL*`、`RUBYOPT`、`SHELLOPTS`、`PS4` を除外）、アプリの環境変数とマージされます。
- シェルラッパー（`bash|sh|zsh ... -c/-lc`）の場合、リクエストスコープの環境変数オーバーライドは小さな明示的許可リスト（`TERM`、`LANG`、`LC_*`、`COLORTERM`、`NO_COLOR`、`FORCE_COLOR`）に制限されます。
- 許可リストモードでの常時許可の判断において、既知のディスパッチラッパー（`env`、`nice`、`nohup`、`stdbuf`、`timeout`）はラッパーパスの代わりに内部の実行可能ファイルパスを永続化します。アンラッピングが安全でない場合、許可リストエントリは自動的に永続化されません。

## ディープリンク

アプリはローカルアクション用に `openclaw://` URL スキームを登録しています。

### `openclaw://agent`

Gateway の `agent` リクエストをトリガーします。

```bash
open 'openclaw://agent?message=Hello%20from%20deep%20link'
```

クエリパラメーター：

- `message`（必須）
- `sessionKey`（オプション）
- `thinking`（オプション）
- `deliver` / `to` / `channel`（オプション）
- `timeoutSeconds`（オプション）
- `key`（オプション、無人モードキー）

安全性：

- `key` なしの場合、アプリは確認を求めます。
- `key` なしの場合、アプリは確認プロンプトに短いメッセージ長の制限を適用し、`deliver` / `to` / `channel` を無視します。
- 有効な `key` がある場合、実行は無人で行われます（個人的な自動化を想定）。

## オンボーディングフロー（一般的な手順）

1. **OpenClaw.app** をインストールして起動します。
2. パーミッションチェックリスト（TCC プロンプト）を完了します。
3. **ローカル**モードがアクティブで Gateway が実行中であることを確認します。
4. ターミナルアクセスが必要な場合は CLI をインストールします。

## ビルド & 開発ワークフロー（ネイティブ）

- `cd apps/macos && swift build`
- `swift run OpenClaw`（または Xcode）
- アプリのパッケージ化：`scripts/package-mac-app.sh`

## Gateway 接続のデバッグ（macOS CLI）

デバッグ CLI を使用して、macOS アプリが使用するのと同じ Gateway WebSocket ハンドシェイクと
検出ロジックをアプリを起動せずに実行できます。

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

接続オプション：

- `--url <ws://host:port>`：設定をオーバーライド
- `--mode <local|remote>`：設定から解決（デフォルト：config または local）
- `--probe`：新しいヘルスプローブを強制
- `--timeout <ms>`：リクエストタイムアウト（デフォルト：`15000`）
- `--json`：差分比較用の構造化出力

検出オプション：

- `--include-local`：「ローカル」としてフィルタリングされる Gateway を含める
- `--timeout <ms>`：全体の検出ウィンドウ（デフォルト：`2000`）
- `--json`：差分比較用の構造化出力

ヒント：`openclaw gateway discover --json` と比較して、macOS アプリの検出パイプライン
（NWBrowser + tailnet DNS-SD フォールバック）が Node CLI の `dns-sd` ベースの検出と
異なるかどうかを確認してください。

## リモート接続の仕組み（SSH トンネル）

macOS アプリが**リモート**モードで実行される場合、SSH トンネルを開いてローカル UI
コンポーネントがリモート Gateway と localhost 上にあるかのように通信できるようにします。

### コントロールトンネル（Gateway WebSocket ポート）

- **目的：** ヘルスチェック、ステータス、Web Chat、設定、その他のコントロールプレーン呼び出し。
- **ローカルポート：** Gateway ポート（デフォルト `18789`）、常に安定。
- **リモートポート：** リモートホスト上の同じ Gateway ポート。
- **動作：** ランダムなローカルポートなし。アプリは既存の正常なトンネルを再利用するか、
  必要に応じて再起動します。
- **SSH 形式：** `ssh -N -L <local>:127.0.0.1:<remote>` に BatchMode +
  ExitOnForwardFailure + keepalive オプション。
- **IP レポート：** SSH トンネルは loopback を使用するため、Gateway はノード IP を
  `127.0.0.1` として認識します。実際のクライアント IP を表示したい場合は
  **Direct (ws/wss)** トランスポートを使用してください（[macOS リモートアクセス](/platforms/mac/remote) を参照）。

セットアップ手順については [macOS リモートアクセス](/platforms/mac/remote) を参照してください。プロトコルの
詳細については [Gateway プロトコル](/gateway/protocol) を参照してください。

## 関連ドキュメント

- [Gateway 運用手順書](/gateway)
- [Gateway (macOS)](/platforms/mac/bundled-gateway)
- [macOS パーミッション](/platforms/mac/permissions)
- [Canvas](/platforms/mac/canvas)
