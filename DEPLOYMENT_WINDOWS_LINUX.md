# OpenClaw Windows 与 Linux 部署说明（小白可执行版）

本文档目标：让非专业人员也可以按步骤完成 OpenClaw 的部署、启动、验证与日常维护。

适用范围：
- Windows 10/11
- Linux（Ubuntu 22.04/24.04、Debian 12、CentOS Stream 9 等）

---

## 1. 本次已生成的发布文件

在项目根目录下，已生成以下发布物：

- release/openclaw-2026.3.11-windows.zip
- release/openclaw-2026.3.11-linux.tar.gz
- release/openclaw-2026.3.11/（解包目录，含 dist 和入口文件）

你可以直接把 zip 或 tar.gz 复制到目标服务器进行部署。

---

## 2. 部署前准备（两端通用）

### 2.1 机器要求

- CPU：2 核及以上
- 内存：4 GB 及以上（推荐 8 GB）
- 磁盘：可用空间 2 GB 以上
- 网络：可访问你要对接的消息渠道、模型服务和数据库

### 2.2 必备软件

- Node.js 22 或更高版本
- npm（随 Node 一起安装）

检查版本命令：

```bash
node -v
npm -v
```

如果 `node -v` 低于 22，请先升级 Node。

---

## 3. Windows 部署步骤

## 3.1 上传并解压发布包

1. 将 `openclaw-2026.3.11-windows.zip` 复制到目标机器，例如 `D:\deploy`。
2. 右键解压后得到目录：`D:\deploy\openclaw-2026.3.11`。

## 3.2 安装运行依赖

打开 PowerShell（管理员或普通用户均可）：

```powershell
1. Run VS Code as **administrator**
2. Open the terminal in VS Code / or search for Windows PowerShell on your computer, open it **as administrator** , and execute the following command.
3. Executing `get-ExecutionPolicy` returns "Restricted," indicating that the status is prohibited.
4. Execute: set-ExecutionPolicy RemoteSigned
5. When you execute get-ExecutionPolicy again, it will display RemoteSigned.
6. This problem will not occur again.

cd D:\deploy\openclaw-2026.3.11
npm install --omit=dev
```

说明：
- 该命令只安装运行时依赖，不安装开发依赖。

## 3.3 首次配置

建议先配置基础项（按你的实际环境调整）：

```powershell
cd D:\deploy\openclaw-2026.3.11
node .\openclaw.mjs config set gateway.mode local
node .\openclaw.mjs config set gateway.bind 0.0.0.0
node .\openclaw.mjs config set gateway.port 18789
```

如果你已准备好渠道 Token、模型密钥等，可继续执行：

```powershell
node .\openclaw.mjs config set <配置键> <配置值>
```

## 3.4 启动服务

前台启动（用于首次验证）：

```powershell
cd D:\deploy\openclaw-2026.3.11
node .\openclaw.mjs gateway run --bind 0.0.0.0 --port 18789 --force
```

看到服务启动日志后，不要关闭该窗口。

## 3.5 健康检查

另开一个 PowerShell 窗口执行：

```powershell
cd D:\deploy\openclaw-2026.3.11
node .\openclaw.mjs channels status --probe
```

检查监听端口：

```powershell
netstat -ano | findstr 18789
```

如果看到 `LISTENING`，表示监听正常。

## 3.6 设置开机自启（推荐）

Windows 没有原生 systemd，推荐使用 NSSM（Non-Sucking Service Manager）：

1. 下载 NSSM 并解压。
2. 以管理员 PowerShell 执行（路径按实际修改）：

```powershell
nssm install OpenClawGateway "C:\Program Files\nodejs\node.exe" "D:\deploy\openclaw-2026.3.11\openclaw.mjs gateway run --bind 0.0.0.0 --port 18789 --force"
nssm set OpenClawGateway AppDirectory "D:\deploy\openclaw-2026.3.11"
nssm start OpenClawGateway
```

3. 验证服务状态：

```powershell
Get-Service OpenClawGateway
```

---

## 4. Linux 部署步骤

## 4.1 上传并解压发布包

```bash
mkdir -p /opt/openclaw
cp openclaw-2026.3.11-linux.tar.gz /opt/openclaw/
cd /opt/openclaw
tar -xzf openclaw-2026.3.11-linux.tar.gz
cd openclaw-2026.3.11
```

## 4.2 安装运行依赖

```bash
cd /opt/openclaw/openclaw-2026.3.11
npm install --omit=dev
```

## 4.3 首次配置

```bash
cd /opt/openclaw/openclaw-2026.3.11
node ./openclaw.mjs config set gateway.mode local
node ./openclaw.mjs config set gateway.bind 0.0.0.0
node ./openclaw.mjs config set gateway.port 18789
```

按需继续写入渠道、模型、数据库等配置：

```bash
node ./openclaw.mjs config set <配置键> <配置值>
```

