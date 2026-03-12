---
name: argocd-diff
description: Compare local Helm chart rendering against ArgoCD live state. Use when you need to preview what changes would be deployed, validate chart changes before PR, or debug sync issues.
---

# ArgoCD Diff Skill

Compare local Helm chart rendering against what's deployed in ArgoCD/Kubernetes.

## Prerequisites

- `argocd` CLI installed
- `kubectl` configured with cluster access
- Access to ArgoCD server (via ingress or port-forward)

## Workflow

### Step 1: Verify Tools and Context

```bash
# Check ArgoCD CLI
which argocd && argocd version --client

# Check Kubernetes context
kubectl config current-context
kubectl cluster-info | head -3
```

### Step 2: Connect to ArgoCD

**Morpho ArgoCD Endpoints:**
| Environment | Hostname | Kubernetes Context | AWS Secret |
|-------------|----------|-------------------|------------|
| Production | `argocd.morpho.dev` | `prd-morpho` | `prd/argocd/admin-password` |
| Development | `argocd-dev.morpho.dev` | `dev-morpho` | `dev/argocd/admin-password` |

**Password Sources:**

1. **AWS Secrets Manager** (preferred): Passwords stored in `eu-west-3` region
2. **Kubernetes Secret**: `argocd-initial-admin-secret` in `argocd` namespace

**Login to ArgoCD:**

```bash
# Determine environment from kubectl context
CONTEXT=$(kubectl config current-context)
if [[ "$CONTEXT" == *"prd"* ]]; then
  ARGOCD_HOST="argocd.morpho.dev"
  AWS_SECRET="prd/argocd/admin-password" # pragma: allowlist secret
elif [[ "$CONTEXT" == *"dev"* ]]; then
  ARGOCD_HOST="argocd-dev.morpho.dev"
  AWS_SECRET="dev/argocd/admin-password" # pragma: allowlist secret
else
  echo "Unknown context: $CONTEXT"
  exit 1
fi

# Get admin password (try AWS SM first, fallback to k8s secret)
ARGOCD_PASSWORD=$(aws secretsmanager get-secret-value --secret-id "$AWS_SECRET" --region eu-west-3 --query 'SecretString' --output text 2>/dev/null) || \
ARGOCD_PASSWORD=$(kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" | base64 -d)

# Login (`--insecure` is used here because these internal ArgoCD endpoints commonly present internal/self-signed cert chains)
argocd login "$ARGOCD_HOST" --username admin --password "$ARGOCD_PASSWORD" --insecure --grpc-web
```

**Direct login (if you know the environment):**

```bash
# Production (from AWS Secrets Manager)
ARGOCD_PASSWORD=$(aws secretsmanager get-secret-value --secret-id "prd/argocd/admin-password" --region eu-west-3 --query 'SecretString' --output text)
argocd login argocd.morpho.dev --username admin --password "$ARGOCD_PASSWORD" --insecure --grpc-web

# Development (from AWS Secrets Manager)
ARGOCD_PASSWORD=$(aws secretsmanager get-secret-value --secret-id "dev/argocd/admin-password" --region eu-west-3 --query 'SecretString' --output text)
argocd login argocd-dev.morpho.dev --username admin --password "$ARGOCD_PASSWORD" --insecure --grpc-web

# Alternative: from Kubernetes secret (if AWS creds not available)
ARGOCD_PASSWORD=$(kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" | base64 -d)
```

### Step 3: List Available Apps

```bash
# List all apps
argocd app list --grpc-web

# Filter by pattern (e.g., morpho apps)
argocd app list --grpc-web | grep -E "morpho|NAME"
```

### Step 4: Compare Against Current Branch

```bash
# Get current branch name
BRANCH=$(git branch --show-current)

# Diff a specific app against current branch
argocd app diff argocd/<APP_NAME> --revision "$BRANCH" --grpc-web

# Filter out cosmetic differences (tracking IDs, timestamps)
argocd app diff argocd/<APP_NAME> --revision "$BRANCH" --grpc-web 2>&1 | \
  grep -v "argocd.argoproj.io/tracking-id" | \
  grep -v "creationTimestamp"
```

