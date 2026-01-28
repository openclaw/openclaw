---
read_when:
  - 在 Windows 上安装 OpenClaw
  - 了解 Windows 伴侣应用的状态
summary: Windows (WSL2) 支持 + 伴侣应用状态
title: Windows (WSL2)
x-i18n:
  generated_at: "2026-02-01T21:34:13Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: c93d2263b4e5b60cb6fbe9adcb1a0ca95b70cd6feb6e63cfc4459cb18b229da0
  source_path: platforms/windows.md
  workflow: 15
---

# Windows (WSL2)

推荐**通过 WSL2** 在 Windows 上使用 OpenClaw（建议使用 Ubuntu）。CLI + Gateway网关在 Linux 内运行，这样可以保持运行时一致性，并使工具链兼容性更好（Node/Bun/pnpm、Linux 二进制文件、Skills）。原生 Windows 可能会更麻烦。WSL2 为你提供完整的 Linux 体验——一条命令即可安装：`wsl --install`。

原生 Windows 伴侣应用已在计划中。

## 安装（WSL2）

- [快速开始](/start/getting-started)（在 WSL 内使用）
- [安装与更新](/install/updating)
- 官方 WSL2 指南（Microsoft）：https://learn.microsoft.com/windows/wsl/install

## Gateway网关

- [Gateway网关运行手册](/gateway)
- [配置](/gateway/configuration)

## Gateway网关服务安装（CLI）

在 WSL2 内：

```
openclaw onboard --install-daemon
```

或：

```
openclaw gateway install
```

或：

```
openclaw configure
```

出现提示时选择 **Gateway网关服务**。

修复/迁移：

```
openclaw doctor
```

## 进阶：通过局域网暴露 WSL 服务（portproxy）

WSL 拥有自己的虚拟网络。如果另一台机器需要访问 **WSL 内部** 运行的服务（SSH、本地 TTS 服务器或 Gateway网关），你必须将 Windows 端口转发到当前 WSL IP。WSL IP 在重启后会改变，因此你可能需要刷新转发规则。

示例（以**管理员身份**运行 PowerShell）：

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

通过 Windows 防火墙放行端口（一次性操作）：

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

WSL 重启后刷新 portproxy：

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

注意事项：

- 从另一台机器通过 SSH 连接时，目标是 **Windows 主机 IP**（例如：`ssh user@windows-host -p 2222`）。
- 远程节点必须指向一个**可达的** Gateway网关 URL（而非 `127.0.0.1`）；使用 `openclaw status --all` 来确认。
- 使用 `listenaddress=0.0.0.0` 进行局域网访问；`127.0.0.1` 仅限本地访问。
- 如果你希望自动执行，可以注册一个计划任务，在登录时运行刷新步骤。

## 分步 WSL2 安装指南

### 1) 安装 WSL2 + Ubuntu

打开 PowerShell（管理员）：

```powershell
wsl --install
# 或明确选择一个发行版：
wsl --list --online
wsl --install -d Ubuntu-24.04
```

如果 Windows 提示，请重启。

### 2) 启用 systemd（Gateway网关安装所需）

在你的 WSL 终端中：

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

然后在 PowerShell 中：

```powershell
wsl --shutdown
```

重新打开 Ubuntu，然后验证：

```bash
systemctl --user status
```

### 3) 安装 OpenClaw（在 WSL 内）

在 WSL 内按照 Linux 快速开始流程操作：

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # 首次运行时自动安装 UI 依赖
pnpm build
openclaw onboard
```

完整指南：[快速开始](/start/getting-started)

## Windows 伴侣应用

我们目前还没有 Windows 伴侣应用。如果你希望推动此功能的实现，欢迎贡献代码。
