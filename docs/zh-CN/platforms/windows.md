---
read_when:
  - 在 Windows 上安装 OpenClaw
  - 查找 Windows 配套应用状态
summary: Windows（WSL2）支持 + 配套应用状态
title: Windows（WSL2）
x-i18n:
  generated_at: "2026-03-16T06:24:52Z"
  model: gpt-5.4
  provider: openai
  source_hash: 2e905b129f34ac31e30d5767504233411b306b5985252f1a285e09f1ece19962
  source_path: platforms/windows.md
  workflow: 15
---

# Windows（WSL2）

推荐在 Windows 上**通过 WSL2** 运行 OpenClaw（推荐 Ubuntu）。CLI + Gateway 网关在 Linux 内运行，这能保持运行时一致，并使
工具链兼容性高得多（Node/Bun/pnpm、Linux 二进制文件、Skills）。原生
Windows 可能会更棘手。WSL2 可提供完整的 Linux 体验 —— 只需一条命令
即可安装：`wsl --install`。

原生 Windows 配套应用已在规划中。

## 安装（WSL2）

- [入门指南](/start/getting-started)（请在 WSL 内使用）
- [安装与更新](/install/updating)
- 官方 WSL2 指南（Microsoft）：[https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)

## 原生 Windows 状态

原生 Windows CLI 流程正在改进，但 WSL2 仍然是推荐路径。

当前在原生 Windows 上运行良好的内容：

- 通过 `install.ps1` 使用网站安装器
- 本地 CLI 用法，例如 `openclaw --version`、`openclaw doctor` 和 `openclaw plugins list --json`
- 嵌入式 local-agent/provider 冒烟测试，例如：

```powershell
openclaw agent --local --agent main --thinking low -m "Reply with exactly WINDOWS-HATCH-OK."
```

当前注意事项：

- 除非你传递 `--skip-health`，否则 `openclaw onboard --non-interactive` 仍然要求本地 Gateway 网关可访问
- `openclaw onboard --non-interactive --install-daemon` 和 `openclaw gateway install` 会优先尝试 Windows Scheduled Tasks
- 如果拒绝创建 Scheduled Task，OpenClaw 会回退到每用户 Startup 文件夹登录项，并立即启动 Gateway 网关
- 如果 `schtasks` 本身卡住或停止响应，OpenClaw 现在会快速中止该路径并回退，而不是无限挂起
- 在可用时仍优先使用 Scheduled Tasks，因为它们能提供更好的 supervisor 状态

如果你只想使用原生 CLI，而不安装 Gateway 网关服务，可使用以下任一方式：

```powershell
openclaw onboard --non-interactive --skip-health
openclaw gateway run
```

如果你确实想在原生 Windows 上使用受管启动：

```powershell
openclaw gateway install
openclaw gateway status --json
```

如果无法创建 Scheduled Task，回退服务模式仍会通过当前用户的 Startup 文件夹在登录后自动启动。

## Gateway 网关

- [Gateway 网关运行手册](/gateway)
- [配置](/gateway/configuration)

## Gateway 网关服务安装（CLI）

在 WSL2 内：

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

出现提示时，选择 **Gateway 服务**。

修复/迁移：

```
openclaw doctor
```

## 在 Windows 登录前自动启动 Gateway 网关

对于无头设置，请确保完整的启动链即使在无人登录
Windows 时也能运行。

### 1）在未登录时保持用户服务运行

在 WSL 内：

```bash
sudo loginctl enable-linger "$(whoami)"
```

### 2）安装 OpenClaw Gateway 网关用户服务

在 WSL 内：

```bash
openclaw gateway install
```

### 3）在 Windows 启动时自动启动 WSL

以管理员身份打开 PowerShell：

```powershell
schtasks /create /tn "WSL Boot" /tr "wsl.exe -d Ubuntu --exec /bin/true" /sc onstart /ru SYSTEM
```

将 `Ubuntu` 替换为以下命令输出中的发行版名称：

```powershell
wsl --list --verbose
```

### 验证启动链

重启后（在 Windows 登录前），在 WSL 中检查：

```bash
systemctl --user is-enabled openclaw-gateway
systemctl --user status openclaw-gateway --no-pager
```

## 高级：通过局域网暴露 WSL 服务（portproxy）

WSL 有自己的虚拟网络。如果另一台机器需要访问
**在 WSL 内运行**的服务（SSH、本地 TTS 服务器或 Gateway 网关），你必须
将 Windows 端口转发到当前的 WSL IP。WSL IP 会在重启后变化，
因此你可能需要刷新转发规则。

示例（**以管理员身份**打开 PowerShell）：

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

允许该端口通过 Windows 防火墙（一次性）：

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

在 WSL 重启后刷新 portproxy：

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

说明：

- 来自另一台机器的 SSH 应指向**Windows 主机 IP**（例如：`ssh user@windows-host -p 2222`）。
- 远程节点必须指向**可访问的** Gateway 网关 URL（而不是 `127.0.0.1`）；请使用
  `openclaw status --all` 进行确认。
- 使用 `listenaddress=0.0.0.0` 可供局域网访问；`127.0.0.1` 则仅限本地。
- 如果你希望自动执行此操作，请注册一个 Scheduled Task，在登录时运行刷新
  步骤。

## 分步 WSL2 安装

### 1）安装 WSL2 + Ubuntu

打开 PowerShell（管理员）：

```powershell
wsl --install
# 或显式选择一个发行版：
wsl --list --online
wsl --install -d Ubuntu-24.04
```

如果 Windows 提示，请重启。

### 2）启用 systemd（Gateway 网关安装所必需）

在你的 WSL 终端中：

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

然后在 PowerShell 中运行：

```powershell
wsl --shutdown
```

重新打开 Ubuntu，然后验证：

```bash
systemctl --user status
```

### 3）安装 OpenClaw（在 WSL 内）

在 WSL 内按照 Linux 入门指南流程操作：

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # 首次运行时会自动安装 UI 依赖
pnpm build
openclaw onboard
```

完整指南：[入门指南](/start/getting-started)

## Windows 配套应用

我们还没有 Windows 配套应用。如果你想推动这件事发生，欢迎
贡献。
