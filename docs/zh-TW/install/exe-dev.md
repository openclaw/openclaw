---
summary: Run OpenClaw Gateway on exe.dev (VM + HTTPS proxy) for remote access
read_when:
  - You want a cheap always-on Linux host for the Gateway
  - You want remote Control UI access without running your own VPS
title: exe.dev
---

# exe.dev

目標：在 exe.dev VM 上執行 OpenClaw Gateway，並可從您的筆電透過 `https://<vm-name>.exe.xyz` 連線

本頁假設使用 exe.dev 預設的 **exeuntu** 映像檔。如果您選擇了不同的發行版，請相應對應套件。

## 初學者快速路徑

1. [https://exe.new/openclaw](https://exe.new/openclaw)
2. 根據需求填入您的認證金鑰/token
3. 點擊您 VM 旁的「Agent」，並等待...
4. ???
5. 獲利

## 您需要的條件

- exe.dev 帳號
- `ssh exe.dev` 存取 [exe.dev](https://exe.dev) 虛擬機（選用）

## 使用 Shelley 自動安裝

Shelley 是 [exe.dev](https://exe.dev) 的代理程式，可以透過我們的提示快速安裝 OpenClaw。使用的提示如下：

```
Set up OpenClaw (https://docs.openclaw.ai/install) on this VM. Use the non-interactive and accept-risk flags for openclaw onboarding. Add the supplied auth or token as needed. Configure nginx to forward from the default port 18789 to the root location on the default enabled site config, making sure to enable Websocket support. Pairing is done by "openclaw devices list" and "openclaw devices approve <request id>". Make sure the dashboard shows that OpenClaw's health is OK. exe.dev handles forwarding from port 8000 to port 80/443 and HTTPS for us, so the final "reachable" should be <vm-name>.exe.xyz, without port specification.
```

## 手動安裝

## 1) 建立虛擬機

從您的裝置執行：

```bash
ssh exe.dev new
```

接著連線：

```bash
ssh <vm-name>.exe.xyz
```

提示：請保持此 VM **有狀態**。OpenClaw 將狀態儲存在 `~/.openclaw/` 和 `~/.openclaw/workspace/`。

## 2) 安裝前置需求（在 VM 上）

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

## 3) 安裝 OpenClaw

執行 OpenClaw 安裝腳本：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## 4) 設定 nginx 將 OpenClaw 代理到 8000 埠口

編輯 `/etc/nginx/sites-enabled/default`，內容如下

server {
listen 80 default_server;
listen [::]:80 default_server;
listen 8000;
listen [::]:8000;

server*name *;

location / {
proxy_pass http://127.0.0.1:18789;
proxy_http_version 1.1;

# WebSocket 支援

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

# 標準代理標頭

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

# 長連線的逾時設定

        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

}

## 5) 存取 OpenClaw 並授予權限

存取 `https://<vm-name>.exe.xyz/`（請參考入門時控制介面的輸出）。如果系統要求驗證，請在虛擬機器上貼上 `gateway.auth.token` 的 token（可用 `openclaw config get gateway.auth.token` 取得，或用 `openclaw doctor --generate-gateway-token` 產生新的 token）。使用 `openclaw devices list` 和 `openclaw devices approve <requestId>` 批准裝置。如有疑問，請從瀏覽器使用 Shelley！

## 遠端存取

遠端存取由 [exe.dev](https://exe.dev) 的驗證機制管理。預設情況下，來自 8000 埠的 HTTP 流量會轉發到 `https://<vm-name>.exe.xyz`，並使用電子郵件驗證。

## 更新

```bash
npm i -g openclaw@latest
openclaw doctor
openclaw gateway restart
openclaw health
```

指南：[更新](/install/updating)
