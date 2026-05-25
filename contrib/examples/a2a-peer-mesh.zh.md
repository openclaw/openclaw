# ClaWorks Phase 2：A2A 双机器人示例

> 多实例架构选型与运维清单：[`docs/MULTI-INSTANCE-DEPLOYMENT.md`](../../docs/MULTI-INSTANCE-DEPLOYMENT.md)。  
> 已废弃的 ClawTwin/ClawOps 三服务栈见 [`docs/legacy/docker-compose-clawtwin-clawops.yml`](../../docs/legacy/docker-compose-clawtwin-clawops.yml)。

## 拓扑

- **alarm-robot**（本机 `:18800`）：接收告警，Playbook 中 `a2a_delegate` 委托维修机器人。
- **maintenance-robot**（本机 `:18801`）：第二份 `claworks.json` + Gateway，处理工单与 MES。

## 步骤

1. 复制 `a2a-peer-mesh.openclaw.fragment.json` 片段到主实例 `~/.claworks/claworks.json` 的 `plugins.entries.claworks-robot.config.a2a.peers`。
2. 第二实例：

```bash
OPENCLAW_STATE_DIR=~/.claworks-maint OPENCLAW_CONFIG_PATH=~/.claworks-maint/claworks.json \
  CLAWORKS_GATEWAY_PORT=18801 pnpm claworks:init
CLAWORKS_INIT_REPAIR=1 OPENCLAW_CONFIG_PATH=~/.claworks-maint/claworks.json pnpm claworks:repair
```

3. 两端 `robot.md` 中 `trusted_sources` 含 `peer`；宪法 `hitl_required` 含 `a2a_delegate`。
4. Playbook 步骤示例：`kind: a2a_delegate`，`peer: maintenance-robot`，`task: diagnose_and_plan`。

## 验证

```bash
curl -sS http://127.0.0.1:18800/.well-known/agent.json
curl -sS http://127.0.0.1:18801/.well-known/agent.json
```

委托任务：`POST /a2a/tasks/send`（需 peer 白名单与 Bearer）。
