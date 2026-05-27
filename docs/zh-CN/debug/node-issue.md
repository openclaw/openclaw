---
read_when:
  - 调试仅限 Node 的开发脚本或 watch 模式失败
  - 排查 OpenClaw 中 tsx/esbuild 加载器崩溃问题
summary: Node + tsx "__name is not a function" 崩溃说明及解决方法
title: Node + tsx 崩溃
x-i18n:
  generated_at: "2026-02-01T20:24:52Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: f9e9bd2281508337a0696126b0db2d47a2d0f56de7a11872fbc0ac4689f9ad41
  source_path: debug/node-issue.md
  workflow: 14
---

# Node + tsx "\_\_name is not a function" 崩溃

## 概述

通过 Node 使用 `tsx` 运行 OpenClaw 时，启动阶段报错：

```
[openclaw] Failed to start CLI: TypeError: __name is not a function
    at createSubsystemLogger (.../src/logging/subsystem.ts:203:25)
    at .../src/agents/auth-profiles/constants.ts:25:20
```

此问题在开发脚本从 Bun 切换到 `tsx` 后出现（提交 `2871657e`，2026-01-06）。相同的运行路径在 Bun 下正常工作。

## 环境

- Node: v25.x（在 v25.3.0 上观察到）
- tsx: 4.21.0
- 操作系统: macOS（其他运行 Node 25 的平台也可能复现）

## 复现步骤（仅 Node）

```bash
# 在仓库根目录
node --version
pnpm install
node --import tsx src/entry.ts status
```

## 仓库内最小复现

```bash
node --import tsx scripts/repro/tsx-name-repro.ts
```

## Node 版本检查

- Node 25.3.0：失败
- Node 22.22.0（Homebrew `node@22`）：失败
- Node 24：尚未安装，需要验证

## 说明 / 假设

- `tsx` 使用 esbuild 转换 TS/ESM。esbuild 的 `keepNames` 会生成一个 `__name` 辅助函数，并用 `__name(...)` 包裹函数定义。
- 崩溃表明 `__name` 存在但在运行时不是函数，这意味着在 Node 25 的加载器路径中该辅助函数缺失或被覆盖。
- 其他 esbuild 使用者也报告过类似的 `__name` 辅助函数缺失或被重写的问题。

## 回归历史

- `2871657e`（2026-01-06）：脚本从 Bun 改为 tsx，使 Bun 成为可选项。
- 在此之前（Bun 路径），`openclaw status` 和 `gateway:watch` 均正常工作。

## 解决方法

- 开发脚本使用 Bun（当前临时回退方案）。
- 使用 Node + tsc watch，然后运行编译产物：
  ```bash
  pnpm exec tsc --watch --preserveWatchOutput
  node --watch openclaw.mjs status
  ```
- 已在本地确认：`pnpm exec tsc -p tsconfig.json` + `node openclaw.mjs status` 在 Node 25 上可正常运行。
- 如果可能，在 TS 加载器中禁用 esbuild 的 keepNames（防止插入 `__name` 辅助函数）；tsx 目前不提供此配置项。
- 在 Node LTS（22/24）上测试 `tsx`，确认该问题是否为 Node 25 特有。

## 参考资料

- https://opennext.js.org/cloudflare/howtos/keep_names
- https://esbuild.github.io/api/#keep-names
- https://github.com/evanw/esbuild/issues/1031

## 后续步骤

- 在 Node 22/24 上复现，确认是否为 Node 25 回归问题。
- 测试 `tsx` nightly 版本，或在存在已知回归时固定到早期版本。
- 如果在 Node LTS 上也能复现，则向上游提交包含 `__name` 堆栈跟踪的最小复现。
