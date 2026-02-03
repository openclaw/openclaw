---
read_when:
  - 你想要一个便宜的常驻 Linux 主机来运行 Gateway网关
  - 你想在不自行运维 VPS 的情况下远程访问控制面板 UI
summary: 在 exe.dev 上运行 OpenClaw Gateway网关（虚拟机 + HTTPS 代理）以实现远程访问
title: exe.dev
x-i18n:
  generated_at: "2026-02-01T21:20:17Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: d4697efb0ff219f6222a932e89572182d311b267c393297b052c1296a6936eda
  source_path: platforms/exe-dev.md
  workflow: 15
---

# exe.dev

目标：在 exe.dev 虚拟机上运行 OpenClaw Gateway网关，通过以下地址从你的笔记本访问：`https://<vm-name>.exe.xyz`

本页假设使用 exe.dev 的默认 **exeuntu** 镜像。如果你选择了其他发行版，请相应调整软件包。

## 新手快速路径

1. [https://exe.new/openclaw](https://exe.new/openclaw)
2. 根据需要填入你的认证密钥/令牌
3. 点击虚拟机旁边的"Agent"，然后等待...
4. ???
5. 完成

## 你需要什么

- exe.dev 账户
- 通过 `ssh exe.dev` 访问 [exe.dev](https://exe.dev) 虚拟机（可选）

## 使用 Shelley 自动安装

Shelley 是 [exe.dev](https://exe.dev) 的智能体，可以通过我们的提示词即时安装 OpenClaw。使用的提示词如下：

```
Set up OpenClaw (https://docs.openclaw.ai/install) on this VM. Use the non-interactive and accept-risk flags for openclaw onboarding. Add the supplied auth or token as needed. Configure nginx to forward from the default port 18789 to the root location on the default enabled site config, making sure to enable Websocket support. Pairing is done by "openclaw devices list" and "openclaw device approve <request id>". Make sure the dashboard shows that OpenClaw's health is OK. exe.dev handles forwarding from port 8000 to port 80/443 and HTTPS for us, so the final "reachable" should be <vm-name>.exe.xyz, without port specification.
```

## 手动安装

## 1）创建虚拟机

从你的设备：

```bash
ssh exe.dev new
```

然后连接：

```bash
ssh <vm-name>.exe.xyz
```

提示：保持此虚拟机为**有状态**。OpenClaw 将状态存储在 `~/.openclaw/` 和 `~/.openclaw/workspace/` 下。

## 2）安装前置依赖（在虚拟机上）

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

## 3）安装 OpenClaw

运行 OpenClaw 安装脚本：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## 4）配置 nginx 将 OpenClaw 代理到端口 8000

编辑 `/etc/nginx/sites-enabled/default`：

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

        # WebSocket 支持
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # 标准代理头
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 长连接超时设置
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

## 5）访问 OpenClaw 并授予权限

访问 `https://<vm-name>.exe.xyz/?token=YOUR-TOKEN-FROM-TERMINAL`。使用 `openclaw devices list` 和 `openclaw device approve` 审批设备。如果不确定，可以从浏览器使用 Shelley！

## 远程访问

远程访问由 [exe.dev](https://exe.dev) 的认证机制处理。默认情况下，端口 8000 的 HTTP 流量会被转发到 `https://<vm-name>.exe.xyz`，并通过邮箱认证。

## 更新

```bash
npm i -g openclaw@latest
openclaw doctor
openclaw gateway restart
openclaw health
```

指南：[更新](/install/updating)
