---
summary: "`openclaw node` の CLI リファレンス（ヘッドレスノードホスト）"
read_when:
  - ヘッドレスノードホストの実行
  - macOS 以外のノードを system.run 用にペアリング
title: "node"
---

# `openclaw node`

Gateway の WebSocket に接続し、このマシンで `system.run` / `system.which` を公開する
**ヘッドレスノードホスト**を実行します。

## ノードホストを使う理由

エージェントにネットワーク内の**他のマシンでコマンドを実行**させたいが、
そのマシンに完全な macOS コンパニオンアプリをインストールしたくない場合に使用します。

一般的なユースケース:

- リモートの Linux/Windows マシン（ビルドサーバー、ラボマシン、NAS）でコマンドを実行する。
- Gateway 上で実行を**サンドボックス化**しつつ、承認された実行を他のホストに委任する。
- オートメーションや CI ノード用の軽量なヘッドレス実行ターゲットを提供する。

ノードホストでは実行が**exec 承認**とエージェントごとの許可リストによって保護されるため、
コマンドアクセスをスコープ指定して明示的に保つことができます。

## ブラウザプロキシ（ゼロコンフィグ）

ノードホストは、ノード上で `browser.enabled` が無効になっていない限り、
ブラウザプロキシを自動的にアドバタイズします。これにより、追加設定なしで
エージェントがそのノード上でブラウザオートメーションを使用できます。

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

- `--host <host>`: Gateway WebSocket ホスト（デフォルト: `127.0.0.1`）
- `--port <port>`: Gateway WebSocket ポート（デフォルト: `18789`）
- `--tls`: Gateway 接続に TLS を使用する
- `--tls-fingerprint <sha256>`: 期待される TLS 証明書フィンガープリント（sha256）
- `--node-id <id>`: ノード ID を上書きする（ペアリングトークンをクリアします）
- `--display-name <name>`: ノードの表示名を上書きする

## サービス（バックグラウンド）

ヘッドレスノードホストをユーザーサービスとしてインストールします。

```bash
openclaw node install --host <gateway-host> --port 18789
```

オプション:

- `--host <host>`: Gateway WebSocket ホスト（デフォルト: `127.0.0.1`）
- `--port <port>`: Gateway WebSocket ポート（デフォルト: `18789`）
- `--tls`: Gateway 接続に TLS を使用する
- `--tls-fingerprint <sha256>`: 期待される TLS 証明書フィンガープリント（sha256）
- `--node-id <id>`: ノード ID を上書きする（ペアリングトークンをクリアします）
- `--display-name <name>`: ノードの表示名を上書きする
- `--runtime <runtime>`: サービスランタイム（`node` または `bun`）
- `--force`: 既にインストール済みの場合は再インストール/上書きする

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

最初の接続時に Gateway 上にペアリングリクエストが保留状態で作成されます。
以下のコマンドで承認してください:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

ノードホストはノード ID、トークン、表示名、Gateway 接続情報を
`~/.openclaw/node.json` に保存します。

## exec 承認

`system.run` はローカルの exec 承認によってゲートされます:

- `~/.openclaw/exec-approvals.json`
- [exec 承認](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>`（Gateway から編集）
