# Mythos Monitoring Stack

Complete observability setup for Mythos-class deployments with Prometheus, Grafana, and Alertmanager.

## 🎯 Overview

This monitoring stack provides:
- **Prometheus**: Metrics collection and storage
- **Grafana**: Visualization and dashboards
- **Alertmanager**: Alert routing and notification
- **Pre-built Dashboard**: Comprehensive Mythos metrics
- **Alert Rules**: Production-ready alerting

## 🚀 Quick Start

### Prerequisites

- Docker and Docker Compose installed
- Mythos Gateway running with metrics endpoint enabled
- Network access between monitoring stack and Mythos

### Start Monitoring Stack

```bash
cd monitoring
docker-compose up -d
```

### Access Services

- **Grafana**: http://localhost:3000 (admin/admin)
- **Prometheus**: http://localhost:9090
- **Alertmanager**: http://localhost:9093

### Import Dashboard

1. Open Grafana: http://localhost:3000
2. Go to **Dashboards** → **Import**
3. Upload `grafana-dashboard.json`
4. Select **Prometheus** as data source
5. Click **Import**

## 📊 Dashboard Panels

### Overview
- Gateway Status
- Uptime (5m)
- Error Rate (5m)
- Memory Usage

### Performance Metrics
- Vector Search Latency (p95, p99)
- Text Search Latency (p95, p99)

### Agent Metrics
- Agent Request Rate
- Agent Response Time

### Memory & Storage
- Memory Usage by Engine
- Document Count by Engine

### Workflows
- Workflow Execution Rate
- Workflow Failure Rate

## 🔔 Alert Rules

### Performance Alerts
- **HighVectorSearchLatency**: p95 > 100ms for 5m
- **HighTextSearchLatency**: p95 > 500ms for 5m
- **CriticalVectorSearchLatency**: p99 > 1s for 2m

### Availability Alerts
- **GatewayDown**: Gateway unreachable for 1m
- **HighErrorRate**: Error rate > 5% for 5m
- **CriticalErrorRate**: Error rate > 15% for 2m

### Resource Alerts
- **HighMemoryUsage**: Memory > 8GB for 10m
- **CriticalMemoryUsage**: Memory > 12GB for 5m
- **RustEngineFallback**: Fallback to JS engines detected

### Workflow Alerts
- **WorkflowFailureRate**: Failure rate > 10% for 5m

## 📁 File Structure

```
monitoring/
├── README.md                          # This file
├── docker-compose.yml                 # Monitoring stack
├── prometheus.yml                     # Prometheus config
├── alerts.yml                         # Alert rules
├── rules.yml                          # Recording rules
└── grafana-dashboard.json            # Pre-built dashboard
```

## ⚙️ Configuration

### Prometheus

Edit `prometheus.yml`:
- Adjust `scrape_interval` for data granularity
- Update target addresses if Mythos runs on different host/port
- Add additional scrape jobs for other services

### Alerts

Edit `alerts.yml`:
- Modify thresholds based on your SLA requirements
- Add notification channels (Slack, PagerDuty, Email)
- Adjust `for` durations to reduce alert noise

### Grafana

Access Grafana at http://localhost:3000:
- Default credentials: admin/admin
- Change password on first login
- Configure data sources (Prometheus auto-configured)
- Import dashboards from JSON files

## 🔧 Customization

### Add Custom Metrics

Mythos exposes metrics at `/metrics` endpoint:

```typescript
// In your Mythos application
import { metrics } from '@openclaw/mythos-core';

// Counter
metrics.counter('my_custom_requests_total').inc();

// Histogram
metrics.histogram('my_custom_duration_seconds').observe(1.5);

// Gauge
metrics.gauge('my_custom_active_sessions').set(42);
```

### Custom Dashboards

1. Create dashboard in Grafana UI
2. Export as JSON
3. Save to `monitoring/` directory
4. Commit to version control

### Alert Routing

