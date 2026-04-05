---
summary: "Deploy Mullusi Gateway to a Kubernetes cluster with Kustomize"
read_when:
  - You want to run Mullusi on a Kubernetes cluster
  - You want to test Mullusi in a Kubernetes environment
title: "Kubernetes"
---

# Mullusi on Kubernetes

A minimal starting point for running Mullusi on Kubernetes — not a production-ready deployment. It covers the core resources and is meant to be adapted to your environment.

## Why not Helm?

Mullusi is a single container with some config files. The interesting customization is in agent content (markdown files, skills, config overrides), not infrastructure templating. Kustomize handles overlays without the overhead of a Helm chart. If your deployment grows more complex, a Helm chart can be layered on top of these manifests.

## What you need

- A running Kubernetes cluster (AKS, EKS, GKE, k3s, kind, OpenShift, etc.)
- `kubectl` connected to your cluster
- An API key for at least one model provider

## Quick start

```bash
# Replace with your provider: ANTHROPIC, GEMINI, OPENAI, or OPENROUTER
export <PROVIDER>_API_KEY="..."
./scripts/k8s/deploy.sh

kubectl port-forward svc/mullusi 18790:18790 -n mullusi
open http://localhost:18790
```

Retrieve the configured shared secret for the Control UI. This deploy script
creates token auth by default:

```bash
kubectl get secret mullusi-secrets -n mullusi -o jsonpath='{.data.MULLUSI_GATEWAY_TOKEN}' | base64 -d
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

### 2) Access the gateway

```bash
kubectl port-forward svc/mullusi 18790:18790 -n mullusi
open http://localhost:18790
```

## What gets deployed

```
Namespace: mullusi (configurable via MULLUSI_NAMESPACE)
├── Deployment/mullusi        # Single pod, init container + gateway
├── Service/mullusi           # ClusterIP on port 18790
├── PersistentVolumeClaim      # 10Gi for agent state and config
├── ConfigMap/mullusi-config  # mullusi.json + AGENTS.md
└── Secret/mullusi-secrets    # Gateway token + API keys
```

## Customization

### Agent instructions

Edit the `AGENTS.md` in `scripts/k8s/manifests/configmap.yaml` and redeploy:

```bash
./scripts/k8s/deploy.sh
```

### Gateway config

Edit `mullusi.json` in `scripts/k8s/manifests/configmap.yaml`. See [Gateway configuration](/gateway/configuration) for the full reference.

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
kubectl patch secret mullusi-secrets -n mullusi \
  -p '{"stringData":{"<PROVIDER>_API_KEY":"..."}}'
kubectl rollout restart deployment/mullusi -n mullusi
```

### Custom namespace

```bash
MULLUSI_NAMESPACE=my-namespace ./scripts/k8s/deploy.sh
```

### Custom image

Edit the `image` field in `scripts/k8s/manifests/deployment.yaml`:

```yaml
image: ghcr.io/mullusi/mullusi:latest # or pin to a specific version from https://github.com/mullusi/mullusi/releases
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
- The default config keeps the Control UI on the safer local-access path: loopback bind plus `kubectl port-forward` to `http://127.0.0.1:18790`
- If you move beyond localhost access, use the supported remote model: HTTPS/Tailscale plus the appropriate gateway bind and Control UI origin settings
- Secrets are generated in a temp directory and applied directly to the cluster — no secret material is written to the repo checkout

## File structure

```
scripts/k8s/
├── deploy.sh                   # Creates namespace + secret, deploys via kustomize
├── create-kind.sh              # Local Kind cluster (auto-detects docker/podman)
└── manifests/
    ├── kustomization.yaml      # Kustomize base
    ├── configmap.yaml          # mullusi.json + AGENTS.md
    ├── deployment.yaml         # Pod spec with security hardening
    ├── pvc.yaml                # 10Gi persistent storage
    └── service.yaml            # ClusterIP on 18790
```
