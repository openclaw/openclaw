---
read_when:
    - Gateway ゲートウェイ用の安価な常時稼働Linuxホストが欲しい場合
    - 自前のVPSを運用せずにリモートからコントロールUIにアクセスしたい場合
summary: exe.dev（VM + HTTPSプロキシ）でOpenClaw Gateway ゲートウェイを実行してリモートアクセスする
title: exe.dev
x-i18n:
    generated_at: "2026-04-02T07:45:20Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 1c03d4daae8a90275c803f3be8ca12aada00dc59ab1934c132bafa953736cc63
    source_path: install/exe-dev.md
    workflow: 15
---

# exe.dev

目標：exe.dev VM上でOpenClaw Gateway ゲートウェイを実行し、ノートPCから`https://<vm-name>.exe.xyz`経由でアクセスできるようにする

このページはexe.devのデフォルト**exeuntu**イメージを前提としています。別のディストリビューションを選択した場合は、パッケージを適宜読み替えてください。

## 初心者向けクイックパス

1. [https://exe.new/openclaw](https://exe.new/openclaw)
2. 必要に応じて認証キー/トークンを入力する
3. VM横の「Agent」をクリックし、Shelleyのプロビジョニング完了を待つ
4. `https://<vm-name>.exe.xyz/`を開き、Gateway ゲートウェイトークンを貼り付けて認証する
5. 保留中のデバイスペアリングリクエストを`openclaw devices approve <requestId>`で承認する

## 必要なもの

- exe.devアカウント
- [exe.dev](https://exe.dev)仮想マシンへの`ssh exe.dev`アクセス（任意）

## Shelleyによる自動インストール

[exe.dev](https://exe.dev)のエージェントであるShelleyが、以下のプロンプトを使用してOpenClawを即座にインストールできます。使用されるプロンプトは以下の通りです：

```
Set up OpenClaw (https://docs.openclaw.ai/install) on this VM. Use the non-interactive and accept-risk flags for openclaw onboarding. Add the supplied auth or token as needed. Configure nginx to forward from the default port 18789 to the root location on the default enabled site config, making sure to enable Websocket support. Pairing is done by "openclaw devices list" and "openclaw devices approve <request id>". Make sure the dashboard shows that OpenClaw's health is OK. exe.dev handles forwarding from port 8000 to port 80/443 and HTTPS for us, so the final "reachable" should be <vm-name>.exe.xyz, without port specification.
```

## 手動インストール

## 1) VMを作成する

お使いのデバイスから：

```bash
ssh exe.dev new
```

次に接続します：

```bash
ssh <vm-name>.exe.xyz
```

ヒント：このVMは**ステートフル**に保ってください。OpenClawは`~/.openclaw/`および`~/.openclaw/workspace/`に状態を保存します。

## 2) 前提条件をインストールする（VM上で）

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

## 3) OpenClawをインストールする

OpenClawのインストールスクリプトを実行します：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## 4) nginxをセットアップしてOpenClawをポート8000にプロキシする

`/etc/nginx/sites-enabled/default`を以下のように編集します

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

## 5) OpenClawにアクセスして権限を付与する

`https://<vm-name>.exe.xyz/`にアクセスします（オンボーディングのコントロールUI出力を参照）。認証を求められた場合は、VM上の`gateway.auth.token`のトークンを貼り付けてください（`openclaw config get gateway.auth.token`で取得するか、`openclaw doctor --generate-gateway-token`で生成できます）。`openclaw devices list`と`openclaw devices approve <requestId>`でデバイスを承認します。迷った場合は、ブラウザからShelleyを使用してください！

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
