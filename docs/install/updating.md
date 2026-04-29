---
summary: "安全更新 OpenClaw（全局安装或源码），以及回滚策略"
read_when:
  - 更新 OpenClaw
  - 更新后出现问题
title: "Updating"
---

保持 OpenClaw 最新。

## 推荐：`openclaw update`

最快的更新方式。它检测您的安装类型（npm 或 git），获取最新版本，运行 `openclaw doctor`，并重启 gateway。

```bash
openclaw update
```

切换渠道或指定版本：

```bash
openclaw update --channel beta
openclaw update --channel dev
openclaw update --tag main
openclaw update --dry-run   # 预览而不应用
```

`--channel beta` 优先使用 beta，但当 beta 标签缺失或比最新稳定版旧时，运行时回退到 stable/latest。如果需要原始 npm beta dist-tag 进行一次性包更新，请使用 `--tag beta`。

参见 [Development channels](/install/development-channels) 了解渠道语义。

## 在 npm 和 git 安装之间切换

当您想更改安装类型时使用渠道。更新程序会保持您的状态、配置、凭证和工作区在 `~/.openclaw`；它只更改 CLI 和 gateway 使用的 OpenClaw 代码安装。

```bash
# npm 包安装 -> 可编辑 git 检出
openclaw update --channel dev

# git 检出 -> npm 包安装
openclaw update --channel stable
```

首先使用 `--dry-run` 预览确切的安装模式切换：

```bash
openclaw update --channel dev --dry-run
openclaw update --channel stable --dry-run
```

`dev` 渠道确保 git 检出、构建并从该检出安装全局 CLI。`stable` 和 `beta` 渠道使用包安装。如果 gateway 已安装，`openclaw update` 会刷新服务元数据并重启，除非您传入 `--no-restart`。

## 替代方案：重新运行安装程序

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

添加 `--no-onboard` 跳过 onboarding。要通过安装程序强制指定安装类型，请传入 `--install-method git --no-onboard` 或 `--install-method npm --no-onboard`。

如果 `openclaw update` 在 npm 包安装阶段后失败，请重新运行安装程序。安装程序不调用旧的更新程序；它直接运行全局包安装，可以恢复部分更新的 npm 安装。

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method npm
```

要将恢复固定到特定版本或 dist-tag，请添加 `--version`：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method npm --version <version-or-dist-tag>
```

## 替代方案：手动 npm、pnpm 或 bun

```bash
npm i -g openclaw@latest
```

当 `openclaw update` 管理全局 npm 安装时，它首先将目标安装到临时 npm 前缀，验证打包的 `dist` 清单，然后将干净的包树交换到真正的全局前缀。这样可以避免 npm 将新包覆盖到旧包的陈旧文件上。如果安装命令失败，OpenClaw 会使用 `--omit=optional` 重试一次。当原生可选依赖无法编译时，此重试有助于在保持原始失败可见的同时，在主机上完成安装。

```bash
pnpm add -g openclaw@latest
```

```bash
bun add -g openclaw@latest
```

### 高级 npm 安装主题

