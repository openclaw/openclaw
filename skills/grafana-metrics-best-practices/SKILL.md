---
name: grafana-metrics-best-practices
description: Use when creating Grafana dashboards, writing PromQL queries, designing Prometheus metrics, adding new metric labels, or reviewing cardinality. Triggers on "dashboard", "panel", "PromQL", "metric", "cardinality", "label", "histogram", "recording rule", "grafana", "thanos query".
---

# Grafana & Prometheus Best Practices

Guidelines for creating dashboards and metrics that don't degrade Morpho's monitoring infrastructure.

## Dashboard Design

| Rule                       | Detail                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Max ~15-20 panels**      | Each panel fires a query on load/refresh. 50-panel dashboards are expensive for everyone.             |
| **Use `$__rate_interval`** | Don't query 30 days at 15s resolution. Use step parameters; rely on downsampled data for long ranges. |
| **No broad regex**         | Avoid `{__name__=~".*"}` — forces full index scans. Be specific in selectors.                         |
| **Sensible refresh**       | 30s-1m for operational dashboards. No auto-refresh for investigative/ad-hoc.                          |
| **Default template vars**  | Dashboards loading with `All` across multiple dropdowns generate huge queries.                        |
| **Organize by team**       | Tag dashboards, use folders by team/service. Delete unused dashboards.                                |

## Recording Rules

Complex queries that run on every dashboard refresh are candidates for recording rules. Ask the platform team to add them to the Thanos ruler configuration.

## Prometheus Metrics

### Cardinality Check (Do This First)

Before shipping any metric, estimate worst case:

```
total_series = metric_count × label1_values × label2_values × ...
```

If result exceeds **~1000 series per metric**, redesign your labels.

### Label Rules

| Rule                           | Why                                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| **Never use unbounded values** | User IDs, request IDs, emails, full paths — each unique value = new time series          |
| **3-5 labels max**             | Ask: "Will I actually filter/group by this in a query?"                                  |
| **Avoid metric churn**         | Short-lived pods/batch jobs cause TSDB head block churn. Use pushgateway for batch jobs. |

### Naming Convention

Format: `<namespace>_<subsystem>_<name>_<unit>`

```
blue_api_http_request_duration_seconds
rewards_db_connections_total
indexer_queue_depth_items
```

Always include unit suffix: `_seconds`, `_bytes`, etc. For counters, append `_total`.

### Metric Types

- **Histograms over summaries** — histograms are aggregatable across instances; summaries are not.
- **Don't duplicate existing metrics** — kube-state-metrics, node-exporter, cAdvisor already cover pod/node/container metrics.

## Grafana Data Sources

| Source     | Type    | Use For                                               |
| ---------- | ------- | ----------------------------------------------------- |
| Prometheus | Metrics | Infrastructure and app metrics (Thanos for long-term) |
| Loki       | Logs    | Application and system logs                           |
| Tempo      | Traces  | Distributed request tracing                           |
| CloudWatch | Metrics | AWS metrics (RDS, ElastiCache, Lambda, CloudFront)    |

Grafana uses SSO (Auth0). Agents cannot query the Grafana API directly — use Prometheus/Thanos/Loki APIs instead. For API tokens, contact the platform team.

## Common Mistakes

| Mistake                                      | Fix                                                    |
| -------------------------------------------- | ------------------------------------------------------ |
| 50+ panels per dashboard                     | Split into focused dashboards of ~15-20 panels         |
| `{__name__=~".*"}` in queries                | Use specific metric names and label selectors          |
| 5s auto-refresh on all dashboards            | 30s-1m for ops, no auto-refresh for investigation      |
| User IDs / request IDs as labels             | Use bounded labels only (endpoint, method, status)     |
| Shipping metrics without cardinality check   | Estimate `total_series` first, redesign if >1000       |
| Adding metrics already in kube-state-metrics | Check existing exporters before custom instrumentation |

## References

- [Prometheus Naming Best Practices](https://prometheus.io/docs/practices/naming/)
- [Prometheus Histograms and Summaries](https://prometheus.io/docs/practices/histograms/)
- [Grafana Dashboard Best Practices](https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/best-practices/)
