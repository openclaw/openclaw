---
summary: "Deploy OpenClaw Gateway to a Kubernetes cluster with kubectl"
read_when:
  - You want to run OpenClaw on a Kubernetes cluster
  - You want to test OpenClaw in a Kubernetes environment
title: "Kubernetes"
---

A minimal starting point for running OpenClaw on Kubernetes — not a production-ready deployment. It covers the core resources and is meant to be adapted to your environment.

## Kubernetes manifests

The manifests in this guide are the maintained starting point for running OpenClaw on Kubernetes. The deploy script applies the manifests under `scripts/k8s/manifests/`, and `scripts/k8s/manifest.yaml` is generated from that directory for direct single-file `kubectl apply` workflows.

## What you need

- A running Kubernetes cluster (AKS, EKS, GKE, k3s, kind, OpenShift, etc.)
- `kubectl` connected to your cluster
- `openssl` to generate the gateway token
- An API key for at least one model provider

## Quick start

```bash
# Replace with your provider: ANTHROPIC, GEMINI, OPENAI, or OPENROUTER
export <PROVIDER>_API_KEY="..."
./scripts/k8s/deploy.sh

kubectl port-forward svc/openclaw 18789:18789 -n openclaw
open http://localhost:18789
```

Retrieve the configured shared secret for the Control UI. This deploy script
creates token auth by default:

```bash
kubectl get secret openclaw-secrets -n openclaw -o jsonpath='{.data.OPENCLAW_GATEWAY_TOKEN}' | base64 -d
```

For local debugging, `./scripts/k8s/deploy.sh --show-token` prints the token after deploy.

## Local testing with Kind

If you don't have a cluster, create one locally with [Kind](https://kind.sigs.k8s.io/):

```bash
./scripts/k8s/create-kind.sh           # auto-detects docker or podman
./scripts/k8s/create-kind.sh --delete  # tear down
```

Then deploy as usual with `./scripts/k8s/deploy.sh`.

## Step by step

### 1) Deploy

**Option A** — API key in environment (one step):

```bash
# Replace with your provider: ANTHROPIC, GEMINI, OPENAI, or OPENROUTER
export <PROVIDER>_API_KEY="..."
./scripts/k8s/deploy.sh
```

The script creates a Kubernetes Secret with the API key and an auto-generated gateway token, then deploys. If the Secret already exists, it preserves the current gateway token and any provider keys not being changed.

**Option B** — create the secret separately:

```bash
export <PROVIDER>_API_KEY="..."
./scripts/k8s/deploy.sh --create-secret
./scripts/k8s/deploy.sh
```

Use `--show-token` with either command if you want the token printed to stdout for local testing.

**Option C** — create the Secret yourself and apply the single-file manifest from GitHub:

```bash
# This example uses Anthropic. Replace ANTHROPIC_API_KEY
# with another supported provider key if needed.
export ANTHROPIC_API_KEY="..."
export OPENCLAW_GATEWAY_TOKEN="$(openssl rand -hex 32)"
SECRET_DIR="$(mktemp -d)"
trap 'rm -rf "$SECRET_DIR"' EXIT

printf '%s' "$OPENCLAW_GATEWAY_TOKEN" > "$SECRET_DIR/OPENCLAW_GATEWAY_TOKEN"
printf '%s' "$ANTHROPIC_API_KEY" > "$SECRET_DIR/ANTHROPIC_API_KEY"
chmod 600 "$SECRET_DIR/OPENCLAW_GATEWAY_TOKEN" "$SECRET_DIR/ANTHROPIC_API_KEY"

kubectl create namespace openclaw --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic openclaw-secrets \
  -n openclaw \
  --from-file=OPENCLAW_GATEWAY_TOKEN="$SECRET_DIR/OPENCLAW_GATEWAY_TOKEN" \
  --from-file=ANTHROPIC_API_KEY="$SECRET_DIR/ANTHROPIC_API_KEY" \
  --dry-run=client \
  -o yaml | kubectl apply --server-side --field-manager=openclaw -f -
kubectl apply -n openclaw \
  -f https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/k8s/manifest.yaml
```

### 2) Access the gateway

```bash
kubectl port-forward svc/openclaw 18789:18789 -n openclaw
open http://localhost:18789
```

## What gets deployed

The deploy script creates the namespace and Secret before applying the checked-in manifests. The single-file manifest path expects you to create the namespace and Secret first; `scripts/k8s/manifest.yaml` then applies the PVC, ConfigMap, Deployment, and Service.

