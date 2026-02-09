---
summary: "「openclaw node」（ヘッドレス ノード ホスト）の CLI リファレンス"
read_when:
  - ヘッドレス ノード ホストを実行する場合
  - system.run のために非 macOS ノードをペアリングする場合
title: "node"
---

# `openclaw node`

Gateway WebSocket に接続し、このマシン上で
`system.run` / `system.which` を公開する **ヘッドレス ノード ホスト** を実行します。

## なぜノード ホストを使用するのですか？

ネットワーク内の **別のマシンでコマンドを実行** させたいが、そこに完全な macOS コンパニオンアプリをインストールしたくない場合に、ノード ホストを使用します。

一般的なユースケース:

- リモートの Linux / Windows マシン（ビルドサーバー、ラボ用マシン、NAS）でコマンドを実行する。
- exec をゲートウェイ上で **サンドボックス化** したまま、承認済みの実行を他のホストに委任する。
- 自動化や CI ノード向けに、軽量でヘッドレスな実行ターゲットを提供する。

実行は引き続き **実行承認** と、ノード ホスト上のエージェントごとの許可リストによって保護されるため、コマンドアクセスを限定的かつ明示的に保てます。

## ブラウザ プロキシ（ゼロ設定）

ノード上で `browser.enabled` が無効化されていない場合、ノード ホストは自動的にブラウザ プロキシをアドバタイズします。これにより、追加の設定なしで、そのノード上のブラウザ自動化をエージェントから利用できます。 これにより、エージェントは追加設定なしでそのノード
のブラウザーオートメーションを使用することができます。

必要に応じてノード上で無効化してください:

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
- `--tls`: ゲートウェイ接続に TLS を使用する
- `--tls-fingerprint <sha256>`: 期待される TLS 証明書フィンガープリント（sha256）
- `--node-id <id>`: ノード ID を上書きする（ペアリング トークンをクリア）
- `--display-name <name>`: ノードの表示名を上書きする

## サービス（バックグラウンド）

ヘッドレス ノード ホストをユーザー サービスとしてインストールします。

```bash
openclaw node install --host <gateway-host> --port 18789
```

オプション:

- `--host <host>`: Gateway WebSocket ホスト（デフォルト: `127.0.0.1`）
- `--port <port>`: Gateway WebSocket ポート（デフォルト: `18789`）
- `--tls`: ゲートウェイ接続に TLS を使用する
- `--tls-fingerprint <sha256>`: 期待される TLS 証明書フィンガープリント（sha256）
- `--node-id <id>`: ノード ID を上書きする（ペアリング トークンをクリア）
- `--display-name <name>`: ノードの表示名を上書きする
- `--runtime <runtime>`: サービスのランタイム（`node` または `bun`）
- `--force`: 既にインストールされている場合に再インストール／上書きする

サービスの管理:

```bash
openclaw node status
openclaw node stop
openclaw node restart
openclaw node uninstall
```

フォアグラウンドのノード ホスト（サービスなし）には `openclaw node run` を使用してください。

サービス コマンドは、機械可読な出力のために `--json` を受け付けます。

## Pairing

最初の接続時に、Gateway 上で保留中のノード ペア要求が作成されます。
次の方法で承認してください:
承認:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

ノード ホストは、ノード ID、トークン、表示名、およびゲートウェイ接続情報を
`~/.openclaw/node.json` に保存します。

## 実行承認

`system.run` は、ローカルの実行承認によって制御されます:

- `~/.openclaw/exec-approvals.json`
- [実行承認](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>`（Gateway から編集）
