---
summary: "在 Oracle Cloud 免费 ARM 层托管 OpenClaw"
read_when:
  - 在 Oracle Cloud 上设置 OpenClaw
  - 为 OpenClaw 寻找免费 VPS 托管
  - 想在小服务器上运行 24/7 OpenClaw
title: "Oracle Cloud"
---

# Oracle Cloud

在 Oracle Cloud 的 **Always Free** ARM 层（最高 4 OCPU、24 GB RAM、200 GB 存储）上运行持久的 OpenClaw Gateway，完全免费。

## 前提条件

- Oracle Cloud 账户（[注册](https://www.oracle.com/cloud/free/)）— 如果遇到问题，请参阅[社区注册指南](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd)
- Tailscale 账户（免费，在 [tailscale.com](https://tailscale.com)）
- SSH 密钥对
- 大约 30 分钟

## 设置

<Steps>
  <Step title="创建 OCI 实例">
    1. 登录 [Oracle Cloud Console](https://cloud.oracle.com/)。
    2. 导航到 **Compute > Instances > Create Instance**。
    3. 配置：
       - **名称：** `openclaw`
       - **镜像：** Ubuntu 24.04 (aarch64)
       - **规格：** `VM.Standard.A1.Flex` (Ampere ARM)
       - **OCPU：** 2（或最多 4）
       - **内存：** 12 GB（或最多 24 GB）
       - **启动卷：** 50 GB（最多 200 GB 免费）
       - **SSH 密钥：** 添加您的公钥
    4. 点击 **Create** 并记下公网 IP 地址。

    <Tip>
    如果实例创建失败并显示“Out of capacity”，请尝试不同的可用性域或稍后重试。免费层容量有限。
    </Tip>

  </Step>

  <Step title="连接并更新系统">
    ```bash
    ssh ubuntu@YOUR_PUBLIC_IP

    sudo apt update && sudo apt upgrade -y
    sudo apt install -y build-essential
    ```

    `build-essential` 是某些依赖项 ARM 编译所需的。

  </Step>

  <Step title="配置用户和主机名">
    ```bash
    sudo hostnamectl set-hostname openclaw
    sudo passwd ubuntu
    sudo loginctl enable-linger ubuntu
    ```

    启用 linger 可以让用户服务在注销后继续运行。

  </Step>

  <Step title="安装 Tailscale">
    ```bash
    curl -fsSL https://tailscale.com/install.sh | sh
    sudo tailscale up --ssh --hostname=openclaw
    ```

    从现在起，通过 Tailscale 连接：`ssh ubuntu@openclaw`。

  </Step>

  <Step title="安装 OpenClaw">
    ```bash
    curl -fsSL https://openclaw.ai/install.sh | bash
    source ~/.bashrc
    ```

    当提示“如何孵化您的机器人？”时，选择**稍后执行此操作**。

  </Step>

  <Step title="配置 Gateway">
    使用令牌认证和 Tailscale Serve 进行安全的远程访问。

    ```bash
    openclaw config set gateway.bind loopback
    openclaw config set gateway.auth.mode token
    openclaw doctor --generate-gateway-token
    openclaw config set gateway.tailscale.mode serve
    openclaw config set gateway.trustedProxies '["127.0.0.1"]'

    systemctl --user restart openclaw-gateway
    ```

  </Step>

  <Step title="锁定 VCN 安全">
    在网络边缘阻止除 Tailscale 之外的所有流量：

    1. 在 OCI Console 中转到 **Networking > Virtual Cloud Networks**。
    2. 点击您的 VCN，然后 **Security Lists > Default Security List**。
    3. **删除**所有入口规则 except `0.0.0.0/0 UDP 41641` (Tailscale)。
    4. 保留默认出口规则（允许所有出站）。

    这会在网络边缘阻止端口 22 上的 SSH、HTTP、HTTPS 和其他所有内容。从现在开始，您只能通过 Tailscale 连接。

  </Step>
  <Step title="验证">
    ```bash
    openclaw --version
    systemctl --user status openclaw-gateway
    tailscale serve status
    curl http://localhost:18789
    ```

    从 tailnet 上的任何设备访问 Control UI：

    ```
    https://openclaw.<tailnet-name>.ts.net/
    ```

    将 `<tailnet-name>` 替换为您的 tailnet 名称（可在 `tailscale status` 中查看）。

  </Step>
</Steps>

## 后备：SSH 隧道

如果 Tailscale Serve 不起作用，请从本地机器使用 SSH 隧道：

```bash
ssh -L 18789:127.0.0.1:18789 ubuntu@openclaw
```

然后打开 `http://localhost:18789`。

## 故障排除

**实例创建失败（“Out of capacity”）** — 免费层 ARM 实例很受欢迎。请尝试不同的可用性域或在非高峰时段重试。

**Tailscale 无法连接** — 运行 `sudo tailscale up --ssh --hostname=openclaw --reset` 重新认证。

**Gateway 无法启动** — 运行 `openclaw doctor --non-interactive` 并使用 `journalctl --user -u openclaw-gateway -n 50` 检查日志。

**ARM 二进制问题** — 大多数 npm 包在 ARM64 上可以正常工作。对于原生二进制文件，请查找 `linux-arm64` 或 `aarch64` 版本。使用 `uname -m` 验证架构。

## 后续步骤

- [频道](/channels) — 连接 Telegram、WhatsApp、Discord 等
- [Gateway 配置](/gateway/configuration) — 所有配置选项
- [更新](/install/updating) — 保持 OpenClaw 最新