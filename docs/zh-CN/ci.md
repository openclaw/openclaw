---
title: CI 流水线
description: OpenClaw CI 流水线工作原理
summary: "CI 作业图、范围门控及本地命令等效项"
read_when:
  - 你需要理解为什么某个 CI 作业运行或未运行
  - 你正在调试 GitHub Actions 检查失败
---

# CI 流水线

CI 会在每次推送到 `main` 分支和每个拉取请求时运行。它使用智能范围检测来跳过仅更改无关区域的高开销作业。

## 作业概览

| 作业                | 用途                                                   | 运行时机                        |
| ------------------- | ------------------------------------------------------ | ------------------------------- |
| `docs-scope`        | 检测仅文档更改                                        | 始终                             |
| `changed-scope`     | 检测哪些区域发生了更改（node/macos/android/windows）  | 非文档更改                      |
| `check`             | TypeScript 类型检查、lint、格式                       | 非文档、node 更改               |
| `check-docs`        | Markdown lint + 损坏链接检查                          | 文档更改                        |
| `secrets`           | 检测泄露的密钥                                        | 始终                             |
| `build-artifacts`   | 构建一次 dist，与 `release-check` 共享                | 推送到 main、node 更改          |
| `release-check`     | 验证 npm 包内容                                       | 推送到 main 后构建              |
| `checks`            | PR 上的 Node 测试 + 协议检查；推送时为 Bun 兼容性     | 非文档、node 更改                |
| `compat-node22`     | 最低支持的 Node 运行时兼容性                          | 推送到 main、node 更改          |
| `checks-windows`    | Windows 特定测试                                      | 非文档、windows 相关更改        |
| `macos`             | Swift lint/build/test + TS 测试                       | 包含 macos 更改的 PR             |
| `android`           | Gradle 构建 + 测试                                    | 非文档、android 更改            |

## 快速失败顺序

作业排序使得廉价检查在昂贵作业之前失败：

1. `docs-scope` + `changed-scope` + `check` + `secrets`（并行，廉价门控优先）
2. PR：`checks`（Linux Node 测试分为 2 个分片）、`checks-windows`、`macos`、`android`
3. 推送到 main：`build-artifacts` + `release-check` + Bun 兼容性 + `compat-node22`

范围逻辑位于 `scripts/ci-changed-scope.mjs`，并在 `src/scripts/ci-changed-scope.test.ts` 中有单元测试覆盖。

## 运行器

| 运行器                           | 作业                                        |
| -------------------------------- | ------------------------------------------ |
| `blacksmith-16vcpu-ubuntu-2404`  | 大多数 Linux 作业，包括范围检测            |
| `blacksmith-32vcpu-windows-2025` | `checks-windows`                           |
| `macos-latest`                   | `macos`、`ios`                              |

## 本地等效命令

```bash
pnpm check          # 类型检查 + lint + 格式
pnpm test           # vitest 测试
pnpm check:docs     # 文档格式 + lint + 损坏链接
pnpm release:check  # 验证 npm 包
```