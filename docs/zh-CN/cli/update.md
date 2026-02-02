---
read_when:
  - 你想安全地更新源码检出
  - 你需要了解 `--update` 简写行为
summary: "`openclaw update`（安全的源码更新 + Gateway网关自动重启）的 CLI 参考"
title: update
x-i18n:
  generated_at: "2026-02-01T20:21:45Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 3a08e8ac797612c498eef54ecb83e61c9a1ee5de09162a01dbb4b3bd72897206
  source_path: cli/update.md
  workflow: 14
---

# `openclaw update`

安全更新 OpenClaw 并在 stable/beta/dev 渠道之间切换。

如果你通过 **npm/pnpm** 安装（全局安装，无 git 元数据），更新将通过[更新](/install/updating)中的包管理器流程进行。

## 用法

```bash
openclaw update
openclaw update status
openclaw update wizard
openclaw update --channel beta
openclaw update --channel dev
openclaw update --tag beta
openclaw update --no-restart
openclaw update --json
openclaw --update
```

## 选项

- `--no-restart`：成功更新后跳过重启 Gateway网关服务。
- `--channel <stable|beta|dev>`：设置更新渠道（git + npm；持久化到配置中）。
- `--tag <dist-tag|version>`：仅为本次更新覆盖 npm dist-tag 或版本。
- `--json`：输出机器可读的 `UpdateRunResult` JSON。
- `--timeout <seconds>`：每步超时时间（默认为 1200 秒）。

注意：降级需要确认，因为旧版本可能会破坏配置。

## `update status`

显示当前活跃的更新渠道 + git 标签/分支/SHA（适用于源码检出），以及更新可用性。

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

选项：

- `--json`：输出机器可读的状态 JSON。
- `--timeout <seconds>`：检查超时时间（默认为 3 秒）。

## `update wizard`

交互式流程，用于选择更新渠道并确认更新后是否重启 Gateway网关（默认重启）。如果你选择 `dev` 但没有 git 检出，它会提供创建一个的选项。

## 工作原理

当你显式切换渠道（`--channel ...`）时，OpenClaw 也会保持安装方式一致：

- `dev` → 确保存在 git 检出（默认：`~/openclaw`，可通过 `OPENCLAW_GIT_DIR` 覆盖），更新它，并从该检出安装全局 CLI。
- `stable`/`beta` → 使用匹配的 dist-tag 从 npm 安装。

## Git 检出流程

渠道：

- `stable`：检出最新的非 beta 标签，然后构建 + doctor。
- `beta`：检出最新的 `-beta` 标签，然后构建 + doctor。
- `dev`：检出 `main`，然后 fetch + rebase。

概要流程：

1. 要求工作树干净（无未提交的更改）。
2. 切换到所选渠道（标签或分支）。
3. 拉取上游（仅 dev）。
4. 仅 dev：在临时工作树中进行预检 lint + TypeScript 构建；如果最新提交失败，会向前回溯最多 10 个提交以找到最新的可成功构建的提交。
5. Rebase 到所选提交（仅 dev）。
6. 安装依赖（优先使用 pnpm；回退到 npm）。
7. 构建项目 + 构建控制台 UI。
8. 运行 `openclaw doctor` 作为最终的"安全更新"检查。
9. 将插件同步到活跃渠道（dev 使用内置扩展；stable/beta 使用 npm）并更新通过 npm 安装的插件。

## `--update` 简写

`openclaw --update` 会重写为 `openclaw update`（便于在 shell 和启动脚本中使用）。

## 另请参阅

- `openclaw doctor`（在 git 检出上会提供先运行更新的选项）
- [开发渠道](/install/development-channels)
- [更新](/install/updating)
- [CLI 参考](/cli)
