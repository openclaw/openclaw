---
summary: "1つのホストで複数のOpenClaw Gatewayを実行（分離、ポート、プロファイル）"
read_when:
  - Running more than one Gateway on the same machine
  - You need isolated config/state/ports per Gateway
title: "複数のGateway"
---

# 複数のGateway（同一ホスト）

ほとんどのセットアップでは、単一のGatewayが複数のメッセージング接続とエージェントを処理できるため、1つのGatewayを使用すべきです。より強力な分離や冗長性（例：レスキューボット）が必要な場合は、分離されたプロファイル/ポートで別々のGatewayを実行してください。

## 分離チェックリスト（必須）

- `OPENCLAW_CONFIG_PATH` — インスタンスごとの設定ファイル
- `OPENCLAW_STATE_DIR` — インスタンスごとのセッション、認証情報、キャッシュ
- `agents.defaults.workspace` — インスタンスごとのワークスペースルート
- `gateway.port`（または`--port`）— インスタンスごとに一意
- 派生ポート（ブラウザ/Canvas）が重複してはいけません

これらが共有されている場合、設定の競合とポートの衝突が発生します。

## 推奨：プロファイル（`--profile`）

プロファイルは`OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH`を自動的にスコープし、サービス名にサフィックスを付加します。

```bash
# メイン
openclaw --profile main setup
openclaw --profile main gateway --port 18789

# レスキュー
openclaw --profile rescue setup
openclaw --profile rescue gateway --port 19001
```

プロファイルごとのサービス：

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

## レスキューボットガイド

同じホスト上で2番目のGatewayを独自の以下の項目で実行します：

- プロファイル/設定
- 状態ディレクトリ
- ワークスペース
- ベースポート（および派生ポート）

これにより、レスキューボットはメインボットから分離され、プライマリボットがダウンしている場合にデバッグや設定変更を適用できます。

ポート間隔：派生されるブラウザ/Canvas/CDPポートが衝突しないように、ベースポート間に少なくとも20ポートの間隔を空けてください。

### インストール方法（レスキューボット）

```bash
# メインボット（既存または新規、--profileパラメータなし）
# ポート18789 + Chrome CDC/Canvas/... ポートで実行
openclaw onboard
openclaw gateway install

# レスキューボット（分離されたプロファイル + ポート）
openclaw --profile rescue onboard
# 注意：
# - ワークスペース名はデフォルトで -rescue がポストフィックスされます
# - ポートは少なくとも 18789 + 20 ポート以上にすべきです。
#   完全に異なるベースポート（例：19789）を選択するのが望ましいです。
# - オンボーディングの残りは通常と同じです

# サービスのインストール（オンボーディング中に自動的に行われなかった場合）
openclaw --profile rescue gateway install
```

## ポートマッピング（派生）

ベースポート = `gateway.port`（または`OPENCLAW_GATEWAY_PORT` / `--port`）。

- ブラウザコントロールサービスポート = ベース + 2（ループバックのみ）
- Canvasホストは`gateway.port`と同じポートのGateway HTTPサーバーで提供されます
- ブラウザプロファイルCDPポートは`browser.controlPort + 9 .. + 108`から自動割り当て

設定または環境変数でこれらのいずれかをオーバーライドする場合、インスタンスごとに一意に保つ必要があります。

## ブラウザ/CDPの注意点（よくある落とし穴）

- 複数のインスタンスで`browser.cdpUrl`を同じ値に固定**しないでください**。
- 各インスタンスには独自のブラウザコントロールポートとCDP範囲（Gatewayポートから派生）が必要です。
- 明示的なCDPポートが必要な場合は、インスタンスごとに`browser.profiles.<name>.cdpPort`を設定してください。
- リモートChrome：インスタンスごとに`browser.profiles.<name>.cdpUrl`を使用してください（プロファイルごと、インスタンスごと）。

## 手動環境変数の例

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/main.json \
OPENCLAW_STATE_DIR=~/.openclaw-main \
openclaw gateway --port 18789

OPENCLAW_CONFIG_PATH=~/.openclaw/rescue.json \
OPENCLAW_STATE_DIR=~/.openclaw-rescue \
openclaw gateway --port 19001
```

## クイックチェック

```bash
openclaw --profile main status
openclaw --profile rescue status
openclaw --profile rescue browser status
```
