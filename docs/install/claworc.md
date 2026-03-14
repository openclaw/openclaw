---
summary: "Claworc: Docker/Kubernetes orchestrator for running multiple OpenClaw agents from a single dashboard"
read_when:
  - You want to run many OpenClaw agents at once (team or fleet deployment)
  - You need isolated workspaces per agent with browser, terminal, and persistent storage
  - You are deploying via Docker or Kubernetes/Helm
title: "Claworc"
---

# Claworc

[Claworc](https://claworc.com) is an orchestrator for running multiple OpenClaw AI agents from a single dashboard. Each agent runs in an isolated workspace with its own Chrome browser, terminal, and persistent storage. Claworc is designed for teams, fleet deployments, and scenarios where you need to manage, monitor, and scale many agents without manual per-machine setup.

## When to use Claworc

- Managing several agents across a team or organization
- Giving different users access to their own assigned agent instances
- Remote monitoring and control from a central dashboard
- Deploying to Docker or Kubernetes without hand-rolling per-agent configuration
- Needing agents that auto-restart on failure via systemd monitoring

## Quick install

<Warning>
Claworc is a third-party tool not maintained by OpenClaw. Review the install script before running it.
</Warning>

```bash
curl -fsSL https://claworc.com/install.sh | bash
```

## Deployment options

<CardGroup cols={2}>
  <Card title="Docker" icon="container">
    Run agents as Docker containers on any host. Ideal for single-server or small-team setups — pull the image, configure your agents, and start the dashboard.
  </Card>
  <Card title="Kubernetes / Helm" icon="server">
    Deploy at scale with the official Helm chart. Each agent pod gets its own isolated workspace; Kubernetes handles scheduling, restarts, and resource limits.
  </Card>
</CardGroup>

## How it works

Each Claworc instance is a self-contained workspace:

- **Browser** — a dedicated Chrome instance for the agent
- **Terminal** — a persistent shell environment
- **Storage** — per-agent persistent volume so state survives restarts
- **Monitoring** — systemd tracks each agent process and auto-restarts on failure

The dashboard lets you view logs, start/stop instances, and manage configuration across all your agents from one place.

## Access and authentication

Claworc uses role-based access control:

- **Admins** can see and manage all agent instances
- **Users** see only the instances assigned to them

Biometric authentication is supported for dashboard login on compatible devices.

## Full documentation

See [https://claworc.com/docs](https://claworc.com/docs) for configuration reference, Helm values, and advanced deployment guides.
