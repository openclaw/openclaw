# Mythos Automation Suite

Production-grade automation scripts for OpenClaw Mythos system management, maintenance, and operations.

## Overview

This automation suite provides comprehensive tooling for:
- **Backup & Restore**: Automated backups with encryption and rotation
- **Token Management**: Secure credential rotation and lifecycle management
- **Health Monitoring**: Continuous system health checks and alerting
- **Disaster Recovery**: Complete system recovery procedures
- **Scaling**: Horizontal scaling operations and recommendations
- **Maintenance**: Scheduled maintenance routines

## Quick Start

```bash
# Run automated backup
./mythos-automation.sh backup

# Run health check
./mythos-automation.sh health-check

# Scale up to 5 replicas
./mythos-automation.sh scale up 5

# Rotate all tokens
./mythos-automation.sh rotate-tokens --all

# Run full maintenance routine
./mythos-automation.sh full-maintenance
```

## Scripts

### Master Automation Script

**`mythos-automation.sh`** - Orchestrates all automation tasks

```bash
# Show usage
./mythos-automation.sh --help

# Run backup
./mythos-automation.sh backup

# Restore from backup
./mythos-automation.sh restore /backup/mythos_20250120.tar.gz

# Run health check
./mythos-automation.sh health-check

# Scale operations
./mythos-automation.sh scale status
./mythos-automation.sh scale up 5
./mythos-automation.sh scale down 2
./mythos-automation.sh scale auto enable

# Token rotation
./mythos-automation.sh rotate-tokens

# Disaster recovery
./mythos-automation.sh disaster-recovery /backup/mythos_20250120.tar.gz

# Full maintenance
./mythos-automation.sh full-maintenance
```

### Backup Script

**`backup.sh`** - Automated backup with encryption

Features:
- Incremental backups with deduplication
- AES-256 encryption
- Automatic rotation (keeps last 7 daily, 4 weekly, 12 monthly)
- Integrity verification with checksums
- Cloud storage support (AWS S3, Google Cloud, Azure)

```bash
# Basic backup
./backup.sh

# Encrypted backup
./backup.sh --encrypt

# Backup to S3
./backup.sh --destination s3://my-bucket/backups

# Dry run (show what would be backed up)
./backup.sh --dry-run

# Custom retention policy
./backup.sh --retention 14d
```

**Configuration** (`~/.mythos/backup.conf`):
```ini
[backup]
destination = /var/backups/mythos
encryption_key = ~/.mythos/backup.key
compression_level = 9
retention_daily = 7
retention_weekly = 4
retention_monthly = 12

[cloud]
provider = aws
bucket = mythos-backups
region = us-west-2
access_key = ~/.aws/credentials

[notifications]
slack_webhook = https://hooks.slack.com/...
email = ops@example.com
```

### Restore Script

**`restore.sh`** - Restore system from backup

Features:
- Point-in-time recovery
- Selective restore (config, memory, agents)
- Pre-restore validation
- Automatic rollback on failure
- Dry-run mode

```bash
# Full restore
./restore.sh /backup/mythos_20250120.tar.gz

# Restore only configuration
./restore.sh /backup/mythos_20250120.tar.gz --select config

# Restore to specific point in time
./restore.sh /backup/mythos_20250120.tar.gz --timestamp 2025-01-20T14:30:00

# Dry run (show what would be restored)
./restore.sh /backup/mythos_20250120.tar.gz --dry-run

# Force restore (skip confirmation)
./restore.sh /backup/mythos_20250120.tar.gz --force
```

### Token Rotation Script

**`rotate-tokens.sh`** - Secure credential rotation

Features:
- Zero-downtime rotation
- Automatic service restart
- Rollback capability
- Audit logging
- Support for multiple credential types (API keys, JWT secrets, database passwords)

```bash
# Rotate all tokens
./rotate-tokens.sh --all

# Rotate specific token
./rotate-tokens.sh --gateway-token
./rotate-tokens.sh --api-keys
./rotate-tokens.sh --database-password

# Preview changes (dry run)
./rotate-tokens.sh --dry-run

# Custom rotation interval
./rotate-tokens.sh --interval 30d
```

