---
title: CI 流水线
summary: "CI 作业图、范围门控和本地命令等效项"
read_when:
  - 您需要了解为什么 CI 作业运行或未运行
  - 您正在调试失败的 GitHub Actions 检查
---

# CI 流水线

CI 在每次推送到 `main` 分支和每个拉取请求时运行。它使用智能作用域，当只有不相关区域发生变化时，会跳过昂贵的作业。

## 作业概述

| 作业                     | 目的                                                             | 运行时机                     |
| ------------------------ | ---------------------------------------------------------------- | ---------------------------- |
| `preflight`              | 检测仅文档变更、变更范围、变更扩展，并构建 CI 清单               | 始终在非草稿推送和 PR 上运行 |
| `security-fast`          | 私钥检测、通过 `zizmor` 进行工作流审计、生产依赖项审计           | 始终在非草稿推送和 PR 上运行 |
| `build-artifacts`        | 构建 `dist/` 和 Control UI 一次，上传可重用的构件供下游作业使用  | 与 Node 相关的变更           |
| `checks-fast-core`       | 快速 Linux 正确性通道，如捆绑/插件契约/协议检查                  | 与 Node 相关的变更           |
| `checks-node-extensions` | 跨扩展套件的完整捆绑插件测试分片                                 | 与 Node 相关的变更           |
| `checks-node-core-test`  | 核心 Node 测试分片，不包括通道、捆绑、契约和扩展通道             | 与 Node 相关的变更           |
| `extension-fast`         | 仅针对变更的捆绑插件的聚焦测试                                   | 当检测到扩展变更时           |
| `check`                  | CI 中的主要本地门控：`pnpm check` 加上 `pnpm build:strict-smoke` | 与 Node 相关的变更           |
| `check-additional`       | 架构、边界、导入循环保护以及网关监视回归测试工具                 | 与 Node 相关的变更           |
| `build-smoke`            | 构建的 CLI 冒烟测试和启动内存冒烟测试                            | 与 Node 相关的变更           |
| `checks`                 | 剩余的 Linux Node 通道：通道测试和仅推送的 Node 22 兼容性        | 与 Node 相关的变更           |
| `check-docs`             | 文档格式化、 lint 和断链检查                                     | 文档变更                     |
| `skills-python`          | Python 支持的技能的 Ruff + pytest                                | 与 Python 技能相关的变更     |
| `checks-windows`         | Windows 特定的测试通道                                           | 与 Windows 相关的变更        |
| `macos-node`             | 使用共享构建构件的 macOS TypeScript 测试通道                     | 与 macOS 相关的变更          |
| `macos-swift`            | macOS 应用的 Swift lint、构建和测试                              | 与 macOS 相关的变更          |
| `android`                | Android 构建和测试矩阵                                           | 与 Android 相关的变更        |

## 快速失败顺序

作业按顺序排列，以便廉价检查在昂贵检查运行之前失败：

1. `preflight` 决定哪些通道存在。`docs-scope` 和 `changed-scope` 逻辑是此作业中的步骤，而不是独立作业。
2. `security-fast`、`check`、`check-additional`、`check-docs` 和 `skills-python` 快速失败，无需等待更重的构件和平台矩阵作业。
3. `build-artifacts` 与快速 Linux 通道重叠，以便下游消费者可以在共享构建准备就绪后立即开始。
4. 之后，更重的平台和运行时通道会展开：`checks-fast-core`、`checks-node-extensions`、`checks-node-core-test`、`extension-fast`、`checks`、`checks-windows`、`macos-node`、`macos-swift` 和 `android`。

作用域逻辑位于 `scripts/ci-changed-scope.mjs` 中，并由 `src/scripts/ci-changed-scope.test.ts` 中的单元测试覆盖。
单独的 `install-smoke` 工作流通过其自己的 `preflight` 作业重用相同的作用域脚本。它从更窄的 changed-smoke 信号计算 `run_install_smoke`，因此 Docker/安装冒烟测试仅在安装、打包和容器相关变更时运行。

在推送时，`checks` 矩阵添加仅推送的 `compat-node22` 通道。在拉取请求上，该通道被跳过，矩阵保持专注于正常的测试/通道通道。

## 运行器

| 运行器                           | 作业                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| `blacksmith-16vcpu-ubuntu-2404`  | `preflight`、`security-fast`、`build-artifacts`、Linux 检查、文档检查、Python 技能、`android` |
| `blacksmith-32vcpu-windows-2025` | `checks-windows`                                                                              |
| `macos-latest`                   | `macos-node`、`macos-swift`                                                                   |

## 本地等效命令

```bash
pnpm check          # 类型 + lint + 格式
pnpm build:strict-smoke
pnpm check:import-cycles
pnpm test:gateway:watch-regression
pnpm test           # vitest 测试
pnpm test:channels
pnpm check:docs     # 文档格式 + lint + 断链
pnpm build          # 当 CI 构件/构建冒烟通道重要时构建 dist
```
