---
title: CI流水线
summary: "CI任务图、范围门控和本地命令等效项"
read_when:
  - 你需要理解为什么CI任务运行或未运行
  - 你正在调试失败的GitHub Actions检查
---

# CI流水线

CI在每次推送到`main`分支和每个拉取请求时运行。它使用智能范围来在只有无关区域更改时跳过昂贵的任务。

## 任务概览

| 任务                      | 目的                                                                                 | 运行时机                            |
| ------------------------ | --------------------------------------------------------------------------------------- | ----------------------------------- |
| `preflight`              | 检测仅文档更改、更改范围、更改的扩展，并构建CI清单                                    | 始终在非草稿推送和PR上运行          |
| `security-fast`          | 私钥检测、通过`zizmor`进行工作流审计、生产依赖项审计                                  | 始终在非草稿推送和PR上运行          |
| `build-artifacts`        | 构建`dist/`和Control UI一次，上传可重用的构件供下游任务使用                          | 与Node相关的更改                     |
| `checks-fast-core`       | 快速Linux正确性通道，如捆绑/插件合约/协议检查                                        | 与Node相关的更改                     |
| `checks-node-extensions` | 跨扩展套件的完整捆绑插件测试分片                                                    | 与Node相关的更改                     |
| `checks-node-core-test`  | 核心Node测试分片，不包括通道、捆绑、合约和扩展通道                                    | 与Node相关的更改                     |
| `extension-fast`         | 仅针对已更改的捆绑插件的集中测试                                                    | 当检测到扩展更改时                   |
| `check`                  | CI中的主要本地门控：`pnpm check`加上`pnpm build:strict-smoke`                       | 与Node相关的更改                     |
| `check-additional`       | 架构、边界、导入循环防护以及网关监视回归测试套件                                     | 与Node相关的更改                     |
| `build-smoke`            | 构建的CLI烟雾测试和启动内存烟雾测试                                                 | 与Node相关的更改                     |
| `checks`                 | 剩余的Linux Node通道：通道测试和仅推送的Node 22兼容性                                | 与Node相关的更改                     |
| `check-docs`             | 文档格式、lint和断链检查                                                             | 文档已更改                           |
| `skills-python`          | 对Python支持的技能进行Ruff + pytest测试                                              | 与Python技能相关的更改               |
| `checks-windows`         | Windows特定测试通道                                                                 | 与Windows相关的更改                  |
| `macos-node`             | 使用共享构建构件的macOS TypeScript测试通道                                           | 与macOS相关的更改                    |
| `macos-swift`            | macOS应用的Swift lint、构建和测试                                                    | 与macOS相关的更改                    |
| `android`                | Android构建和测试矩阵                                                                | 与Android相关的更改                  |

## 快速失败顺序

任务按顺序排列，以便廉价检查在昂贵检查运行之前失败：

1. `preflight`决定哪些通道存在。`docs-scope`和`changed-scope`逻辑是此任务中的步骤，不是独立任务。
2. `security-fast`、`check`、`check-additional`、`check-docs`和`skills-python`快速失败，无需等待更重的构件和平台矩阵任务。
3. `build-artifacts`与快速Linux通道重叠，以便下游消费者可以在共享构建准备就绪后立即开始。
4. 之后，更重的平台和运行时通道会展开：`checks-fast-core`、`checks-node-extensions`、`checks-node-core-test`、`extension-fast`、`checks`、`checks-windows`、`macos-node`、`macos-swift`和`android`。

范围逻辑位于`scripts/ci-changed-scope.mjs`中，并由`src/scripts/ci-changed-scope.test.ts`中的单元测试覆盖。
单独的`install-smoke`工作流通过其自己的`preflight`任务重用相同的范围脚本。它从更窄的更改烟雾信号计算`run_install_smoke`，因此Docker/安装烟雾测试仅在安装、打包和容器相关更改时运行。

在推送时，`checks`矩阵添加仅推送的`compat-node22`通道。在拉取请求时，该通道被跳过，矩阵专注于正常的测试/通道。

## 运行器

| 运行器                           | 任务                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `blacksmith-16vcpu-ubuntu-2404`  | `preflight`、`security-fast`、`build-artifacts`、Linux检查、文档检查、Python技能、`android` |
| `blacksmith-32vcpu-windows-2025` | `checks-windows`                                                                                     |
| `macos-latest`                   | `macos-node`、`macos-swift`                                                                          |

## 本地等效命令

```bash
pnpm check          # 类型 + lint + 格式
pnpm build:strict-smoke
pnpm check:import-cycles
pnpm test:gateway:watch-regression
pnpm test           # vitest测试
pnpm test:channels
pnpm check:docs     # 文档格式 + lint + 断链
pnpm build          # 当CI构件/构建烟雾通道重要时构建dist
```