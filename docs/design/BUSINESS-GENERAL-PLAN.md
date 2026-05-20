# ClaWorks 通用企业业务扩展规划

**版本**：v1.0  
**日期**：2026-05-20  
**状态**：Pack 已实现，可随 `packs.installed: ["base", "enterprise-general"]` 启用

---

## 一、定位

`enterprise-general` Pack 是独立于工业场景的**通用企业 AI 机器人基础能力层**，适用于：

- 任何企业的 OA 类机器人（飞书/企微/钉钉）
- 不需要 OT/SCADA/工单维修的企业
- 与 `process-industry` Pack 并存，共享 EventKernel + RBAC + ObjectStore

### 位置

```
base（核心治理）
  └── enterprise-general（通用企业业务）
        └── process-industry（工业扩展，按需叠加）
```

---

## 二、对象类型（ObjectStore Schema）

| 类型              | 描述      | 主要字段                                                    |
| ----------------- | --------- | ----------------------------------------------------------- |
| `Task`            | 任务      | title, assignee_id, priority, status, due_at                |
| `ApprovalRequest` | 审批申请  | category, applicant_id, approver_id, amount, status         |
| `Meeting`         | 会议纪要  | organizer_id, raw_notes, summary, action_items, kb_ingested |
| `Incident`        | 业务故障  | category, severity, status, root_cause, resolution          |
| `DailyReport`     | 日报/周报 | report_type, period_start, stats, content                   |
| `ShiftSchedule`   | 排班      | on_duty_id, off_duty_id, handover_note, status              |
| `Announcement`    | 公告      | title, content, target_channels, status                     |

---

## 三、Playbook 清单

### 任务管理

| Playbook                    | 触发                | 功能                         |
| --------------------------- | ------------------- | ---------------------------- |
| `task_created_notify`       | `task.created`      | 通知责任人 + HITL 接单确认   |
| `task_overdue_remind`       | Cron 09:00 工作日   | 扫描超期任务，批量提醒       |
| `query_task_status_from_im` | `task.status_query` | IM 查询个人任务，AI 摘要回复 |

### 审批流程

| Playbook                   | 触发               | 功能                     |
| -------------------------- | ------------------ | ------------------------ |
| `approval_request_created` | `approval.created` | 向审批人发 HITL 审批卡片 |
| `approval_decided`         | `approval.decided` | 通知申请人结果 + KB 存档 |

**自动批准规则**：500元以内报销（`expense`）自动批准，无需 HITL。

### 会议与知识

| Playbook                 | 触发                 | 功能                         |
| ------------------------ | -------------------- | ---------------------------- |
| `meeting_minutes_ingest` | `meeting.created`    | AI 摘要 + 任务提取 + KB 入库 |
| `kb_query_from_im`       | `kb.query_requested` | IM 检索 KB + AI 生成答复     |

### 故障响应

| Playbook                    | 触发                | 功能                                               |
| --------------------------- | ------------------- | -------------------------------------------------- |
| `incident_created_response` | `incident.created`  | AI 根因分析 + P1/P2 立即通知 + 创建处置任务 + HITL |
| `incident_resolved_notify`  | `incident.resolved` | 通知相关人 + 生成复盘摘要 + KB 存档                |

### 运营自动化

| Playbook                 | 触发                   | 功能                                   |
| ------------------------ | ---------------------- | -------------------------------------- |
| `daily_report_generate`  | Cron 17:30 工作日      | AI 生成日报推送 IM                     |
| `shift_handover_notify`  | `shift.handover_due`   | 换班提醒 + HITL 确认 + 更新 RobotOwner |
| `announcement_broadcast` | `announcement.publish` | 多频道广播 + KB 存档                   |

---

## 四、IM 意图扩展

`base` Pack 中的 `classify_im_to_business_event` Playbook 已更新，新增以下意图识别：

| IM 意图           | 发布事件                    | 触发 Playbook               |
| ----------------- | --------------------------- | --------------------------- |
| `task_query`      | `task.status_query`         | `query_task_status_from_im` |
| `task_create`     | `task.create_requested`     | 自定义                      |
| `approval_create` | `approval.create_requested` | 自定义                      |
| `approval_decide` | `approval.decision_input`   | HITL 系统处理               |
| `incident_report` | `incident.created`          | `incident_created_response` |
| `kb_query`        | `kb.query_requested`        | `kb_query_from_im`          |
| `meeting_create`  | `meeting.created`           | `meeting_minutes_ingest`    |
| `announcement`    | `announcement.publish`      | `announcement_broadcast`    |

