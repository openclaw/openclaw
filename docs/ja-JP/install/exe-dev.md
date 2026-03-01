---
summary: "exe.dev（VM + HTTPSプロキシ）上でOpenClaw Gatewayを実行してリモートアクセスする"
read_when:
  - Gateway用の安価な常時稼働Linuxホストが必要な場合
  - 自分でVPSを運用せずにリモートControl UIアクセスが必要な場合
title: "exe.dev"
---

# exe.dev

目標：exe.dev VM上でOpenClaw Gatewayを実行し、ラップトップから`https://<vm-name>.exe.xyz`経由でアクセス可能にする。

このページはexe.devのデフォルトの**exeuntu**イメージを前提としています。異なるディストリビューションを選択した場合は、パッケージを適宜マッピングしてください。

## 初心者向けクイックパス

1. [https://exe.new/openclaw](https://exe.new/openclaw)
2. 必要に応じて認証キー/トークンを入力
3. VMの横の「Agent」をクリックして待機...
4. ???
5. 完了

## 必要なもの

- exe.devアカウント
- [exe.dev](https://exe.dev)仮想マシンへの`ssh exe.dev`アクセス（オプション）

## Shelleyによる自動インストール

[exe.dev](https://exe.dev)のエージェントであるShelleyは、以下のプロンプトを使用してOpenClawを即座にインストールできます。使用されるプロンプトは以下の通りです：

```
Set up OpenClaw (https://docs.openclaw.ai/install) on this VM. Use the non-interactive and accept-risk flags for openclaw onboarding. Add the supplied auth or token as needed. Configure nginx to forward from the default port 18789 to the root location on the default enabled site config, making sure to enable Websocket support. Pairing is done by "openclaw devices list" and "openclaw devices approve <request id>". Make sure the dashboard shows that OpenClaw's health is OK. exe.dev handles forwarding from port 8000 to port 80/443 and HTTPS for us, so the final "reachable" should be <vm-name>.exe.xyz, without port specification.
```

## 手動インストール

## 1）VMの作成

デバイスから：

```bash
ssh exe.dev new
```

その後接続：

```bash
ssh <vm-name>.exe.xyz
```

ヒント：このVMは**ステートフル**に保ってください。OpenClawは`~/.openclaw/`と`~/.openclaw/workspace/`に状態を保存します。

## 2）前提条件のインストール（VM上）

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

## 3）OpenClawのインストール

OpenClawインストールスクリプトを実行：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## 4）OpenClawをポート8000にプロキシするためのnginxセットアップ

`/etc/nginx/sites-enabled/default`を以下の内容で編集してください：

```
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    listen 8000;
    listen [::]:8000;

    server_name _;

    location / {
        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;

        # WebSocketサポート
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # 標準プロキシヘッダー
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 長時間接続用のタイムアウト設定
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

## 5）OpenClawへのアクセスと権限の付与

`https://<vm-name>.exe.xyz/`にアクセスしてください（オンボーディングからのControl UI出力を参照）。認証を求められた場合は、VM上の`gateway.auth.token`からトークンを貼り付けてください（`openclaw config get gateway.auth.token`で取得、または`openclaw doctor --generate-gateway-token`で生成）。`openclaw devices list`と`openclaw devices approve <requestId>`でデバイスを承認してください。分からない場合は、ブラウザからShelleyを使用してください。

## リモートアクセス

リモートアクセスは[exe.dev](https://exe.dev)の認証によって処理されます。デフォルトでは、ポート8000からのHTTPトラフィックがメール認証付きで`https://<vm-name>.exe.xyz`に転送されます。

## アップデート

```bash
npm i -g openclaw@latest
openclaw doctor
openclaw gateway restart
openclaw health
```

ガイド：[アップデート](/install/updating)
