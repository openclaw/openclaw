---
name: industrial-kb
description: >
  Use when searching industrial knowledge — procedures, standards (GB/API/ISO),
  OEM manuals, historical incidents, or station-specific maintenance records.
  Citations are mandatory. Covers Milvus L0-L2 vector search, GraphRAG relationship
  queries, and OpenClaw wiki L3 station memory.
---

# Industrial Knowledge Base

Search and reason over industrial domain knowledge with mandatory source citations.

## When to use

- "GB 50251 对压缩机轴封振动的要求是什么？"
- "C-001 轴承磨损上次是怎么处理的？"
- "压缩机振动异常和哪些上下游设备有关？"
- "我们有没有关于 SDV 阀门的操作规程？"

## Tools

```
kb_search(query, layer?, equipment_type?) → KnowledgeChunks

  layer: "L0" | "L1" | "L2" | null (search all)
  equipment_type: "compressor" | "valve" | "meter" | "pipeline" | null

  Returns:
    chunks[]: { content, source, citation, score }
    Citations format:
      L0: "GB-50251-2015:§7.3"
      L1: "OEM-C001-v3:p47"
      L2: "SOP-MAINT-2024:§3.2"

  Platform API: GET /v1/kb/search?q={url_encoded_query}&layer={L0|L1|L2|L3|null}&equipment_type={compressor|valve|...|null}
  (Bearer: OpenClaw Service Token; path is authoritative per DESIGN-FINAL-LOCK.md §1.4 — not POST /v1/tools/kb/search)

──────────────────────────────────────────────

graph_query(entity, rel_type?, depth?) → Relationships

  entity: equipment_id or concept name
  rel_type: "fault_impact" | "belongs_to" | "similar_fault" | null
  depth: 1 | 2 (default 1)

  Returns:
    entities[]: { name, relation, impact_description, confidence }
    citations[]: "GraphRAG:community-{id}:{description}"

  Platform API: **not listed in DESIGN-FINAL-LOCK.md §1** — use MCP / future NEXUS-API-REFERENCE endpoint when available (do not assume /v1/tools/graph/query).

──────────────────────────────────────────────

kb_search(query, layer="L3") → StationMemory

  Searches L3 station-specific knowledge (verified work orders, local experience)
  L3 is stored in Platform PostgreSQL + pgvector (Phase A); layer filter via query param
  Returns: { title, summary, citation: "L3:station-X:WO-..." }
  # Uses GET /v1/kb/search — NOT OpenClaw memory-wiki CLI (no Platform contract there)
```

## Reasoning rules (mandatory)

```
Knowledge priority (highest to lowest):
  L3 Station memory > L2 Internal SOP > L1 OEM Manual > L0 National Standard

Multi-hop reasoning format:
  Premise [citation] → Reasoning step → Conclusion [confidence: 0.87]

Confidence thresholds:
  ≥ 0.8  → State conclusion directly
  0.6–0.8 → State with "likely" or "probable"
  < 0.6  → "Insufficient evidence, recommend verification"

Prohibited:
  · Any diagnosis without citations
  · Extrapolating beyond the known knowledge boundary
  · Contradicting L3 station memory without explaining why
```

## Output format

```
根据知识库查询：

**发现**：往复式压缩机轴向振动超过 3.5 mm/s 持续 24 小时，
建议停机检查轴承润滑和磨损情况。
[SY/T-5724-2020:§5.3, confidence: 0.91]

**历史参考**：场站 2025-11-02 类似案例（WO-2025-1102-003）
确认轴承磨损，更换轴封后恢复正常。
[L3:station-A:WO-2025-1102-003]

**关联影响**：C-001 异常将影响下游 P-003（流量下降约 15%）
[GraphRAG:community-4:fault-propagation-C001, confidence: 0.76]
```

## Configuration

```
CLAWTWIN_PLATFORM_URL=http://platform-api:8080
CLAWTWIN_OPENCLAW_SERVICE_TOKEN=<openclaw-service-token>
# ↑ Platform 管理员分配的 Service Token（见 ADR-6）
# 绑定飞书用户：OpenClaw 同时携带 X-Feishu-OpenId header（自动注入）
```
