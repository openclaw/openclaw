---
summary: "在 exe.dev（VM + HTTPS 代理）上執行 OpenClaw Gateway 閘道器，以進行遠端存取"
read_when:
  - 你需要一個便宜且常駐的 Linux 主機來執行 Gateway 閘道器
  - 你希望在不自行架設 VPS 的情況下，進行遠端 Control UI 存取
title: "exe.dev"
---

# exe.dev

目標：在 exe.dev 的 VM 上執行 OpenClaw Gateway 閘道器，並可從你的筆電透過以下方式連線：`https://<vm-name>.exe.xyz`

This page assumes exe.dev's default **exeuntu** image. If you picked a different distro, map packages accordingly.

## 初學者快速路徑

1. [https://exe.new/openclaw](https://exe.new/openclaw)
2. Fill in your auth key/token as needed
3. 在你的 VM 旁點擊「Agent」，然後等待……
4. ???
5. 獲利

## What you need

- exe.dev 帳戶
- 對 [exe.dev](https://exe.dev) 虛擬機器的 `ssh exe.dev` 存取（選用）

## 使用 Shelley 的自動化安裝

Shelley 是 [exe.dev](https://exe.dev) 的代理程式，可透過我們的提示即時安裝 OpenClaw。
所使用的提示如下： The prompt used is as below:

```
Set up OpenClaw (https://docs.openclaw.ai/install) on this VM. Use the non-interactive and accept-risk flags for openclaw onboarding. Add the supplied auth or token as needed. Configure nginx to forward from the default port 18789 to the root location on the default enabled site config, making sure to enable Websocket support. Pairing is done by "openclaw devices list" and "openclaw device approve <request id>". Make sure the dashboard shows that OpenClaw's health is OK. exe.dev handles forwarding from port 8000 to port 80/443 and HTTPS for us, so the final "reachable" should be <vm-name>.exe.xyz, without port specification.
```

## 手動安裝

## 1. 建立 VM

從你的裝置：

```bash
ssh exe.dev new
```

然後連線：

```bash
ssh <vm-name>.exe.xyz
```

Tip: keep this VM **stateful**. OpenClaw stores state under `~/.openclaw/` and `~/.openclaw/workspace/`.

## 2. 安裝先決條件（於 VM 上）

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

## 3. 安裝 OpenClaw

執行 OpenClaw 安裝腳本：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## 4. 設定 nginx 將 OpenClaw 代理到連接埠 8000

編輯 `/etc/nginx/sites-enabled/default`，內容如下：

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

## 5. 存取 OpenClaw 並授予權限

Access `https://<vm-name>.exe.xyz/` (see the Control UI output from onboarding). If it prompts for auth, paste the
token from `gateway.auth.token` on the VM (retrieve with `openclaw config get gateway.auth.token`, or generate one
with `openclaw doctor --generate-gateway-token`). Approve devices with `openclaw devices list` and
`openclaw devices approve <requestId>`. When in doubt, use Shelley from your browser!

## Remote Access

Remote access is handled by [exe.dev](https://exe.dev)'s authentication. By
default, HTTP traffic from port 8000 is forwarded to `https://<vm-name>.exe.xyz`
with email auth.

## 更新

```bash
npm i -g openclaw@latest
openclaw doctor
openclaw gateway restart
openclaw health
```

指南：[Updating](/install/updating)