**Configuration** (`~/.mythos/tokens.conf`):
```ini
[rotation]
interval_days = 90
auto_rotate = true
notify_before_days = 7

[credentials]
gateway_token = enabled
api_keys = enabled
database_password = enabled
jwt_secret = enabled

[notifications]
on_rotation = slack,email
on_failure = slack,email,pagerduty
```

### Health Check Script

**`health-check.sh`** - Comprehensive system health monitoring

Features:
- 8 critical health checks
- Real-time monitoring
- Automated alerting (Slack, Email, PagerDuty)
- JSON reporting
- Performance metrics collection

```bash
# Basic health check
./health-check.sh

# Continuous monitoring (every 60 seconds)
./health-check.sh --continuous --interval 60

# Custom alert thresholds
./health-check.sh --alert-threshold-cpu 75 --alert-threshold-memory 80

# Output to JSON
./health-check.sh --output /var/log/mythos_health.json

# Send alerts on failure
./health-check.sh --alert
```

**Checks Performed**:
1. **Gateway Connectivity**: HTTP 200 response, response time < 5s
2. **Configuration Validation**: JSON syntax, critical fields present
3. **Memory Engines**: Rust-native vs JavaScript fallback
4. **Disk Space**: Usage < 90%
5. **Service Status**: Running and healthy
6. **Network**: DNS resolution, port connectivity
7. **Certificates**: Valid and not expiring soon
8. **Performance**: Metrics available and within bounds

**Configuration** (`~/.mythos/health-check.conf`):
```ini
[thresholds]
cpu_percent = 80
memory_percent = 85
disk_percent = 90
response_time_ms = 5000

[alerts]
slack_webhook = https://hooks.slack.com/...
email = ops@example.com
pagerduty_key = your-pagerduty-key

[monitoring]
continuous = false
interval_seconds = 60
```

### Scaling Script

**`scale.sh`** - Horizontal scaling operations

Features:
- Manual scaling (up/down)
- Autoscaling with HPA
- Resource monitoring
- Scaling recommendations
- Safe scaling with health checks

```bash
# Show current scaling status
./scale.sh status

# Scale up to 5 replicas
./scale.sh up 5

# Scale down to 2 replicas
./scale.sh down 2

# Enable autoscaling
./scale.sh auto enable

# Disable autoscaling
./scale.sh auto disable

# Monitor resources (5 minutes)
./scale.sh monitor 5m

# Get scaling recommendations
./scale.sh recommend
```

**Autoscaling Configuration** (`~/.mythos/scaling.conf`):
```ini
[autoscaling]
enabled = false
min_replicas = 2
max_replicas = 10
cpu_threshold = 70
memory_threshold = 80
cooldown_seconds = 300

[monitoring]
metrics_interval = 60
retention_days = 30
```

### Disaster Recovery Script

**`disaster-recovery.sh`** - Complete system recovery

Features:
- Full system restoration
- Selective component recovery
- Pre-flight validation
- Post-recovery verification
- Automatic rollback on failure

```bash
# Full disaster recovery
./disaster-recovery.sh /backup/mythos_20250120.tar.gz

# Restore specific components
./disaster-recovery.sh /backup/mythos_20250120.tar.gz --components config,memory

# Dry run (validate backup, show what would be restored)
./disaster-recovery.sh /backup/mythos_20250120.tar.gz --dry-run

# Skip post-recovery validation
./disaster-recovery.sh /backup/mythos_20250120.tar.gz --skip-validation

# Keep services stopped after recovery
./disaster-recovery.sh /backup/mythos_20250120.tar.gz --keep-stopped
```

**Recovery Process**:
1. Validate backup integrity
2. Stop all services gracefully
3. Backup current state (safety net)
4. Extract and restore components
5. Rebuild indexes and caches
6. Validate restored system
7. Start services
8. Run health checks
9. Notify stakeholders

