---
read_when:
  - 你希望将 OpenClaw 与主 macOS 环境隔离运行
  - 你需要在沙盒中集成 iMessage（BlueBubbles）
  - 你需要一个可重置、可克隆的 macOS 环境
  - 你想比较本地与托管 macOS 虚拟机方案
summary: 在沙盒化的 macOS 虚拟机（本地或托管）中运行 OpenClaw，适用于需要隔离环境或 iMessage 的场景
title: macOS 虚拟机
x-i18n:
  generated_at: "2026-02-01T21:33:51Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 4d1c85a5e4945f9f0796038cd5960edecb71ec4dffb6f9686be50adb75180716
  source_path: platforms/macos-vm.md
  workflow: 15
---

# 在 macOS 虚拟机上运行 OpenClaw（沙盒化）

## 推荐默认方案（大多数用户）

- **小型 Linux VPS**，用于始终在线的 Gateway网关，成本低廉。参阅 [VPS 托管](/vps)。
- **专用硬件**（Mac mini 或 Linux 主机），如果你需要完全控制和**住宅 IP** 以进行浏览器自动化。许多网站会屏蔽数据中心 IP，因此本地浏览通常效果更好。
- **混合方案：** 将 Gateway网关部署在廉价 VPS 上，需要浏览器/UI 自动化时将你的 Mac 作为**节点**连接。参阅 [节点](/nodes) 和 [Gateway网关远程控制](/gateway/remote)。

当你特别需要 macOS 专有功能（iMessage/BlueBubbles）或希望与日常使用的 Mac 严格隔离时，请使用 macOS 虚拟机。

## macOS 虚拟机方案

### 在 Apple Silicon Mac 上运行本地虚拟机（Lume）

