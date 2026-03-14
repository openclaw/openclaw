---
read_when:
  - 更新 OpenClaw
  - 更新后出现问题
summary: 安全更新 OpenClaw（全局安装或源码），以及回滚策略
title: 更新
x-i18n:
  generated_at: "2026-02-03T07:50:25Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 38cccac0839f0f22403b6508cd94ba1b401133ffc1d92d4f7640b8d04e082317
  source_path: install/updating.md
  workflow: 15
---

# 更新

OpenClaw 发展迅速（尚未到"1.0"）。将更新视为发布基础设施：更新 → 运行检查 → 重启（或使用会重启的 `openclaw update`）→ 验证。

## 推荐：重新运行网站安装程序（原地升级）

**首选**的更新路径是重新运行网站上的安装程序。它会检测现有安装、原地升级，并在需要时运行 `openclaw doctor`。

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

说明：

- 如果你不想再次运行新手引导向导，添加 `--no-onboard`。
- 对于**源码安装**，使用：
  ```bash
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
  ```
  安装程序**仅**在仓库干净时才会执行 `git pull --rebase`。
- 对于**全局安装**，脚本底层使用 `npm install -g openclaw@latest`。
- 旧版说明：`clawdbot` 仍可作为兼容性垫片使用。

## 更新之前

- 了解你的安装方式：**全局**（npm/pnpm）还是**源码**（git clone）。
- 了解你的 Gateway 网关运行方式：**前台终端**还是**受管理服务**（launchd/systemd）。
- 快照你的定制内容：
  - 配置：`~/.openclaw/openclaw.json`
  - 凭证：`~/.openclaw/credentials/`
  - 工作区：`~/.openclaw/workspace`

## 更新（全局安装）

全局安装（选择一个）：

```bash
npm i -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

我们**不**推荐将 Bun 用于 Gateway 网关运行时（WhatsApp/Telegram 有 bug）。

切换更新渠道（git + npm 安装）：

```bash
openclaw update --channel beta
openclaw update --channel dev
openclaw update --channel stable
```

使用 `--tag <dist-tag|version>` 进行一次性安装指定标签/版本。

渠道语义和发布说明参见[开发渠道](/install/development-channels)。

注意：在 npm 安装上，Gateway 网关在启动时会记录更新提示（检查当前渠道标签）。通过 `update.checkOnStart: false` 禁用。

然后：

```bash
openclaw doctor
openclaw gateway restart
openclaw health
```

说明：

- 如果你的 Gateway 网关作为服务运行，`openclaw gateway restart` 优于杀死 PID。
- 如果你固定在特定版本，参见下面的"回滚/固定"。

## 更新（`openclaw update`）

对于**源码安装**（git checkout），首选：

```bash
openclaw update
```

它运行一个相对安全的更新流程：

- 需要干净的工作树。
- 切换到选定的渠道（标签或分支）。
- 获取并 rebase 到配置的上游（dev 渠道）。
- 安装依赖、构建、构建控制 UI，并运行 `openclaw doctor`。
- 默认重启 Gateway 网关（使用 `--no-restart` 跳过）。

如果你通过 **npm/pnpm** 安装（没有 git 元数据），`openclaw update` 将尝试通过你的包管理器更新。如果无法检测到安装，请改用"更新（全局安装）"。

## 更新（控制 UI / RPC）

控制 UI 有**更新并重启**（RPC：`update.run`）。它：

1. 运行与 `openclaw update` 相同的源码更新流程（仅限 git checkout）。
2. 写入带有结构化报告（stdout/stderr 尾部）的重启哨兵。
3. 重启 Gateway 网关并向最后活跃的会话 ping 报告。

如果 rebase 失败，Gateway 网关会中止并在不应用更新的情况下重启。

## 更新（从源码）

从仓库 checkout：

首选：

```bash
openclaw update
```

手动（大致等效）：

```bash
git pull
pnpm install
pnpm build
pnpm ui:build # 首次运行时自动安装 UI 依赖
openclaw doctor
openclaw health
```

说明：

- 当你运行打包的 `openclaw` 二进制文件（[`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs)）或使用 Node 运行 `dist/` 时，`pnpm build` 很重要。
- 如果你从仓库 checkout 运行而没有全局安装，CLI 命令使用 `pnpm openclaw ...`。
- 如果你直接从 TypeScript 运行（`pnpm openclaw ...`），通常不需要重新构建，但**配置迁移仍然适用** → 运行 doctor。
- 在全局和 git 安装之间切换很容易：安装另一种方式，然后运行 `openclaw doctor` 以便将 Gateway 网关服务入口点重写为当前安装。

## 始终运行：`openclaw doctor`

Doctor 是"安全更新"命令。它故意很无聊：修复 + 迁移 + 警告。

注意：如果你是**源码安装**（git checkout），`openclaw doctor` 会提供先运行 `openclaw update`。

它通常做的事情：

- 迁移已弃用的配置键/旧版配置文件位置。
- 审计私信策略并对有风险的"开放"设置发出警告。
- 检查 Gateway 网关健康状况，可以提供重启。
- 检测并将旧版 Gateway 网关服务（launchd/systemd；旧版 schtasks）迁移到当前 OpenClaw 服务。
- 在 Linux 上，确保 systemd 用户 lingering（这样 Gateway 网关在登出后仍能存活）。

详情：[Doctor](/gateway/doctor)

## 启动/停止/重启 Gateway 网关

CLI（无论操作系统都适用）：

```bash
openclaw gateway status
openclaw gateway stop
openclaw gateway restart
openclaw gateway --port 18789
openclaw logs --follow
```

如果你使用受管理服务：

- macOS launchd（应用捆绑的 LaunchAgent）：`launchctl kickstart -k gui/$UID/bot.molt.gateway`（使用 `bot.molt.<profile>`；旧版 `com.openclaw.*` 仍然有效）
- Linux systemd 用户服务：`systemctl --user restart openclaw-gateway[-<profile>].service`
- Windows（WSL2）：`systemctl --user restart openclaw-gateway[-<profile>].service`
  - `launchctl`/`systemctl` 仅在服务已安装时有效；否则运行 `openclaw gateway install`。

运行手册 + 确切的服务标签：[Gateway 网关运行手册](/gateway)

## 回滚/固定（当出问题时）

### 固定（全局安装）

安装已知良好的版本（将 `<version>` 替换为最后可用的版本）：

```bash
npm i -g openclaw@<version>
```

```bash
pnpm add -g openclaw@<version>
```

提示：要查看当前发布的版本，运行 `npm view openclaw version`。

然后重启 + 重新运行 doctor：

```bash
openclaw doctor
openclaw gateway restart
```

### 按日期固定（源码）

选择某个日期的提交（示例："2026-01-01 时 main 的状态"）：

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
```

然后重新安装依赖 + 重启：

```bash
pnpm install
pnpm build
openclaw gateway restart
```

如果你之后想回到最新版本：

```bash
git checkout main
git pull
```

## 如果你卡住了

- 再次运行 `openclaw doctor` 并仔细阅读输出（它通常会告诉你修复方法）。
- 查看：[故障排除](/gateway/troubleshooting)
- 在 Discord 上提问：https://discord.gg/clawd