<AccordionGroup>
  <Accordion title="只读包树">
    OpenClaw 将打包的全局安装视为运行时只读，即使全局包目录对当前用户可写。捆绑插件运行时依赖被暂存到可写运行时目录，而不是修改包树。这可以防止 `openclaw update` 与在同一安装期间修复插件依赖的运行 gateway 或本地 agent 产生竞争。

    一些 Linux npm 设置将全局包安装在 root 拥有的目录下，如 `/usr/lib/node_modules/openclaw`。OpenClaw 通过相同的外部暂存路径支持该布局。

  </Accordion>
  <Accordion title="强化的 systemd units">
    设置一个包含在 `ReadWritePaths` 中的可写暂存目录：

    ```ini
    Environment=OPENCLAW_PLUGIN_STAGE_DIR=/var/lib/openclaw/plugin-runtime-deps
    ReadWritePaths=/var/lib/openclaw /home/openclaw/.openclaw /tmp
    ```

    `OPENCLAW_PLUGIN_STAGE_DIR` 也接受路径列表。OpenClaw 从左到右解析跨列出根的捆绑插件运行时依赖，将较早的根视为只读预安装层，仅安装或修复到最后一个可写根：

    ```ini
    Environment=OPENCLAW_PLUGIN_STAGE_DIR=/opt/openclaw/plugin-runtime-deps:/var/lib/openclaw/plugin-runtime-deps
    ReadWritePaths=/var/lib/openclaw /home/openclaw/.openclaw /tmp
    ```

    如果未设置 `OPENCLAW_PLUGIN_STAGE_DIR`，OpenClaw 会在 systemd 提供时使用 `$STATE_DIRECTORY`，然后回退到 `~/.openclaw/plugin-runtime-deps`。修复步骤将该暂存视为 OpenClaw 拥有的本地包根，并忽略用户 npm 前缀和全局设置，因此全局安装的 npm 配置不会将捆绑插件依赖重定向到 `~/node_modules` 或全局包树。

  </Accordion>
  <Accordion title="磁盘空间预检">
    在包更新和捆绑运行时依赖修复之前，OpenClaw 尝试对目标卷进行尽力而为的磁盘空间检查。空间不足会产生带有检查路径的警告，但不会阻止更新，因为文件系统配额、快照和网络卷可以在检查后更改。实际的 npm 安装、复制和安装后验证仍然是权威的。

  </Accordion>
  <Accordion title="捆绑插件运行时依赖">
    打包安装将捆绑插件运行时依赖保持在只读包树之外。在启动时和 `openclaw doctor --fix` 期间，OpenClaw 仅对在配置中处于活动状态、通过旧渠道配置处于活动状态或由其捆绑清单默认启用的捆绑插件修复运行时依赖。仅凭持久化的渠道 auth 状态不会触发 Gateway 启动运行时依赖修复。

    明确的禁用优先。禁用的插件或渠道不会仅仅因为它存在于包中就获得其运行时依赖修复。外部插件和自定义加载路径仍然使用 `openclaw plugins install` 或 `openclaw plugins update`。

  </Accordion>
</AccordionGroup>

## 自动更新程序

自动更新程序默认关闭。在 `~/.openclaw/openclaw.json` 中启用它：

```json5
{
  update: {
    channel: "stable",
    auto: {
      enabled: true,
      stableDelayHours: 6,
      stableJitterHours: 12,
      betaCheckIntervalHours: 1,
    },
  },
}
```

| 渠道 | 行为 |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| `stable` | 等待 `stableDelayHours`，然后通过 `stableJitterHours`（分散发布）中的确定性抖动应用。 |
| `beta` | 每 `betaCheckIntervalHours` 检查一次（默认：每小时）并立即应用。 |
| `dev` | 不自动应用。手动使用 `openclaw update`。 |

gateway 也在启动时记录更新提示（使用 `update.checkOnStart: false` 禁用）。要降级或事件恢复，请在 gateway 环境中设置 `OPENCLAW_NO_AUTO_UPDATE=1`，以阻止自动应用，即使配置了 `update.auto.enabled`。除非 `update.checkOnStart` 也被禁用，否则启动更新提示仍然可以运行。

## 更新后

<Steps>

### 运行 doctor

```bash
openclaw doctor
```

迁移配置、审计 DM 策略并检查 gateway 健康状况。详情：[Doctor](/gateway/doctor)

### 重启 gateway

```bash
openclaw gateway restart
```

### 验证

```bash
openclaw health
```

</Steps>

## 回滚

### 固定版本（npm）

```bash
npm i -g openclaw@<version>
openclaw doctor
openclaw gateway restart
```

<Tip>
`npm view openclaw version` 显示当前发布的版本。
</Tip>

### 固定提交（源码）

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
pnpm install && pnpm build
openclaw gateway restart
```

要返回最新版本：`git checkout main && git pull`。

## 如果您卡住了

- 再次运行 `openclaw doctor` 并仔细阅读输出。
- 对于源码检出的 `openclaw update --channel dev`，更新程序在需要时自动引导 `pnpm`。如果您看到 pnpm/corepack 引导错误，请手动安装 `pnpm`（或重新启用 `corepack`）然后重新运行更新。
- 检查：[故障排除](/gateway/troubleshooting)
- 在 Discord 提问：[https://discord.gg/clawd](https://discord.gg/clawd)

## 相关

- [安装概述](/install)：所有安装方式。
- [Doctor](/gateway/doctor)：更新后的健康检查。
- [迁移](/install/migrating)：主要版本迁移指南。
