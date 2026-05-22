# ClaWorks 目录布局（实现真源）

> 更新：2026-05-22  
> 与 [REPO-STRUCTURE.md](./REPO-STRUCTURE.md) 的关系：REPO-STRUCTURE 含三仓规划；**本文描述 claworks 仓当前磁盘布局**。

## 顶层

```
claworks/
├── claworks.mjs              # 产品 CLI 入口（推荐）
├── openclaw.mjs              # upstream 兼容入口
├── packages/                 # ClaWorks 产品包（见下）
├── extensions/               # OpenClaw 插件树 + claworks-robot
├── src/                      # OpenClaw 继承 + ClaWorks 产品 CLI/配置 seam
├── contrib/                  # 配置片段、示例（非 Pack 源码）
├── connectors/               # OT 连接器子进程（stdio NDJSON）
├── packs/                    # 运行时安装目录（git 空，见 packs/README.md）
├── studio/                   # 轻量静态 Studio 占位
├── docs/design/              # 架构与设计
└── scripts/claworks-*.mjs    # 产品运维脚本
```

## 产品运行时（`packages/claworks-runtime/`）

EventKernel、三平面、对外接口 **已实现于此**，不在 `src/kernel/`：

```
packages/claworks-runtime/src/
├── kernel/           # EventBus、Ingress、Scheduler、PlaybookMatcher
├── planes/
│   ├── data/         # ObjectStore、Ontology、KB
│   └── orch/         # PlaybookEngine、StepExecutor、HITL
├── interfaces/
│   ├── a2a/          # A2A Server / Client
│   ├── mcp/          # MCP 工具面
│   ├── rest/         # /v1/* HTTP
│   ├── connectors/   # ConnectorManager（spawn connectors/）
│   ├── nexus/        # Pack Nexus
│   └── studio/       # Studio API seam
├── claworks/         # 产品装配：runtime、doctor、pack-runtime、robot
├── pack-loader/      # 从 claworks-packs 加载 manifest
└── agents/           # 运行时 agent 辅助
```

## 插件与扩展

| 路径                         | 角色                                          |
| ---------------------------- | --------------------------------------------- |
| `extensions/claworks-robot/` | 主产品插件：挂载 runtime、`cw_*` 工具、Skills |
| `extensions/feishu/` 等      | 继承 OpenClaw 渠道（HITL / 通知）             |
| `packages/claworks-sdk/`     | 第三方 Pack 开发 SDK                          |
| `packages/claworks-client/`  | 内部 HTTP/MCP 客户端（fork 内）               |

## contrib（非 Pack 源码）

```
contrib/
├── README.md
├── claworks-product.plugins.allow.json
├── claworks-extensions-prune.json
├── examples/                 # openclaw.fragment.json、starter pack 示例
└── packs/README.md           # 指针 → claworks-packs 仓
```

## 外部 sibling 仓

| 仓                                | 关系                                            |
| --------------------------------- | ----------------------------------------------- |
| `../claworks-packs/`              | Pack YAML/TS **唯一真源**                       |
| `../openclaw-claworks-extension/` | 官方 OpenClaw 桥接插件                          |
| `../daily-report-system/`         | 日报垂直应用（Python + install 脚本）           |
| `../openclaw/`                    | upstream Gateway fork（不含 ClaWorks 产品代码） |

## 已废弃路径（勿新建）

| 路径                                    | 替代                                    |
| --------------------------------------- | --------------------------------------- |
| `contrib/packs/*`（除 README）          | `claworks-packs/`                       |
| `contrib/industrial-oilgas-skills/`     | `docs/design/legacy-from-openclaw/`     |
| `src/kernel/`（规划位）                 | `packages/claworks-runtime/src/kernel/` |
| `clawtwin-platform` / `clawtwin-studio` | 已归档至 `~/Projects/archive/`          |

## 维护规则

1. 新增 ClaWorks 运行时模块 → `packages/claworks-runtime/`，并更新 `IMPLEMENTATION-STATUS.md`。
2. 新增 Pack → `claworks-packs/`，不在本仓 `packs/` 或 `contrib/` 写真源。
3. 新增配置片段 / 示例 → `contrib/examples/`。
4. 改目录边界 → 同步 `PROJECT-BOUNDARY.md` 与本文。
