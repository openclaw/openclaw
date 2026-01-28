---
read_when:
  - 你想在稳定版/测试版/开发版之间切换
  - 你正在标记或发布预发布版本
summary: 稳定版、测试版和开发版渠道：语义、切换和标签管理
title: 开发渠道
x-i18n:
  generated_at: "2026-02-01T21:05:54Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 2b01219b7e705044ce39838a0da7c7fa65c719809ab2f8a51e14529064af81bf
  source_path: install/development-channels.md
  workflow: 14
---

# 开发渠道

最后更新：2026-01-21

OpenClaw 提供三个更新渠道：

- **stable**：npm dist-tag `latest`。
- **beta**：npm dist-tag `beta`（测试中的构建）。
- **dev**：`main` 分支的最新提交（git）。npm dist-tag：`dev`（发布时）。

我们将构建发布到 **beta**，进行测试，然后**将经过验证的构建提升为 `latest`**，无需更改版本号 — dist-tag 是 npm 安装的权威来源。

## 切换渠道

Git checkout 方式：

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

- `stable`/`beta` 会签出最新匹配的标签（通常是同一个标签）。
- `dev` 切换到 `main` 并在上游基础上进行 rebase。

npm/pnpm 全局安装方式：

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

这会通过对应的 npm dist-tag（`latest`、`beta`、`dev`）进行更新。

当你**显式**使用 `--channel` 切换渠道时，OpenClaw 也会同步调整安装方式：

- `dev` 确保存在 git checkout（默认 `~/openclaw`，可通过 `OPENCLAW_GIT_DIR` 覆盖），更新它，并从该 checkout 安装全局 CLI。
- `stable`/`beta` 使用匹配的 dist-tag 从 npm 安装。

提示：如果你想同时使用 stable 和 dev，可以保留两个克隆，并将 Gateway网关指向 stable 的那个。

## 插件与渠道

使用 `openclaw update` 切换渠道时，OpenClaw 也会同步插件来源：

- `dev` 优先使用 git checkout 中内置的插件。
- `stable` 和 `beta` 恢复通过 npm 安装的插件包。

## 标签最佳实践

- 为你希望 git checkout 落到的版本打标签（`vYYYY.M.D` 或 `vYYYY.M.D-<patch>`）。
- 保持标签不可变：永远不要移动或重用标签。
- npm dist-tag 仍然是 npm 安装的权威来源：
  - `latest` → 稳定版
  - `beta` → 候选构建
  - `dev` → main 快照（可选）

## macOS 应用可用性

测试版和开发版构建可能**不包含** macOS 应用发布。这是正常的：

- git 标签和 npm dist-tag 仍然可以发布。
- 在发布说明或变更日志中注明"此测试版无 macOS 构建"即可。
