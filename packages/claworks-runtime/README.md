# @claworks/runtime

ClaWorks 核心运行时库：EventKernel、DataPlane、OrchPlane、REST / A2A / MCP 接口。

OpenClaw 插件 `extensions/claworks-robot` 通过本包挂载 HTTP 路由与服务；也可在进程内直接 `createClaworksRuntime()` 嵌入。

```typescript
import {
  createClaworksRuntime,
  startClaworksRuntime,
  createClaworksRestHandler,
  createPackLoader,
  parsePlaybookYaml,
} from "@claworks/runtime";

// Pack 作者也可单独引用
import { parsePlaybookYaml } from "@claworks/runtime/pack-loader";
```

**包内模块**：`kernel/`、`pack-loader/`、`claworks/`、`planes/`、`interfaces/` 均已物理迁入（见 `docs/design/RUNTIME-PACKAGE.md`）。仓根 `src/**` 为兼容 shim。

子路径：`@claworks/runtime`、`@claworks/runtime/kernel`、`@claworks/runtime/pack-loader`、`@claworks/runtime/claworks`、`@claworks/runtime/planes/data`、`@claworks/runtime/planes/orch`、`@claworks/runtime/interfaces`。

仍引用仓根：`src/infra/node-sqlite`、`studio/index.html`、`connectors/*` 桥接脚本。

```bash
pnpm claworks:runtime:build       # tsdown → dist/（全量 runtime）
pnpm claworks:runtime:dist-smoke  # 验证 dist 可加载
pnpm claworks:smoke               # build + dist-smoke + e2e + http-smoke
```

npm 发布时使用 `publishConfig.exports`（仅 `dist/`）；仓内 workspace 默认仍解析 `src/` 便于 Vitest。发布清单见 [`docs/claworks/npm-publish.md`](../../docs/claworks/npm-publish.md)。

运行时源码仅在 `packages/claworks-runtime/`；新代码请用 `@claworks/runtime` 或子路径 `@claworks/runtime/kernel` 等。

OpenClaw 专用胶水（`createClaworksBridge`、通道通知、HITL managedFlows）在 `extensions/claworks-robot/`。
