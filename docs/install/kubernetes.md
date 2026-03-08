---
summary: "Deploy OpenClaw Gateway to a Kubernetes cluster with Kustomize and an interactive setup script"
read_when:
  - You want to run OpenClaw on a Kubernetes cluster
  - You need a persistent, always-on Gateway in Kubernetes
  - You want to deploy OpenClaw with Kustomize overlays
title: "Kubernetes"
---

# OpenClaw on Kubernetes

## Goal

Deploy a persistent OpenClaw Gateway to a Kubernetes cluster using Kustomize, with durable state via PersistentVolumeClaims and an interactive setup script that handles secrets, config generation, and deployment.

## What you need

- A running Kubernetes cluster (any distribution: EKS, GKE, AKS, kind, k3s, etc.)
- `kubectl` configured and connected to your cluster
- `envsubst` (usually pre-installed on Linux/macOS)
- An API key for at least one model provider (Anthropic, OpenAI, Gemini, OpenRouter, Mistral, xAI, or Groq)

---

## Quick path

```bash
./k8s/setup.sh
kubectl port-forward svc/openclaw 18789:18789 -n <namespace>
open http://localhost:18789
```

---

## Local testing with Kind

If you don't have a cluster, create one locally with [Kind](https://kind.sigs.k8s.io/):

```bash
./k8s/create-kind.sh
```

This creates a single-node Kind cluster named `openclaw`. Then continue with the setup below.

---

## Step-by-step

### 1) Verify prerequisites

Confirm `kubectl` can reach your cluster:

```bash
kubectl cluster-info
kubectl get nodes
```

You should see your cluster API server address and at least one node in `Ready` state.

### 2) Run the setup script

From the repo root:

```bash
./k8s/setup.sh
```

The script will:

1. **Verify connectivity** — checks that `kubectl` is installed and connected
2. **Prompt for configuration** — namespace, agent display name, model provider and API key
3. **Generate secrets** — creates a random gateway token
4. **Render manifests** — copies and renders templates into `k8s/manifests/generated/`
5. **Create the namespace** — `kubectl create namespace <namespace>`
6. **Deploy via Kustomize** — `kubectl apply -k k8s/manifests/generated/`
7. **Wait for readiness** — watches `kubectl rollout status` (up to 5 minutes)
8. **Print access instructions** — port-forward command and credentials

<Accordion title="Interactive prompts reference">

| Prompt | Description | Default |
| --- | --- | --- |
| Namespace | Kubernetes namespace for the deployment | `openclaw` |
| Agent display name | The name shown in the Gateway UI | `OpenClaw Assistant` |
| Model provider | Choose from Anthropic, OpenAI, Gemini, OpenRouter, Mistral, xAI, Groq | — |
| API key | Key for the selected provider | — |

</Accordion>

### 3) Access the Gateway

The Gateway binds to loopback inside the pod. Use `kubectl port-forward` to access it from your machine:

```bash
kubectl port-forward svc/openclaw 18789:18789 -n <namespace>
```

Then open `http://localhost:18789` in your browser.

Paste the gateway token (printed at the end of setup, or stored in the generated `k8s/.env` file) into the Control UI.

### 4) Verify the deployment

Check that the pod is running:

```bash
kubectl get pods -n <namespace>
```

Expected output:

```
NAME                        READY   STATUS    RESTARTS   AGE
openclaw-xxxxxxxxxx-xxxxx   1/1     Running   0          2m
```

Check logs:

```bash
kubectl logs -f deployment/openclaw -n <namespace>
```

Health check (while port-forward is active):

```bash
curl -fsS http://localhost:18789/healthz
```

---

## Configuration

### Model providers

OpenClaw auto-discovers model providers from API key environment variables. The setup script prompts for one provider, but you can add more by updating the Secret:

| Provider | Env Var | Example model |
| --- | --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic/claude-sonnet-4-6` |
| OpenAI | `OPENAI_API_KEY` | `openai/gpt-4.1-mini` |
| Google Gemini | `GEMINI_API_KEY` | `google/gemini-2.5-flash` |
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter/anthropic/claude-sonnet-4-6` |
| Mistral | `MISTRAL_API_KEY` | `mistral/mistral-large-latest` |
| xAI | `XAI_API_KEY` | `xai/grok-3` |
| Groq | `GROQ_API_KEY` | `groq/llama-3.3-70b-versatile` |

To add a provider after deployment, patch the Secret and restart:

```bash
kubectl patch secret openclaw-secrets -n <namespace> \
  -p '{"stringData":{"OPENAI_API_KEY":"sk-..."}}'
kubectl rollout restart deployment/openclaw -n <namespace>
```

