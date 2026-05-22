# ClaWorks 分阶段落地（对照你的路线图）

**原则**：简单任务建立信心 → 多机器人 A2A → LLM 深度推理；安全与可靠性从第一天写入，而非事后补丁。

---

## 架构共识（已采纳）

每台 **单机 ClaWorks** = **人机通道** + **自动通道** 并存：

| 通道     | 实现                                        | 说明                                       |
| -------- | ------------------------------------------- | ------------------------------------------ |
| 人机     | 飞书/Telegram + `classify_im_*` + HITL 卡片 | 人说话 → 意图 → 事件 → Playbook            |
| 自动     | Connector / Scheduler / REST / MCP          | 设备、Cron、API、OpenClaw Agent 工具       |
| 对外脑   | OpenClaw 个人 Agent                         | **MCP** `cw_*` 或 **A2A** 接入同一 Gateway |
| 多机协作 | A2A `a2a_delegate` + peer 白名单            | Phase 2                                    |

OpenClaw **不是**替代 ClaWorks 内核，而是网络中的一个智能体节点（只读查询 + 意图分类，写操作走 ClaWorks HITL/RBAC）。

---

## Phase 1：单机 + 简单 Playbook

**目标**：`告警 → 查对象 → 通知人 → 审批 → 工单`

| 你的建议            | 代码现状                                                     | 判定               |
| ------------------- | ------------------------------------------------------------ | ------------------ |
| 启用 claworks-robot | `pnpm claworks:repair` / init                                | ✅ 运维命令已补    |
| robot.md 宪法       | `contrib/examples/robot.md` + `parseRobotConstitutionFromMd` | ✅ 本次落地        |
| 最简单 Playbook     | `phase1_alarm_notify_hitl.yaml`（无 LLM）                    | ✅ 本次落地        |
| 完整跑通            | 需 Gateway + packs + 飞书可选                                | ⚠️ 你本机需 repair |

**进阶**（已有，比 Phase1 复杂）：`diagnose_on_alarm`（含 LLM 诊断）— Phase 3 预热，不建议第一条。

**验证命令**：

```bash
pnpm claworks:repair && pnpm claworks:gateway
# 注入测试告警（或 echo connector）
curl -sS -H "Authorization: Bearer $CLAWORKS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type":"alarm.created","source":"test","payload":{"priority":"P1","equipment_id":"EQ-1","alarm_id":"A-1"}}' \
  http://127.0.0.1:18800/v1/events
```

---

## Phase 2：多机器人 + A2A

**目标**：告警机器人 → A2A 委托维修机器人

| 机制                               | 现状                                     |
| ---------------------------------- | ---------------------------------------- | ------- |
| A2A 入站                           | `/a2a` + peer 白名单 `config.a2a.peers`  | ✅      |
| `a2a_delegate` 步骤                | Playbook + RBAC `a2a.delegate`           | ✅      |
| 跨机身份                           | `a2a-peer-auth.ts` + `subjectType: peer` | ✅      |
| 宪法 `hitl_required: a2a_delegate` | `robot-constitution.ts`                  | ✅ 本次 |

**待做**（合理，未过度实现）：维修域独立 Pack。  
**示例已补**：`contrib/examples/a2a-peer-mesh.openclaw.fragment.json` + `a2a-peer-mesh.zh.md`（双 Gateway + peer 白名单）。

---

## Phase 3：复杂推理 + LLM

| 机制              | 现状                                     | 注意                     |
| ----------------- | ---------------------------------------- | ------------------------ |
| LLM 步骤          | `kind: llm` + OpenClaw `api.runtime.llm` | ✅ JSON 意图已解析进变量 |
| 诊断函数          | `DiagnoseEquipment`                      | ⚠️ 无 LLM 时 stub 0.82   |
| 多步推理 Playbook | enterprise/commercial packs              | 依赖模型与 KB            |