使用 [Lume](https://cua.ai/docs/lume) 在现有的 Apple Silicon Mac 上以沙盒化的 macOS 虚拟机运行 OpenClaw。

这将为你提供：

- 隔离的完整 macOS 环境（宿主机保持干净）
- 通过 BlueBubbles 支持 iMessage（Linux/Windows 上无法实现）
- 通过克隆虚拟机即时重置
- 无需额外硬件或云端费用

### 托管 Mac 提供商（云端）

如果你需要云端的 macOS，托管 Mac 提供商也可以：

- [MacStadium](https://www.macstadium.com/)（托管 Mac）
- 其他托管 Mac 供应商同样适用；按照其虚拟机 + SSH 文档操作

获得 macOS 虚拟机的 SSH 访问权限后，继续下方步骤 6。

---

## 快速路径（Lume，有经验的用户）

1. 安装 Lume
2. `lume create openclaw --os macos --ipsw latest`
3. 完成设置助理，启用远程登录（SSH）
4. `lume run openclaw --no-display`
5. SSH 登录，安装 OpenClaw，配置渠道
6. 完成

---

## 准备工作（Lume）

- Apple Silicon Mac（M1/M2/M3/M4）
- 宿主机运行 macOS Sequoia 或更高版本
- 每个虚拟机约 60 GB 可用磁盘空间
- 约 20 分钟

---

## 1) 安装 Lume

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/lume/scripts/install.sh)"
```

如果 `~/.local/bin` 不在你的 PATH 中：

```bash
echo 'export PATH="$PATH:$HOME/.local/bin"' >> ~/.zshrc && source ~/.zshrc
```

验证：

```bash
lume --version
```

文档：[Lume 安装指南](https://cua.ai/docs/lume/guide/getting-started/installation)

---

## 2) 创建 macOS 虚拟机

```bash
lume create openclaw --os macos --ipsw latest
```

这将下载 macOS 并创建虚拟机。VNC 窗口会自动打开。

注意：下载时间取决于你的网络连接速度。

---

## 3) 完成设置助理

在 VNC 窗口中：

1. 选择语言和地区
2. 跳过 Apple ID（如果以后需要 iMessage 则登录）
3. 创建用户账户（记住用户名和密码）
4. 跳过所有可选功能

设置完成后，启用 SSH：

1. 打开系统设置 → 通用 → 共享
2. 启用"远程登录"

---

## 4) 获取虚拟机的 IP 地址

```bash
lume get openclaw
```

查找 IP 地址（通常为 `192.168.64.x`）。

---

## 5) SSH 登录虚拟机

```bash
ssh youruser@192.168.64.X
```

将 `youruser` 替换为你创建的账户，IP 替换为你的虚拟机 IP。

---

## 6) 安装 OpenClaw

在虚拟机内：

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

按照新手引导提示设置你的模型提供商（Anthropic、OpenAI 等）。

---

## 7) 配置渠道

编辑配置文件：

```bash
nano ~/.openclaw/openclaw.json
```

添加你的渠道：

```json
{
  "channels": {
    "whatsapp": {
      "dmPolicy": "allowlist",
      "allowFrom": ["+15551234567"]
    },
    "telegram": {
      "botToken": "YOUR_BOT_TOKEN"
    }
  }
}
```

然后登录 WhatsApp（扫描二维码）：

```bash
openclaw channels login
```

---

## 8) 无界面运行虚拟机

停止虚拟机并以无显示模式重启：

```bash
lume stop openclaw
lume run openclaw --no-display
```

虚拟机将在后台运行。OpenClaw 的守护进程会保持 Gateway网关运行。

检查状态：

```bash
ssh youruser@192.168.64.X "openclaw status"
```

---

## 附加功能：iMessage 集成

这是在 macOS 上运行的杀手级功能。使用 [BlueBubbles](https://bluebubbles.app) 将 iMessage 添加到 OpenClaw。

在虚拟机内：

1. 从 bluebubbles.app 下载 BlueBubbles
2. 使用你的 Apple ID 登录
3. 启用 Web API 并设置密码
4. 将 BlueBubbles webhook 指向你的 Gateway网关（示例：`https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`）

添加到你的 OpenClaw 配置：

```json
{
  "channels": {
    "bluebubbles": {
      "serverUrl": "http://localhost:1234",
      "password": "your-api-password",
      "webhookPath": "/bluebubbles-webhook"
    }
  }
}
```

重启 Gateway网关。现在你的智能体可以收发 iMessage 了。

完整设置详情：[BlueBubbles 渠道](/channels/bluebubbles)

---

## 保存黄金镜像

在进一步自定义之前，快照保存你的干净状态：

```bash
lume stop openclaw
lume clone openclaw openclaw-golden
```

随时重置：

```bash
lume stop openclaw && lume delete openclaw
lume clone openclaw-golden openclaw
lume run openclaw --no-display
```

---

## 全天候运行

通过以下方式保持虚拟机运行：

- 保持 Mac 接通电源
- 在系统设置 → 节能中禁用睡眠
- 如有需要使用 `caffeinate`

如需真正的始终在线，请考虑专用 Mac mini 或小型 VPS。参阅 [VPS 托管](/vps)。

---

## 故障排除

| 问题                    | 解决方案                                                        |
| ----------------------- | --------------------------------------------------------------- |
| 无法 SSH 登录虚拟机     | 检查虚拟机系统设置中是否已启用"远程登录"                        |
| 虚拟机 IP 未显示        | 等待虚拟机完全启动，再次运行 `lume get openclaw`                |
| Lume 命令未找到         | 将 `~/.local/bin` 添加到你的 PATH                               |
| WhatsApp 二维码无法扫描 | 确保运行 `openclaw channels login` 时登录的是虚拟机（非宿主机） |

---

## 相关文档

- [VPS 托管](/vps)
- [节点](/nodes)
- [Gateway网关远程控制](/gateway/remote)
- [BlueBubbles 渠道](/channels/bluebubbles)
- [Lume 快速入门](https://cua.ai/docs/lume/guide/getting-started/quickstart)
- [Lume CLI 参考](https://cua.ai/docs/lume/reference/cli-reference)
- [无人值守虚拟机设置](https://cua.ai/docs/lume/guide/fundamentals/unattended-setup)（高级）
- [Docker 沙盒化](/install/docker)（替代隔离方案）