Configure Alertmanager in `alertmanager.yml`:

```yaml
route:
  receiver: 'slack-notifications'
  routes:
  - match:
      severity: critical
    receiver: 'pagerduty-critical'
  - match:
      severity: warning
    receiver: 'slack-warnings'

receivers:
- name: 'slack-notifications'
  slack_configs:
  - api_url: 'YOUR_SLACK_WEBHOOK'
    channel: '#mythos-alerts'

- name: 'pagerduty-critical'
  pagerduty_configs:
  - service_key: 'YOUR_PAGERDUTY_KEY'
```

## 📈 Metrics Reference

### Gateway Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `mythos_http_requests_total` | Counter | Total HTTP requests |
| `mythos_http_request_duration_seconds` | Histogram | Request latency |
| `up{job="mythos-gateway"}` | Gauge | Gateway health |

### Search Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `mythos_vector_search_duration_seconds` | Histogram | Vector search latency |
| `mythos_text_search_duration_seconds` | Histogram | Text search latency |
| `mythos_search_results_total` | Counter | Search results returned |

### Agent Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `mythos_agent_requests_total` | Counter | Agent requests by type |
| `mythos_agent_response_duration_seconds` | Histogram | Agent response time |
| `mythos_agent_errors_total` | Counter | Agent errors |

### Memory Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `mythos_memory_usage_bytes` | Gauge | Memory usage by engine |
| `mythos_memory_documents_total` | Counter | Documents stored |
| `mythos_memory_operations_total` | Counter | Memory operations |

### Workflow Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `mythos_workflow_executions_total` | Counter | Workflow executions |
| `mythos_workflow_duration_seconds` | Histogram | Workflow duration |
| `mythos_workflow_steps_total` | Counter | Workflow steps executed |

## 🐛 Troubleshooting

### Prometheus Not Scraping Metrics

```bash
# Check Prometheus targets
curl http://localhost:9090/api/v1/targets

# Verify Mythos metrics endpoint
curl http://gateway:18789/metrics

# Check network connectivity
docker network inspect monitoring_mythos-network
```

### Grafana Dashboard Not Showing Data

1. Verify Prometheus data source is configured
2. Check time range in dashboard (try "Last 1 hour")
3. Verify metric names match Prometheus queries
4. Check Prometheus logs: `docker logs prometheus`

### Alerts Not Firing

```bash
# Check alert rules
curl http://localhost:9090/api/v1/rules

# Check alert status
curl http://localhost:9093/api/v2/alerts

# Verify Alertmanager config
docker logs alertmanager
```

### High Cardinality Issues

If Prometheus memory usage is high:

1. Reduce label cardinality in metrics
2. Increase `scrape_interval` for less critical metrics
3. Configure `scrape_timeout` to prevent slow scrapes
4. Use recording rules to pre-compute expensive queries

## 📚 Related Documentation

- **[Prometheus Documentation](https://prometheus.io/docs/)**
- **[Grafana Documentation](https://grafana.com/docs/)**
- **[Alertmanager Documentation](https://prometheus.io/docs/alerting/latest/alertmanager/)**
- **[Mythos Metrics Guide](../MYTHOS-METRICS-GUIDE.md)**

## 🎓 Best Practices

1. **Set Realistic Alerts**: Avoid alert fatigue with meaningful thresholds
2. **Use Recording Rules**: Pre-compute expensive queries
3. **Monitor the Monitor**: Set up alerts for Prometheus/Grafana itself
4. **Regular Reviews**: Review and tune alerts monthly
5. **Document Runbooks**: Link alerts to troubleshooting guides
6. **Test Alerts**: Regularly verify alert delivery works
7. **Version Control**: Keep monitoring configs in Git

## 🦞 About

This monitoring stack is part of the Mythos-class implementation for OpenClaw, providing enterprise-grade observability for Rust-powered multi-agent AI deployments.

**The lobster has titanium claws.** 🦞⚡