## 4.4 前台启动验证

```bash
cd /opt/openclaw/openclaw-2026.3.11
node ./openclaw.mjs gateway run --bind 0.0.0.0 --port 18789 --force
```

另开终端执行探测：

```bash
cd /opt/openclaw/openclaw-2026.3.11
node ./openclaw.mjs channels status --probe
ss -ltnp | grep 18789
```

## 4.5 配置 systemd 开机自启（推荐）

创建服务文件：

```bash
sudo tee /etc/systemd/system/openclaw-gateway.service > /dev/null <<'EOF'
[Unit]
Description=OpenClaw Gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/openclaw/openclaw-2026.3.11
ExecStart=/usr/bin/node /opt/openclaw/openclaw-2026.3.11/openclaw.mjs gateway run --bind 0.0.0.0 --port 18789 --force
Restart=always
RestartSec=5
User=root
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
```

生效并启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable openclaw-gateway
sudo systemctl start openclaw-gateway
```

查看状态与日志：

```bash
sudo systemctl status openclaw-gateway
sudo journalctl -u openclaw-gateway -f
```

---

## 5. Windows WSL2 部署方案

适用场景：你使用 Windows 主机，但希望在 Linux 环境中运行 OpenClaw。

## 5.1 安装并准备 WSL2

下面分 Win11 和 Win10 两种情况说明。

### 5.1.1 Win11 启用 WSL2（推荐）

前置检查：
- Windows 11 建议升级到最新补丁。
- BIOS/UEFI 中开启虚拟化（Intel VT-x / AMD-V）。

步骤 1：以管理员身份打开 PowerShell。

步骤 2：执行一键安装命令：

```powershell
wsl --install -d Ubuntu-24.04
```

步骤 3：按提示重启 Windows。

步骤 4：重启后打开 Ubuntu，首次初始化 Linux 用户名与密码。

步骤 5：确认安装结果：

```powershell
wsl --status
wsl -l -v
```

检查点：
- 默认版本为 2。
- `Ubuntu-24.04` 的 `VERSION` 为 `2`。

如果不是 2，执行：

```powershell
wsl --set-default-version 2
wsl --set-version Ubuntu-24.04 2
```

### 5.1.2 Win10 启用 WSL2（详细）

Win10 对版本要求更严格，建议满足以下条件：
- Windows 10 x64，版本 2004+（内部版本 19041+）。
- BIOS/UEFI 已开启虚拟化。

先检查系统版本（任意一种方式）：

```powershell
winver
```

或：

```powershell
systeminfo | findstr /B /C:"OS Name" /C:"OS Version"
```

#### 方式 A：命令行启用（推荐）

以管理员 PowerShell 执行：

```powershell
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
```

然后重启系统。

重启后执行：

```powershell
wsl --set-default-version 2
wsl --install -d Ubuntu-24.04
```

若 `wsl --install` 在旧版 Win10 不可用，则改用：

```powershell
wsl --list --online
wsl --install -d Ubuntu
```

若仍不可用，可从 Microsoft Store 手动安装 Ubuntu（例如 Ubuntu 24.04 LTS），安装完成后再执行：

```powershell
wsl --set-version Ubuntu 2
```

#### 方式 B：图形界面启用

1. 打开“控制面板 -> 程序 -> 启用或关闭 Windows 功能”。
2. 勾选：
	- “适用于 Linux 的 Windows 子系统”
	- “虚拟机平台”
3. 点击确定并重启系统。
4. 重启后安装 Ubuntu（Store 或命令行），并设置为 WSL2。

### 5.1.3 WSL2 启用后的统一验证

```powershell
wsl --status
wsl -l -v
```

在 Ubuntu 终端里验证：

```bash
uname -a
cat /etc/os-release
```

预期：
- 能看到 Linux 内核信息。
- 发行版正常显示 Ubuntu。

### 5.1.4 常见失败点（先查这 4 项）

1. 虚拟化未开启：任务管理器 -> 性能 -> CPU，检查“虚拟化: 已启用”。
2. Windows 功能没开全：必须同时开启 WSL 和 Virtual Machine Platform。
3. 系统版本过低：Win10 太旧版本不支持完整 WSL2 功能。
4. 公司安全策略限制虚拟化：联系 IT 放开 Hyper-V/虚拟化策略。

## 5.2 在 WSL2 中安装 Node.js 22+

进入 Ubuntu（WSL）终端执行：

```bash
sudo apt update
sudo apt install -y curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

## 5.3 将发布包复制到 WSL2 并解压

建议将程序放到 WSL 的 Linux 文件系统目录（性能更稳定），不要长期运行在 `/mnt/c` 下。

```bash
mkdir -p ~/deploy
cp /mnt/c/path/to/openclaw-2026.3.11-linux.tar.gz ~/deploy/
cd ~/deploy
tar -xzf openclaw-2026.3.11-linux.tar.gz
cd openclaw-2026.3.11
```

