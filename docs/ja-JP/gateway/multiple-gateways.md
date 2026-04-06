---
read_when:
    - 同一マシンで複数の Gateway ゲートウェイを実行する場合
    - Gateway ゲートウェイごとに分離された設定・状態・ポートが必要な場合
summary: 1台のホストで複数のOpenClaw Gateway ゲートウェイを実行する（分離、ポート、プロファイル）
title: 複数の Gateway ゲートウェイ
x-i18n:
    generated_at: "2026-04-02T08:30:41Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 98c14bed7b7447481325d60ac379846ae379326400c4b0ed7f8d320ad8c50080
    source_path: gateway/multiple-gateways.md
    workflow: 15
---

# 複数の Gateway ゲートウェイ（同一ホスト）

ほとんどのセットアップでは、単一の Gateway ゲートウェイで複数のメッセージング接続やエージェントを処理できるため、1つで十分です。より強い分離や冗長性が必要な場合（例：レスキューボット）は、プロファイルとポートを分離して個別の Gateway ゲートウェイを実行してください。

## 分離チェックリスト（必須）

- `OPENCLAW_CONFIG_PATH` — インスタンスごとの設定ファイル
- `OPENCLAW_STATE_DIR` — インスタンスごとのセッション、認証情報、キャッシュ
- `agents.defaults.workspace` — インスタンスごとのワークスペースルート
- `gateway.port`（または `--port`）— インスタンスごとにユニークな値
- 派生ポート（ブラウザ/キャンバス）が重複しないこと

これらを共有すると、設定の競合やポートの衝突が発生します。

## 推奨：プロファイル（`--profile`）

プロファイルは `OPENCLAW_STATE_DIR` と `OPENCLAW_CONFIG_PATH` を自動的にスコープし、サービス名にサフィックスを付与します。

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

同一ホスト上で、以下を個別に持つ2つ目の Gateway ゲートウェイを実行します：

- プロファイル/設定
- 状態ディレクトリ
- ワークスペース
- ベースポート（および派生ポート）

これにより、レスキューボットがメインボットから分離されるため、プライマリボットがダウンしている場合でもデバッグや設定変更を適用できます。

ポート間隔：派生されるブラウザ/キャンバス/CDPポートが衝突しないよう、ベースポート間は少なくとも20ポートの間隔を空けてください。

### インストール方法（レスキューボット）

```bash
# メインボット（既存または新規、--profile パラメータなし）
# ポート 18789 + Chrome CDC/Canvas/... ポートで実行
openclaw onboard
openclaw gateway install

# レスキューボット（分離されたプロファイル + ポート）
openclaw --profile rescue onboard
# 注意:
# - ワークスペース名はデフォルトで -rescue がポストフィックスされます
# - ポートは少なくとも 18789 + 20 ポート以上にしてください。
#   完全に異なるベースポート（例: 19789）を選択するのがより良いです。
# - それ以外のオンボーディングは通常と同じです

# サービスのインストール（セットアップ中に自動で行われなかった場合）
openclaw --profile rescue gateway install
```

## ポートマッピング（派生）

ベースポート = `gateway.port`（または `OPENCLAW_GATEWAY_PORT` / `--port`）。

- ブラウザ制御サービスポート = ベース + 2（loopback のみ）
- キャンバスホストは Gateway ゲートウェイ HTTPサーバー上で提供されます（`gateway.port` と同じポート）
- ブラウザプロファイルのCDPポートは `browser.controlPort + 9 .. + 108` から自動割り当て

設定や環境変数でこれらを上書きする場合は、インスタンスごとにユニークな値を維持する必要があります。

## ブラウザ/CDPに関する注意（よくある落とし穴）

- 複数のインスタンスで `browser.cdpUrl` を同じ値に固定**しないでください**。
- 各インスタンスには、独自のブラウザ制御ポートとCDP範囲が必要です（Gateway ゲートウェイポートから派生）。
- 明示的なCDPポートが必要な場合は、インスタンスごとに `browser.profiles.<name>.cdpPort` を設定してください。
- リモートChrome：`browser.profiles.<name>.cdpUrl`（プロファイルごと、インスタンスごと）を使用してください。

## 手動の環境変数の例

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
