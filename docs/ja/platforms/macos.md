---
summary: "OpenClaw macOS コンパニオンアプリ（メニューバー + ゲートウェイブローカー）"
read_when:
  - macOS アプリ機能を実装する場合
  - macOS でのゲートウェイのライフサイクルやノードブリッジを変更する場合
title: "macOS アプリ"
---

# OpenClaw macOS コンパニオン（メニューバー + ゲートウェイブローカー）

macOS アプリは OpenClaw の **メニューバー コンパニオン**です。権限を管理し、ローカルで Gateway（ゲートウェイ）に接続または起動（launchd または手動）し、macOS の機能をノードとしてエージェントに公開します。 パーミッションを所有し、
ローカルゲートウェイ(起動または手動)を管理/アタッチし、macOS
機能をノードとしてエージェントに公開します。

## 何を行うか

- ネイティブ通知とステータスをメニューバーに表示します。
- TCC プロンプト（通知、アクセシビリティ、画面収録、マイク、音声認識、オートメーション / AppleScript）を管理します。
- Gateway（ローカルまたはリモート）を実行または接続します。
- macOS 専用ツール（Canvas、Camera、Screen Recording、`system.run`）を公開します。
- ローカルノードホストサービスを **remote** モード（launchd）で起動し、**local** モードでは停止します。
- UI 自動化のために **PeekabooBridge** を任意でホストします。
- 要求に応じて npm / pnpm 経由でグローバル CLI（`openclaw`）をインストールします（Gateway ランタイムには bun は推奨されません）。

## ローカル vs リモート モード

- **Local**（デフォルト）: 実行中のローカル Gateway があれば接続します。存在しない場合は、`openclaw gateway install` を介して launchd サービスを有効化します。
- **リモート**: アプリは SSH / Tailscale でゲートウェイに接続し、ローカルプロセスの
  を起動しません。
  **Remote**: SSH / Tailscale 経由で Gateway に接続し、ローカルプロセスは起動しません。  
  リモート Gateway からこの Mac に到達できるよう、ローカルの **ノードホストサービス**を起動します。  
  アプリは Gateway を子プロセスとして起動しません。
  このアプリは子プロセスとして Gateway を生成しません。

## launchd の制御

アプリは、ユーザー単位の LaunchAgent（ラベル `bot.molt.gateway`）を管理します  
（`--profile` / `OPENCLAW_PROFILE` を使用する場合は `bot.molt.<profile>`。レガシーの `com.openclaw.*` でもアンロードされます）。

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

名前付きプロファイルを実行する場合は、ラベルを `bot.molt.<profile>` に置き換えてください。

LaunchAgent がインストールされていない場合は、アプリから有効化するか、`openclaw gateway install` を実行してください。

## ノード機能（mac）

macOS アプリはノードとして振る舞います。一般的なコマンドは次のとおりです。 一般的なコマンド:

- Canvas: `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, `canvas.a2ui.*`
- Camera: `camera.snap`, `camera.clip`
- Screen: `screen.record`
- System: `system.run`, `system.notify`

ノードは、エージェントが許可可否を判断できるように `permissions` マップを報告します。

ノードサービス + アプリ IPC:

- ヘッドレスのノードホストサービスが実行中（remote モード）の場合、ノードとして Gateway の WS に接続します。
- `system.run` は、ローカルの Unix ソケット越しに macOS アプリ（UI / TCC コンテキスト）内で実行されます。プロンプトと出力はアプリ内に留まります。

図（SCI）:

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + TCC + system.run)
```

## 実行承認（system.run）

`system.run` は、macOS アプリの **実行承認**（設定 → 実行承認）で制御されます。  
セキュリティ、確認、許可リストは、この Mac の次の場所にローカル保存されます。
セキュリティ+Ask+allowlistはMac上にローカルに保存されています:

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

注記:

- `allowlist` エントリは、解決済みバイナリパスに対するグロブパターンです。
- プロンプトで「常に許可」を選択すると、そのコマンドが許可リストに追加されます。
- `system.run` の環境変数オーバーライドはフィルタリング（`PATH`、`DYLD_*`、`LD_*`、`NODE_OPTIONS`、`PYTHON*`、`PERL*`、`RUBYOPT` を除外）された後、アプリの環境とマージされます。

