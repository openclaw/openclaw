# OpenClaw Agent Cluster on k3s

This deploys the **OpenClaw gateway** plus a **collaborative multi-agent configuration** in local `k3s`/`k3d`.

Agents created:

- `main` (default) – simple agent for quick smoke tests
- `orchestrator` – spawns researcher, builder, reviewer for collaboration
- `researcher`
- `builder`
- `reviewer`

Collaboration settings:

- `tools.agentToAgent.enabled=true`
- `tools.agentToAgent.allow=[main,orchestrator,researcher,builder,reviewer]`
- `orchestrator.subagents.allowAgents=[researcher,builder,reviewer]`

Gateway bind behavior in this setup:

- Config uses `gateway.bind=loopback` so in-pod tool RPC (including `sessions_spawn`) resolves to `ws://127.0.0.1:18789` and avoids pairing-required failures.
- Runtime still starts with `--bind lan` so the Kubernetes Service can expose the gateway externally.

## Prerequisites

- Docker
- `kubectl` connected to your local `k3s` or `k3d` cluster
- At least one model provider key (for example `OPENAI_API_KEY`)

Important:

- This setup expects a `k3s`/`k3d`/`docker-desktop` runtime so it can import a local image with `imagePullPolicy: Never`.
- Docker Desktop: the script detects worker nodes (`desktop-worker*`) and imports the image into each node's containerd.

## Deploy

From repo root:

```bash
export OPENAI_API_KEY="<your-key>"
export OPENCLAW_GATEWAY_TOKEN="<shared-token>" # optional; auto-generated if omitted

./scripts/k8s/openclaw-agent-cluster/k3s-up.sh \
  --model "openai/gpt-5.2" \
  --smoke
```

## Connect

```bash
kubectl -n openclaw-agents port-forward svc/openclaw-gateway 18789:18789
```

Then point your local OpenClaw CLI/client at `ws://127.0.0.1:18789` using the same token.

## Trigger collaboration manually

Quick smoke test:

```bash
kubectl -n openclaw-agents exec openclaw-gateway-0 -- \
  node dist/index.js agent --local --agent main --message "reply with OK"
```

Full collaboration:

```bash
kubectl -n openclaw-agents exec openclaw-gateway-0 -- \
  node dist/index.js agent --local --agent orchestrator --message "Plan a k3s reliability hardening pass. Use researcher, builder, and reviewer via sessions_spawn, then summarize."
```

Why `--local`:

- In this cluster config, gateway calls from the pod can require device pairing (`1008 pairing required`).
- `--local` runs the agent runtime in-process in the same pod and avoids that pairing path.

## Teardown

```bash
./scripts/k8s/openclaw-agent-cluster/k3s-down.sh
```
