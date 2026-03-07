# OpenClaw Observability

Complete monitoring and observability solution for OpenClaw using OpenTelemetry, Prometheus, and Grafana.

## Quick Start

### 1. Install Dependencies
```bash
# Install OTEL Collector
curl -L -O https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v0.91.0/otelcol_0.91.0_linux_amd64.tar.gz
tar -xzf otelcol_0.91.0_linux_amd64.tar.gz
sudo mv otelcol /usr/local/bin/

# Install Node Exporter
./scripts/install-node-exporter.sh
```

### 2. Configure OTEL Collector
```bash
sudo cp docs/observability/otel-collector-config.example.yaml /etc/otel-collector-config.yaml
sudo systemctl enable --now otel-collector
```

### 3. Enable OpenClaw Diagnostics
```bash
openclaw gateway config.patch '{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://localhost:4318"
    }
  }
}'
```

### 4. Import Grafana Dashboards
- Import dashboard JSON files from `dashboards/` directory
- Configure Prometheus data source: `http://localhost:8889`

## Features

- **Application Metrics**: Token usage, costs, performance, errors
- **System Metrics**: CPU, memory, disk, network monitoring  
- **Business Intelligence**: Trading analytics, efficiency tracking
- **Real-time Dashboards**: Comprehensive operational visibility
- **Alerting**: Proactive issue detection and notification

## Files

- `OBSERVABILITY.md` - Complete setup and configuration guide
- `otel-collector-config.example.yaml` - OTEL Collector configuration
- `observability-stack-config.yaml` - Stack configuration reference
- `../dashboards/` - Grafana dashboard configurations
- `../scripts/install-node-exporter.sh` - System monitoring setup

## Dashboards

- **Infrastructure**: Operational health and performance
- **Business**: Cost tracking and efficiency metrics  
- **System**: Server resource monitoring

## Architecture

```
OpenClaw → OTEL Collector → Prometheus → Grafana
System Metrics → Node Exporter ↗
```

For detailed setup instructions, see [OBSERVABILITY.md](OBSERVABILITY.md).