## ディープ リンク

アプリは、ローカルアクション用に `openclaw://` URL スキームを登録します。

### `openclaw://agent`

Gateway の `agent` リクエストをトリガーします。

```bash
open 'openclaw://agent?message=Hello%20from%20deep%20link'
```

クエリパラメーター:

- `message`（必須）
- `sessionKey`（任意）
- `thinking`（任意）
- `deliver` / `to` / `channel`（任意）
- `timeoutSeconds`（任意）
- `key`（無人モード用キー、任意）

安全性:

- `key` がない場合、アプリは確認を求めます。
- 有効な `key` がある場合、実行は無人になります（個人用自動化を想定）。

## オンボーディング フロー（一般的）

1. **OpenClaw.app** をインストールして起動します。
2. 権限チェックリスト（TCC プロンプト）を完了します。
3. **Local** モードが有効で、Gateway が実行中であることを確認します。
4. ターミナルから利用したい場合は、CLI をインストールします。

## ビルド & 開発ワークフロー（ネイティブ）

- `cd apps/macos && swift build`
- `swift run OpenClaw`（または Xcode）
- アプリのパッケージ化: `scripts/package-mac-app.sh`

## Gateway 接続のデバッグ（macOS CLI）

デバッグ CLI を使用すると、アプリを起動せずに、macOS アプリと同じ Gateway WebSocket のハンドシェイクおよび検出ロジックを検証できます。

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

接続オプション:

- `--url <ws://host:port>`: 設定を上書き
- `--mode <local|remote>`: 設定から解決（デフォルト: 設定またはローカル）
- `--probe`: 新規のヘルスプローブを強制
- `--timeout <ms>`: リクエスト タイムアウト（デフォルト: `15000`）
- `--json`: 差分比較用の構造化出力

検出オプション:

- `--include-local`: 「local」としてフィルタリングされる Gateway を含める
- `--timeout <ms>`: 全体の検出ウィンドウ（デフォルト: `2000`）
- `--json`: 差分比較用の構造化出力

ヒント: `openclaw gateway discover --json` と比較して、macOS アプリの検出パイプライン（NWBrowser + tailnet DNS‑SD フォールバック）が、Node CLI の `dns-sd` ベースの検出と異なるかどうかを確認してください。

## リモート接続の配管（SSH トンネル）

macOS アプリが **Remote** モードで実行される場合、ローカル UI コンポーネントが、あたかも localhost 上にあるかのようにリモート Gateway と通信できるよう、SSH トンネルを開きます。

### コントロール トンネル（Gateway WebSocket ポート）

- **目的:** ヘルスチェック、ステータス、Web Chat、設定、その他のコントロールプレーン呼び出し。
- **ローカル ポート:** Gateway ポート（デフォルト `18789`）。常に固定です。
- **リモート ポート:** リモート ホスト上の同一 Gateway ポート。
- **挙動:** ランダムなローカル ポートは使用しません。既存の健全なトンネルを再利用し、必要に応じて再起動します。
- **SSH 形態:** BatchMode + ExitOnForwardFailure + keepalive オプション付きの `ssh -N -L <local>:127.0.0.1:<remote>`。
- **IP レポート:** SSH トンネルはループバックを使用するため、Gateway から見えるノード IP は `127.0.0.1` になります。実際のクライアント IP を表示したい場合は、**Direct (ws/wss)** トランスポートを使用してください（[macOS remote access](/platforms/mac/remote) を参照）。 実際のクライアント
  IP を表示させたい場合は、**Direct (ws/wss)** を使用してください ([macOS リモート アクセス](/platforms/mac/remote)を参照してください)。

セットアップ手順については [macOS remote access](/platforms/mac/remote) を、プロトコルの詳細については [Gateway protocol](/gateway/protocol) を参照してください。 プロトコル
の詳細については、[Gateway protocol](/gateway/protocol)を参照してください。

## 関連ドキュメント

- [Gateway runbook](/gateway)
- [Gateway（macOS）](/platforms/mac/bundled-gateway)
- [macOS permissions](/platforms/mac/permissions)
- [Canvas](/platforms/mac/canvas)
