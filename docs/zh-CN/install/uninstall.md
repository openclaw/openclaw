---
read_when:
  - 你想从机器上移除 OpenClaw
  - 卸载后 Gateway网关服务仍在运行
summary: 完全卸载 OpenClaw（CLI、服务、状态、工作区）
title: 卸载
x-i18n:
  generated_at: "2026-02-01T21:16:21Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 6673a755c5e1f90a807dd8ac92a774cff6d1bc97d125c75e8bf72a40e952a777
  source_path: install/uninstall.md
  workflow: 15
---

# 卸载

两种方式：

- **简易方式**：`openclaw` 仍已安装时使用。
- **手动移除服务**：CLI 已删除但服务仍在运行时使用。

## 简易方式（CLI 仍已安装）

推荐：使用内置卸载程序：

```bash
openclaw uninstall
```

非交互模式（自动化 / npx）：

```bash
openclaw uninstall --all --yes --non-interactive
npx -y openclaw uninstall --all --yes --non-interactive
```

手动步骤（效果相同）：

1. 停止 Gateway网关服务：

```bash
openclaw gateway stop
```

2. 卸载 Gateway网关服务（launchd/systemd/schtasks）：

```bash
openclaw gateway uninstall
```

3. 删除状态和配置：

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
```

如果你将 `OPENCLAW_CONFIG_PATH` 设置为状态目录之外的自定义位置，请同时删除该文件。

4. 删除工作区（可选，会移除智能体文件）：

```bash
rm -rf ~/.openclaw/workspace
```

5. 移除 CLI 安装（选择你使用的方式）：

```bash
npm rm -g openclaw
pnpm remove -g openclaw
bun remove -g openclaw
```

6. 如果你安装了 macOS 应用：

```bash
rm -rf /Applications/OpenClaw.app
```

注意事项：

- 如果你使用了配置文件（`--profile` / `OPENCLAW_PROFILE`），请对每个状态目录重复步骤 3（默认为 `~/.openclaw-<profile>`）。
- 在远程模式下，状态目录位于 **Gateway网关主机**上，因此也需要在那里执行步骤 1-4。

## 手动移除服务（CLI 未安装）

当 Gateway网关服务持续运行但 `openclaw` 已不存在时使用此方式。

### macOS (launchd)

默认标签为 `bot.molt.gateway`（或 `bot.molt.<profile>`；旧版 `com.openclaw.*` 可能仍然存在）：

```bash
launchctl bootout gui/$UID/bot.molt.gateway
rm -f ~/Library/LaunchAgents/bot.molt.gateway.plist
```

如果你使用了配置文件，请将标签和 plist 名称替换为 `bot.molt.<profile>`。如存在旧版 `com.openclaw.*` plist 文件，请一并移除。

### Linux（systemd 用户单元）

默认单元名称为 `openclaw-gateway.service`（或 `openclaw-gateway-<profile>.service`）：

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows（计划任务）

默认任务名称为 `OpenClaw Gateway网关`（或 `OpenClaw Gateway网关 (<profile>)`）。
任务脚本位于你的状态目录下。

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway网关"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd"
```

如果你使用了配置文件，请删除对应的任务名称和 `~\.openclaw-<profile>\gateway.cmd`。

## 常规安装与源码检出

### 常规安装（install.sh / npm / pnpm / bun）

如果你使用了 `https://openclaw.ai/install.sh` 或 `install.ps1`，CLI 是通过 `npm install -g openclaw@latest` 安装的。
使用 `npm rm -g openclaw` 移除（如果你使用的是其他方式，则用 `pnpm remove -g` / `bun remove -g`）。

### 源码检出（git clone）

如果你从仓库检出运行（`git clone` + `openclaw ...` / `bun run openclaw ...`）：

1. 在删除仓库**之前**先卸载 Gateway网关服务（使用上述简易方式或手动移除服务）。
2. 删除仓库目录。
3. 按上述方式移除状态和工作区。