### Step 5: Analyze Specific Changes

```bash
# Show only changed resources
argocd app diff argocd/<APP_NAME> --revision "$BRANCH" --grpc-web 2>&1 | \
  grep -E "^====="

# Show image changes
argocd app diff argocd/<APP_NAME> --revision "$BRANCH" --grpc-web 2>&1 | \
  grep -E "image:"

# Show version/chart changes
argocd app diff argocd/<APP_NAME> --revision "$BRANCH" --grpc-web 2>&1 | \
  grep -E "(version:|chart:)"
```

### Step 6: Compare Multiple Apps

```bash
# Diff multiple apps in a loop
BRANCH=$(git branch --show-current)
for app in morpho-blue-api morpho-historical-api morpho-realtime-api; do
  echo "=== $app ==="
  argocd app diff argocd/$app --revision "$BRANCH" --grpc-web 2>&1 | \
    grep -E "^=====|image:" | head -20
  echo ""
done
```

### Step 7: Generate Diff Summary

```bash
# Count changed resources per app
BRANCH=$(git branch --show-current)
for app in $(argocd app list --grpc-web -o name | grep morpho); do
  count=$(argocd app diff $app --revision "$BRANCH" --grpc-web 2>&1 | grep -c "^=====" || echo "0")
  echo "$app: $count resources changed"
done
```

## Output Interpretation

| Diff Pattern                     | Meaning                               |
| -------------------------------- | ------------------------------------- |
| `< line`                         | Removed from live state               |
| `> line`                         | Added in new version                  |
| `argocd.argoproj.io/tracking-id` | Cosmetic - ArgoCD tracking annotation |
| `creationTimestamp: null`        | Cosmetic - Kubernetes metadata        |
| `image:` changes                 | Actual container image update         |
| `version:` changes               | Helm chart version bump               |

## Common Issues

### "Argo CD server address unspecified"

- Run `argocd login` first with the server address

### "connection refused" on port-forward

- Port-forward may have died, restart it
- Use ingress/ALB instead if available

### Large diff output

- Filter with `grep -v` to remove cosmetic changes
- Focus on specific resources with `grep -E "^===== apps/Deployment"`

## Tips

1. **Always filter tracking IDs** - These are added by ArgoCD and aren't meaningful changes
2. **Check image tags carefully** - Different tags mean different application versions
3. **Compare against main first** - See what's pending in main before your branch changes
4. **Use `--local` flag** - Render from local files instead of fetching from git (useful for uncommitted changes)

## Example Session

```bash
# Quick diff workflow for PRODUCTION
kubectl config current-context  # Should show prd-morpho

# Login to ArgoCD (production) - using AWS Secrets Manager
ARGOCD_PASS=$(aws secretsmanager get-secret-value --secret-id "prd/argocd/admin-password" --region eu-west-3 --query 'SecretString' --output text)
argocd login argocd.morpho.dev --username admin --password "$ARGOCD_PASS" --insecure --grpc-web

# Diff current branch
BRANCH=$(git branch --show-current)
argocd app diff argocd/morpho-blue-api --revision "$BRANCH" --grpc-web 2>&1 | \
  grep -v "tracking-id" | grep -v "creationTimestamp" | head -50
```

```bash
# Quick diff workflow for DEVELOPMENT
kubectl config use-context <dev-context>  # Switch to dev cluster

# Login to ArgoCD (development) - using AWS Secrets Manager
ARGOCD_PASS=$(aws secretsmanager get-secret-value --secret-id "dev/argocd/admin-password" --region eu-west-3 --query 'SecretString' --output text)
argocd login argocd-dev.morpho.dev --username admin --password "$ARGOCD_PASS" --insecure --grpc-web

# Diff current branch against dev apps
BRANCH=$(git branch --show-current)
argocd app diff argocd/morpho-blue-api --revision "$BRANCH" --grpc-web 2>&1 | \
  grep -v "tracking-id" | grep -v "creationTimestamp" | head -50
```
