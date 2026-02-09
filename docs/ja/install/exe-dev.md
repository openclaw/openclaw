---
summary: "リモートアクセスのために exe.dev（VM + HTTPS プロキシ）で OpenClaw Gateway（ゲートウェイ）を実行します"
read_when:
  - Gateway（ゲートウェイ）用に安価で常時稼働の Linux ホストが必要な場合
  - 自分で VPS を運用せずにリモート Control UI にアクセスしたい場合
title: "exe.dev"
---

# exe.dev

目的：exe.dev の VM 上で OpenClaw Gateway（ゲートウェイ）を実行し、ノート PC から `https://<vm-name>.exe.xyz` 経由で到達可能にします。

このページは、exe.dev の既定の **exeuntu** イメージを前提としています。別のディストリビューションを選択した場合は、パッケージを適宜読み替えてください。 別のdistroを選択した場合は、それに応じてパッケージをマップします。

## 初心者向けクイックパス

1. [https://exe.new/openclaw](https://exe.new/openclaw)
2. 必要に応じて認証キー／トークンを入力します
3. VM の横にある「Agent」をクリックし、待機します…
4. ???
5. 利益

## 必要なもの

- exe.dev アカウント
- [exe.dev](https://exe.dev) 仮想マシンへの `ssh exe.dev` アクセス（任意）

## Shelley による自動インストール

exe.dev のエージェントである Shelley は、当社のプロンプトを使って OpenClaw を即座にインストールできます。
使用されるプロンプトは以下のとおりです： 使用するプロンプトは以下のとおりです。

```
Set up OpenClaw (https://docs.openclaw.ai/install) on this VM. Use the non-interactive and accept-risk flags for openclaw onboarding. Add the supplied auth or token as needed. Configure nginx to forward from the default port 18789 to the root location on the default enabled site config, making sure to enable Websocket support. Pairing is done by "openclaw devices list" and "openclaw device approve <request id>". Make sure the dashboard shows that OpenClaw's health is OK. exe.dev handles forwarding from port 8000 to port 80/443 and HTTPS for us, so the final "reachable" should be <vm-name>.exe.xyz, without port specification.
```

## 手動インストール

## 1. VM を作成する

お使いのデバイスから：

```bash
ssh exe.dev new
```

その後、接続します：

```bash
ssh <vm-name>.exe.xyz
```

ヒント: この VM を **状態** に保ちます。 OpenClawは`~/.openclaw/`と`~/.openclaw/workspace/`の下の状態を保存します。

## 2. 前提条件をインストール（VM 上）

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

## 3. OpenClaw をインストール

OpenClaw のインストールスクリプトを実行します：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## 4. nginx を設定して OpenClaw をポート 8000 にプロキシする

`/etc/nginx/sites-enabled/default` を編集し、以下を設定します：

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

        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Standard proxy headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeout settings for long-lived connections
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

## 5. OpenClaw にアクセスして権限を付与する

`https://<vm-name>.exe.xyz/` にアクセスします (オンボードからの制御UI出力を参照)。 `https://<vm-name>.exe.xyz/` にアクセスします（オンボーディング時の Control UI の出力を参照）。認証を求められた場合は、VM 上の `gateway.auth.token` にあるトークンを貼り付けてください（`openclaw config get gateway.auth.token` で取得するか、`openclaw doctor --generate-gateway-token` で生成できます）。`openclaw devices list` および `openclaw devices approve <requestId>` を使用してデバイスを承認します。迷った場合は、ブラウザーから Shelley を使用してください。 `openclaw devices list` と
`openclaw devices approved <requestId> ` でデバイスを承認します。 疑わしいときは、お使いのブラウザからShelleyを使用してください!

## リモートアクセス

リモートアクセスは、[exe.dev](https://exe.dev) の認証によって処理されます。既定では、ポート 8000 からの HTTP トラフィックは、メール認証付きで `https://<vm-name>.exe.xyz` に転送されます。
デフォルトでは、8000 からの HTTP トラフィックは Eメールで `https://<vm-name>.exe.xyz`
に転送されます。

## 更新

```bash
npm i -g openclaw@latest
openclaw doctor
openclaw gateway restart
openclaw health
```

ガイド：[Updating](/install/updating)
