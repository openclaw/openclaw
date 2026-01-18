---
description: Update or rollback Clawdbot deployment on K8s VNPAY Cloud
---

# Update/Rollback Clawdbot Deployment

This workflow handles updating or rolling back Clawdbot on Kubernetes VNPAY Cloud.

## Update Deployment

### Step 1: Pull Latest Changes

```bash
cd /home/duhd/clawdbot && git pull origin main
```

// turbo
### Step 2: Build and Push New Image

```bash
cd /home/duhd/clawdbot && ./k8s/build-push-script.sh
```

// turbo
### Step 3: Apply Config Changes (if any)

```bash
cd /home/duhd/clawdbot/k8s && kubectl apply -f configmap.yaml -f secret.yaml
```

// turbo
### Step 4: Trigger Rolling Update

```bash
kubectl rollout restart deployment/clawdbot-gateway -n clawdbot
```

// turbo
### Step 5: Wait for Rollout

```bash
kubectl rollout status deployment/clawdbot-gateway -n clawdbot --timeout=120s
```

// turbo
### Step 6: Re-enable Zalo Plugin

```bash
kubectl exec deployment/clawdbot-gateway -n clawdbot -- tsx src/entry.ts plugins enable zalo
```

// turbo
### Step 7: Restart Gateway for Plugin

```bash
kubectl exec deployment/clawdbot-gateway -n clawdbot -- kill 1
```

// turbo
### Step 8: Verify Update

```bash
sleep 30 && kubectl exec deployment/clawdbot-gateway -n clawdbot -- tsx src/entry.ts channels status
```

---

## Rollback Deployment

### Quick Rollback to Previous Version

// turbo
```bash
kubectl rollout undo deployment/clawdbot-gateway -n clawdbot
```

### Rollback to Specific Revision

```bash
# View rollout history
kubectl rollout history deployment/clawdbot-gateway -n clawdbot

# Rollback to specific revision
kubectl rollout undo deployment/clawdbot-gateway -n clawdbot --to-revision=<revision-number>
```

// turbo
### Wait for Rollback

```bash
kubectl rollout status deployment/clawdbot-gateway -n clawdbot --timeout=120s
```

// turbo
### Re-enable Zalo After Rollback

```bash
kubectl exec deployment/clawdbot-gateway -n clawdbot -- tsx src/entry.ts plugins enable zalo && kubectl exec deployment/clawdbot-gateway -n clawdbot -- kill 1
```

---

## Deploy Specific Image Version

```bash
# List available tags (if using registry UI)
# Or check build history

# Deploy specific tag
kubectl set image deployment/clawdbot-gateway -n clawdbot \
  gateway=vcr.vnpaycloud.vn/286e18c6183846159c47575db4e3d831-clawdbot/clawdbot:20260118-075118
```

---

## Health Checks

// turbo
### Check Pod Status

```bash
kubectl get pods -n clawdbot -o wide
```

// turbo
### Check Gateway Logs

```bash
kubectl logs -n clawdbot -l app=clawdbot --tail=30
```

// turbo
### Check Channel Status

```bash
kubectl exec deployment/clawdbot-gateway -n clawdbot -- tsx src/entry.ts channels status
```

---

## Emergency Actions

### Force Delete and Recreate Pod

```bash
kubectl delete pod -n clawdbot -l app=clawdbot --force --grace-period=0
```

### Scale Down/Up

```bash
# Scale down
kubectl scale deployment/clawdbot-gateway -n clawdbot --replicas=0

# Scale up
kubectl scale deployment/clawdbot-gateway -n clawdbot --replicas=1
```

### Full Redeploy

```bash
cd /home/duhd/clawdbot/k8s && ./deploy.sh
```
