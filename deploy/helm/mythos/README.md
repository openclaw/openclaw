# Mythos Helm Chart

Production-ready Helm chart for deploying Mythos-Class OpenClaw on Kubernetes.

## Features

- **High Availability**: Multi-replica deployment with automatic failover
- **Auto-Scaling**: Horizontal Pod Autoscaler based on CPU/memory
- **Security**: Network policies, RBAC, secrets management
- **Monitoring**: Prometheus metrics, Grafana dashboards
- **Persistence**: Persistent volumes for data and workspace
- **Ingress**: Optional ingress configuration for external access

## Prerequisites

- Kubernetes 1.25+
- Helm 3.8+
- PV provisioner (for persistence)

## Installation

### Add Repository (if published)

```bash
helm repo add mythos https://charts.openclaw.ai
helm repo update
```

### Install from Local Chart

```bash
# Create values file with your configuration
cat > my-values.yaml <<EOF
gateway:
  secrets:
    gatewayToken: "your-secure-token"
    anthropicApiKey: "sk-ant-..."
    openaiApiKey: "sk-..."
  persistence:
    enabled: true
    size: 10Gi
postgresql:
  auth:
    password: "your-postgres-password"
EOF

# Install
helm install mythos ./deploy/helm/mythos -f my-values.yaml
```

### Install with Custom Namespace

```bash
kubectl create namespace mythos
helm install mythos ./deploy/helm/mythos \
  --namespace mythos \
  -f my-values.yaml
```

## Configuration

### Key Parameters

| Parameter | Description | Default |
|-----------|-------------|---------|
| `gateway.replicaCount` | Number of replicas | `2` |
| `gateway.image.repository` | Image repository | `openclaw/mythos` |
| `gateway.image.tag` | Image tag | `2026.5.10` |
| `gateway.service.type` | Service type | `ClusterIP` |
| `gateway.service.port` | Gateway port | `18789` |
| `gateway.resources.limits.cpu` | CPU limit | `2000m` |
| `gateway.resources.limits.memory` | Memory limit | `4Gi` |
| `gateway.autoscaling.enabled` | Enable autoscaling | `true` |
| `gateway.autoscaling.minReplicas` | Min replicas | `2` |
| `gateway.autoscaling.maxReplicas` | Max replicas | `10` |
| `postgresql.enabled` | Enable PostgreSQL | `true` |
| `redis.enabled` | Enable Redis | `true` |
| `monitoring.enabled` | Enable monitoring | `true` |

### Secrets Configuration

**Required Secrets:**

```yaml
gateway:
  secrets:
    gatewayToken: ""        # Gateway authentication token
    anthropicApiKey: ""     # Anthropic Claude API key
    openaiApiKey: ""        # OpenAI API key
    geminiApiKey: ""        # Google Gemini API key
```

**Optional Secrets:**

```yaml
gateway:
  secrets:
    telegramBotToken: ""    # Telegram bot integration
    discordBotToken: ""     # Discord bot integration
    slackBotToken: ""       # Slack bot integration
    githubToken: ""         # GitHub API access
```

### Persistence Configuration

```yaml
gateway:
  persistence:
    enabled: true
    storageClass: "standard"
    accessModes:
      - ReadWriteOnce
    size: 10Gi
```

### Ingress Configuration

```yaml
gateway:
  ingress:
    enabled: true
    className: "nginx"
    annotations:
      cert-manager.io/cluster-issuer: "letsencrypt-prod"
    hosts:
      - host: mythos.example.com
        paths:
          - path: /
            pathType: Prefix
    tls:
      - secretName: mythos-tls
        hosts:
          - mythos.example.com
```

### Monitoring Configuration

```yaml
monitoring:
  enabled: true
  serviceMonitor:
    enabled: true
    interval: 30s
  prometheusRule:
    enabled: true
```

## Upgrading

```bash
# Upgrade to new version
helm upgrade mythos ./deploy/helm/mythos -f my-values.yaml

# Upgrade with new image tag
helm upgrade mythos ./deploy/helm/mythos \
  -f my-values.yaml \
  --set gateway.image.tag=2026.5.11
```

## Uninstalling

```bash
# Uninstall chart
helm uninstall mythos

# Uninstall with namespace cleanup
helm uninstall mythos --namespace mythos
kubectl delete namespace mythos
```

## Troubleshooting

### Check Pod Status

```bash
kubectl get pods -l app.kubernetes.io/name=mythos
kubectl describe pod <pod-name>
```

### Check Logs

```bash
kubectl logs -l app.kubernetes.io/name=mythos
kubectl logs -l app.kubernetes.io/name=mythos --previous
```

### Check Services

```bash
kubectl get svc -l app.kubernetes.io/name=mythos
kubectl port-forward svc/mythos-gateway 18789:18789
```

### Check Persistent Volumes

```bash
kubectl get pvc -l app.kubernetes.io/name=mythos
kubectl describe pvc <pvc-name>
```

## Monitoring

### Prometheus Metrics

Access metrics endpoint:

```bash
kubectl port-forward svc/mythos-gateway 9090:9090
curl http://localhost:9090/metrics
```

### Grafana Dashboard

Import the provided dashboard:

1. Open Grafana
2. Go to Dashboards → Import
3. Upload `monitoring/grafana-dashboard.json`

### Alerts

Configured alerts:

- `MythosHighLatency`: 95th percentile latency > 1s
- `MythosHighErrorRate`: Error rate > 5%
- `MythosHighMemoryUsage`: Memory usage > 3.5GB

## Performance Tuning

### Resource Allocation

For production workloads:

```yaml
gateway:
  resources:
    requests:
      cpu: 1000m
      memory: 2Gi
    limits:
      cpu: 4000m
      memory: 8Gi
```

### Autoscaling Thresholds

Tune autoscaling based on workload:

```yaml
gateway:
  autoscaling:
    targetCPUUtilizationPercentage: 60  # More aggressive
    targetMemoryUtilizationPercentage: 70
```

### Database Tuning

For PostgreSQL:

```yaml
postgresql:
  primary:
    resources:
      limits:
        cpu: 2000m
        memory: 4Gi
    persistence:
      size: 50Gi
```

## Security Best Practices

1. **Use Secrets**: Never store API keys in values.yaml
2. **Network Policies**: Enable network policies to restrict traffic
3. **Pod Security**: Use security contexts to limit privileges
4. **RBAC**: Configure service accounts with minimal permissions
5. **Encryption**: Enable TLS for ingress

## High Availability

For HA deployment:

```yaml
gateway:
  replicaCount: 3
  autoscaling:
    minReplicas: 3
    maxReplicas: 15
  podDisruptionBudget:
    enabled: true
    minAvailable: 2
  topologySpreadConstraints:
    enabled: true
    maxSkew: 1
```

## Production Checklist

- [ ] Set strong gateway token
- [ ] Configure all API keys
- [ ] Enable persistence
- [ ] Configure autoscaling
- [ ] Enable monitoring
- [ ] Set up alerts
- [ ] Configure network policies
- [ ] Enable TLS/HTTPS
- [ ] Set up backups
- [ ] Test disaster recovery

## Support

- **Documentation**: [OpenClaw Docs](https://docs.openclaw.ai)
- **Issues**: [GitHub Issues](https://github.com/openclaw/openclaw/issues)
- **Discord**: [OpenClaw Discord](https://discord.gg/openclaw)

## License

MIT License - See [LICENSE](../../../LICENSE) for details.
