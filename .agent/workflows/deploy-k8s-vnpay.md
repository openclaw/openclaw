---
description: Deploy Clawdbot to K8s VNPAY Cloud with Zalo channel
---

# Deploy Clawdbot to K8s VNPAY Cloud

This workflow deploys Clawdbot gateway to Kubernetes on VNPAY Cloud with full Zalo channel integration.

## Prerequisites

- Docker installed and configured
- kubectl configured with VNPAY Cloud cluster access
- Registry credentials for `vcr.vnpaycloud.vn`
- Claude.ai account with Pro/Team subscription (for OAuth mode)

## Step 0: Get Claude AI Session Key (OAuth Mode)

1. Login to **https://claude.ai**
2. Open Developer Tools (F12) → **Application** → **Cookies** → **https://claude.ai**
3. Find cookie: `__Secure-next-auth.session-token`
4. Copy the entire value (starts with `eyJ...`)

> For detailed steps, run: `/get-oauth-session-key`

## Step 1: Configure Secrets

Edit `k8s/secret.yaml` with your credentials:

```yaml
# Required - Claude OAuth Session (from Step 0)
CLAUDE_AI_SESSION_KEY: "eyJhbGciOiJkaXIi..."  # Paste your session token here

# Gateway token (generate a secure random string)
CLAWDBOT_GATEWAY_TOKEN: "your-secure-gateway-token"

# For Zalo channel
ZALO_BOT_TOKEN: "12345689:abc-xyz"  # Get from https://bot.zaloplatforms.com
```

// turbo
## Step 2: Build and Push Docker Image

```bash
cd /home/duhd/clawdbot && ./k8s/build-push-script.sh
```

// turbo
## Step 3: Deploy to Kubernetes

```bash
cd /home/duhd/clawdbot/k8s && ./deploy.sh
```

// turbo
## Step 4: Wait for Pod Ready

```bash
kubectl rollout status deployment/clawdbot-gateway -n clawdbot --timeout=120s
```

// turbo
## Step 5: Enable Zalo Plugin

```bash
kubectl exec deployment/clawdbot-gateway -n clawdbot -- tsx src/entry.ts plugins enable zalo
```

// turbo
## Step 6: Restart Gateway to Apply Plugin

```bash
kubectl exec deployment/clawdbot-gateway -n clawdbot -- kill 1
```

// turbo
## Step 7: Wait for Gateway Restart

```bash
sleep 30 && kubectl logs -n clawdbot -l app=clawdbot --tail=10
```

// turbo
## Step 8: Verify Deployment

```bash
kubectl exec deployment/clawdbot-gateway -n clawdbot -- tsx src/entry.ts channels status
```

Expected output should show:
- Gateway reachable
- Zalo channel: enabled, configured, mode:polling

## Step 9: Access Control UI

Open in browser: `https://clawdbot.x.vnshop.cloud`

Use the gateway token from `secret.yaml` to authenticate.

## Troubleshooting

### Zalo not appearing in channels
```bash
# Re-enable plugin
kubectl exec deployment/clawdbot-gateway -n clawdbot -- tsx src/entry.ts plugins enable zalo
kubectl exec deployment/clawdbot-gateway -n clawdbot -- kill 1
```

### Check logs
```bash
kubectl logs -n clawdbot -l app=clawdbot --tail=50
```

### Check pod status
```bash
kubectl get pods -n clawdbot
kubectl describe pod -n clawdbot -l app=clawdbot
```

### Force redeploy
```bash
kubectl delete pod -n clawdbot -l app=clawdbot
```

## Configuration Files

- `k8s/secret.yaml` - Credentials and tokens
- `k8s/configmap.yaml` - Gateway and channel configuration  
- `k8s/deployment.yaml` - Kubernetes deployment spec
- `k8s/auth-profile-configmap.yaml` - Auth profile init script

## Zalo Configuration

Zalo channel is configured in `k8s/configmap.yaml`:
```json
"zalo": {
  "enabled": true,
  "dmPolicy": "open",      // or "pairing" or "allowlist"
  "allowFrom": ["*"],      // ["user-id-1", "user-id-2"] for allowlist
  "mediaMaxMb": 5
}
```

DM Policies:
- `open`: Anyone can message the bot
- `pairing`: Requires pairing code approval
- `allowlist`: Only users in allowFrom list can message
