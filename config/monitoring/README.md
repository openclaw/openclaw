# OpenClaw Security Monitoring Setup

This directory contains all configuration files needed to set up comprehensive security monitoring for OpenClaw.

---

## Quick Start

### 1. Deploy Monitoring Script

```bash
# Run once to test
node --import tsx scripts/security-monitoring.ts --once

# Run continuously
node --import tsx scripts/security-monitoring.ts

# Generate daily report
node --import tsx scripts/security-monitoring.ts --report
```

### 2. Set Up Environment Variables

```bash
# Create .env file
cat > .env <<EOF
SECURITY_LOG=/var/log/openclaw/security.log
APP_LOG=/var/log/openclaw/application.log
ACCESS_LOG=/var/log/openclaw/access.log
METRICS_DIR=/tmp/openclaw-metrics
ALERT_EMAIL=security-team@example.com
SLACK_WEBHOOK=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
PAGERDUTY_KEY=your-pagerduty-routing-key
EOF
```

### 3. Set Up Cron Job

```bash
# Add to crontab
crontab -e

# Add these lines:
# Run security monitoring every hour
0 * * * * cd /path/to/openclaw && node --import tsx scripts/security-monitoring.ts --once

# Generate daily report at 9 AM
0 9 * * * cd /path/to/openclaw && node --import tsx scripts/security-monitoring.ts --report | mail -s "OpenClaw Daily Security Report" security-team@example.com
```

### 4. Set Up as Systemd Service (Linux)

```bash
# Copy service file
sudo cp config/monitoring/openclaw-security-monitor.service /etc/systemd/system/

# Edit service file to set correct paths
sudo nano /etc/systemd/system/openclaw-security-monitor.service

# Enable and start service
sudo systemctl enable openclaw-security-monitor
sudo systemctl start openclaw-security-monitor

# Check status
sudo systemctl status openclaw-security-monitor

# View logs
sudo journalctl -u openclaw-security-monitor -f
```

---

## Monitoring Stack Options

### Option 1: Simple (Files + Email)

**What you get**:

- Security metrics saved to files
- Email alerts on critical events
- Daily email reports

**Setup time**: 15 minutes

**Files used**:

- `scripts/security-monitoring.ts`

**Pros**: Simple, no dependencies
**Cons**: Limited visualization, manual analysis

---

### Option 2: Prometheus + Grafana (Recommended)

**What you get**:

- Real-time metrics dashboard
- Historical data retention
- Advanced alerting
- Beautiful visualizations

**Setup time**: 1 hour

**Files used**:

- `config/monitoring/prometheus.yml`
- `config/monitoring/alert-rules.yml`
- `config/monitoring/grafana-dashboard.json`

**Step-by-step setup**:

#### 1. Install Prometheus

```bash
# Download Prometheus
wget https://github.com/prometheus/prometheus/releases/download/v2.45.0/prometheus-2.45.0.linux-amd64.tar.gz
tar xvf prometheus-2.45.0.linux-amd64.tar.gz
cd prometheus-2.45.0.linux-amd64

# Copy config
cp /path/to/openclaw/config/monitoring/prometheus.yml .
cp /path/to/openclaw/config/monitoring/alert-rules.yml .

# Run Prometheus
./prometheus --config.file=prometheus.yml
```

#### 2. Install Grafana

```bash
# Install Grafana (Ubuntu/Debian)
sudo apt-get install -y software-properties-common
sudo add-apt-repository "deb https://packages.grafana.com/oss/deb stable main"
wget -q -O - https://packages.grafana.com/gpg.key | sudo apt-key add -
sudo apt-get update
sudo apt-get install grafana

# Start Grafana
sudo systemctl start grafana-server
sudo systemctl enable grafana-server

# Access Grafana at http://localhost:3000
# Default credentials: admin/admin
```

#### 3. Configure Grafana

1. Add Prometheus data source:
   - Go to Configuration → Data Sources
   - Add Prometheus
   - URL: `http://localhost:9090`

2. Import dashboard:
   - Go to Dashboards → Import
   - Upload `config/monitoring/grafana-dashboard.json`

#### 4. Install Node Exporter (for system metrics)

```bash
# Download Node Exporter
wget https://github.com/prometheus/node_exporter/releases/download/v1.6.0/node_exporter-1.6.0.linux-amd64.tar.gz
tar xvf node_exporter-1.6.0.linux-amd64.tar.gz
cd node_exporter-1.6.0.linux-amd64

# Run Node Exporter
./node_exporter
```

---

### Option 3: Cloud Monitoring (Datadog, New Relic, etc.)

**What you get**:

- Fully managed monitoring
- Advanced features (APM, distributed tracing)
- Built-in alerting and on-call
- Mobile apps

**Setup time**: 30 minutes

**Example: Datadog**

```bash
# Install Datadog agent
DD_AGENT_MAJOR_VERSION=7 DD_API_KEY=<YOUR_API_KEY> DD_SITE="datadoghq.com" bash -c "$(curl -L https://s3.amazonaws.com/dd-agent/scripts/install_script.sh)"

# Configure custom metrics
cat > /etc/datadog-agent/conf.d/openclaw.d/conf.yaml <<EOF
init_config:

instances:
  - prometheus_url: http://localhost:3000/metrics
    namespace: openclaw
    metrics:
      - openclaw_*
EOF

# Restart agent
sudo systemctl restart datadog-agent
```

---

## Alert Configuration

### Email Alerts

Already configured in `scripts/security-monitoring.ts`.

