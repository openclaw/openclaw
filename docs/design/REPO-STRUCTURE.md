# ClaWorks 仓库结构说明

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

```
claworks/
│
├── claworks.mjs                    ← ClaWorks 启动器（替代 openclaw.mjs）
├── package.json                    ← name: "claworks", bin: { claworks: ./claworks.mjs }
├── pnpm-workspace.yaml             ← packages/*
│
├── src/                            ← 继承自 OpenClaw（不大改），新增 ClaWorks 目录
│   ├── gateway/                    ← ✅ OpenClaw 原有，直接继承
│   ├── plugins/                    ← ✅ OpenClaw 原有，直接继承
│   ├── agents/                     ← ✅ OpenClaw 原有（含 Skills/subagent）
│   ├── config/                     ← ✅ OpenClaw 原有
│   ├── cli/                        ← ✅ OpenClaw 原有，新增 claworks 子命令
│   ├── acp/                        ← ✅ OpenClaw 原有
│   │
│   ├── kernel/                     ← 🆕 ClaWorks EventKernel
│   │   ├── event-bus.ts            ← EventBus（优先级队列）
│   │   ├── matcher.ts              ← 事件→Playbook 匹配
│   │   ├── scheduler.ts            ← Cron 触发（复用 gateway cron）
│   │   ├── outbox.ts               ← 可靠投递
│   │   └── index.ts
│   │
│   ├── planes/
│   │   ├── data/                   ← 🆕 DataPlane
│   │   │   ├── object-store.ts     ← ObjectStore（Drizzle ORM）
│   │   │   ├── ontology-engine.ts  ← YAML schema 加载
│   │   │   ├── kb.ts               ← 知识库（Phase 1: 全文；Phase 2: 向量）
│   │   │   └── index.ts
│   │   └── orch/                  ← 🆕 OrchPlane
│   │       ├── playbook-engine.ts  ← Playbook 加载 + 触发
│   │       ├── step-executor.ts    ← 8 种步骤类型执行
│   │       ├── hitl-gate.ts        ← HITL 挂起/恢复
│   │       ├── function-executor.ts← 单次 LLM 推理
│   │       └── index.ts
│   │
│   └── interfaces/
│       ├── a2a/                    ← 🆕 A2A Server
│       │   ├── agent-card.ts       ← /.well-known/agent.json
│       │   ├── task-handler.ts     ← POST /a2a/tasks
│       │   ├── client.ts           ← 主动发 A2A 请求
│       │   └── index.ts
│       ├── mcp/                    ← 🆕 MCP Server（对外暴露工具）
│       │   ├── server.ts
│       │   └── index.ts
│       └── connectors/             ← 🆕 OT Connector 管理
│           ├── connector-manager.ts← 子进程管理（stdio NDJSON）
│           └── index.ts
│
├── extensions/                     ← ClaWorks 自身的核心 Extension（保留必要的）
│   ├── claworks-robot/             ← 🆕 主 Extension（挂载 EventKernel 为 registerService）
│   │   ├── index.ts                ← 注册 kernel 服务 + 自我构建工具
│   │   ├── openclaw.plugin.json
│   │   ├── skills/
│   │   │   ├── claworks-builder/   ← 自我构建 Skill
│   │   │   │   └── SKILL.md
│   │   │   └── claworks-ops/       ← 运维 Skill
│   │   │       └── SKILL.md
│   │   └── src/
│   │       ├── self-build-tools.ts ← cw_write_playbook, cw_define_object_type
│   │       └── status-tools.ts     ← cw_kernel_status, cw_playbook_runs
│   │
│   ├── openai/                     ← ✅ 继承 OpenClaw（LLM Provider）
│   ├── anthropic/                  ← ✅ 继承 OpenClaw
│   ├── feishu/                     ← ✅ 继承 OpenClaw（HITL 通知渠道）
│   ├── telegram/                   ← ✅ 继承 OpenClaw
│   └── ...（其他必要 provider/channel）
│
├── packages/
│   ├── claworks-sdk/               ← 🆕 第三方 Pack 开发 SDK
│   │   ├── src/
│   │   │   ├── define-pack-entry.ts
│   │   │   ├── pack-manifest.ts    ← claworks.pack.json 类型定义
│   │   │   └── index.ts
│   │   └── package.json            ← name: "@claworks/sdk"
│   │
│   └── claworks-client-internal/   ← 🆕 内部 HTTP 工具（供 claworks-robot 使用）
│
├── packs/                          ← Pack 安装目录（运行时，类比 ~/.openclaw/skills/）
│   └── .gitkeep
│
├── docs/
│   ├── design/                     ← 本设计文档目录
│   └── reference/                  ← 开发者参考文档
│
└── UPSTREAM-SYNC.md                ← OpenClaw 上游同步策略
```

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
└── oilgas/                         ← 油气行业（商业，闭源）
    ├── claworks.pack.json
    └── ontology/ ...
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

| 保留原名（不改） | 原因 |
|-----------------|------|
| `OpenClawConfig` | 改名 = 每次 merge 都冲突 |
| `definePluginEntry` | 同上 |
| `src/gateway/` | 同上 |
| `openclaw.plugin.json` | 插件合约，不改 |
| `api.runtime.*` | Plugin SDK，不改 |

| 改成 ClaWorks 品牌（只改表层） |
|-------------------------------|
| `claworks` CLI 命令名 |
| `claworks.json` 配置文件名 |
| `~/.claworks/` 状态目录 |
| 产品文档/README |
