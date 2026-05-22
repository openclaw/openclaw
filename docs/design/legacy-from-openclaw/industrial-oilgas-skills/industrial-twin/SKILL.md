---
name: industrial-twin
description: >
  Use when reading or interpreting real-time industrial equipment state — current sensor values,
  operational status, threshold comparisons, or historical trends.
  Equipment state is served by Nexus Platform API with Redis-cached shadow data.
---

# Industrial Digital Twin Reader

Read and interpret the real-time state of industrial equipment from the ClawTwin Nexus Platform.
Equipment state is stored in Redis shadow cache (updated by OPC-UA bridge or Mock scheduler)
and historical time-series in TimescaleDB. **Not Eclipse Ditto** (removed from Phase A).

## When to use

- "C-001 现在的压力是多少？"
- "SDV-001 阀门是开着还是关着？"
- "查一下场站所有设备的当前状态"
- "C-001 的振动有没有超过警告阈值？"

## Tool

```
twin_read(equipment_id: string) → EquipmentState

Returns:
  name: string
  type: string
  current: { [metric: string]: number }
  thresholds: { [metric: string]: { warn: number, alarm: number } }
  status: "NORMAL" | "WARNING" | "ALARM" | "OFFLINE"
  last_updated: ISO timestamp
  citations: ["shadow:{equipment_id}:{timestamp}", "OPC-UA:{node_id}"]

Platform API: GET /v1/equipment/{equipment_id}
  (Bearer: OpenClaw Service Token for agent tools; see DESIGN-FINAL-LOCK.md §1.1)
```

## Behavior rules

- **Real-time data is not a substitute for field instruments** — always note data timestamp
- **Report status clearly**: compare current values against thresholds, state if in NORMAL / WARNING / ALARM
- **Include Studio link** when relevant: `https://{studio}/#{equipment_id}` for 3D view
- **Citations required**: `shadow:{equipment_id}:{timestamp}` (Redis shadow / mock scheduler in Phase A; not Eclipse Ditto)

## Output format

```
设备：C-001 天然气压缩机
状态：⚠️ WARNING
轴向振动：4.2 mm/s（警告阈值：3.5，报警阈值：5.0）
出口压力：6.1 MPa（正常范围：5.8–6.5）
运行温度：78°C（正常范围：60–85）
数据时间：2026-05-08 14:32:00

[3D 查看 →](https://studio.clawtwin.local/#C-001)
citations: [shadow:C-001:2026-05-08T14:32:00Z]
```

## Diagnosis (AI reasoning stays in OpenClaw; Platform is data + HITL only)

When the user asks for diagnosis or analysis, **do not call Platform for LLM chat**. The OpenClaw
agent loop performs reasoning; this Skill reads **authoritative Platform state** via REST (Service Token)
or MCP (see DESIGN-FINAL-LOCK.md §1.7). Platform may run **bge-m3 embed + MOIRAI background scoring**
only — never vLLM chat on Platform (DEVELOPMENT-CONTRACT.md §三, §六).

```
Step 1: GET {PLATFORM_URL}/v1/equipment/{equipment_id}/decision-package
        (and/or GET /v1/equipment/{equipment_id} for live snapshot + GET /v1/equipment/{id}/readings)
Step 2: GET {PLATFORM_URL}/v1/kb/search?q=...&layer=...&equipment_type=...
Step 3: Reasoning: OpenClaw model / provider (not Platform HTTP)
Step 4 (optional persist): POST {PLATFORM_URL}/v1/workorders/ai-draft  → AI-filled fields only; created rows use field name state (never status)
```

Diagnosis triggers:

- "C-001 振动异常，请诊断"
- "分析 SDV-001 的运行状态"
- "今天的设备健康情况怎么样"

Studio-triggered long jobs use `POST /v1/ai/jobs` + SSE (`GET /v1/sse/ai-jobs/{job_id}`), not ad-hoc GPU calls from this Skill (DEVELOPMENT-CONTRACT.md §六).

## Configuration

```
CLAWTWIN_PLATFORM_URL=http://platform-api:8080
CLAWTWIN_OPENCLAW_SERVICE_TOKEN=<openclaw-service-token>
```

> Architecture note: Configure LLM / GPU endpoints only in OpenClaw (`OPENCLAW_*` / provider
> profiles). Skills must not bypass OpenClaw to hit vLLM for chat.

**Authorization (iron law 2)**: never trust client-supplied `station_id` for mutating calls; derive
`station_id` from equipment (or JWT-scoped `station_ids`) on Platform after `GET /v1/equipment/{id}`.
