---
read_when:
    - ヘッドレスノードホストを実行する場合
    - macOS以外のノードをsystem.run用にペアリングする場合
summary: '`openclaw node`（ヘッドレスノードホスト）のCLIリファレンス'
title: node
x-i18n:
    generated_at: "2026-04-02T07:34:39Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 3c2bda33cc4399d2fe5250182869f022b334f02d699fb4ef53323fef6b84ac4b
    source_path: cli/node.md
    workflow: 15
---

# `openclaw node`

Gateway ゲートウェイのWebSocketに接続し、このマシン上で `system.run` / `system.which` を
公開する**ヘッドレスノードホスト**を実行します。

## ノードホストを使用する理由

エージェントにネットワーク内の**他のマシンでコマンドを実行**させたいが、そこに完全な
macOSコンパニオンアプリをインストールしたくない場合にノードホストを使用します。

一般的なユースケース:

- リモートのLinux/Windowsマシン（ビルドサーバー、ラボマシン、NAS）でコマンドを実行。
- Gateway ゲートウェイ上で実行を**サンドボックス化**しつつ、承認済みの実行を他のホストに委任。
- 自動化やCIノード向けの軽量なヘッドレス実行ターゲットを提供。

ノードホスト上では**実行承認**とエージェントごとの許可リストによって保護されているため、
コマンドアクセスをスコープ付きで明示的に保つことができます。

## ブラウザプロキシ（ゼロ設定）

ノードホストは、ノード上で `browser.enabled` が無効になっていない限り、ブラウザプロキシを
自動的にアドバタイズします。これにより、追加設定なしでエージェントがそのノード上で
ブラウザ自動化を使用できます。

デフォルトでは、プロキシはノードの通常のブラウザプロファイルサーフェスを公開します。
`nodeHost.browserProxy.allowProfiles` を設定すると、プロキシは制限的になります:
許可リストにないプロファイルの指定は拒否され、永続プロファイルの
作成/削除ルートはプロキシ経由でブロックされます。

必要に応じてノード上で無効化できます:

```json5
{
  nodeHost: {
    browserProxy: {
      enabled: false,
    },
  },
}
```

## 実行（フォアグラウンド）

```bash
openclaw node run --host <gateway-host> --port 18789
```

オプション:

- `--host <host>`: Gateway ゲートウェイのWebSocketホスト（デフォルト: `127.0.0.1`）
- `--port <port>`: Gateway ゲートウェイのWebSocketポート（デフォルト: `18789`）
- `--tls`: Gateway ゲートウェイ接続にTLSを使用
- `--tls-fingerprint <sha256>`: 期待されるTLS証明書フィンガープリント（sha256）
- `--node-id <id>`: ノードIDを上書き（ペアリングトークンをクリア）
- `--display-name <name>`: ノードの表示名を上書き

## ノードホストのGateway ゲートウェイ認証

`openclaw node run` と `openclaw node install` は設定/環境変数からGateway ゲートウェイ認証を解決します（nodeコマンドには `--token`/`--password` フラグはありません）:

- `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD` が最初にチェックされます。
- 次にローカル設定のフォールバック: `gateway.auth.token` / `gateway.auth.password`。
- ローカルモードでは、ノードホストは意図的に `gateway.remote.token` / `gateway.remote.password` を継承しません。
- `gateway.auth.token` / `gateway.auth.password` がSecretRef経由で明示的に設定され未解決の場合、ノード認証の解決はクローズドで失敗します（リモートフォールバックによるマスキングなし）。
- `gateway.mode=remote` では、リモートクライアントフィールド（`gateway.remote.token` / `gateway.remote.password`）もリモート優先ルールに従って対象になります。
- ノードホストの認証解決は `OPENCLAW_GATEWAY_*` 環境変数のみを尊重します。

## サービス（バックグラウンド）

ヘッドレスノードホストをユーザーサービスとしてインストールします。

```bash
openclaw node install --host <gateway-host> --port 18789
```

オプション:

- `--host <host>`: Gateway ゲートウェイのWebSocketホスト（デフォルト: `127.0.0.1`）
- `--port <port>`: Gateway ゲートウェイのWebSocketポート（デフォルト: `18789`）
- `--tls`: Gateway ゲートウェイ接続にTLSを使用
- `--tls-fingerprint <sha256>`: 期待されるTLS証明書フィンガープリント（sha256）
- `--node-id <id>`: ノードIDを上書き（ペアリングトークンをクリア）
- `--display-name <name>`: ノードの表示名を上書き
- `--runtime <runtime>`: サービスランタイム（`node` または `bun`）
- `--force`: 既にインストール済みの場合に再インストール/上書き

サービスの管理:

```bash
openclaw node status
openclaw node stop
openclaw node restart
openclaw node uninstall
```

フォアグラウンドのノードホスト（サービスなし）には `openclaw node run` を使用してください。

サービスコマンドは機械可読な出力のために `--json` を受け付けます。

## ペアリング

最初の接続時に、Gateway ゲートウェイ上で保留中のデバイスペアリングリクエスト（`role: node`）が作成されます。
以下で承認してください:

```bash
openclaw devices list
openclaw devices approve <requestId>
```

ノードが認証の詳細（ロール/スコープ/公開鍵）を変更してペアリングを再試行した場合、
以前の保留中リクエストは置き換えられ、新しい `requestId` が作成されます。
承認前に再度 `openclaw devices list` を実行してください。

ノードホストは、ノードID、トークン、表示名、およびGateway ゲートウェイ接続情報を
`~/.openclaw/node.json` に保存します。

## 実行承認

`system.run` はローカルの実行承認によってゲートされます:

- `~/.openclaw/exec-approvals.json`
- [実行承認](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>`（Gateway ゲートウェイから編集）
