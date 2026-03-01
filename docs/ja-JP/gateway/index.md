---
summary: "Gatewayサービスのランブック、ライフサイクル、運用"
read_when:
  - Running or debugging the gateway process
title: "Gatewayランブック"
---

# Gatewayランブック

このページはGatewayサービスの初日起動と2日目運用に使用してください。

<CardGroup cols={2}>
  <Card title="詳細トラブルシューティング" icon="siren" href="/gateway/troubleshooting">
    症状優先の診断と正確なコマンドラダーとログシグネチャ。
  </Card>
  <Card title="設定" icon="sliders" href="/gateway/configuration">
    タスク指向のセットアップガイド + 完全な設定リファレンス。
  </Card>
  <Card title="シークレット管理" icon="key-round" href="/gateway/secrets">
    SecretRef契約、ランタイムスナップショット動作、マイグレーション/リロード操作。
  </Card>
  <Card title="シークレットプラン契約" icon="shield-check" href="/gateway/secrets-plan-contract">
    正確な`secrets apply`のターゲット/パスルールとref限定の認証プロファイル動作。
  </Card>
</CardGroup>

## 5分間ローカル起動

<Steps>
  <Step title="Gatewayを起動">

```bash
openclaw gateway --port 18789
# debug/traceをstdioにミラー
openclaw gateway --port 18789 --verbose
# 選択したポートのリスナーを強制終了してから起動
openclaw gateway --force
```

  </Step>

  <Step title="サービスの健全性を確認">

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
```

健全なベースライン：`Runtime: running`と`RPC probe: ok`。

  </Step>

  <Step title="チャンネルの準備状態を検証">

```bash
openclaw channels status --probe
```

  </Step>
</Steps>

<Note>
Gatewayの設定リロードはアクティブな設定ファイルパス（プロファイル/状態デフォルトから解決、または`OPENCLAW_CONFIG_PATH`が設定されている場合はそれ）を監視します。
デフォルトモードは`gateway.reload.mode="hybrid"`です。
</Note>

## ランタイムモデル

- ルーティング、コントロールプレーン、チャンネル接続のための常時稼働プロセス。
- 以下の単一多重化ポート：
  - WebSocketコントロール/RPC
  - HTTP API（OpenAI互換、Responses、ツール呼び出し）
  - コントロールUIとhooks
- デフォルトバインドモード：`loopback`。
- 認証はデフォルトで必要です（`gateway.auth.token` / `gateway.auth.password`、または`OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`）。

### ポートとバインドの優先順位

| 設定      | 解決順序                                              |
| ------------ | ------------------------------------------------------------- |
| Gatewayポート | `--port` → `OPENCLAW_GATEWAY_PORT` → `gateway.port` → `18789` |
| バインドモード    | CLI/オーバーライド → `gateway.bind` → `loopback`                    |

### ホットリロードモード

| `gateway.reload.mode` | 動作                                   |
| --------------------- | ------------------------------------------ |
| `off`                 | 設定リロードなし                           |
| `hot`                 | ホットセーフな変更のみ適用                |
| `restart`             | リロードが必要な変更時に再起動         |
| `hybrid`（デフォルト）    | 安全な場合はホットアプライ、必要な場合は再起動 |

## オペレーターコマンドセット

```bash
openclaw gateway status
openclaw gateway status --deep
openclaw gateway status --json
openclaw gateway install
openclaw gateway restart
openclaw gateway stop
openclaw secrets reload
openclaw logs --follow
openclaw doctor
```

## リモートアクセス

推奨：Tailscale/VPN。
フォールバック：SSHトンネル。

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

次にクライアントをローカルの`ws://127.0.0.1:18789`に接続します。

<Warning>
Gateway認証が設定されている場合、SSHトンネル経由でもクライアントは認証（`token`/`password`）を送信する必要があります。
</Warning>

参照：[リモートGateway](/gateway/remote)、[認証](/gateway/authentication)、[Tailscale](/gateway/tailscale)。

## スーパービジョンとサービスライフサイクル

本番環境のような信頼性のためにスーパーバイズド実行を使用します。

<Tabs>
  <Tab title="macOS (launchd)">

