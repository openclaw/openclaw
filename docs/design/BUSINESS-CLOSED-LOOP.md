# ClaWorks 业务闭环（设计对照）

本文描述设计文档要求的**端到端业务闭环**及验证方式。

## 主链路

1. **事件入站**：REST `POST /v1/events`、OT Connector、`cw_publish_event`、A2A Task
2. **匹配**：EventBus 优先级队列 → Matcher（glob + 语义 fallback）
3. **编排**：PlaybookEngine 执行步骤（action / function / HITL / notify / a2a_delegate / subagent / skill）
4. **数据**：ObjectStore 持久化；`WorkOrder` 创建触发 `workorder.created`
5. **下游**：`dispatch_mes_on_workorder_created` 等 Playbook 自动匹配
6. **人工**：HITL 挂起 → REST/Studio/Agent 审批 → 恢复执行
7. **运维**：`reload_packs`、Nexus install、Studio 面板、Prometheus metrics

## Pack 剧本（claworks-packs）

| Playbook                            | 触发                   | 闭环作用           |
| ----------------------------------- | ---------------------- | ------------------ |
| `diagnose_on_alarm`                 | `alarm.created` P1/P2  | 诊断 → 工单 → HITL |
| `dispatch_mes_on_workorder_created` | `workorder.created`    | MES 下发           |
| `mro_alarm_to_workorder`            | `alarm.created` + flag | MRO 通知脚手架     |
| `ingest_text_to_kb`                 | manual                 | 知识入库           |
| `reload_packs_and_notify`           | manual                 | 热重载 Pack        |

## 一键验证

```bash
# 单元 + 集成
node node_modules/vitest/vitest.mjs run packages/claworks-runtime

# 进程内 E2E（无需 Gateway）
node --import tsx scripts/claworks-e2e-smoke.mjs

# 业务演示（Gateway 需已启动）
node --import tsx scripts/claworks-closed-loop-demo.mjs
```

## Gateway 启动

```bash
pnpm claworks:init
CLAWORKS_DEMO_CONNECTORS=1 pnpm claworks:init   # 含 echo/mqtt 演示连接器
pnpm claworks:gateway
```

- Studio：`http://127.0.0.1:18800/studio`
- Health：`GET /v1/health`
- 带鉴权时配置 `plugins.entries.claworks-robot.config.api.api_key`
