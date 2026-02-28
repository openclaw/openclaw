# Production Installation Guide - ClarityRouter Observability Stack

## Table of Contents
1. [Environment Setup](#environment-setup)
2. [Pre-Installation Checks](#pre-installation-checks)
3. [Step-by-Step Installation](#step-by-step-installation)
4. [Post-Installation Configuration](#post-installation-configuration)
5. [Verification](#verification)
6. [Troubleshooting](#troubleshooting)

## Environment Setup

### Prerequisites
- EKS cluster `clarity-router-prod` running in `us-east-1`
- kubectl configured to access production cluster
- AWS CLI v2 installed and authenticated
- Helm 3.x installed
- Secrets Manager with credentials stored
- EFS provisioned and accessible

### Verify Prerequisites

```bash
# Check kubectl
kubectl version --client

# Check Helm
helm version

# Check AWS CLI
aws --version

# Verify cluster access
kubectl cluster-info

# Check cluster nodes
kubectl get nodes
```

Expected output:
```
NAME                                         STATUS   ROLES    AGE   VERSION
ip-10-0-1-100.ec2.internal                  Ready    <none>   45d   v1.27.x
ip-10-0-2-100.ec2.internal                  Ready    <none>   45d   v1.27.x
ip-10-0-3-100.ec2.internal                  Ready    <none>   45d   v1.27.x
```

## Pre-Installation Checks

### 1. Verify EFS Availability

```bash
# List EFS file systems in us-east-1
aws efs describe-file-systems --region us-east-1 --query 'FileSystems[*].[FileSystemId,Name,SizeInBytes]' --output table

# Check mount targets for all AZs
EFS_ID="fs-xxxxxxxx"  # Replace with your EFS ID
aws efs describe-mount-targets --file-system-id "$EFS_ID" --query 'MountTargets[*].[MountTargetId,AvailabilityZone,LifeCycleState]' --output table
```

### 2. Verify EFS CSI Driver

```bash
# Check if EFS CSI controller is running
kubectl get deployment -n kube-system efs-csi-controller

# Check if CSI node plugin is on all nodes
kubectl get daemonset -n kube-system efs-csi-node

# If not installed, install with:
# helm repo add aws-efs-csi-driver https://kubernetes-sigs.github.io/aws-efs-csi-driver/
# helm install aws-efs-csi-driver aws-efs-csi-driver/aws-efs-csi-driver -n kube-system
```

### 3. Verify AWS Secrets

```bash
# Check Slack webhook secret
aws secretsmanager get-secret-value \
  --secret-id slack-webhook-prod \
  --region us-east-1 \
  --query 'SecretString' \
  --output text | head -c 20
echo "..."

# Check PagerDuty integration key
aws secretsmanager get-secret-value \
  --secret-id pagerduty-integration-prod \
  --region us-east-1 \
  --query 'SecretString' \
  --output text | head -c 20
echo "..."

# Check Grafana admin password
aws secretsmanager get-secret-value \
  --secret-id grafana-admin-password \
  --region us-east-1 \
  --query 'SecretString' \
  --output text | head -c 20
echo "..."
```

### 4. Verify Storage Class

```bash
# List available storage classes
kubectl get storageclass

# Verify EFS storage class exists (should show "ebs-csi" or custom "efs-sc")
kubectl get storageclass efs-sc -o yaml || echo "Creating EFS storage class..."
```

If storage class doesn't exist, create it:
```bash
kubectl apply -f - <<EOF
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: efs-sc
provisioner: efs.csi.aws.com
EOF
```

## Step-by-Step Installation

### Step 1: Create Observability Namespace

```bash
kubectl create namespace observability

# Verify namespace created
kubectl get namespace observability
```

Output:
```
NAME            STATUS   AGE
observability   Active   1s
```

### Step 2: Create Secrets in Kubernetes

#### Create Slack Webhook Secret

```bash
# Retrieve secret from AWS
SLACK_WEBHOOK=$(aws secretsmanager get-secret-value \
  --secret-id slack-webhook-prod \
  --region us-east-1 \
  --query 'SecretString' \
  --output text)

# Create Kubernetes secret
kubectl create secret generic slack-webhook \
  --from-literal=webhook-url="$SLACK_WEBHOOK" \
  -n observability

# Verify secret created
kubectl get secret slack-webhook -n observability
```

#### Create PagerDuty Integration Secret

```bash
# Retrieve secret from AWS
PAGERDUTY_KEY=$(aws secretsmanager get-secret-value \
  --secret-id pagerduty-integration-prod \
  --region us-east-1 \
  --query 'SecretString' \
  --output text)

# Create Kubernetes secret
kubectl create secret generic pagerduty-integration \
  --from-literal=integration-key="$PAGERDUTY_KEY" \
  -n observability

# Verify secret created
kubectl get secret pagerduty-integration -n observability
```

#### Create Grafana Admin Secret

```bash
# Retrieve secret from AWS
GRAFANA_ADMIN=$(aws secretsmanager get-secret-value \
  --secret-id grafana-admin-password \
  --region us-east-1 \
  --query 'SecretString' \
  --output text)

# Create Kubernetes secret
kubectl create secret generic grafana-admin \
  --from-literal=admin-password="$GRAFANA_ADMIN" \
  -n observability

# Verify secret created
kubectl get secret grafana-admin -n observability
```

### Step 3: Create PersistentVolumeClaims

#### Create Prometheus PVC (30 GB)

```bash
kubectl apply -f - <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: prometheus-storage
  namespace: observability
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: efs-sc
  resources:
    requests:
      storage: 30Gi
EOF

# Verify PVC created and bound
kubectl get pvc prometheus-storage -n observability
```

#### Create Loki PVC (150 GB)

```bash
kubectl apply -f - <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: loki-storage
  namespace: observability
spec:
  accessModes:
    - ReadWriteMany  # Required for multi-replica Loki
  storageClassName: efs-sc
  resources:
    requests:
      storage: 150Gi
EOF

# Verify PVC created and bound
kubectl get pvc loki-storage -n observability
```

### Step 4: Add Helm Repositories

```bash
# Add Prometheus community repository
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts

# Add Grafana repository
helm repo add grafana https://grafana.github.io/helm-charts

# Add Loki repository
helm repo add loki https://grafana.github.io/loki/charts

# Update all repositories
helm repo update

# Verify repositories
helm repo list
```

Expected output:
```
NAME                    URL
prometheus-community    https://prometheus-community.github.io/helm-charts
grafana                 https://grafana.github.io/helm-charts
loki                    https://grafana.github.io/loki/charts
```

### Step 5: Deploy Prometheus (3 Replicas)

Create values file: `prometheus-prod-values.yaml`

```yaml
prometheus:
  prometheusSpec:
    replicas: 3
    retention: 15d
    storageSpec:
      volumeClaimTemplate:
        spec:
          storageClassName: efs-sc
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 30Gi
    resources:
      requests:
        memory: "2Gi"
        cpu: "500m"
      limits:
        memory: "3Gi"
        cpu: "1000m"
    
    # Scrape configuration for router and infrastructure
    scrapeConfigs:
      - job_name: 'router'
        static_configs:
          - targets: ['clarity-router:8089']
      
      - job_name: 'node-exporter'
        relabel_configs:
          - source_labels: [__address__]
            target_label: __param_target
          - source_labels: [__param_target]
            target_label: instance
          - target_label: __address__
            replacement: 'node-exporter:9100'

# Alert Manager configuration
alertmanager:
  alertmanagerSpec:
    replicas: 3
    storage:
      volumeClaimTemplate:
        spec:
          storageClassName: efs-sc
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 2Gi
```

Deploy Prometheus:

```bash
helm upgrade --install prometheus prometheus-community/kube-prometheus-stack \
  -n observability \
  -f prometheus-prod-values.yaml \
  --wait \
  --timeout 10m

# Verify deployment
kubectl get pods -n observability -l app.kubernetes.io/name=prometheus
```

Expected output:
```
NAME                                     READY   STATUS    RESTARTS   AGE
prometheus-kube-prom-prometheus-0        2/2     Running   0          2m
prometheus-kube-prom-prometheus-1        2/2     Running   0          2m
prometheus-kube-prom-prometheus-2        2/2     Running   0          2m
```

### Step 6: Deploy Loki (3 Replicas)

Create values file: `loki-prod-values.yaml`

```yaml
loki:
  replicas: 3
  config:
    auth_enabled: false
    limits_config:
      retention_period: 30d
      max_cache_freshness_per_query: 10m
    storage_config:
      filesystem:
        directory: /loki/chunks
  persistence:
    enabled: true
    storageClassName: efs-sc
    size: 150Gi
  resources:
    requests:
      memory: "1Gi"
      cpu: "250m"
    limits:
      memory: "2Gi"
      cpu: "500m"

# Promtail configuration (log collection)
promtail:
  enabled: true
  config:
    clients:
      - url: http://loki:3100/loki/api/v1/push
    scrape_configs:
      - job_name: kubernetes-pods
        kubernetes_sd_configs:
          - role: pod
```

Deploy Loki:

```bash
helm upgrade --install loki grafana/loki-stack \
  -n observability \
  -f loki-prod-values.yaml \
  --wait \
  --timeout 10m

# Verify deployment
kubectl get pods -n observability -l app.kubernetes.io/name=loki
```

### Step 7: Deploy Grafana (2 Replicas)

Create values file: `grafana-prod-values.yaml`

```yaml
replicaCount: 2

adminPassword: null  # Will use secret created earlier
adminUser: admin

persistence:
  enabled: true
  storageClassName: efs-sc
  size: 2Gi

resources:
  requests:
    memory: "512Mi"
    cpu: "250m"
  limits:
    memory: "1Gi"
    cpu: "500m"

datasources:
  datasources.yaml:
    apiVersion: 1
    datasources:
      - name: Prometheus
        type: prometheus
        url: http://prometheus-kube-prom-prometheus:9090
        access: proxy
        isDefault: true
      
      - name: Loki
        type: loki
        url: http://loki:3100
        access: proxy

dashboardProviders:
  dashboardproviders.yaml:
    apiVersion: 1
    providers:
      - name: 'default'
        orgId: 1
        folder: ''
        type: file
        disableDeletion: false
        updateIntervalSeconds: 10
        allowUiUpdates: true
        options:
          path: /var/lib/grafana/dashboards/default
```

Deploy Grafana:

```bash
helm upgrade --install grafana grafana/grafana \
  -n observability \
  -f grafana-prod-values.yaml \
  --wait \
  --timeout 10m

# Verify deployment
kubectl get pods -n observability -l app.kubernetes.io/name=grafana
```

Expected output:
```
NAME                     READY   STATUS    RESTARTS   AGE
grafana-7d8f5c9b8-2n9m9  1/1     Running   0          1m
grafana-7d8f5c9b8-4x2p5  1/1     Running   0          1m
```

## Post-Installation Configuration

### 1. Configure AlertManager Routing

```bash
# Create AlertManager configuration ConfigMap
kubectl apply -f - <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: alertmanager-config
  namespace: observability
data:
  alertmanager.yml: |
    global:
      resolve_timeout: 5m
      slack_api_url: file:///etc/alertmanager/secrets/slack-webhook/webhook-url

    route:
      receiver: 'default'
      group_by: ['alertname', 'cluster', 'service']
      group_wait: 30s
      group_interval: 5m
      repeat_interval: 1h
      
      routes:
        - match:
            severity: critical
          receiver: 'critical'
          group_wait: 0s
          repeat_interval: 5m
        
        - match:
            severity: warning
          receiver: 'warning'
          repeat_interval: 1h

    receivers:
      - name: 'default'
        slack_configs:
          - channel: '#observability-alerts'
            title: '[{{ .Status | toUpper }}] {{ .GroupLabels.alertname }}'
            text: '{{ range .Alerts }}{{ .Annotations.description }}{{ end }}'

      - name: 'critical'
        slack_configs:
          - channel: '#observability-incidents'
            title: '[CRITICAL] {{ .GroupLabels.alertname }}'
          - service_key: file:///etc/alertmanager/secrets/pagerduty/integration-key
            description: '{{ .GroupLabels.alertname }}: {{ .Alerts.Firing | len }} alerts'

      - name: 'warning'
        slack_configs:
          - channel: '#observability-alerts'
            title: '[WARNING] {{ .GroupLabels.alertname }}'
EOF
```

### 2. Load Grafana Dashboards

```bash
# Port forward to Grafana
kubectl port-forward -n observability svc/grafana 3000:80 &

# Access Grafana at http://localhost:3000
# Login with admin credentials
# Add Prometheus data source: http://prometheus-kube-prom-prometheus:9090
# Add Loki data source: http://loki:3100
# Import dashboards from grafana/dashboards/*.json
```

### 3. Create Alert Rules

```bash
# Apply alert rules ConfigMap
kubectl apply -f - <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: alert-rules
  namespace: observability
data:
  alert-rules.yml: |
    groups:
      - name: observability
        interval: 30s
        rules:
          - alert: PrometheusDown
            expr: up{job="prometheus"} == 0
            for: 2m
            annotations:
              summary: "Prometheus is down"

          - alert: GrafanaDown
            expr: up{job="grafana"} == 0
            for: 2m
            annotations:
              summary: "Grafana is down"

          - alert: LokiDown
            expr: up{job="loki"} == 0
            for: 2m
            annotations:
              summary: "Loki is down"

          - alert: PVCAlmostFull
            expr: (kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes) > 0.8
            for: 10m
            annotations:
              summary: "PVC {{ \$labels.persistentvolumeclaim }} is 80% full"
EOF
```

## Verification

After installation, verify all components are healthy:

```bash
# 1. Check all pods are running
kubectl get pods -n observability

# 2. Check PVCs are bound
kubectl get pvc -n observability

# 3. Check services
kubectl get svc -n observability

# 4. Check PersistentVolumes
kubectl get pv

# 5. Verify Prometheus scraping targets
kubectl port-forward -n observability svc/prometheus-kube-prom-prometheus 9090:9090
# Visit http://localhost:9090/targets

# 6. Test Grafana dashboard
kubectl port-forward -n observability svc/grafana 3000:80
# Visit http://localhost:3000
# Default credentials: admin / <password from secret>
```

See [`VERIFY_PRODUCTION.md`](VERIFY_PRODUCTION.md) for comprehensive verification checklist.

## Troubleshooting

### Issue: PVCs Stuck in Pending

```bash
# Check PVC events
kubectl describe pvc prometheus-storage -n observability

# Check if EFS CSI driver is running
kubectl get pods -n kube-system | grep efs-csi

# Check if storage class exists
kubectl get storageclass efs-sc
```

**Solution:** Ensure EFS CSI driver is installed and storage class is configured.

### Issue: Pods CrashLooping

```bash
# Check pod logs
kubectl logs -n observability <pod-name> --tail=50

# Check pod events
kubectl describe pod -n observability <pod-name>
```

**Common causes:**
- Missing secrets
- Insufficient memory (increase resource limits)
- Configuration errors (check ConfigMaps)

### Issue: Prometheus Not Scraping Metrics

```bash
# Check Prometheus targets
kubectl port-forward -n observability svc/prometheus-kube-prom-prometheus 9090:9090
# Visit http://localhost:9090/targets

# Check ServiceMonitor objects
kubectl get servicemonitor -n observability
```

**Solution:** Ensure target pods are labeled correctly and ServiceMonitor selectors match labels.

### Issue: Loki Not Ingesting Logs

```bash
# Check Promtail DaemonSet
kubectl get daemonset -n observability

# Check Promtail logs
kubectl logs -n observability -l app=promtail --tail=20

# Check log file permissions
kubectl exec -n observability <loki-pod> -- ls -la /var/log/containers/
```

**Solution:** Ensure Promtail has read access to `/var/log/containers/`.

### Issue: High Memory Usage

```bash
# Check memory usage
kubectl top pods -n observability

# If Prometheus is high:
# - Reduce retention period
# - Reduce number of scrape targets
# - Increase memory limits
```

---

**Next Steps:**
1. Complete [`VERIFY_PRODUCTION.md`](VERIFY_PRODUCTION.md) verification checklist
2. Review dashboards in Grafana
3. Test alert routing to Slack/PagerDuty
4. See [`ACCESS_PRODUCTION.md`](ACCESS_PRODUCTION.md) for production access methods