## Scheduling

### Cron Jobs

Add to `/etc/cron.d/mythos-automation`:

```bash
# Daily backup at 2 AM
0 2 * * * root /opt/mythos/automation/mythos-automation.sh backup >> /var/log/mythos-automation/backup.log 2>&1

# Health check every 5 minutes
*/5 * * * * root /opt/mythos/automation/mythos-automation.sh health-check >> /var/log/mythos-automation/health.log 2>&1

# Weekly full maintenance on Sunday at 3 AM
0 3 * * 0 root /opt/mythos/automation/mythos-automation.sh full-maintenance >> /var/log/mythos-automation/maintenance.log 2>&1

# Monthly token rotation on 1st at 4 AM
0 4 1 * * root /opt/mythos/automation/mythos-automation.sh rotate-tokens >> /var/log/mythos-automation/rotation.log 2>&1
```

### Systemd Timers

Create `/etc/systemd/system/mythos-backup.timer`:

```ini
[Unit]
Description=Mythos Daily Backup

[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

Create `/etc/systemd/system/mythos-backup.service`:

```ini
[Unit]
Description=Mythos Backup Service

[Service]
Type=oneshot
ExecStart=/opt/mythos/automation/mythos-automation.sh backup
User=root

[Install]
WantedBy=multi-user.target
```

Enable the timer:

```bash
sudo systemctl enable mythos-backup.timer
sudo systemctl start mythos-backup.timer
```

## Monitoring & Alerting

### Integration with Prometheus

Expose health check metrics to Prometheus:

```bash
# Install Prometheus Node Exporter
sudo apt-get install prometheus-node-exporter

# Configure custom metrics endpoint
./health-check.sh --continuous --prometheus-port 9101
```

### Grafana Dashboard

Import the provided Grafana dashboard:

```bash
# Import dashboard
curl -X POST http://grafana:3000/api/dashboards/db \
  -H "Authorization: Bearer $GRAFANA_API_KEY" \
  -H "Content-Type: application/json" \
  -d @monitoring/grafana-dashboard.json
```

### Alertmanager Configuration

Configure alert routing in `alertmanager.yml`:

```yaml
route:
  receiver: 'mythos-alerts'
  group_by: ['alertname', 'severity']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  routes:
    - match:
        severity: critical
      receiver: 'pagerduty'
    - match:
        severity: warning
      receiver: 'slack'

receivers:
  - name: 'mythos-alerts'
    slack_configs:
      - api_url: 'https://hooks.slack.com/...'
        channel: '#mythos-alerts'
  
  - name: 'pagerduty'
    pagerduty_configs:
      - service_key: 'your-pagerduty-key'
  
  - name: 'slack'
    slack_configs:
      - api_url: 'https://hooks.slack.com/...'
        channel: '#mythos-warnings'
