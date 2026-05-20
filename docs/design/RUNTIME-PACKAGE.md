# @claworks/runtime 包演进

**更新**：2026-05-20

## 当前形态

| 模块           | 位置                                         | 说明              |
| -------------- | -------------------------------------------- | ----------------- |
| `kernel/`      | `packages/claworks-runtime/src/kernel/`      | ✅ 已物理迁入     |
| `pack-loader/` | `packages/claworks-runtime/src/pack-loader/` | ✅ 已物理迁入     |
| `claworks/`    | `packages/claworks-runtime/src/claworks/`    | ✅ 已物理迁入     |
| `planes/`      | `packages/claworks-runtime/src/planes/`      | ✅ 已物理迁入     |
| `interfaces/`  | `packages/claworks-runtime/src/interfaces/`  | ✅ 已物理迁入     |
| OpenClaw 胶水  | `extensions/claworks-robot/`                 | 不进入 runtime 包 |

根 `src/kernel`、`src/planes`、`src/interfaces`、`src/claworks` shim 已删除；运行时仅 `packages/claworks-runtime/`。

## 消费方式

```typescript
// 进程内 / 脚本 / OpenClaw 插件
import {
  createClaworksRuntime,
  startClaworksRuntime,
  createClaworksRestHandler,
  bridgeImMessage,
  bridgeWebhookPayload,
  applyIngressPublish,
} from "@claworks/runtime";

// 仅 Pack 解析
import { parsePlaybookYaml } from "@claworks/runtime/pack-loader";

// 仅 Kernel
import { createEventKernel } from "@claworks/runtime/kernel";
```

## 验证脚本

```bash
node node_modules/vitest/vitest.mjs run packages/claworks-runtime
node --import tsx scripts/claworks-e2e-smoke.mjs
node --import tsx scripts/claworks-http-smoke.mjs
# 可选（需 Gateway）：
# pnpm claworks:init && pnpm claworks:gateway
# node --import tsx scripts/claworks-closed-loop-demo.mjs
```

聚合：`pnpm claworks:smoke`（e2e + http-smoke）。

## 迁移阶段

### M1 — 子路径与构建 ✅

- [x] `exports` 子路径（开发指向 `src/`，`publishConfig` 指向 `dist/`）
- [x] `pnpm claworks:runtime:build` — 全量 tsdown → `dist/`（7 个入口）
- [x] `pnpm claworks:runtime:dist-smoke` — 验证 `dist/index.mjs` 可启动 runtime

### M2 — 物理迁入 ✅

`kernel`、`pack-loader`、`claworks`、`planes/data`、`planes/orch`、`interfaces` 均在 `packages/claworks-runtime/src/`。根 `src/**` 为 shim。

仓外依赖：`src/infra/node-sqlite`、`studio/index.html`、`connectors/*/bridge.mjs`。

### M3 — 本地 dist 构建 ✅

- `files`: 仅 `dist` + `README.md`（`publishConfig`，**暂不公开发布**）
- `prepublishOnly`: 自动 `build`（仅在未来 publish 时使用）
- 仓内开发仍用 `src/` exports；`pnpm claworks:smoke` 含 build + dist-smoke
- 待办：无（`packs-cli` 已迁入；根 shim 已删除；`entry.ts` bootstrap 经 `../packages/claworks-runtime/src/claworks/product-env.js` 相对 import）

## 约束

- **禁止** `src/claworks/runtime.ts` 直接 `import "@claworks/runtime"`（循环 + Vitest 子路径解析）。
- OpenClaw `api.*` 仅出现在 `extensions/claworks-robot/`。
- Pack 作者优先 `@claworks/sdk`；运行时集成用 `@claworks/runtime`。
