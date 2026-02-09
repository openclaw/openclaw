---
summary: "1 台のホストで複数の OpenClaw Gateway（ゲートウェイ）を実行します（分離、ポート、プロファイル）"
read_when:
  - 同一マシン上で複数の Gateway（ゲートウェイ）を実行する場合
  - Gateway（ゲートウェイ）ごとに分離された設定／状態／ポートが必要な場合
title: "複数の Gateway（ゲートウェイ）"
---

# 複数の Gateway（ゲートウェイ）（同一ホスト）

ほとんどのセットアップでは 1 つの Gateway（ゲートウェイ）で十分です。単一の Gateway（ゲートウェイ）で複数のメッセージング接続とエージェントを処理できます。より強力な分離や冗長性（例: レスキューボット）が必要な場合は、分離されたプロファイル／ポートを使用して別々の Gateway（ゲートウェイ）を実行してください。 より強力な隔離または冗長性(レスキューボットなど)が必要な場合は、分離されたプロファイル/ポートを持つ別々のゲートウェイを実行します。

## 分離チェックリスト（必須）

- `OPENCLAW_CONFIG_PATH` — インスタンスごとの設定ファイル
- `OPENCLAW_STATE_DIR` — インスタンスごとのセッション、認証情報、キャッシュ
- `agents.defaults.workspace` — インスタンスごとのワークスペース ルート
- `gateway.port`（または `--port`）— インスタンスごとに一意
- 派生ポート（ブラウザ／キャンバス）は重複してはいけません

これらが共有されていると、設定の競合やポートの衝突が発生します。

## 推奨: プロファイル（`--profile`）

プロファイルは `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` を自動的にスコープし、サービス名にサフィックスを付与します。

```bash
# main
openclaw --profile main setup
openclaw --profile main gateway --port 18789

# rescue
openclaw --profile rescue setup
openclaw --profile rescue gateway --port 19001
```

プロファイルごとのサービス:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

## レスキューボット ガイド

同一ホスト上で 2 つ目の Gateway（ゲートウェイ）を、以下を専用にして実行します。

- プロファイル／設定
- state dir
- ワークスペース
- ベースポート（および派生ポート）

これにより、レスキューボットがメインのボットから分離され、プライマリ ボットが停止している場合でもデバッグや設定変更を適用できます。

ポート間隔: 派生するブラウザ／キャンバス／CDP ポートが決して衝突しないよう、ベースポート間は少なくとも 20 ポート空けてください。

### インストール方法（レスキューボット）

```bash
# Main bot (existing or fresh, without --profile param)
# Runs on port 18789 + Chrome CDC/Canvas/... Ports
openclaw onboard
openclaw gateway install

# Rescue bot (isolated profile + ports)
openclaw --profile rescue onboard
# Notes:
# - workspace name will be postfixed with -rescue per default
# - Port should be at least 18789 + 20 Ports,
#   better choose completely different base port, like 19789,
# - rest of the onboarding is the same as normal

# To install the service (if not happened automatically during onboarding)
openclaw --profile rescue gateway install
```

## ポート マッピング（派生）

ベースポート = `gateway.port`（または `OPENCLAW_GATEWAY_PORT` / `--port`）。

- ブラウザ制御サービス ポート = ベース + 2（local loopback のみ）
- `canvasHost.port = base + 4`
- ブラウザ プロファイルの CDP ポートは `browser.controlPort + 9 .. + 108` から自動割り当てされます

これらのいずれかを設定ファイルや環境変数で上書きする場合、インスタンスごとに一意である必要があります。

## ブラウザ／CDP に関する注意（よくある落とし穴）

- 複数のインスタンスで `browser.cdpUrl` を同じ値に固定しないでください。
- 各インスタンスには、独自のブラウザ制御ポートと CDP 範囲（ゲートウェイ ポートから派生）が必要です。
- 明示的な CDP ポートが必要な場合は、インスタンスごとに `browser.profiles.<name>.cdpPort` を設定してください。
- リモート Chrome: `browser.profiles.<name>.cdpUrl` を使用してください（プロファイルごと、インスタンスごと）。

## 手動 env 例

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