```

## Security

### File Permissions

```bash
# Set secure permissions
chmod 700 /opt/mythos/automation
chmod 700 /opt/mythos/automation/*.sh
chmod 600 ~/.mythos/*.conf
chmod 600 ~/.mythos/*.key
```

### Encryption Keys

Generate encryption keys for backups:

```bash
# Generate AES-256 key
openssl rand -base64 32 > ~/.mythos/backup.key
chmod 600 ~/.mythos/backup.key

# Generate RSA key pair for token signing
openssl genrsa -out ~/.mythos/signing.key 4096
openssl rsa -in ~/.mythos/signing.key -pubout -out ~/.mythos/signing.pub
chmod 600 ~/.mythos/signing.key
chmod 644 ~/.mythos/signing.pub
```

### Audit Logging

All automation scripts log to `/var/log/mythos-automation/`:

```bash
# View logs
tail -f /var/log/mythos-automation/master_*.log

# Search for errors
grep -i error /var/log/mythos-automation/*.log

# Generate audit report
./mythos-automation.sh audit-report --output /tmp/audit.json
```

## Troubleshooting

### Common Issues

**Backup fails with "Permission denied"**:
```bash
# Check permissions
ls -la /var/backups/mythos
sudo chown -R openclaw:openclaw /var/backups/mythos
```

**Health check reports "Gateway not responding"**:
```bash
# Check gateway status
systemctl status mythos-gateway

# Check gateway logs
journalctl -u mythos-gateway -f
```

**Token rotation fails**:
```bash
# Check current tokens
cat ~/.openclaw/.gateway_token

# Manual rotation
./rotate-tokens.sh --dry-run
```

**Scaling operations fail**:
```bash
# Check Kubernetes connectivity
kubectl cluster-info

# Check HPA status
kubectl get hpa -n mythos
```

### Debug Mode

Enable debug logging:

```bash
export MYTHOS_DEBUG=1
./mythos-automation.sh backup
```

### Log Rotation

Configure log rotation in `/etc/logrotate.d/mythos-automation`:

```
/var/log/mythos-automation/*.log {
    daily
    rotate 30
    compress
    delaycompress
    notifempty
    missingok
    create 0640 root root
}
```

## Best Practices

### 1. Test Backups Regularly

```bash
# Monthly restore test
./mythos-automation.sh restore /backup/latest.tar.gz --dry-run
```

### 2. Monitor Alert Fatigue

Review and tune alert thresholds quarterly:

```bash
# Analyze alert frequency
grep "ALERT" /var/log/mythos-automation/health.log | awk '{print $4}' | sort | uniq -c
```

### 3. Document Customizations

Keep a changelog in `/opt/mythos/automation/CHANGELOG.md`:

```markdown
## 2025-01-20
- Increased backup retention to 30 days
- Added S3 cloud backup destination
- Customized alert thresholds for CPU (75%)
```

### 4. Version Control

Track automation scripts in Git:

```bash
cd /opt/mythos/automation
git init
git add .
git commit -m "Initial automation suite"
```

### 5. Disaster Recovery Drills

Conduct quarterly DR drills:

```bash
# Simulate disaster
./disaster-recovery.sh /backup/latest.tar.gz --dry-run

# Time the recovery
time ./disaster-recovery.sh /backup/latest.tar.gz
```

## Performance Tuning

### Backup Optimization

```bash
# Increase compression level (slower but smaller)
./backup.sh --compression-level 9

# Use multiple threads
./backup.sh --threads 4

# Exclude large files
./backup.sh --exclude "*.log" --exclude "*.tmp"
```

### Health Check Optimization

```bash
# Reduce check frequency for stable systems
./health-check.sh --continuous --interval 300

# Disable expensive checks
./health-check.sh --skip-check certificates
```

### Scaling Optimization

```bash
# Adjust autoscaling thresholds
./scale.sh auto enable --cpu-threshold 65 --memory-threshold 75

# Reduce cooldown period
./scale.sh auto enable --cooldown 120
```

## API Reference

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MYTHOS_URL` | Gateway URL | `http://localhost:18789` |
| `OPENCLAW_HOME` | OpenClaw home directory | `~/.openclaw` |
| `LOG_DIR` | Log directory | `/var/log/mythos-automation` |
| `ALERT_THRESHOLD_CPU` | CPU alert threshold (%) | `80` |
| `ALERT_THRESHOLD_MEMORY` | Memory alert threshold (%) | `85` |
| `ALERT_THRESHOLD_DISK` | Disk alert threshold (%) | `90` |
| `SLACK_WEBHOOK_URL` | Slack webhook for alerts | - |
| `ALERT_EMAIL` | Email for alerts | - |
| `PAGERDUTY_KEY` | PagerDuty integration key | - |

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Configuration error |
| 3 | Connection error |
| 4 | Authentication error |
| 5 | Permission denied |

## Support

- **Documentation**: [OpenClaw Docs](https://docs.openclaw.ai)
- **Issues**: [GitHub Issues](https://github.com/openclaw/openclaw/issues)
- **Discord**: [OpenClaw Discord](https://discord.gg/openclaw)

## License

MIT License - See [LICENSE](../LICENSE) for details.
