# Mythos Deployment Runbook

Complete deployment guide for production Mythos-class OpenClaw deployments.

## Prerequisites

### System Requirements

**Minimum:**
- CPU: 4 cores
- RAM: 8 GB
- Disk: 20 GB SSD
- Network: 100 Mbps

**Recommended (Production):**
- CPU: 8+ cores
- RAM: 32+ GB
- Disk: 100+ GB SSD
- Network: 1 Gbps
- GPU: Optional (for embedding acceleration)

### Software Requirements

- Docker 24.0+ or Kubernetes 1.28+
- Helm 3.12+ (for Kubernetes)
- Rust 1.75+ (for building from source)
- Node.js 22+
- pnpm 10.0+

---

## Deployment Options

### Option 1: Docker Compose (Development/Small Scale)

**Best for:** Development, testing, small deployments (< 50 users)

#### Step 1: Clone Repository

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
git checkout arena/019f8084-openclaw
```

#### Step 2: Configure Environment

```bash
cp deploy/mythos/.env.example deploy/mythos/.env
nano deploy/mythos/.env
```

**Required variables:**
```bash
# Gateway authentication
OPENCLAW_GATEWAY_TOKEN=<generate-with-openssl-rand-hex-32>

# Model provider API keys (at least one)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=AIza...

# PostgreSQL credentials
PG_USER=mythos
PG_PASSWORD=<strong-password>
PG_DATABASE=mythos
```

#### Step 3: Build and Start

```bash
cd deploy/mythos
docker-compose up -d
```

#### Step 4: Verify Deployment

```bash
# Check container status
docker-compose ps

# Check logs
docker-compose logs -f mythos-gateway

# Health check
curl http://localhost:18789/health
```

#### Step 5: Access Dashboard

Open http://localhost:18789 in your browser.

---

### Option 2: Kubernetes (Production)

**Best for:** Production, high availability, auto-scaling

#### Step 1: Create Namespace

```bash
kubectl create namespace mythos
```

#### Step 2: Create Secrets

```bash
# Create secrets manifest
cat > mythos-secrets.yaml <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: mythos-secrets
  namespace: mythos
type: Opaque
data:
  gateway-token: $(echo -n "YOUR_TOKEN" | base64)
  anthropic-api-key: $(echo -n "sk-ant-..." | base64)
  openai-api-key: $(echo -n "sk-..." | base64)
  gemini-api-key: $(echo -n "AIza..." | base64)
EOF

kubectl apply -f mythos-secrets.yaml
```

#### Step 3: Install with Helm

```bash
# Create values file
cat > my-values.yaml <<EOF
gateway:
  replicaCount: 3
  
  resources:
    limits:
      cpu: 4000m
      memory: 8Gi
    requests:
      cpu: 2000m
      memory: 4Gi
  
  autoscaling:
    enabled: true
    minReplicas: 3
    maxReplicas: 10
    targetCPUUtilizationPercentage: 70
  
  persistence:
    enabled: true
    size: 50Gi

postgresql:
  enabled: true
  auth:
    username: mythos
    password: <strong-password>
    database: mythos
  
  primary:
    persistence:
      enabled: true
      size: 100Gi

redis:
  enabled: true
  master:
    persistence:
      enabled: true
      size: 10Gi

monitoring:
  enabled: true
  serviceMonitor:
    enabled: true
  prometheusRule:
    enabled: true
EOF

# Install
helm install mythos ./deploy/helm/mythos \
  --namespace mythos \
  -f my-values.yaml
```

#### Step 4: Verify Deployment

```bash
# Check pod status
kubectl get pods -n mythos

# Check services
kubectl get svc -n mythos

# Check logs
kubectl logs -f deployment/mythos-gateway -n mythos

# Port forward for testing
kubectl port-forward svc/mythos-gateway 18789:18789 -n mythos
```

#### Step 5: Configure Ingress (Optional)

```bash
# Create ingress
cat > ingress.yaml <<EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: mythos-ingress
  namespace: mythos
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - mythos.example.com
    secretName: mythos-tls
  rules:
  - host: mythos.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: mythos-gateway
            port:
              number: 18789
EOF

kubectl apply -f ingress.yaml
```

---

### Option 3: Cloud Provider Managed

**AWS:**

```bash
# Create EKS cluster
eksctl create cluster --name mythos --region us-west-2

