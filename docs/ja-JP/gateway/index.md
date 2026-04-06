---
read_when:
    - Gateway ゲートウェイプロセスの実行やデバッグを行う場合
summary: Gateway ゲートウェイサービスのランブック、ライフサイクル、運用
title: Gateway ゲートウェイ ランブック
x-i18n:
    generated_at: "2026-04-02T07:42:32Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: fbbac8b6140229d1748a7d8731e27696fbd0aa61ea611aff9a02475a94850ea1
    source_path: gateway/index.md
    workflow: 15
---

# Gateway ゲートウェイ ランブック

このページは、Gateway ゲートウェイサービスの初日のスタートアップと2日目以降の運用に使用してください。

<CardGroup cols={2}>
  <Card title="詳細なトラブルシューティング" icon="siren" href="/gateway/troubleshooting">
    症状を起点とした診断手順。正確なコマンドラダーとログシグネチャを含みます。
  </Card>
  <Card title="設定" icon="sliders" href="/gateway/configuration">
    タスク指向のセットアップガイド + 完全な設定リファレンス。
  </Card>
  <Card title="シークレット管理" icon="key-round" href="/gateway/secrets">
    SecretRefコントラクト、ランタイムスナップショットの動作、migrate/reloadオペレーション。
  </Card>
  <Card title="シークレットプランコントラクト" icon="shield-check" href="/gateway/secrets-plan-contract">
    `secrets apply` の正確なターゲット/パスルールとref-only認証プロファイルの動作。
  </Card>
</CardGroup>

## 5分でローカル起動

<Steps>
  <Step title="Gateway ゲートウェイを起動">

```bash
openclaw gateway --port 18789
# デバッグ/トレースをstdioにミラーリング
openclaw gateway --port 18789 --verbose
# 選択したポートのリスナーを強制終了してから起動
openclaw gateway --force
```

  </Step>

  <Step title="サービスの正常性を確認">

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
```

正常なベースライン: `Runtime: running` および `RPC probe: ok`。

  </Step>

  <Step title="チャネルの準備状況を検証">

```bash
openclaw channels status --probe
```

  </Step>
</Steps>

<Note>
Gateway ゲートウェイの設定リロードは、アクティブな設定ファイルパス（プロファイル/状態のデフォルトから解決、または `OPENCLAW_CONFIG_PATH` が設定されている場合はそれを使用）を監視します。
デフォルトモードは `gateway.reload.mode="hybrid"` です。
最初の読み込み成功後、実行中のプロセスはアクティブなインメモリ設定スナップショットを提供します。リロード成功時にそのスナップショットをアトミックにスワップします。
</Note>

## ランタイムモデル

- ルーティング、コントロールプレーン、チャネル接続のための常時稼働プロセスが1つ。
- 以下のための単一多重化ポート:
  - WebSocketコントロール/RPC
  - HTTP API、OpenAI互換（`/v1/models`、`/v1/embeddings`、`/v1/chat/completions`、`/v1/responses`、`/tools/invoke`）
  - コントロールUIとフック
- デフォルトのバインドモード: `loopback`。
- 認証はデフォルトで必須（`gateway.auth.token` / `gateway.auth.password`、または `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`）。

## OpenAI互換エンドポイント

OpenClawの最も活用度の高い互換性サーフェスは以下です:

- `GET /v1/models`
- `GET /v1/models/{id}`
- `POST /v1/embeddings`
- `POST /v1/chat/completions`
- `POST /v1/responses`

このセットが重要な理由:

- ほとんどのOpen WebUI、LobeChat、LibreChatインテグレーションは最初に `/v1/models` をプローブします。
- 多くのRAGおよびメモリパイプラインは `/v1/embeddings` を期待します。
- エージェントネイティブなクライアントは `/v1/responses` を好む傾向が増えています。

計画メモ:

- `/v1/models` はエージェントファーストです: `openclaw`、`openclaw/default`、`openclaw/<agentId>` を返します。
- `openclaw/default` は、設定されたデフォルトエージェントに常にマッピングされる安定したエイリアスです。
- バックエンドのプロバイダー/モデルオーバーライドが必要な場合は `x-openclaw-model` を使用してください。それ以外の場合、選択されたエージェントの通常のモデルおよびエンベディング設定が制御を維持します。

これらはすべてメインのGateway ゲートウェイポートで実行され、Gateway ゲートウェイHTTP APIの他の部分と同じ信頼されたオペレーター認証境界を使用します。

### ポートとバインドの優先順位

| 設定 | 解決順序 |
| ------------ | ------------------------------------------------------------- |
| Gateway ゲートウェイポート | `--port` → `OPENCLAW_GATEWAY_PORT` → `gateway.port` → `18789` |
| バインドモード | CLI/オーバーライド → `gateway.bind` → `loopback` |

### ホットリロードモード

| `gateway.reload.mode` | 動作 |
| --------------------- | ------------------------------------------ |
| `off` | 設定リロードなし |
| `hot` | ホットセーフな変更のみ適用 |
| `restart` | リロード必須の変更時に再起動 |
| `hybrid`（デフォルト） | 安全な場合はホット適用、必須の場合は再起動 |

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

推奨: Tailscale/VPN。
フォールバック: SSHトンネル。

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

その後、クライアントをローカルの `ws://127.0.0.1:18789` に接続します。

