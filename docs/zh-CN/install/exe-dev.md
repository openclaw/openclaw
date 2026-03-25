---
read_when:
  - 你想为 Gateway 网关使用一台便宜且始终在线的 Linux 主机
  - 你想在不自行运行 VPS 的情况下远程访问控制 UI
summary: 在 exe.dev 上运行 OpenClaw Gateway 网关（VM + HTTPS 代理）以实现远程访问
title: exe.dev
x-i18n:
  generated_at: "2026-03-16T06:23:23Z"
  model: gpt-5.4
  provider: openai
  source_hash: 3c90f57e37145333429328477a3e12306586aa53283127daec75e065dbb85e39
  source_path: install/exe-dev.md
  workflow: 15
---

# exe.dev

目标：让 OpenClaw Gateway 网关运行在 exe.dev VM 上，并且可通过你的笔记本电脑访问：`https://<vm-name>.exe.xyz`

本页假设你使用的是 exe.dev 默认的 **exeuntu** 镜像。如果你选择了不同的发行版，请相应调整软件包。

## 面向初学者的快速路径

1. [https://exe.new/openclaw](https://exe.new/openclaw)
2. 根据需要填写你的身份验证密钥/令牌
3. 点击你的 VM 旁边的 “Agent”，然后等待……
4. ???
5. 成功

## 你需要准备的内容

- exe.dev 账户
- 对 [exe.dev](https://exe.dev) 虚拟机的 `ssh exe.dev` 访问权限（可选）

## 使用 Shelley 自动安装

Shelley 是 [exe.dev](https://exe.dev) 的智能体，可以使用我们的提示词立即安装 OpenClaw。
使用的提示词如下：

```
Set up OpenClaw (https://docs.openclaw.ai/install) on this VM. Use the non-interactive and accept-risk flags for openclaw onboarding. Add the supplied auth or token as needed. Configure nginx to forward from the default port 18789 to the root location on the default enabled site config, making sure to enable Websocket support. Pairing is done by "openclaw devices list" and "openclaw devices approve <request id>". Make sure the dashboard shows that OpenClaw's health is OK. exe.dev handles forwarding from port 8000 to port 80/443 and HTTPS for us, so the final "reachable" should be <vm-name>.exe.xyz, without port specification.
```

## 手动安装

## 1）创建 VM

在你的设备上运行：

```bash
ssh exe.dev new
```

然后连接：

```bash
ssh <vm-name>.exe.xyz
```

提示：请让这个 VM 保持**有状态**。OpenClaw 会将状态存储在 `~/.openclaw/` 和 `~/.openclaw/workspace/` 下。

## 2）安装前置依赖（在 VM 上）

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

## 3）安装 OpenClaw

运行 OpenClaw 安装脚本：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## 4）设置 nginx，将 OpenClaw 代理到端口 8000

编辑 `/etc/nginx/sites-enabled/default`，内容如下：

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

## 5）访问 OpenClaw 并授予权限

访问 `https://<vm-name>.exe.xyz/`（请查看新手引导输出中的控制 UI）。如果提示进行身份验证，请粘贴 VM 上的
`gateway.auth.token` 中的令牌（可通过 `openclaw config get gateway.auth.token` 获取，或使用
`openclaw doctor --generate-gateway-token` 生成）。使用 `openclaw devices list` 和
`openclaw devices approve <requestId>` 批准设备。如果拿不准，请在浏览器中使用 Shelley！

## 远程访问

远程访问由 [exe.dev](https://exe.dev) 的身份验证处理。默认情况下，
来自端口 8000 的 HTTP 流量会被转发到 `https://<vm-name>.exe.xyz`，
并使用电子邮件身份验证。

## 更新

```bash
npm i -g openclaw@latest
openclaw doctor
openclaw gateway restart
openclaw health
```

指南：[Updating](/install/updating)
