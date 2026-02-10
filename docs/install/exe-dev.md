---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Run OpenClaw Gateway on exe.dev (VM + HTTPS proxy) for remote access"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want a cheap always-on Linux host for the Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want remote Control UI access without running your own VPS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "exe.dev"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# exe.dev（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Goal: OpenClaw Gateway running on an exe.dev VM, reachable from your laptop via: `https://<vm-name>.exe.xyz`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This page assumes exe.dev's default **exeuntu** image. If you picked a different distro, map packages accordingly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Beginner quick path（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. [https://exe.new/openclaw](https://exe.new/openclaw)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Fill in your auth key/token as needed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Click on "Agent" next to your VM, and wait...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. ???（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Profit（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What you need（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- exe.dev account（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ssh exe.dev` access to [exe.dev](https://exe.dev) virtual machines (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Automated Install with Shelley（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Shelley, [exe.dev](https://exe.dev)'s agent, can install OpenClaw instantly with our（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
prompt. The prompt used is as below:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set up OpenClaw (https://docs.openclaw.ai/install) on this VM. Use the non-interactive and accept-risk flags for openclaw onboarding. Add the supplied auth or token as needed. Configure nginx to forward from the default port 18789 to the root location on the default enabled site config, making sure to enable Websocket support. Pairing is done by "openclaw devices list" and "openclaw device approve <request id>". Make sure the dashboard shows that OpenClaw's health is OK. exe.dev handles forwarding from port 8000 to port 80/443 and HTTPS for us, so the final "reachable" should be <vm-name>.exe.xyz, without port specification.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Manual installation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 1) Create the VM（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
From your device:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ssh exe.dev new（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then connect:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ssh <vm-name>.exe.xyz（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tip: keep this VM **stateful**. OpenClaw stores state under `~/.openclaw/` and `~/.openclaw/workspace/`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2) Install prerequisites (on the VM)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo apt-get update（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo apt-get install -y git curl jq ca-certificates openssl（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 3) Install OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run the OpenClaw install script:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -fsSL https://openclaw.ai/install.sh | bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 4) Setup nginx to proxy OpenClaw to port 8000（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Edit `/etc/nginx/sites-enabled/default` with（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
server {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    listen 80 default_server;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    listen [::]:80 default_server;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    listen 8000;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    listen [::]:8000;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    server_name _;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    location / {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        proxy_pass http://127.0.0.1:18789;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        proxy_http_version 1.1;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        # WebSocket support（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        proxy_set_header Upgrade $http_upgrade;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        proxy_set_header Connection "upgrade";（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        # Standard proxy headers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        proxy_set_header Host $host;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        proxy_set_header X-Real-IP $remote_addr;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        proxy_set_header X-Forwarded-Proto $scheme;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        # Timeout settings for long-lived connections（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        proxy_read_timeout 86400s;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        proxy_send_timeout 86400s;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 5) Access OpenClaw and grant privileges（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Access `https://<vm-name>.exe.xyz/` (see the Control UI output from onboarding). If it prompts for auth, paste the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
token from `gateway.auth.token` on the VM (retrieve with `openclaw config get gateway.auth.token`, or generate one（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
with `openclaw doctor --generate-gateway-token`). Approve devices with `openclaw devices list` and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`openclaw devices approve <requestId>`. When in doubt, use Shelley from your browser!（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Remote Access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Remote access is handled by [exe.dev](https://exe.dev)'s authentication. By（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
default, HTTP traffic from port 8000 is forwarded to `https://<vm-name>.exe.xyz`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
with email auth.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Updating（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
npm i -g openclaw@latest（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway restart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw health（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Guide: [Updating](/install/updating)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