# Deploy with Helm
helm install mythos ./deploy/helm/mythos \
  --namespace mythos \
  -f my-values.yaml
```

**Google Cloud:**

```bash
# Create GKE cluster
gcloud container clusters create mythos --region us-central1

# Deploy with Helm
helm install mythos ./deploy/helm/mythos \
  --namespace mythos \
  -f my-values.yaml
```

**Azure:**

```bash
# Create AKS cluster
az aks create --name mythos --resource-group mythos-rg

# Deploy with Helm
helm install mythos ./deploy/helm/mythos \
  --namespace mythos \
  -f my-values.yaml
```

---

## Post-Deployment Configuration

### Step 1: Initialize Memory Indexes

```bash
# Inside gateway pod/container
kubectl exec -it deployment/mythos-gateway -n mythos -- \
  node scripts/mythos/operator-runbook.js memory-rebuild
```

### Step 2: Configure Channels

Edit `openclaw.json`:

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": { "source": "env", "id": "TELEGRAM_BOT_TOKEN" }
    },
    "discord": {
      "enabled": true,
      "botToken": { "source": "env", "id": "DISCORD_BOT_TOKEN" }
    }
  }
}
```

### Step 3: Set Up Monitoring

```bash
# Install Prometheus operator (if not present)
kubectl apply -f https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/main/bundle.yaml

# Deploy monitoring stack
kubectl apply -f monitoring/

# Access Grafana
kubectl port-forward svc/grafana 3000:3000 -n monitoring
```

### Step 4: Configure Backup

```bash
# Create backup cron job
kubectl apply -f <<EOF
apiVersion: batch/v1
kind: CronJob
metadata:
  name: mythos-backup
  namespace: mythos
spec:
  schedule: "0 2 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: backup
            image: openclaw/mythos:latest
            command:
            - /app/scripts/mythos/backup.sh
            volumeMounts:
            - name: data
              mountPath: /data
            - name: backup
              mountPath: /backup
          volumes:
          - name: data
            persistentVolumeClaim:
              claimName: mythos-data
          - name: backup
            persistentVolumeClaim:
              claimName: mythos-backup
          restartPolicy: OnFailure
EOF
```

---

## Scaling Guide

### Horizontal Scaling

**Kubernetes HPA:**
```bash
# Check current HPA
kubectl get hpa -n mythos

# Scale manually
kubectl scale deployment/mythos-gateway --replicas=5 -n mythos

# Or update HPA
kubectl patch hpa mythos-gateway -n mythos -p \
  '{"spec":{"maxReplicas":15}}'
```

**Docker Compose:**
```bash
# Scale gateway service
docker-compose up -d --scale mythos-gateway=5
```

### Vertical Scaling

**Increase Resources:**
```bash
# Edit values.yaml
resources:
  limits:
    cpu: 8000m
    memory: 16Gi

# Upgrade release
helm upgrade mythos ./deploy/helm/mythos -f my-values.yaml
```

---

## Backup and Restore

### Manual Backup

```bash
# Create backup
kubectl exec -it deployment/mythos-gateway -n mythos -- \
  /app/scripts/mythos/backup.sh

# Copy backup from pod
kubectl cp mythos/$(kubectl get pod -n mythos -l app=mythos-gateway -o name | head -1):/backup/mythos-backup.tar.gz ./backup.tar.gz
```

### Manual Restore

```bash
# Copy backup to pod
kubectl cp ./backup.tar.gz mythos/$(kubectl get pod -n mythos -l app=mythos-gateway -o name | head -1):/tmp/backup.tar.gz

# Restore
kubectl exec -it deployment/mythos-gateway -n mythos -- \
  /app/scripts/mythos/restore.sh /tmp/backup.tar.gz
```

---

## Upgrading

### Zero-Downtime Upgrade

```bash
# Update image tag
helm upgrade mythos ./deploy/helm/mythos \
  --namespace mythos \
  --set gateway.image.tag=2026.5.11 \
  -f my-values.yaml

# Monitor rollout
kubectl rollout status deployment/mythos-gateway -n mythos
```

### Rollback

```bash
# Rollback to previous version
helm rollback mythos -n mythos

# Or specific revision
helm rollback mythos 1 -n mythos
```

---

## Monitoring

### Health Checks

