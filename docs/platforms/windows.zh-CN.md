---
summary: "Windows支持：原生和WSL2安装路径、守护进程以及当前限制"
read_when:
  - 在Windows上安装OpenClaw
  - 在原生Windows和WSL2之间选择
  - 查找Windows companion应用状态
title: "Windows"
---

# Windows

OpenClaw同时支持**原生Windows**和**WSL2**。WSL2是更稳定的路径，推荐用于完整体验——CLI、Gateway和工具在Linux内运行，具有完全的兼容性。原生Windows适用于核心CLI和Gateway使用，但存在一些限制，如下所述。

原生Windows companion应用正在规划中。

## WSL2（推荐）

- [快速开始](/start/getting-started)（在WSL内使用）
- [安装与更新](/install/updating)
- 官方WSL2指南（Microsoft）：[https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)

## 原生Windows状态

原生Windows CLI流程正在改进，但WSL2仍然是推荐的路径。

今天在原生Windows上运行良好的功能：

- 通过`install.ps1`进行网站安装
- 本地CLI使用，例如`openclaw --version`、`openclaw doctor`和`openclaw plugins list --json`
- 嵌入式本地代理/提供商测试，例如：

```powershell
openclaw agent --local --agent main --thinking low -m "Reply with exactly WINDOWS-HATCH-OK."
```

当前限制：

- `openclaw onboard --non-interactive`仍然需要一个可访问的本地网关，除非您传递`--skip-health`
- `openclaw onboard --non-interactive --install-daemon`和`openclaw gateway install`首先尝试Windows计划任务
- 如果计划任务创建被拒绝，OpenClaw会回退到每用户的启动文件夹登录项，并立即启动网关
- 如果`schtasks`本身卡住或停止响应，OpenClaw现在会快速中止该路径并回退，而不是永远挂起
- 当可用时，计划任务仍然是首选，因为它们提供更好的监督状态

如果您只想要原生CLI，不需要网关服务安装，请使用以下命令之一：

```powershell
openclaw onboard --non-interactive --skip-health
openclaw gateway run
```

如果您确实想要在原生Windows上进行托管启动：

```powershell
openclaw gateway install
openclaw gateway status --json
```

如果计划任务创建被阻止，回退服务模式仍然会通过当前用户的启动文件夹在登录后自动启动。

## Gateway

- [Gateway运行手册](/gateway)
- [配置](/gateway/configuration)

## Gateway服务安装（CLI）

在WSL2内：

```
openclaw onboard --install-daemon
```

或者：

```
openclaw gateway install
```

或者：

```
openclaw configure
```

当提示时选择**Gateway服务**。

修复/迁移：

```
openclaw doctor
```

## Windows登录前自动启动Gateway

对于无头设置，确保即使没有人登录Windows，完整的启动链也能运行。

### 1) 保持用户服务在未登录状态下运行

在WSL内：

```bash
sudo loginctl enable-linger "$(whoami)"
```

### 2) 安装OpenClaw网关用户服务

在WSL内：

```bash
openclaw gateway install
```

### 3) 在Windows启动时自动启动WSL

在PowerShell（管理员）中：

```powershell
schtasks /create /tn "WSL Boot" /tr "wsl.exe -d Ubuntu --exec /bin/true" /sc onstart /ru SYSTEM
```

将`Ubuntu`替换为您的发行版名称，可通过以下命令查看：

```powershell
wsl --list --verbose
```

### 验证启动链

重启后（在Windows登录前），从WSL检查：

```bash
systemctl --user is-enabled openclaw-gateway.service
systemctl --user status openclaw-gateway.service --no-pager
```

## 高级：通过LAN暴露WSL服务（portproxy）

WSL有自己的虚拟网络。如果另一台机器需要访问**WSL内部**运行的服务（SSH、本地TTS服务器或Gateway），您必须将Windows端口转发到当前的WSL IP。WSL IP在重启后会更改，因此您可能需要刷新转发规则。

示例（PowerShell **以管理员身份**）：

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

允许端口通过Windows防火墙（一次性）：

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

WSL重启后刷新portproxy：

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

注意：

- 从另一台机器SSH时，目标是**Windows主机IP**（例如：`ssh user@windows-host -p 2222`）。
- 远程节点必须指向**可访问**的Gateway URL（不是`127.0.0.1`）；使用`openclaw status --all`确认。
- 使用`listenaddress=0.0.0.0`进行LAN访问；`127.0.0.1`仅保持本地访问。
- 如果您希望这是自动的，请注册一个计划任务，在登录时运行刷新步骤。

## 分步WSL2安装

### 1) 安装WSL2 + Ubuntu

打开PowerShell（管理员）：

```powershell
wsl --install
# 或者明确选择发行版：
wsl --list --online
wsl --install -d Ubuntu-24.04
```

如果Windows要求，请重启。

### 2) 启用systemd（网关安装所需）

在您的WSL终端中：

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

然后从PowerShell：

```powershell
wsl --shutdown
```

重新打开Ubuntu，然后验证：

```bash
systemctl --user status
```

### 3) 安装OpenClaw（在WSL内）

在WSL内按照Linux快速开始流程：

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # 首次运行时自动安装UI依赖
pnpm build
openclaw onboard
```

完整指南：[快速开始](/start/getting-started)

## Windows companion应用

我们还没有Windows companion应用。如果您想为实现它做出贡献，我们欢迎您的贡献。