## 5.4 安装依赖并配置

```bash
cd ~/deploy/openclaw-2026.3.11
npm install --omit=dev
node ./openclaw.mjs config set gateway.mode local
node ./openclaw.mjs config set gateway.bind 0.0.0.0
node ./openclaw.mjs config set gateway.port 18789
```

## 5.5 启动与验证

前台启动：

```bash
cd ~/deploy/openclaw-2026.3.11
node ./openclaw.mjs gateway run --bind 0.0.0.0 --port 18789 --force
```

WSL2 内验证：

```bash
node ./openclaw.mjs channels status --probe
ss -ltnp | grep 18789
```

Windows 主机访问验证：

```powershell
curl http://localhost:18789
```

说明：默认情况下，WSL2 监听端口可通过 Windows 的 `localhost` 直接访问。

## 5.6 WSL2 自启动建议

方案 A（推荐，简单）：在 Windows 任务计划程序中创建“开机触发”任务，执行：

```powershell
wsl -d Ubuntu-24.04 --cd /home/<你的用户名>/deploy/openclaw-2026.3.11 -- bash -lc "nohup node ./openclaw.mjs gateway run --bind 0.0.0.0 --port 18789 --force > ~/openclaw-gateway.log 2>&1 &"
```

方案 B（进阶）：在 WSL 内启用 systemd 后，按 Linux 章节方式配置服务。

---

## 6. 升级流程（Windows/Linux/WSL2 通用）

1. 备份配置文件与凭据目录。
2. 停止现有服务。
3. 上传新版本发布包并解压到新目录（例如 `openclaw-2026.3.12`）。
4. 在新目录执行：

```bash
npm install --omit=dev
```

5. 将旧版本配置迁移到新版本。
6. 启动新版本并验证。
7. 验证通过后，再删除旧版本目录。

---

## 7. 常见问题排查

## 7.1 提示 node: command not found

原因：Node 未安装或环境变量未生效。
处理：
- 重新安装 Node.js 22+
- 重开终端
- 再执行 `node -v`

## 7.2 端口被占用

处理：
- 改端口启动，例如 `--port 18800`
- 或停止占用进程后重启 OpenClaw

Windows 查占用：

```powershell
netstat -ano | findstr 18789
```

Linux 查占用：

```bash
ss -ltnp | grep 18789
```

## 7.3 渠道状态异常

执行：

```bash
node ./openclaw.mjs channels status --probe
```

通常是 Token、密钥、网络白名单、代理配置导致。

## 7.4 WSL2 中 Windows 能访问但局域网无法访问

原因：WSL2 默认是 NAT 网络，`localhost` 转发到 Windows 主机可用，但外部设备访问通常需要额外端口映射。

处理建议：
- 仅本机使用：继续使用 `http://localhost:18789`。
- 需要局域网访问：在 Windows 上额外配置端口转发和防火墙放行。

---

## 8. 回滚方案（强烈建议保留）

1. 保留至少一个旧版本目录（例如 `openclaw-2026.3.10`）。
2. 新版本异常时，停止新版本服务。
3. 将服务工作目录改回旧版本并重启。
4. 业务恢复后，再排查新版本问题。

---

## 9. 运维建议（非专业也适用）

- 每次变更只改一个项目，改完立即验证。
- 配置和凭据先备份再调整。
- 建议记录一份“部署日志”：时间、改动项、结果、回滚点。
- 生产环境优先使用 systemd/NSSM，避免手工窗口常驻。

---

## 10. 一页式快速命令（可打印）

Windows：

```powershell
cd D:\deploy\openclaw-2026.3.11
npm install --omit=dev
node .\openclaw.mjs config set gateway.mode local
node .\openclaw.mjs config set gateway.bind 0.0.0.0
node .\openclaw.mjs config set gateway.port 18789
node .\openclaw.mjs gateway run --bind 0.0.0.0 --port 18789 --force
node .\openclaw.mjs channels status --probe
```

Linux：

```bash
cd /opt/openclaw/openclaw-2026.3.11
npm install --omit=dev
node ./openclaw.mjs config set gateway.mode local
node ./openclaw.mjs config set gateway.bind 0.0.0.0
node ./openclaw.mjs config set gateway.port 18789
node ./openclaw.mjs gateway run --bind 0.0.0.0 --port 18789 --force
node ./openclaw.mjs channels status --probe
```

WSL2（Ubuntu）：

```bash
cd ~/deploy/openclaw-2026.3.11
npm install --omit=dev
node ./openclaw.mjs config set gateway.mode local
node ./openclaw.mjs config set gateway.bind 0.0.0.0
node ./openclaw.mjs config set gateway.port 18789
node ./openclaw.mjs gateway run --bind 0.0.0.0 --port 18789 --force
node ./openclaw.mjs channels status --probe
```
