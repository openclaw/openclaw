---
read_when:
  - 你想在 stable/beta/dev 之间切换
  - 你正在标记或发布预发布版本
summary: stable、beta 和 dev 渠道：语义、切换和标签
title: 开发渠道
x-i18n:
  generated_at: "2026-03-11T12:00:00Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: a585ce9f2a9c61271c2a0f56cfb6c20645029a32
  source_path: install/development-channels.md
  workflow: 15
---

# 开发渠道

最后更新：2026-01-21

OpenClaw 提供三个更新渠道：

- **stable**：npm dist-tag `latest`。
- **beta**：npm dist-tag `beta`（测试中的构建）。
- **dev**：`main` 的移动头（git）。npm dist-tag：`dev`（发布时）。

我们将构建发布到 **beta**，进行测试，然后**将经过验证的构建提升到 `latest`**，
版本号不变——dist-tag 是 npm 安装的数据源。

## 切换渠道

Git checkout：

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

- `stable`/`beta` 检出最新匹配的标签（通常是同一个标签）。
- `dev` 切换到 `main` 并在上游基础上 rebase。

npm/pnpm 全局安装：

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

这会通过相应的 npm dist-tag（`latest`、`beta`、`dev`）进行更新。

当你使用 `--channel` **显式**切换渠道时，OpenClaw 还会对齐安装方式：

- `dev` 确保有一个 git checkout（默认 `~/openclaw`，可通过 `OPENCLAW_GIT_DIR` 覆盖），
  更新它，并从该 checkout 安装全局 CLI。
- `stable`/`beta` 使用匹配的 dist-tag 从 npm 安装。

提示：如果你想同时使用 stable + dev，保留两个克隆并将 Gateway 网关指向 stable 那个。

## 插件和渠道

当你使用 `openclaw update` 切换渠道时，OpenClaw 还会同步插件来源：

- `dev` 优先使用 git checkout 中的内置插件。
- `stable` 和 `beta` 恢复 npm 安装的插件包。

## 标签最佳实践

- 为你希望 git checkout 落在的发布版本打标签（`vYYYY.M.D` 表示 stable，`vYYYY.M.D-beta.N` 表示 beta）。
- `vYYYY.M.D.beta.N` 也可识别（兼容），但推荐使用 `-beta.N`。
- 旧版 `vYYYY.M.D-<patch>` 标签仍被视为 stable（非 beta）。
- 保持标签不可变：永远不要移动或重用标签。
- npm dist-tag 仍然是 npm 安装的数据源：
  - `latest` → stable
  - `beta` → 候选构建
  - `dev` → main 快照（可选）

## macOS 应用可用性

Beta 和 dev 构建可能**不**包含 macOS 应用发布。这没问题：

- git 标签和 npm dist-tag 仍然可以发布。
- 在发布说明或变更日志中注明"此 beta 无 macOS 构建"。