```bash
openclaw gateway install
openclaw gateway status
openclaw gateway restart
openclaw gateway stop
```

LaunchAgentラベルは`ai.openclaw.gateway`（デフォルト）または`ai.openclaw.<profile>`（名前付きプロファイル）です。`openclaw doctor`はサービス設定のドリフトを監査・修復します。

  </Tab>

  <Tab title="Linux (systemdユーザー)">

```bash
openclaw gateway install
systemctl --user enable --now openclaw-gateway[-<profile>].service
openclaw gateway status
```

ログアウト後の永続化のため、リンガーを有効にします：

```bash
sudo loginctl enable-linger <user>
```

  </Tab>

  <Tab title="Linux (システムサービス)">

マルチユーザー/常時稼働ホスト用にシステムユニットを使用します。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway[-<profile>].service
```

  </Tab>
</Tabs>

## 1つのホストで複数のGateway

ほとんどのセットアップでは**1つの**Gatewayを実行すべきです。
厳密な分離/冗長性（例：レスキュープロファイル）の場合にのみ複数を使用してください。

インスタンスごとのチェックリスト：

- 一意の`gateway.port`
- 一意の`OPENCLAW_CONFIG_PATH`
- 一意の`OPENCLAW_STATE_DIR`
- 一意の`agents.defaults.workspace`

例：

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002
```

参照：[複数のGateway](/gateway/multiple-gateways)。

### 開発プロファイルのクイックパス

```bash
openclaw --dev setup
openclaw --dev gateway --allow-unconfigured
openclaw --dev status
```

デフォルトには分離された状態/設定とベースGatewayポート`19001`が含まれます。

## プロトコルクイックリファレンス（オペレータービュー）

- 最初のクライアントフレームは`connect`でなければなりません。
- Gatewayは`hello-ok`スナップショット（`presence`、`health`、`stateVersion`、`uptimeMs`、制限/ポリシー）を返します。
- リクエスト：`req(method, params)` → `res(ok/payload|error)`。
- 一般的なイベント：`connect.challenge`、`agent`、`chat`、`presence`、`tick`、`health`、`heartbeat`、`shutdown`。

エージェント実行は2段階です：

1. 即座の受け入れack（`status:"accepted"`）
2. 最終完了レスポンス（`status:"ok"|"error"`）、間にストリーム`agent`イベント。

完全なプロトコルドキュメント：[Gatewayプロトコル](/gateway/protocol)を参照。

## 運用チェック

### ライブネス

- WSを開き`connect`を送信します。
- スナップショット付きの`hello-ok`レスポンスを期待します。

### レディネス

```bash
openclaw gateway status
openclaw channels status --probe
openclaw health
```

### ギャップリカバリ

イベントはリプレイされません。シーケンスギャップの場合、続行する前に状態を更新します（`health`、`system-presence`）。

## 一般的な障害シグネチャ

| シグネチャ                                                      | 原因の可能性                             |
| -------------------------------------------------------------- | ---------------------------------------- |
| `refusing to bind gateway ... without auth`                    | トークン/パスワードなしの非ループバックバインド |
| `another gateway instance is already listening` / `EADDRINUSE` | ポート競合                            |
| `Gateway start blocked: set gateway.mode=local`                | 設定がリモートモードに設定されている                |
| `unauthorized` during connect                                  | クライアントとGateway間の認証不一致 |

完全な診断ラダーについては、[Gatewayトラブルシューティング](/gateway/troubleshooting)を使用してください。

## 安全保証

- Gatewayプロトコルクライアントは、Gatewayが利用できない場合に即座に失敗します（暗黙の直接チャンネルフォールバックなし）。
- 無効/非connectの最初のフレームは拒否され閉じられます。
- グレースフルシャットダウンはソケット閉鎖前に`shutdown`イベントを発行します。

---

関連：

- [トラブルシューティング](/gateway/troubleshooting)
- [バックグラウンドプロセス](/gateway/background-process)
- [設定](/gateway/configuration)
- [ヘルス](/gateway/health)
- [Doctor](/gateway/doctor)
- [認証](/gateway/authentication)
