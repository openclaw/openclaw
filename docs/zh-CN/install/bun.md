---
read_when:
  - 你想要最快的本地开发循环（bun + watch）
  - 你遇到 Bun 安装/补丁/生命周期脚本问题
summary: Bun 工作流（实验性）：安装及与 pnpm 相比的注意事项
title: Bun（实验性）
x-i18n:
  generated_at: "2026-02-03T07:49:24Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: eb3f4c222b6bae49938d8bf53a0818fe5f5e0c0c3c1adb3e0a832ce8f785e1e3
  source_path: install/bun.md
  workflow: 15
---

# Bun（实验性）

目标：使用 **Bun** 运行此仓库（可选，不推荐用于 WhatsApp/Telegram），同时不偏离 pnpm 工作流。

⚠️ **不推荐用于 Gateway 网关运行时**（WhatsApp/Telegram 存在 bug）。生产环境请使用 Node。

## 状态

- Bun 是一个可选的本地运行时，用于直接运行 TypeScript（`bun run …`、`bun --watch …`）。
- `pnpm` 是构建的默认工具，仍然完全支持（并被一些文档工具使用）。
- Bun 无法使用 `pnpm-lock.yaml` 并会忽略它。

## 安装

默认：

```sh
bun install
```

注意：`bun.lock`/`bun.lockb` 被 gitignore，所以无论哪种方式都不会有仓库变动。如果你想*不写入锁文件*：

```sh
bun install --no-save
```

## 构建/测试（Bun）

```sh
bun run build
bun run vitest run
```

## Bun 生命周期脚本（默认被阻止）

除非明确信任（`bun pm untrusted` / `bun pm trust`），Bun 可能会阻止依赖的生命周期脚本。
对于此仓库，通常被阻止的脚本不是必需的：

- `@whiskeysockets/baileys` `preinstall`：检查 Node 主版本 >= 20（我们运行 Node 22+）。
- `protobufjs` `postinstall`：发出关于不兼容版本方案的警告（无构建产物）。

如果你遇到真正需要这些脚本的运行时问题，请明确信任它们：

```sh
bun pm trust @whiskeysockets/baileys protobufjs
```

## 注意事项

- 一些脚本仍然硬编码 pnpm（例如 `docs:build`、`ui:*`、`protocol:check`）。目前请通过 pnpm 运行这些脚本。