<Warning>
Gateway ゲートウェイ認証が設定されている場合、SSHトンネル経由でもクライアントは認証（`token`/`password`）を送信する必要があります。
</Warning>

参照: [リモートGateway ゲートウェイ](/gateway/remote)、[認証](/gateway/authentication)、[Tailscale](/gateway/tailscale)。

## スーパーバイズとサービスライフサイクル

本番環境に近い信頼性のために、スーパーバイズされた実行を使用してください。

<Tabs>
  <Tab title="macOS (launchd)">

```bash
openclaw gateway install
openclaw gateway status
openclaw gateway restart
openclaw gateway stop
```

LaunchAgentラベルは `ai.openclaw.gateway`（デフォルト）または `ai.openclaw.<profile>`（名前付きプロファイル）です。`openclaw doctor` はサービス設定のドリフトを監査・修復します。

  </Tab>

  <Tab title="Linux (systemdユーザー)">

```bash
openclaw gateway install
systemctl --user enable --now openclaw-gateway[-<profile>].service
openclaw gateway status
```

ログアウト後も永続化するには、リンガリングを有効にします:

```bash
sudo loginctl enable-linger <user>
```

  </Tab>

  <Tab title="Linux (システムサービス)">

マルチユーザー/常時稼働ホストにはシステムユニットを使用します。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway[-<profile>].service
```

  </Tab>
</Tabs>

## 1つのホストで複数のGateway ゲートウェイ

ほとんどのセットアップでは**1つ**のGateway ゲートウェイを実行すべきです。
厳密な分離/冗長性（例: レスキュープロファイル）の場合にのみ複数を使用してください。

インスタンスごとのチェックリスト:

- 一意の `gateway.port`
- 一意の `OPENCLAW_CONFIG_PATH`
- 一意の `OPENCLAW_STATE_DIR`
- 一意の `agents.defaults.workspace`

例:

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002
```

参照: [複数のGateway ゲートウェイ](/gateway/multiple-gateways)。

### 開発プロファイルのクイックパス

```bash
openclaw --dev setup
openclaw --dev gateway --allow-unconfigured
openclaw --dev status
```

デフォルトには分離された状態/設定とベースGateway ゲートウェイポート `19001` が含まれます。

## プロトコルクイックリファレンス（オペレータービュー）

- 最初のクライアントフレームは `connect` である必要があります。
- Gateway ゲートウェイは `hello-ok` スナップショット（`presence`、`health`、`stateVersion`、`uptimeMs`、limits/policy）を返します。
- リクエスト: `req(method, params)` → `res(ok/payload|error)`。
- 一般的なイベント: `connect.challenge`、`agent`、`chat`、`presence`、`tick`、`health`、`heartbeat`、`shutdown`。

エージェント実行は2段階です:

1. 即時の受理応答（`status:"accepted"`）
2. 最終的な完了レスポンス（`status:"ok"|"error"`）。その間にストリーミングされた `agent` イベントを伴います。

完全なプロトコルドキュメントを参照: [Gateway ゲートウェイプロトコル](/gateway/protocol)。

## 運用チェック

### ライブネス

- WSを開いて `connect` を送信します。
- スナップショット付きの `hello-ok` レスポンスを期待します。

### レディネス

```bash
openclaw gateway status
openclaw channels status --probe
openclaw health
```

### ギャップリカバリ

イベントはリプレイされません。シーケンスギャップが発生した場合、続行前に状態（`health`、`system-presence`）をリフレッシュしてください。

## 一般的な障害シグネチャ

| シグネチャ | 考えられる問題 |
| -------------------------------------------------------------- | ---------------------------------------- |
| `refusing to bind gateway ... without auth` | トークン/パスワードなしの非loopbackバインド |
| `another gateway instance is already listening` / `EADDRINUSE` | ポート競合 |
| `Gateway start blocked: set gateway.mode=local` | 設定がリモートモードになっている |
| `unauthorized` during connect | クライアントとGateway ゲートウェイ間の認証不一致 |

完全な診断ラダーについては、[Gateway ゲートウェイ トラブルシューティング](/gateway/troubleshooting)を使用してください。

## 安全性の保証

- Gateway ゲートウェイプロトコルクライアントは、Gateway ゲートウェイが利用不可の場合にフェイルファストします（暗黙のダイレクトチャネルフォールバックなし）。
- 無効な/connect以外の最初のフレームは拒否されクローズされます。
- グレースフルシャットダウンはソケットクローズ前に `shutdown` イベントを発行します。

---

関連:

- [トラブルシューティング](/gateway/troubleshooting)
- [バックグラウンドプロセス](/gateway/background-process)
- [設定](/gateway/configuration)
- [ヘルス](/gateway/health)
- [Doctor](/gateway/doctor)
- [認証](/gateway/authentication)