---

## 五、启用方式

### 5.1 配置文件

```json
{
  "plugins": {
    "entries": {
      "claworks-robot": {
        "config": {
          "packs": {
            "installed": ["base", "enterprise-general"]
          }
        }
      }
    }
  }
}
```

### 5.2 叠加工业场景（可选）

```json
"installed": ["base", "enterprise-general", "process-industry"]
```

### 5.3 热重载（已运行的机器人）

```bash
curl -X POST http://localhost:18800/v1/packs/reload
# 或通过 MCP 工具：
# cw_reload_packs
```

---

## 六、业务事件总线（约定）

```
task.created          → task_created_notify
task.status_query     → query_task_status_from_im
task.status_changed   → （可自定义下游 Playbook）
approval.created      → approval_request_created
approval.decided      → approval_decided
meeting.created       → meeting_minutes_ingest
incident.created      → incident_created_response
incident.resolved     → incident_resolved_notify
shift.handover_due    → shift_handover_notify
announcement.publish  → announcement_broadcast
kb.query_requested    → kb_query_from_im
```

---

## 七、下一步扩展（待规划）

| 模块                       | 描述                                            | 优先级 |
| -------------------------- | ----------------------------------------------- | ------ |
| **人员档案（Employee）**   | 员工信息、部门、角色，跨 Playbook 共享          | 高     |
| **费用报表**               | 月度汇总报销统计，PDF 生成 + A2A 推送财务机器人 | 高     |
| **SLA 监控**               | 故障 SLA 计时、自动升级、月度 SLA 报告          | 高     |
| **知识问答 v2（向量 KB）** | 接 memory-lancedb 向量检索，提升 KB 问答质量    | 中     |
| **外部系统集成**           | Jira/钉钉/企微审批/飞书审批 API Connector       | 中     |
| **多机器人协作**           | HR 机器人 + 财务机器人 + 运营机器人 A2A 委托    | 中     |
| **合规检查**               | 定期合规报告、异常操作检测、审计日志            | 低     |
| **培训管理**               | 课程安排、培训提醒、完成度追踪                  | 低     |

---

## 八、与 process-industry 的边界

| 维度     | enterprise-general        | process-industry                       |
| -------- | ------------------------- | -------------------------------------- |
| 场景     | 通用企业（任何行业）      | 流程工业（OT/SCADA）                   |
| 核心对象 | Task / Incident / Meeting | Equipment / Alarm / WorkOrder          |
| 触发源   | IM / Webhook / Cron / API | Connector（MQTT/OPC-UA/Modbus）/ Alarm |
| 依赖     | base                      | base                                   |
| 可并存   | ✅                        | ✅                                     |

两者共享同一 EventKernel + ObjectStore + RBAC，事件命名空间不冲突。
工业 WorkOrder ≈ 企业 Task（不同语义）；Alarm ≈ Incident（不同来源）。

---

## 九、验证

```bash
# 启动带 enterprise-general 的机器人
pnpm claworks:init  # 或修改 claworks.json installed 列表
# 在 claworks.json 中将 installed 改为 ["base", "enterprise-general"]
pnpm claworks:gateway

# 测试：发布任务创建事件
curl -X POST http://localhost:18800/v1/events \
  -H 'Content-Type: application/json' \
  -d '{"type":"task.created","source":"test","payload":{"id":"t-001","title":"测试任务","assignee_id":"user-1","priority":"high","channel_id":"feishu"}}'

# 测试：发布故障事件
curl -X POST http://localhost:18800/v1/events \
  -H 'Content-Type: application/json' \
  -d '{"type":"incident.created","source":"test","payload":{"id":"i-001","title":"生产系统响应缓慢","category":"it_system","severity":"P2","description":"API 响应时间超过 5 秒"}}'
```

---

## 相关文档

- `ARCHITECTURE.md` — 整体架构与 Playbook 步骤设计
- `IMPLEMENTATION-STATUS.md` — 实现状态（Phase 0-7 已完成）
- `../../../claworks-packs/enterprise-general/` — Pack 源码
