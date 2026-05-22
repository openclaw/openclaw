---
name: industrial-analytics
description: >
  Use when analyzing equipment trends, detecting anomalies with AI time-series models,
  querying historical operational data, or generating KPI reports.
  Covers MOIRAI 2.0 anomaly detection, TimescaleDB history queries, and trend analysis.
---

# Industrial Analytics

Analyze trends, detect anomalies, and generate reports from industrial operational data.

## When to use

- "C-001 最近 7 天的振动趋势是什么？"
- "这个月哪些设备有异常？"
- "给我出一份场站本周的 KPI 报告"
- "C-001 的振动还有多久会超过报警值？"

## Tools

```
anomaly_detect(equipment_id, metrics[], window?) → AnomalyResult

  window: "24h" | "7d" | "30d" (default "7d")

  Returns:
    anomaly: boolean
    trend: "stable" | "rising" | "falling" | "oscillating" | "step_change"
    prediction_72h: { value: number, confidence: number }
    confidence: number (MOIRAI model confidence)
    citation: "MOIRAI-2.0:{equipment_id}:{timestamp}"

  Platform API: prefer GET /v1/equipment/{equipment_id}/decision-package for pre-computed MOIRAI / health signals (DESIGN-FINAL-LOCK §1.1); dedicated `/v1/analytics/*` paths are not in §1 — confirm in NEXUS-API-REFERENCE.md before coding clients.

──────────────────────────────────────────────

historical_query(equipment_id, metrics[], start, end) → TimeSeries

  Returns: time-indexed data array + statistics (mean, std, min, max, percentiles)
  Platform API: GET /v1/equipment/{equipment_id}/readings?metric=&from=&to= (DESIGN-FINAL-LOCK §1.1)

──────────────────────────────────────────────

kpi_report(station_id, period?) → KPIReport

  period: "day" | "week" | "month" | "quarter" (default "week")

  Returns:
    availability: number (%)
    mtbf: number (hours)
    mttr: number (hours)
    energy_consumption: number
    anomaly_count: { P1, P2, P3 }
    workorder_stats: { planned, unplanned, completed, pending }

  Platform API: GET /v1/production/kpi?station_id= (DESIGN-FINAL-LOCK §二a production section)
  # `station_id` must match JWT-scoped `station_ids` for user flows; service tokens are machine-scoped per IMS policy.

──────────────────────────────────────────────

trend_analysis(equipment_id, metric, window?) → TrendAnalysis

  Returns: regression slope, seasonality, forecast_30d, anomaly_windows[]
  Platform API: derive from GET /v1/equipment/{equipment_id}/readings?metric=&from=&to= until a dedicated trend endpoint is listed in NEXUS-API-REFERENCE.md
```

## Output format

```
异常检测结果（C-001 轴向振动）：

MOIRAI 分析（过去 7 天）：
  · 当前：4.2 mm/s（警告阈值：3.5）
  · 趋势：单调上升（斜率 +0.3 mm/s/天）
  · 72h 预测：5.8 mm/s（置信度 83%）
  · 判断：⚠️ 异常（建议 48 小时内干预）

[citation: MOIRAI-2.0:C-001:2026-05-08T15:00:00Z, confidence: 0.83]

注意：置信度 < 0.9 时，建议结合现场确认。
```

## Configuration

```
CLAWTWIN_PLATFORM_URL=http://platform-api:8080
CLAWTWIN_OPENCLAW_SERVICE_TOKEN=<openclaw-service-token>
```
