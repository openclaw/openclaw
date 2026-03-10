---
title: CI 流水线
description: OpenClaw CI 流水线的工作原理
summary: "CI 任务图、范围检测和本地命令等效"
read_when:
  - 你需要了解为什么某个 CI 任务没有运行
  - 你正在调试失败的 GitHub Actions 检查
---

# CI 流水线

CI 在每次推送到 `main` 分支和每个 Pull Request 时运行。它使用智能范围检测来跳过仅有文档或原生代码变更时的昂贵任务。

## 任务概览

| 任务               | 用途                                                 | 运行时机                                      |
| ----------------- | ------------------------------------------------------- | ------------------------------------------------- |
| `docs-scope`      | 检测仅文档变更                                | 始终                                            |
| `changed-scope`   | 检测哪些区域发生了变更 (node/macos/android/windows) | 非文档 PR                                    |
| `check`           | TypeScript 类型检查、lint、格式化                          | 推送到 `main`，或有 Node 相关变更的 PR |
| `check-docs`      | Markdown lint + 检查坏链接                       | 文档变更                                  |
| `code-analysis`   | 代码行数阈值检查 (1000 行)                        | 仅 PR                                |
| `secrets`         | 检测泄露的密钥                                   | 始终                                            |
| `build-artifacts` | 构建一次 dist，共享给其他任务                  | 非文档，node 变更                            |
| `release-check`   | 验证 npm pack 内容                              | 构建后                                       |
| `checks`          | Node/Bun 测试 + 协议检查                         | 非文档，node 变更                            |
| `checks-windows`  | Windows 特定测试                                  | 非文档，windows 相关变更                |
| `macos`           | Swift lint/build/test + TS 测试                        | 有 macos 变更的 PR                            |
| `android`         | Gradle 构建 + 测试                                    | 非文档，android 变更                         |

## 快速失败顺序

任务按顺序排列，使便宜的检查在昂贵的检查之前失败：

1. `docs-scope` + `code-analysis` + `check` (并行, ~1-2 分钟)
2. `build-artifacts` (等待上述完成)
3. `checks`, `checks-windows`, `macos`, `android` (等待构建完成)

范围检测逻辑位于 `scripts/ci-changed-scope.mjs`，单元测试位于 `src/scripts/ci-changed-scope.test.ts`。

## 运行器

| 运行器                           | 任务                                       |
| -------------------------------- | ------------------------------------------ |
| `blacksmith-16vcpu-ubuntu-2404`  | 大多数 Linux 任务，包括范围检测 |
| `blacksmith-32vcpu-windows-2025` | `checks-windows`                           |
| `macos-latest`                   | `macos`, `ios`                             |

## 本地等效命令

```bash
pnpm check          # 类型 + lint + 格式化
pnpm test           # vitest 测试
pnpm check:docs     # 文档格式化 + lint + 坏链接检查
pnpm release:check  # 验证 npm pack
```
