---
read_when:
  - 你想从机器上移除 EasyHub
  - 卸载后 Gateway 网关服务仍在运行
summary: 完全卸载 EasyHub（CLI、服务、状态、工作区）
title: 卸载
x-i18n:
  generated_at: "2026-02-03T07:50:10Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 6673a755c5e1f90a807dd8ac92a774cff6d1bc97d125c75e8bf72a40e952a777
  source_path: install/uninstall.md
  workflow: 15
---

# 卸载

两种方式：

- 如果 `EasyHub` 仍已安装，使用**简单方式**。
- 如果 CLI 已删除但服务仍在运行，使用**手动服务移除**。

## 简单方式（CLI 仍已安装）

推荐：使用内置卸载程序：

```bash
EasyHub uninstall
```

非交互式（自动化 / npx）：

```bash
EasyHub uninstall --all --yes --non-interactive
npx -y EasyHub uninstall --all --yes --non-interactive
```

手动步骤（效果相同）：

1. 停止 Gateway 网关服务：

```bash
EasyHub gateway stop
```

2. 卸载 Gateway 网关服务（launchd/systemd/schtasks）：

```bash
EasyHub gateway uninstall
```

3. 删除状态 + 配置：

```bash
rm -rf "${EASYHUB_STATE_DIR:-$HOME/.EasyHub}"
```

如果你将 `EASYHUB_CONFIG_PATH` 设置为状态目录外的自定义位置，也请删除该文件。

4. 删除你的工作区（可选，移除智能体文件）：

```bash
rm -rf ~/.easyhub/workspace
```

5. 移除 CLI 安装（选择你使用的那个）：

```bash
npm rm -g EasyHub
pnpm remove -g EasyHub
bun remove -g EasyHub
```

6. 如果你安装了 macOS 应用：

```bash
rm -rf /Applications/EasyHub.app
```

注意事项：

- 如果你使用了配置文件（`--profile` / `EASYHUB_PROFILE`），对每个状态目录重复步骤 3（默认为 `~/.EasyHub-<profile>`）。
- 在远程模式下，状态目录位于 **Gateway 网关主机**上，因此也需要在那里运行步骤 1-4。

## 手动服务移除（CLI 未安装）

如果 Gateway 网关服务持续运行但 `EasyHub` 缺失，请使用此方法。

### macOS（launchd）

默认标签是 `bot.molt.gateway`（或 `bot.molt.<profile>`；旧版 `com.EasyHub.*` 可能仍然存在）：

```bash
launchctl bootout gui/$UID/bot.molt.gateway
rm -f ~/Library/LaunchAgents/bot.molt.gateway.plist
```

如果你使用了配置文件，请将标签和 plist 名称替换为 `bot.molt.<profile>`。如果存在任何旧版 `com.EasyHub.*` plist，请将其移除。

### Linux（systemd 用户单元）

默认单元名称是 `EasyHub-gateway.service`（或 `EasyHub-gateway-<profile>.service`）：

```bash
systemctl --user disable --now EasyHub-gateway.service
rm -f ~/.config/systemd/user/EasyHub-gateway.service
systemctl --user daemon-reload
```

### Windows（计划任务）

默认任务名称是 `EasyHub Gateway`（或 `EasyHub Gateway (<profile>)`）。
任务脚本位于你的状态目录下。

```powershell
schtasks /Delete /F /TN "EasyHub Gateway"
Remove-Item -Force "$env:USERPROFILE\.easyhub\gateway.cmd"
```

如果你使用了配置文件，请删除匹配的任务名称和 `~\.EasyHub-<profile>\gateway.cmd`。

## 普通安装 vs 源码检出

### 普通安装（install.sh / npm / pnpm / bun）

如果你使用了 `https://EasyHub.ai/install.sh` 或 `install.ps1`，CLI 是通过 `npm install -g EasyHub@latest` 安装的。
使用 `npm rm -g EasyHub` 移除（或 `pnpm remove -g` / `bun remove -g`，如果你是用那种方式安装的）。

### 源码检出（git clone）

如果你从仓库检出运行（`git clone` + `EasyHub ...` / `bun run EasyHub ...`）：

1. 在删除仓库**之前**卸载 Gateway 网关服务（使用上面的简单方式或手动服务移除）。
2. 删除仓库目录。
3. 按上述方式移除状态 + 工作区。