```bash
# Gateway health
curl http://localhost:18789/health

# Detailed status
curl http://localhost:18789/api/v1/status

# Prometheus metrics
curl http://localhost:18789/metrics
```

### Logs

```bash
# Gateway logs
kubectl logs -f deployment/mythos-gateway -n mythos

# PostgreSQL logs
kubectl logs -f statefulset/mythos-postgresql -n mythos

# Redis logs
kubectl logs -f deployment/mythos-redis -n mythos
```

### Metrics

**Prometheus Queries:**
```promql
# Request rate
rate(mythos_request_total[5m])

# Error rate
rate(mythos_request_errors_total[5m]) / rate(mythos_request_total[5m])

# Latency
histogram_quantile(0.95, rate(mythos_request_duration_seconds_bucket[5m]))

# Memory usage
container_memory_usage_bytes{container="gateway"}
```

---

## Disaster Recovery

### Complete Recovery

1. **Restore from Backup:**
   ```bash
   kubectl exec -it deployment/mythos-gateway -n mythos -- \
     /app/scripts/mythos/disaster-recovery.sh /backup/latest.tar.gz
   ```

2. **Rebuild Indexes:**
   ```bash
   kubectl exec -it deployment/mythos-gateway -n mythos -- \
     node scripts/mythos/operator-runbook.js memory-rebuild
   ```

3. **Verify:**
   ```bash
   kubectl exec -it deployment/mythos-gateway -n mythos -- \
     node scripts/mythos/operator-runbook.js health-check
   ```

### Data Loss Prevention

- Enable WAL mode in PostgreSQL
- Configure replication
- Schedule frequent backups
- Test restore procedures regularly

---

## Security Hardening

### Network Security

```bash
# Enable network policies
kubectl apply -f deploy/k8s/network-policy.yaml

# Restrict ingress
kubectl apply -f deploy/k8s/ingress-tls.yaml
```

### Authentication

```bash
# Rotate gateway token
kubectl exec -it deployment/mythos-gateway -n mythos -- \
  node scripts/mythos/operator-runbook.js rotate-token
```

### Secrets Management

```bash
# Use sealed secrets
kubectl apply -f https://github.com/bitnami-labs/sealed-secrets/releases/download/v0.24.5/controller.yaml

# Encrypt secrets
kubeseal < secret.yaml > sealed-secret.yaml
```

---

## Performance Tuning

### Database Tuning

```yaml
# PostgreSQL optimization
postgresql:
  primary:
    resources:
      limits:
        cpu: 4000m
        memory: 8Gi
    persistence:
      size: 200Gi
      storageClass: fast-ssd
```

### Cache Tuning

```yaml
# Redis optimization
redis:
  master:
    resources:
      limits:
        memory: 4Gi
    persistence:
      size: 20Gi
```

### Gateway Tuning

```yaml
# Optimize for high throughput
gateway:
  resources:
    limits:
      cpu: 8000m
      memory: 16Gi
  
  env:
    - name: NODE_OPTIONS
      value: "--max-old-space-size=12288"
```

---

## Troubleshooting

### Common Issues

**Gateway won't start:**
```bash
# Check logs
kubectl logs deployment/mythos-gateway -n mythos

# Verify secrets
kubectl get secret mythos-secrets -n mythos -o yaml
```

**High latency:**
```bash
# Check resource usage
kubectl top pod -n mythos

# Scale up
kubectl scale deployment/mythos-gateway --replicas=10 -n mythos
```

**Memory issues:**
```bash
# Check memory usage
kubectl exec -it deployment/mythos-gateway -n mythos -- \
  node -e "console.log(process.memoryUsage())"

# Increase limits
kubectl edit deployment/mythos-gateway -n mythos
```

---

## Support

- **Documentation:** https://docs.openclaw.ai
- **Issues:** https://github.com/openclaw/openclaw/issues
- **Discord:** https://discord.gg/openclaw

---

## Checklist

Before going to production:

- [ ] All secrets configured
- [ ] SSL/TLS enabled
- [ ] Monitoring deployed
- [ ] Backup schedule configured
- [ ] Disaster recovery tested
- [ ] Load testing completed
- [ ] Security audit passed
- [ ] Documentation reviewed
- [ ] Team trained
- [ ] Rollback plan tested

---

## License

MIT License - See LICENSE for details.
