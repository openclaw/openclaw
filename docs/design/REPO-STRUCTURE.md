# ClaWorks 仓库结构说明

> **实现真源（2026-05-22）**：运行时内核与三平面在 `packages/claworks-runtime/src/`，不在 `src/kernel/`。  
> 当前磁盘布局见 [DIRECTORY-LAYOUT.md](./DIRECTORY-LAYOUT.md)。

---

## 三个独立仓库，三条关注点

```
仓库                              用途                        依赖关系
────────────────────────────      ──────────────────          ────────────────
claworks/                         ClaWorks 产品本体            依赖 openclaw（upstream）
openclaw-claworks-extension/      官方 OpenClaw 接入插件        依赖 openclaw npm 包
claworks-packs/                   行业扩展包                   依赖 claworks-sdk npm 包
```

**黄金法则：三个仓库互不直接依赖代码，只通过 npm 包 / HTTP / A2A 交互。**

---

## 仓库一：claworks/

> OpenClaw Fork → ClaWorks 产品

### 目录结构

> **实现真源（2026-05-22）**：见 [DIRECTORY-LAYOUT.md](./DIRECTORY-LAYOUT.md)。  
> EventKernel / 三平面 / 对外接口在 **`packages/claworks-runtime/src/`**，不在 `src/kernel/`。  
> 根 `package.json` 仍 `name: openclaw`（upstream 兼容）；产品 CLI 为 `claworks.mjs`。

```
claworks/
├── claworks.mjs / openclaw.mjs     ← 产品 / upstream 双入口
├── packages/claworks-runtime/      ← ★ 运行时真源（kernel, planes, interfaces）
├── extensions/claworks-robot/      ← 进程内插件（48 cw_* 工具）
├── packages/claworks-sdk/          ← @claworks/sdk
├── packages/claworks-client/       ← @claworks/client（fork 内 HTTP/MCP）
├── src/cli/product/                ← claworks 子 CLI
├── src/config/claworks-*           ← 产品配置 seam
├── connectors/                     ← OT 子进程
├── contrib/                        ← 配置片段 + 示例（非 Pack 真源）
├── packs/                          ← 运行时安装目录（git 空）
└── docs/design/                    ← 设计文档
```

历史规划中的 `src/kernel/` 树已废弃，勿再按该路径新建模块。

---

## 仓库二：openclaw-claworks-extension/

> 让官方 OpenClaw 用户连接 ClaWorks 的独立 npm 包

```
openclaw-claworks-extension/
│
├── package.json
│   {
│     "name": "@claworks/openclaw-extension",
│     "peerDependencies": { "openclaw": ">=2026.5.0" }
│   }
│
├── pnpm-workspace.yaml
│
├── extensions/
│   └── claworks/                   ← 迁入自 openclaw/extensions/claworks/
│       ├── index.ts                ← 所有 cw_* 工具（HTTP bridge to ClaWorks）
│       ├── openclaw.plugin.json
│       ├── skills/
│       │   ├── claworks-monolith/  ← Skill 文档（修复与工具名不符的问题）
│       │   └── claworks-multi/
│       └── src/
│
└── packages/
    ├── claworks-client/            ← 迁入自 openclaw/packages/claworks-client/
    │   ├── src/
    │   │   ├── instance-config.ts  ← 实例配置（monolith/twin/ops）
    │   │   ├── instance-resolver.ts
    │   │   ├── http-transport.ts   ← HTTP bridge
    │   │   └── mcp-transport.ts    ← MCP bridge
    │   └── package.json            ← name: "@claworks/openclaw-client"
    │
    └── claworks-plugin-bridge/     ← 迁入自 openclaw/packages/claworks-plugin-bridge/
        └── package.json            ← name: "@claworks/openclaw-plugin-bridge"
```

**安装方式**（官方 OpenClaw 用户）：

```bash
openclaw plugins install @claworks/openclaw-extension
```

**配置**：

```json
{
  "plugins": {
    "entries": {
      "claworks": {
        "enabled": true,
        "config": {
          "instances": {
            "main": { "role": "monolith", "url": "http://localhost:8900" }
          }
        }
      }
    }
  }
}
```

---

## 仓库三：claworks-packs/

> 行业扩展包（可以逐步商业化）

```
claworks-packs/
│
├── README.md                       ← Pack 开发指南
│
├── base/                           ← 基础本体（开源，随 ClaWorks 分发）
│   ├── claworks.pack.json
│   └── ontology/
│       ├── object_types/
│       │   ├── Equipment.yaml      ← 迁入自 Python clawtwin-platform
│       │   ├── Alarm.yaml
│       │   ├── WorkOrder.yaml
│       │   ├── Shift.yaml
│       │   └── KnowledgeDoc.yaml
│       └── playbooks/
│           ├── alarm-to-workorder.yaml  ← 迁入自 Python 侧
│           └── hitl-approve.yaml
│
├── process-industry/               ← 流程工业（开源）
│   ├── claworks.pack.json
│   └── ontology/
│       ├── object_types/
│       │   ├── Pump.yaml
│       │   ├── Compressor.yaml
│       │   └── Pipeline.yaml
│       └── playbooks/
│           ├── pump-alarm-diagnose.yaml
│           └── inspection-trigger.yaml
│
└── domain-operations/              ← 领域运营（见 claworks.packs.json）

> 规划中的 `oilgas/` 商业 Pack **尚未**纳入本仓；工业场景见 `process-industry/`、`industrial/`。
```

---

## 上游同步策略（UPSTREAM-SYNC.md 摘要）

```bash
# 定期同步（建议每月一次或 OpenClaw 重大发布后）

git fetch upstream
git log upstream/main --oneline -20  # 查看上游变更

# 合并（只有表层文件冲突：package.json、README、docs/）
git merge upstream/main

# 冲突处理：
# package.json  → 保留 claworks 的 name/bin，接受上游的依赖升级
# README.md     → 保留 claworks 品牌，接受上游的新功能描述
# src/**/*.ts   → 通常无冲突（我们只在新目录里添加，不改 src/ 原有文件）

# 验证
pnpm install && pnpm build && pnpm test:changed
```

**内部代码不改名原则（确保低冲突）**：

| 保留原名（不改）       | 原因                     |
| ---------------------- | ------------------------ |
| `OpenClawConfig`       | 改名 = 每次 merge 都冲突 |
| `definePluginEntry`    | 同上                     |
| `src/gateway/`         | 同上                     |
| `openclaw.plugin.json` | 插件合约，不改           |
| `api.runtime.*`        | Plugin SDK，不改         |

| 改成 ClaWorks 品牌（只改表层） |
| ------------------------------ |
| `claworks` CLI 命令名          |
| `claworks.json` 配置文件名     |
| `~/.claworks/` 状态目录        |
| 产品文档/README                |
