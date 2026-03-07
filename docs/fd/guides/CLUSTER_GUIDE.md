# Cluster Guide

## What is the Cluster?

The cluster is the infrastructure that keeps OpenClaw running. It's your own
hardware — not cloud services you're renting. Two machines, shared storage,
and local AI inference.

## Your nodes

| Node | Role | Key services |
|------|------|-------------|
| **M1 Mac Studio** | AI primary | Ollama (Qwen 3.5), local inference |
| **M4** | Gateway + fallback | OpenClaw Gateway, Ollama fallback |

## Shared storage

Both nodes share a workspace so files, configs, and data stay in sync.
You don't need to copy files between machines.

## What can you do here?

- **Check node status** — are both machines online and healthy
- **View service health** — which services are running, which aren't
- **Inspect shared storage** — is the workspace accessible
- **Run health checks** — full diagnostic across all nodes
- **Trigger failover** — switch AI from M1 to M4 if M1 is down
- **Warm AI models** — pre-load models so inference is fast

## Common prompts

Try asking OpenClaw:

- "Check cluster health."
- "Are all nodes online?"
- "Warm the AI models."
- "Run a full health check."
- "Is shared storage healthy?"

## What requires approval?

- Restarting services
- Triggering failover
- Modifying cluster config

Health checks are read-only and never need approval.

## How to check cluster health

1. Open the Command Center
2. Look at the System Health widget for a quick status
3. For a deeper check, ask: "Run a full health check"
4. Review node status, service health, and shared storage
5. If any node is degraded, OpenClaw suggests next steps

## How failover works

1. OpenClaw detects M1 is unresponsive
2. It alerts you and suggests failover to M4
3. You approve the failover
4. AI inference switches to M4 (backup hardware)
5. When M1 comes back, you can switch back

You can also run `make failover` from the command line.
