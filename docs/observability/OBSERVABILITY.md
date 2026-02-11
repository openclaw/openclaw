# OpenClaw Observability Guide

## Overview

This guide covers the complete setup and configuration of OpenClaw's observability stack, providing enterprise-grade monitoring through OpenTelemetry, Prometheus, and Grafana integration.

## Architecture

```
OpenClaw Gateway → OTEL Collector:4318 ↘
System Metrics → Node Exporter:9100 → OTEL Collector → Prometheus:8889 → Grafana
```

## Quick Setup

### 1. Install System Monitoring

```bash
# Install Node Exporter for system metrics
chmod +x install-node-exporter.sh
./install-node-exporter.sh
```

### 2. Configure OTEL Collector

Create `/etc/otel-collector-config.yaml`:

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318
  prometheus:
    config:
      scrape_configs:
        - job_name: 'node-exporter'
          static_configs:
            - targets: ['localhost:9100']
          scrape_interval: 15s

processors:
  batch:
    timeout: 1s
    send_batch_size: 1024
  resource:
    attributes:
      - key: service.name
        value: openclaw-gateway
        action: upsert

exporters:
  prometheus:
    endpoint: "0.0.0.0:8889"
    namespace: openclaw
    const_labels:
      environment: production

service:
  pipelines:
    metrics:
      receivers: [otlp, prometheus]
      processors: [resource, batch]
      exporters: [prometheus]
```

### 3. Configure OpenClaw Diagnostics

```bash
openclaw gateway config.patch '{
  "diagnostics": {
    "enabled": true,
    "flags": ["*"],
    "otel": {
      "enabled": true,
      "endpoint": "http://localhost:4318",
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true,
      "logs": false,
      "flushIntervalMs": 5000
    }
  }
}'
```

### 4. Setup Grafana

1. **Add Data Source**: Configure Prometheus at `http://localhost:8889`
2. **Import Dashboards**: Use provided JSON files
3. **Configure Alerts**: Set up notification channels

## Metrics Reference

### Application Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `openclaw_tokens_total` | Counter | Token usage by type |
| `openclaw_cost_usd_total` | Counter | Model costs in USD |
| `openclaw_message_processed_total` | Counter | Messages by outcome |
| `openclaw_queue_depth` | Histogram | Queue depth distribution |
| `openclaw_run_duration_ms` | Histogram | Agent run times |

### System Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `node_cpu_seconds_total` | Counter | CPU usage by mode |
| `node_memory_MemAvailable_bytes` | Gauge | Available memory |
| `node_filesystem_avail_bytes` | Gauge | Available disk space |
| `node_network_receive_bytes_total` | Counter | Network received |

## Dashboard Configurations

### Infrastructure Dashboard
- Gateway health and uptime
- Message processing rates
- Error rate monitoring
- Queue depth trends
- Response time percentiles

### Business Dashboard
- Daily/monthly cost tracking
- Token efficiency metrics
- Model usage distribution
- Success rate analysis
- Context utilization

### System Dashboard
- CPU and memory usage
- Disk I/O performance
- Network throughput
- Load averages
- Process monitoring

## Security Considerations

- **Network Binding**: Use localhost for internal metrics
- **Authentication**: Secure Grafana with proper auth
- **Firewall**: Restrict metric endpoint access
- **Secrets**: Never commit real credentials

## Troubleshooting

### OTEL Collector Not Starting
```bash
# Check configuration syntax
otelcol validate --config=/etc/otel-collector-config.yaml

# Review logs
journalctl -u otel-collector.service -f
```

### Metrics Not Appearing
```bash
# Verify endpoints
curl -s http://localhost:8889/metrics | head
curl -s http://localhost:9100/metrics | head

# Check OpenClaw diagnostics
grep -i "diagnostic\|otel" ~/.openclaw/logs/gateway.log
```

### Dashboard Import Issues
- Verify Prometheus data source URL
- Check metric name compatibility
- Review Grafana version compatibility

## Performance Impact

- **OTEL Collector**: ~10-20MB RAM, minimal CPU
- **Node Exporter**: ~5MB RAM, negligible CPU  
- **Metric Export**: ~1-2% additional latency
- **Storage**: ~1GB/month for typical usage

## Advanced Configuration

### Custom Metrics

Add custom business metrics:

```javascript
const meter = metrics.getMeter('openclaw-business');
const tradingCounter = meter.createCounter('trading_positions', {
  description: 'Trading positions by outcome'
});

tradingCounter.add(1, { outcome: 'profit', symbol: 'AAPL' });
```

### Alert Rules

Example Prometheus alerting rules:

```yaml
groups:
- name: openclaw
  rules:
  - alert: OpenClawDown
    expr: up{job="openclaw-gateway"} == 0
    for: 1m
    
  - alert: HighErrorRate
    expr: rate(openclaw_message_processed_total{outcome="error"}[5m]) > 0.1
    for: 2m
```

## Migration Guide

### From Basic Monitoring
1. Enable diagnostics in OpenClaw config
2. Install OTEL collector
3. Add system monitoring
4. Import dashboard templates

### From Custom Solutions
1. Map existing metrics to OpenClaw schema
2. Update dashboard queries
3. Migrate alerting rules
4. Test end-to-end pipeline

## Support

For issues:
1. Check troubleshooting section
2. Review OpenClaw diagnostics logs
3. Validate OTEL collector configuration
4. Test metric endpoints manually

This observability stack provides comprehensive visibility into OpenClaw operations, enabling proactive monitoring, performance optimization, and cost management.