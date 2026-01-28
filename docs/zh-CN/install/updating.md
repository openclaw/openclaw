---
read_when:
  - 更新 OpenClaw
  - 更新后出现问题
summary: 安全更新 OpenClaw（全局安装或源码安装），以及回滚策略
title: 更新
x-i18n:
  generated_at: "2026-02-01T21:16:51Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 612b2519cf3e4a2c2d0f01575c3fa75ab1c88a6fed9e59477bf27395beda03c1
  source_path: install/updating.md
  workflow: 15
---

# 更新

OpenClaw 迭代速度很快（尚未到"1.0"）。请像对待基础设施发布一样对待更新：更新 → 运行检查 → 重启（或使用 `openclaw update`，它会自动重启）→ 验证。

## 推荐方式：重新运行网站安装程序（原地升级）

**首选**更新路径是重新运行网站上的安装程序。它会检测现有安装、原地升级，并在需要时运行 `openclaw doctor`。

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

注意事项：

- 如果不想再次运行新手引导向导，请添加 `--no-onboard`。
- 对于**源码安装**，请使用：
  ```bash
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
  ```
  安装程序**仅在**仓库工作区干净时才会执行 `git pull --rebase`。
- 对于**全局安装**，脚本底层使用 `npm install -g openclaw@latest`。
- 兼容性说明：`openclaw` 仍可作为兼容性垫片使用。

## 更新前的准备

- 了解你的安装方式：**全局安装**（npm/pnpm）还是**源码安装**（git clone）。
- 了解你的 Gateway网关运行方式：**前台终端**还是**受监控服务**（launchd/systemd）。
- 备份你的自定义配置：
  - 配置文件：`~/.openclaw/openclaw.json`
  - 凭据：`~/.openclaw/credentials/`
  - 工作区：`~/.openclaw/workspace`

## 更新（全局安装）

全局安装（任选其一）：

```bash
npm i -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

我们**不建议**使用 Bun 作为 Gateway网关运行时（存在 WhatsApp/Telegram 相关 bug）。

切换更新渠道（git + npm 安装）：

```bash
openclaw update --channel beta
openclaw update --channel dev
openclaw update --channel stable
```

使用 `--tag <dist-tag|version>` 进行一次性指定标签/版本安装。

有关渠道语义和发布说明，请参阅[开发渠道](/install/development-channels)。

注意：在 npm 安装中，Gateway网关启动时会记录更新提示（检查当前渠道标签）。可通过 `update.checkOnStart: false` 禁用。

然后：

```bash
openclaw doctor
openclaw gateway restart
openclaw health
```

注意事项：

- 如果你的 Gateway网关作为服务运行，建议使用 `openclaw gateway restart` 而非直接终止 PID。
- 如果你固定在特定版本，请参阅下方的"回滚/版本固定"。

## 更新（`openclaw update`）

对于**源码安装**（git checkout），推荐使用：

```bash
openclaw update
```

它会执行一个相对安全的更新流程：

- 要求工作区干净。
- 切换到所选渠道（标签或分支）。
- 从配置的上游（dev 渠道）拉取并变基。
- 安装依赖、构建、构建控制面板 UI，并运行 `openclaw doctor`。
- 默认重启 Gateway网关（使用 `--no-restart` 跳过）。

如果你通过 **npm/pnpm** 安装（无 git 元数据），`openclaw update` 会尝试通过你的包管理器进行更新。如果无法检测到安装方式，请改用"更新（全局安装）"。

## 更新（控制面板 UI / RPC）

控制面板 UI 提供**更新并重启**功能（RPC：`update.run`）。它会：

1. 执行与 `openclaw update` 相同的源码更新流程（仅限 git checkout）。
2. 写入重启哨兵文件及结构化报告（stdout/stderr 尾部内容）。
3. 重启 Gateway网关并向最近活跃的会话发送报告。

如果变基失败，Gateway网关会中止并在不应用更新的情况下重启。

## 更新（源码安装）

从仓库检出目录：

推荐方式：

```bash
openclaw update
```

手动方式（大致等效）：

```bash
git pull
pnpm install
pnpm build
pnpm ui:build # 首次运行时自动安装 UI 依赖
openclaw doctor
openclaw health
```

注意事项：

- 当你运行打包后的 `openclaw` 二进制文件（[`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs)）或使用 Node 运行 `dist/` 时，`pnpm build` 很重要。
- 如果你从仓库检出运行而没有全局安装，请使用 `pnpm openclaw ...` 执行 CLI 命令。
- 如果你直接从 TypeScript 运行（`pnpm openclaw ...`），通常不需要重新构建，但**配置迁移仍然适用** → 运行 doctor。
- 在全局安装和 git 安装之间切换很容易：安装另一种方式，然后运行 `openclaw doctor`，这样 Gateway网关服务入口点会被重写为当前安装。

## 必须执行：`openclaw doctor`

Doctor 是"安全更新"命令。它有意设计得很朴素：修复 + 迁移 + 警告。

注意：如果你使用的是**源码安装**（git checkout），`openclaw doctor` 会建议先运行 `openclaw update`。

它通常执行以下操作：

- 迁移已弃用的配置键 / 旧版配置文件位置。
- 审核私信策略并对高风险的"开放"设置发出警告。
- 检查 Gateway网关健康状态并可建议重启。
- 检测并将旧版 Gateway网关服务（launchd/systemd；旧版 schtasks）迁移到当前的 OpenClaw 服务。
- 在 Linux 上，确保 systemd 用户 lingering（使 Gateway网关在登出后继续运行）。

详情：[Doctor](/gateway/doctor)

## 启动/停止/重启 Gateway网关

CLI（适用于所有操作系统）：

```bash
openclaw gateway status
openclaw gateway stop
openclaw gateway restart
openclaw gateway --port 18789
openclaw logs --follow
```

如果使用服务管理：

- macOS launchd（应用捆绑的 LaunchAgent）：`launchctl kickstart -k gui/$UID/bot.molt.gateway`（使用 `bot.molt.<profile>`；旧版 `com.openclaw.*` 仍可用）
- Linux systemd 用户服务：`systemctl --user restart openclaw-gateway[-<profile>].service`
- Windows（WSL2）：`systemctl --user restart openclaw-gateway[-<profile>].service`
  - `launchctl`/`systemctl` 仅在服务已安装时有效；否则请运行 `openclaw gateway install`。

运维手册及完整服务标签：[Gateway网关运维手册](/gateway)

## 回滚/版本固定（出现问题时）

### 版本固定（全局安装）

安装一个已知可用的版本（将 `<version>` 替换为上一个正常工作的版本）：

```bash
npm i -g openclaw@<version>
```

```bash
pnpm add -g openclaw@<version>
```

提示：要查看当前已发布的版本，请运行 `npm view openclaw version`。

然后重启并重新运行 doctor：

```bash
openclaw doctor
openclaw gateway restart
```

### 版本固定（源码安装）按日期

选取某个日期的提交（示例："main 分支截至 2026-01-01 的状态"）：

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
```

然后重新安装依赖并重启：

```bash
pnpm install
pnpm build
openclaw gateway restart
```

如果之后想回到最新版本：

```bash
git checkout main
git pull
```

## 如果你遇到困难

- 再次运行 `openclaw doctor` 并仔细阅读输出（它通常会告诉你修复方法）。
- 查看：[故障排除](/gateway/troubleshooting)
- 在 Discord 中提问：https://discord.gg/clawd
