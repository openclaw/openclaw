---
title: CI 流水线
summary: "CI 任务图、范围门和本地命令对照"
read_when:
  - 需要了解为什么 CI 任务运行或未运行
  - 正在调试失败的 GitHub Actions 检查
---

# CI 流水线

CI 在每次推送到 `main` 和每个 Pull Request 时运行。它使用智能范围跳过昂贵的作业，只运行相关区域的更改。

## 概述

| 任务             | 目的                                                                      | 运行时机                                         |
| ----------------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| `preflight`       | 文档范围、范围更改、密钥扫描、工作流审计、生产依赖审计 | 始终基于审计，非文档更改跳过 |
| `docs-scope`      | 检测仅文档更改                                                  | 始终                                           |
| `changed-scope`   | 检测哪些区域更改（node/macos/android/windows）                   | 非文档更改                                  |
| `check`           | TypeScript 类型、lint、格式                                            | 非文档、node 更改                           |
| `check-docs`      | Markdown lint + 断链检查                                         | 文档更改                                     |
| `secrets`         | 检测泄露的密钥                                                     | 始终                                           |
| `build-artifacts` | 构建一次，在 `release-check` 中共享                               | 推送到 `main`、node 更改                   |
| `release-check`   | 验证 npm 包内容                                                | 构建后推送到 `main`                     |
| `checks`          | Node 测试 + PR 协议检查；推送时 Bun 兼容检查                    | 非文档、node 更改                           |
| `compat-node22`   | 最低支持的 Node 运行时兼容性                              | 推送到 `main`、node 更改                   |
| `checks-windows`  | Windows 特定测试                                                    | 非文档、windows 相关更改               |
| `macos`           | Swift lint/build/test + TS 测试                                          | macos 更改的 PR                           |
| `android`         | Gradle 构建 + 测试                                                      | android 更改                        |

## 快速顺序
作业按成本从低到高排序，失败的作业会昂贵：

1. `docs-scope` + `changed-scope` + `check` + `secrets`（并行，先运行廉价的门）
2. PR: `checks`（Linux Node 测试分为 2 个分片）、`checks-windows`、`macos`、`android`
3. 推送到 `main`: `build-artifacts` + `release-check` + Bun 兼容 + `compat-node22`

范围逻辑在 `scripts/ci-changed-scope.mjs` 中，并在 `src/scripts/ci-changed-scope.test.ts` 中有单元测试覆盖。
同一个模块还驱动单独的 `install-smoke` 工作流，通过更窄的 `changed-smoke` 门，因此 Docker/安装烟雾测试运行安装、打包和容器相关的更改。

## 运行器
| 运行器                           | 任务                                       |
| -------------------------------- | ------------------------------------------ |
| `blacksmith-16vcpu-ubuntu-2404`  | 大多数 Linux 任务，包括范围检测 |
| `blacksmith-32vcpu-windows-2025` | `checks-windows`                           |
| `macos-latest`                   | `macos`、`ios`                             |

## 本地命令对照
```bash
pnpm check          # 类型 + lint + 格式
pnpm test           # vitest 测试
pnpm check:docs     # 文档格式 + lint + 断链检查
pnpm release:check  # 验证 npm 包
```