**建议**：Phase 3 在 Phase1/2 稳定后再默认启用 `diagnose_on_alarm` 与 enterprise LLM Playbook。

---

## 安全机制对照

| #   | 你的机制            | 实现                                               | 备注    |
| --- | ------------------- | -------------------------------------------------- | ------- |
| 1   | Robot Identity 宪法 | `robot.md` + ` ```yaml constitution`               | ✅      |
| 2   | RBAC Guard          | `RbacPolicy` ObjectStore + `DEFAULT_RBAC_POLICIES` | ✅      |
| 3   | A2A 认证            | peer 白名单 + RBAC                                 | ✅      |
| 4   | OpenClaw Agent 只读 | `subjectType: agent` deny write                    | ✅ 本次 |
| 5   | HITL 硬门控         | `hitl` 步骤 + 飞书通知                             | ✅      |
| 6   | 审计                | Playbook run DB + `decision-log` + step logs       | ✅      |

宪法 **`deny`** 已在 action/a2a 步骤执行前强制；**`hitl_required`** 与 Playbook 内显式 `hitl` 步骤配合（避免双重门控冲突）。

---

## 可靠性机制对照

| #   | 你的机制                          | 实现                                             | 差距                                                     |
| --- | --------------------------------- | ------------------------------------------------ | -------------------------------------------------------- |
| 1   | 60s 去重                          | `createDedupGuard(60_000)`                       | ✅ 宪法可配置 `dedup_window`（解析已做，内核默认仍 60s） |
| 2   | Outbox 重试                       | `event-kernel` outbox flush                      | ✅ 指数退避在 outbox 模块                                |
| 3   | Run 存库                          | `playbook_runs` SQLite                           | ✅                                                       |
| 4   | 确定性 vs LLM 分离                | action/condition vs llm 步骤                     | ✅                                                       |
| 5   | HITL 超时升级                     | `timeout_hours` + `expireStaleHitlRuns` + notify | ✅ 每 60s sweep，`hitl.timeout` 事件                     |
| —   | `failure_mode: continue_on_error` | 逐步 `on_failure: continue`                      | ✅ 按步骤，非全局 YAML                                   |
| —   | 全局 `reliability:` YAML 块       | 未实现                                           | 合理推迟；用 Pack 步骤策略即可                           |

---

## 不合理或需调整的部分

1. **`reliability:` 全局块写进每个 Playbook`** — 与当前「步骤级 `on_failure`」重复；建议保留步骤级，全局默认放 `robot.md` / 内核配置。
2. **`auto_allow: query.object_store` 与 RBAC 双轨** — 宪法表达意图，RBAC 仍是执行层真相；两者已并存，文档需写清优先级：**deny（宪法）→ RBAC deny → RBAC allow → 宪法 auto**。
3. **Phase 1 就上 LLM 分类** — IM 分类 Playbook 依赖模型；Phase1 演示可用 **直接 REST 发 `alarm.created`** 绕过分类，你的「简单任务」路径正确。
4. **OpenClaw Agent = 机器人** — 更准确是 **同一网络上的 Agent 节点**（MCP 客户端），身份是 `agent` 主体，不是第二个 `claworks-robot` 进程。

---

## 推荐操作顺序（运维）

1. `pnpm claworks:repair`
2. 复制 `contrib/examples/robot.md` → `~/.claworks/robot.md`（可按需改 Owner/channel）
3. 重启 Gateway，跑 Phase1 告警事件
4. 配置第二个实例 + `a2a.peers`（Phase 2）
5. 打开 `diagnose_on_alarm` / enterprise LLM Playbook（Phase 3）

---

## 相关文件

- 宪法示例：`contrib/examples/robot.md`
- Phase1 Playbook：`claworks-packs/base/ontology/playbooks/phase1_alarm_notify_hitl.yaml`
- 宪法解析：`packages/claworks-runtime/src/claworks/robot-constitution.ts`
- 身份与 RBAC：`packages/claworks-runtime/src/claworks/robot-identity.ts`