**Required**: Set `ALERT_EMAIL` environment variable.

```bash
export ALERT_EMAIL="security-team@example.com"
```

---

### Slack Alerts

**Setup**:

1. Create Slack webhook:
   - Go to https://api.slack.com/apps
   - Create new app → Incoming Webhooks
   - Copy webhook URL

2. Set environment variable:
   ```bash
   export SLACK_WEBHOOK="https://hooks.slack.com/services/YOUR/WEBHOOK/URL"
   ```

---

### PagerDuty Alerts

**Setup**:

1. Create PagerDuty service:
   - Go to Services → Create Service
   - Integration Type: Events API V2
   - Copy Integration Key

2. Set environment variable:
   ```bash
   export PAGERDUTY_KEY="your-integration-key"
   ```

---

## Metrics Reference

### Security Metrics

| Metric                               | Description                     | Alert Threshold                         |
| ------------------------------------ | ------------------------------- | --------------------------------------- |
| `openclaw_sandbox_violations_total`  | Plugin sandbox violations       | > 5/hour (warn), > 20/hour (critical)   |
| `openclaw_rate_limit_exceeded_total` | Rate limiting triggers          | > 50/hour (warn), > 200/hour (critical) |
| `openclaw_auth_failures_total`       | Authentication failures         | > 20/hour (warn), > 100/hour (critical) |
| `openclaw_signature_failures_total`  | Signature verification failures | > 5/hour (warn), > 20/hour (critical)   |
| `openclaw_csrf_triggered_total`      | CSRF protection triggers        | > 10/hour (warn), > 50/hour (critical)  |
| `openclaw_registry_tampering_total`  | Registry tampering attempts     | > 0 (critical)                          |
| `openclaw_plugin_load_errors_total`  | Plugin load failures            | > 10/hour (warn)                        |

### System Metrics

| Metric                                       | Description           |
| -------------------------------------------- | --------------------- |
| `openclaw_process_resident_memory_bytes`     | Process memory usage  |
| `openclaw_http_requests_total`               | HTTP request count    |
| `openclaw_http_request_duration_seconds`     | HTTP request duration |
| `openclaw_plugin_execution_duration_seconds` | Plugin execution time |

---

## Viewing Metrics

### Command Line

```bash
# View raw metrics
curl http://localhost:3000/metrics

# View security metrics
curl http://localhost:3000/metrics | grep openclaw_security

# Check specific metric
curl http://localhost:3000/metrics | grep sandbox_violations
```

### Grafana Dashboard

Access: `http://localhost:3000/d/openclaw-security`

Panels:

- Sandbox Violations Over Time
- Rate Limiting Activity
- Authentication Failures
- Signature Verification Failures
- Top Security Events
- Memory Usage

---

## Troubleshooting

### Metrics not appearing

**Check**:

1. Is OpenClaw running? `systemctl status openclaw`
2. Is metrics endpoint accessible? `curl http://localhost:3000/metrics`
3. Is Prometheus scraping? Check Prometheus UI → Targets
4. Check Prometheus logs: `journalctl -u prometheus -f`

### Alerts not firing

**Check**:

1. Are thresholds correct? Review `alert-rules.yml`
2. Is Alertmanager running? `systemctl status alertmanager`
3. Check alert rules: Prometheus UI → Alerts
4. Test alert: Force threshold breach

### No email alerts

**Check**:

1. Is mail command available? `which mail`
2. Is ALERT_EMAIL set? `echo $ALERT_EMAIL`
3. Check monitoring script logs
4. Test email: `echo "test" | mail -s "Test" your@email.com`

---

## Best Practices

### 1. Monitor Monitoring

- Set up alerts for monitoring system itself
- Monitor Prometheus disk space
- Check monitoring script is running: `ps aux | grep security-monitoring`

### 2. Regular Reviews

- Review alerts weekly: Are they actionable?
- Adjust thresholds based on actual patterns
- Archive old metrics data (> 90 days)

### 3. On-Call Rotation

- Set up PagerDuty schedules
- Document escalation paths
- Practice incident response

### 4. Security

- Restrict access to Grafana (enable authentication)
- Use HTTPS for Prometheus/Grafana
- Secure webhook URLs (treat as secrets)
- Rotate API keys quarterly

---

## Maintenance

### Daily

- [ ] Check security dashboard
- [ ] Review alerts (if any)
- [ ] Verify monitoring is running

### Weekly

- [ ] Review metric trends
- [ ] Test alert system
- [ ] Check disk space for metrics

### Monthly

- [ ] Update monitoring stack
- [ ] Review and adjust thresholds
- [ ] Archive old data
- [ ] Test disaster recovery

---

## Support

**Documentation**:

- `/docs/security/SECURITY-OPERATIONS-RUNBOOK.md` - Operations guide
- `/docs/security/README.md` - Security overview

**Scripts**:

- `/scripts/security-monitoring.ts` - Monitoring daemon
- `/scripts/deploy-production.sh` - Deployment automation

**Logs**:

- `/var/log/openclaw/security.log` - Security events
- `/tmp/openclaw-metrics/` - Metrics data

---

## Additional Resources

- [Prometheus Documentation](https://prometheus.io/docs/introduction/overview/)
- [Grafana Documentation](https://grafana.com/docs/)
- [OpenClaw Security Guide](/docs/security/README.md)
- [Incident Response Playbook](/docs/security/SECURITY-OPERATIONS-RUNBOOK.md#incident-response)