| Resource                                  | Purpose                                                                                                                                                         |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Namespace/openclaw`                      | Default namespace, configurable with `OPENCLAW_NAMESPACE` when using `deploy.sh`.                                                                               |
| `PersistentVolumeClaim/openclaw-home-pvc` | Requests 10Gi and is mounted at `/home/node/.openclaw`.                                                                                                         |
| `ConfigMap/openclaw-config`               | Provides the default `openclaw.json` and `AGENTS.md`.                                                                                                           |
| `Deployment/openclaw`                     | Runs the gateway pod. The init container copies ConfigMap files into `/home/node/.openclaw`, and the main container runs `node /app/dist/index.js gateway run`. |
| `Service/openclaw`                        | Creates a ClusterIP Service on port `18789` for `kubectl port-forward`.                                                                                         |
| `Secret/openclaw-secrets`                 | Stores the gateway token and provider API keys. It is created by `deploy.sh` or by the Option C secret command, not by `scripts/k8s/manifest.yaml`.             |

## Customization

Edit the source manifests under `scripts/k8s/manifests/`. If you also use or review the single-file manifest, run `pnpm k8s:manifest:gen` after editing; `pnpm k8s:manifest:check` verifies that `scripts/k8s/manifest.yaml` is current.

### Agent instructions

Edit the `AGENTS.md` in `scripts/k8s/manifests/configmap.yaml` and redeploy:

```bash
./scripts/k8s/deploy.sh
```

### Gateway config

Edit `openclaw.json` in `scripts/k8s/manifests/configmap.yaml`. See [Gateway configuration](/gateway/configuration) for the full reference.

### Add providers

Re-run with additional keys exported:

```bash
export ANTHROPIC_API_KEY="..."
export OPENAI_API_KEY="..."
./scripts/k8s/deploy.sh --create-secret
./scripts/k8s/deploy.sh
```

Existing provider keys stay in the Secret unless you overwrite them.

Or patch the Secret directly:

```bash
kubectl patch secret openclaw-secrets -n openclaw \
  -p '{"stringData":{"<PROVIDER>_API_KEY":"..."}}'
kubectl rollout restart deployment/openclaw -n openclaw
```

### Custom namespace

```bash
OPENCLAW_NAMESPACE=my-namespace ./scripts/k8s/deploy.sh
```

### Custom image

Edit the `image` field in `scripts/k8s/manifests/deployment.yaml`:

```yaml
image: ghcr.io/openclaw/openclaw:latest # primary; official Docker Hub mirror: openclaw/openclaw:latest
```

### Expose beyond port-forward

The default manifests bind the gateway to loopback inside the pod. That works with `kubectl port-forward`, but it does not work with a Kubernetes `Service` or Ingress path that needs to reach the pod IP.

If you want to expose the gateway through an Ingress or load balancer:

- Change the gateway bind in `scripts/k8s/manifests/configmap.yaml` from `loopback` to a non-loopback bind that matches your deployment model
- Keep gateway auth enabled and use a proper TLS-terminated entrypoint
- Configure the Control UI for remote access using the supported web security model (for example HTTPS/Tailscale Serve and explicit allowed origins when needed)

## Re-deploy

```bash
./scripts/k8s/deploy.sh
```

This applies all manifests and restarts the pod to pick up any config or secret changes.

## Teardown

```bash
./scripts/k8s/deploy.sh --delete
```

This deletes the namespace and all resources in it, including the PVC.

## Architecture notes

- The gateway binds to loopback inside the pod by default, so the included setup is for `kubectl port-forward`
- No cluster-scoped resources — everything lives in a single namespace
- Security: `readOnlyRootFilesystem`, `drop: ALL` capabilities, non-root user (UID 1000)
- The default config keeps the Control UI on the safer local-access path: loopback bind plus `kubectl port-forward` to `http://127.0.0.1:18789`
- If you move beyond localhost access, use the supported remote model: HTTPS/Tailscale plus the appropriate gateway bind and Control UI origin settings
- Secrets are generated in a temp directory and applied directly to the cluster — no secret material is written to the repo checkout

## File structure

```
scripts/k8s/
├── deploy.sh                   # Creates namespace + secret, deploys the checked-in manifests
├── create-kind.sh              # Local Kind cluster (auto-detects docker/podman)
├── manifest.yaml               # Generated single-file PVC, ConfigMap, Deployment, and Service
└── manifests/
    ├── kustomization.yaml      # Local manifest set used by deploy.sh
    ├── configmap.yaml          # Default openclaw.json + AGENTS.md
    ├── deployment.yaml         # Gateway pod, init config copy, and health probes
    ├── pvc.yaml                # 10Gi PVC mounted at /home/node/.openclaw
    └── service.yaml            # ClusterIP Service on 18789
```

## Related

- [Docker](/install/docker)
- [Docker VM runtime](/install/docker-vm-runtime)
- [Install overview](/install)
