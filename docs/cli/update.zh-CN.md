---
summary: "`openclaw update` 命令行参考（安全的源代码更新 + 网关自动重启）"
read_when:
  - 你想安全地更新源代码 checkout
  - 你需要了解 `--update` 简写行为
title: "update"
---

# `openclaw update`

安全更新 OpenClaw 并在稳定/测试/开发频道之间切换。

如果你通过 **npm/pnpm/bun** 安装（全局安装，无 git 元数据），
更新通过 [更新](/install/updating) 中的包管理器流程进行。

## 使用方法

```bash
openclaw update
openclaw update status
openclaw update wizard
openclaw update --channel beta
openclaw update --channel dev
openclaw update --tag beta
openclaw update --tag main
openclaw update --dry-run
openclaw update --no-restart
openclaw update --yes
openclaw update --json
openclaw --update
```

## 选项

- `--no-restart`：成功更新后跳过重启网关服务。
- `--channel <stable|beta|dev>`：设置更新频道（git + npm；在配置中持久化）。
- `--tag <dist-tag|version|spec>`：仅为此更新覆盖包目标。对于包安装，`main` 映射到 `github:openclaw/openclaw#main`。
- `--dry-run`：预览计划的更新操作（频道/标签/目标/重启流程），而不写入配置、安装、同步插件或重启。
- `--json`：打印机器可读的 `UpdateRunResult` JSON。
- `--timeout <seconds>`：每步超时（默认 1200 秒）。
- `--yes`：跳过确认提示（例如降级确认）

注意：降级需要确认，因为旧版本可能会破坏配置。

## `update status`

显示活动更新频道 + git 标签/分支/SHA（对于源代码 checkout），以及更新可用性。

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

选项：

- `--json`：打印机器可读的状态 JSON。
- `--timeout <seconds>`：检查超时（默认 3 秒）。

## `update wizard`

交互式流程，选择更新频道并确认是否在更新后重启网关
（默认是重启）。如果你在没有 git checkout 的情况下选择 `dev`，它会
提供创建一个。

选项：

- `--timeout <seconds>`：每个更新步骤的超时（默认 `1200`）

## 它的作用

当你明确切换频道时（`--channel ...`），OpenClaw 还会保持
安装方法对齐：

- `dev` → 确保 git checkout（默认：`~/openclaw`，可通过 `OPENCLAW_GIT_DIR` 覆盖），
  更新它，并从该 checkout 安装全局 CLI。
- `stable` → 使用 `latest` 从 npm 安装。
- `beta` → 首选 npm 分发标签 `beta`，但当 beta 缺失或
  比当前稳定版本旧时，回退到 `latest`。

网关核心自动更新器（当通过配置启用时）重用相同的更新路径。

## Git checkout 流程

频道：

- `stable`：checkout 最新的非测试版标签，然后构建 + 诊断。
- `beta`：首选最新的 `-beta` 标签，但当 beta 缺失或旧时，回退到最新的稳定标签。
- `dev`：checkout `main`，然后 fetch + rebase。

高级流程：

1. 需要干净的工作树（无未提交的更改）。
2. 切换到选定的频道（标签或分支）。
3. 拉取上游（仅 dev）。
4. 仅 dev：在临时工作树中进行预检 lint + TypeScript 构建；如果尖端失败，向上回溯最多 10 个提交以找到最新的干净构建。
5. 变基到选定的提交（仅 dev）。
6. 使用仓库包管理器安装依赖。对于 pnpm checkout，更新器按需引导 `pnpm`（首先通过 `corepack`，然后是临时 `npm install pnpm@10` 回退），而不是在 pnpm 工作区中运行 `npm run build`。
7. 构建 + 构建控制 UI。
8. 运行 `openclaw doctor` 作为最终的“安全更新”检查。
9. 将插件同步到活动频道（dev 使用捆绑的扩展；stable/beta 使用 npm）并更新 npm 安装的插件。

如果 pnpm 引导仍然失败，更新器现在会提前停止并显示包管理器特定的错误，而不是尝试在 checkout 中运行 `npm run build`。

## `--update` 简写

`openclaw --update` 重写为 `openclaw update`（对 shell 和启动脚本有用）。

## 另请参阅

- `openclaw doctor`（在 git checkout 上首先提供运行更新）
- [开发频道](/install/development-channels)
- [更新](/install/updating)
- [CLI 参考](/cli)
