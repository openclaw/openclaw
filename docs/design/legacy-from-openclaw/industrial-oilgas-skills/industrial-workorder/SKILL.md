---
name: industrial-workorder
description: >
  Use when drafting maintenance work orders, requesting field inspections,
  or managing the HITL approval workflow. Never silently executes field actions.
  All outputs are clearly labeled as drafts pending human approval.
---

# Industrial Work Order

Draft and manage maintenance work orders with human-in-the-loop safety.

## When to use

- "帮我给 C-001 建一个检修工单"
- "C-001 振动异常，需要安排停机检查"
- "查一下 C-001 最近的工单历史"
- After `industrial-kb` identifies a procedure → translate to work order draft

## Tools

```
workorder_draft(equipment_id, symptom, suggested_steps?) → WorkOrderDraft

  Returns:
    draft_id: string
    equipment_id: string
    symptom: string
    suggested_steps: string[]
    hazards: string[] (from kb_search, if available)
    required_isolations: string[] (from kb_search, if available)
    procedure_references: string[]
    status: "DRAFT — Pending human approval, not submitted"   # display label only
    citations: string[]

  Platform API: POST /v1/workorders/ai-draft  (DESIGN-FINAL-LOCK.md §1.3; legacy /v1/tools/workorder/* is deprecated)
  Side effect: Platform stores AI-filled draft payload; HITL cards use Feishu callback → /v1/feishu/events (card.action.trigger only)

  ⚠️ Persisted work orders use field name **state** (draft → pending_approval → …), never **status** (DEVELOPMENT-CONTRACT §七).

──────────────────────────────────────────────

workorder_history(equipment_id, limit?) → WorkOrderHistory

  Returns recent work orders for equipment (last 20 by default)
  Platform API: GET /v1/workorders?equipment_id={id}&state=&page= (list filter; not /v1/objects/...)
```

## HITL flow (managed by Platform, not by this skill)

```
1. workorder_draft called → draft stored in PostgreSQL
2. Platform → sends Feishu interactive card to duty group
3. Supervisor taps ✅ Approve or ❌ Reject in Feishu
4. If approved:
   · Work order written to PostgreSQL (official record)
   · Platform triggers L3 knowledge write (kb_documents layer=L3 + Milvus, async)
5. If rejected: draft closed, rejection reason recorded
```

## Output format (draft)

```
📋 工单草稿（待审批，未提交）

设备：C-001 天然气压缩机
标签：C-001 | 类型：计划检修
现象：轴向振动 4.2 mm/s，超过警告阈值 3.5 mm/s，持续上升趋势

建议步骤：
  1. 联系厂家确认停机窗口（预计停机 6 小时）
  2. 关闭进出口截断阀，泄压至安全压力
  3. 拆检轴承，检查润滑脂状态和轴承磨损量
  4. 更换轴封（配件型号：见 OEM 手册 p47）
  5. 回装、试运行，确认振动恢复正常（< 2.0 mm/s）

危险点：
  · 设备带压操作风险 → 确认泄压后再拆检
  · 轴承高温 → 佩戴隔热手套

规程依据：SOP-MAINT-2024:§3.2 | SY/T-5724-2020:§5.3

⚠️ 此为草稿，尚未提交。需主管在飞书审批后生效。
```

## Absolute prohibitions

- Do NOT claim work order has been submitted, approved, or completed without confirmation
- Do NOT recommend executing any field operation without prior HITL approval
- Do NOT bypass permit-to-work (PTW) requirements

## Configuration

```
CLAWTWIN_PLATFORM_URL=http://platform-api:8080
CLAWTWIN_OPENCLAW_SERVICE_TOKEN=<openclaw-service-token>
```
