# ClaWorks 产品配置档案

> 与 OpenClaw `plugins.allow` + `plugins.entries` 模式对齐。单独运行时使用 `~/.claworks/claworks.json`。

---

## 初始化与启动（对齐 OpenClaw 习惯）

```bash
# 一键：自动 init/repair + 启动 Gateway（最省事，等同 openclaw gateway run）
pnpm claworks:start
# 或
node claworks.mjs start

# 开发：文件变更自动重启 Gateway
pnpm claworks:dev

# 首次：交互向导（模型 / 飞书 / Skills），不常驻 Gateway
pnpm claworks:setup

# 仅写 ~/.claworks/claworks.json 骨架
pnpm claworks:init

# 修复已有配置（robot + packs + 端口）
pnpm claworks:repair

# 向量 KB（memory-core + LanceDB）
CLAWORKS_VECTOR_KB=1 pnpm claworks:repair

# PostgreSQL schema
CLAWORKS_DATABASE_URL=postgresql://... pnpm claworks:migrate
```

`claworks gateway run` 在 product 模式下也会自动执行轻量 repair（可用 `CLAWORKS_SKIP_BOOTSTRAP=1` 关闭）。

| 变量                                                 | 效果                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| `CLAWORKS_VECTOR_KB=1`                               | repair 时写入 `memory-core` / `memory-lancedb` / `plugins.slots.memory` |
| `CLAWORKS_INIT_PROFILE=core`                         | `installed`: `base`, `process-industry`                                 |
| `CLAWORKS_INIT_PROFILE=enterprise`（默认）           | 上列 + `enterprise-general`, `enterprise-commercial`                    |
| `CLAWORKS_INIT_SECURE=1`                             | 新配置：写入 key；**已有配置**：就地升级（不覆盖 packs/peers）          |
| `CLAWORKS_INIT_FORCE=1`                              | 强制覆盖整个 `claworks.json`                                            |
| `CLAWORKS_PRODUCT_PROFILE=core`                      | 仅 `claworks-robot`（高级/最小部署）                                    |
| `CLAWORKS_PRODUCT_PROFILE=extended`（**init 默认**） | core + feishu + openai + memory-core 等                                 |

插件白名单源文件：`contrib/claworks-product.plugins.allow.json`。

---

## 验证命令

| 命令                                                  | 范围                                                                    |
| ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `pnpm claworks:runtime:test`                          | `@claworks/runtime` 单元/集成                                           |
| `pnpm test extensions/claworks-robot`                 | Manifest 契约                                                           |
| `pnpm claworks:smoke`                                 | dist + e2e + http + 企业/商务闭环                                       |
| `pnpm build`                                          | 全量构建（含 plugin-sdk dts）                                           |
| `pnpm claworks:gateway:e2e`                           | **真实 Gateway** 启动 + `/v1` + MCP                                     |
| `pnpm claworks:gateway` + `pnpm claworks:closed-loop` | 对已运行 Gateway 的手工闭环（`claworks:gateway` 委托 `claworks start`） |

---

## 两种 OpenClaw 对接形态

| 形态                   | 插件                                                  | 通信                                        |
| ---------------------- | ----------------------------------------------------- | ------------------------------------------- |
| **内置机器人**（本仓） | `extensions/claworks-robot`                           | 进程内 `@claworks/runtime`，HTTP `/v1` 同源 |
| **外接平台**（独立仓） | `openclaw-claworks-extension` → `extensions/claworks` | HTTP/MCP 到远程 ClaWorks URL                |

工具名均为 `cw_*`，配置键分别为 `plugins.entries.claworks-robot` 与 `plugins.entries.claworks`。