To change the default model, edit the ConfigMap:

```bash
kubectl edit configmap openclaw-config -n <namespace>
kubectl rollout restart deployment/openclaw -n <namespace>
```

### Custom image

By default the deployment uses `ghcr.io/openclaw/openclaw:latest`. To use a different image:

```bash
OPENCLAW_IMAGE="ghcr.io/openclaw/openclaw:2026.3.1" ./k8s/setup.sh
```

For local development with Kind, build and load a local image:

```bash
docker build -t openclaw:local .
kind load docker-image openclaw:local --name openclaw
OPENCLAW_IMAGE="openclaw:local" ./k8s/setup.sh
```

---

## Adding or updating agents

<Note>
In Kubernetes, the init container copies `openclaw.json` from the ConfigMap into the PVC on **every restart**. Config changes made via the Gateway UI are written to the PVC only and will be lost on the next pod restart.
</Note>

### Add a new agent

Edit `k8s/manifests/openclaw.json.envsubst` and add an entry to `agents.list`:

```json
{
  "agents": {
    "list": [
      {
        "id": "default",
        "name": "OpenClaw Assistant",
        "workspace": "~/.openclaw/workspace"
      },
      {
        "id": "researcher",
        "name": "Research Agent",
        "workspace": "~/.openclaw/workspace-researcher"
      }
    ]
  }
}
```

Then re-run setup to regenerate and apply:

```bash
./k8s/setup.sh --env-file k8s/.env
```

Or edit the ConfigMap directly and restart:

```bash
kubectl edit configmap openclaw-config -n <namespace>
kubectl rollout restart deployment/openclaw -n <namespace>
```

### Customize agent behavior

The default agent instructions live in `k8s/manifests/AGENTS.md` — a standalone Markdown file that gets bundled into a ConfigMap by Kustomize. Edit it before deployment to change the default agent's system prompt and workspace conventions.

The init container copies `AGENTS.md` into the workspace **only on first boot** (it won't overwrite your customizations). To update a running agent's instructions:

```bash
kubectl exec -it deployment/openclaw -n <namespace> -- \
  vi ~/.openclaw/workspace/AGENTS.md
```

Each agent gets its own workspace directory. For a new agent, create its workspace and add an `AGENTS.md`:

```bash
kubectl exec -it deployment/openclaw -n <namespace> -- \
  sh -c 'mkdir -p ~/.openclaw/workspace-researcher && vi ~/.openclaw/workspace-researcher/AGENTS.md'
```

Workspace files (`AGENTS.md`, `MEMORY.md`, etc.) live on the PVC and survive restarts — only `openclaw.json` gets overwritten from the ConfigMap.

---

## What persists where (source of truth)

| Component | Location | Persistence | Notes |
| --- | --- | --- | --- |
| Gateway config | `/home/node/.openclaw/` | PersistentVolumeClaim | Includes `openclaw.json`, tokens |
| Agent workspace | `/home/node/.openclaw/workspace/` | PersistentVolumeClaim | Code and agent artifacts |
| Secrets | Kubernetes Secrets | Namespace-scoped | Gateway token, API keys |
| Config | ConfigMap | Namespace-scoped | Gateway JSON config |
| Container image | Container registry or local | Rebuilt on update | All binaries baked in |

---

## Teardown

```bash
./k8s/setup.sh --delete
```

This deletes the namespace and all resources in it (including PVCs).

---

## Architecture notes

- The Gateway binds to `loopback` (127.0.0.1:18789) inside the pod — it is not directly exposed
- No cluster-scoped resources are required — everything deploys within a single namespace
- Auth uses token-based authentication
- The init container uses `busybox:latest` to set up config directory permissions
- PVC permissions are handled via `fsGroup: 1000` in the pod security context
- `dangerouslyDisableDeviceAuth` is set to `true` because the Control UI is accessed via plain HTTP through `kubectl port-forward`. Device auth uses the browser's SubtleCrypto API to sign WebSocket handshakes (MitM protection), which requires a secure context (HTTPS). Since the gateway binds to loopback only and port-forward traffic never leaves the kubectl tunnel, there is no network exposure to intercept. If you expose the gateway over HTTPS (e.g. via Ingress with TLS), you can remove this flag to enable device auth

---

## Related

- [Docker](/install/docker) — containerized gateway without Kubernetes
- [Hetzner](/install/hetzner) — Docker on a VPS
- [Gateway configuration](/gateway/configuration) — full config reference
