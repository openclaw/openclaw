---
summary: "Run OpenClaw in an islo.dev sandbox with one command"
read_when:
  - Setting up OpenClaw in an isolated cloud sandbox
  - Running OpenClaw with islo.dev for secure AI agent development
title: "islo.dev"
---

# islo.dev

Goal: OpenClaw running inside an [islo.dev](https://islo.dev) sandbox — an isolated cloud VM with full toolchain access, one command to launch.

## Quick Start

```bash
islo use my-sandbox --agent openclaw --task "Build a REST API with Express"
```

That's it. islo automatically:

1. Creates a sandbox VM (Kata Container on bare-metal)
2. Installs Node.js and OpenClaw via [mise](https://mise.jdx.dev)
3. Launches `openclaw agent --message "..." --local --thinking high`

## What you need

- [islo CLI](https://docs.islo.dev) installed and logged in (`islo login`)
- Anthropic API key — via [islo.dev integrations](https://app.islo.dev/settings/integrations) (recommended) or `--env`

## Interactive Mode

Drop into OpenClaw's interactive agent without a task:

```bash
islo use my-sandbox --agent openclaw
```

## With a Source Repo

Clone a GitHub repo into the sandbox and let OpenClaw work on it:

```bash
islo use my-sandbox \
  --source "github://myorg/myrepo" \
  --agent openclaw \
  --workdir myrepo \
  --task "Fix the failing tests in src/auth.ts"
```

## Environment Variables

Pass API keys and config explicitly:

```bash
islo use my-sandbox \
  --agent openclaw \
  --env ANTHROPIC_API_KEY=sk-ant-... \
  --task "Your task"
```

Or configure via [islo.dev integrations](https://app.islo.dev/settings/integrations) — keys are injected automatically into every sandbox.

## Configuration via `islo.yaml`

Pin versions or add dependencies in your project's `islo.yaml`:

```yaml
tools:
  openclaw: "latest"
  node: "22.14"
```

OpenClaw requires Node 22.14+. islo installs it automatically as a dependency.

## How it works

islo.dev sandboxes are hardware-isolated VMs (Kata Containers) with:

- Full root access and toolchain (git, gh CLI, docker, etc.)
- Network isolation via nftables + Envoy transparent proxy
- GitHub integration for cloning repos and opening PRs
- Agent-aware lifecycle — sandbox stays alive while the agent runs

When you pass `--agent openclaw`, islo:

1. Installs `node` (dependency) and `openclaw` (via npm)
2. Injects configured API keys as environment variables
3. Runs `openclaw agent --message "<task>" --local --thinking high`
4. Streams agent output to your terminal

## Multi-repo workflows

Work across multiple repos in a single sandbox:

```bash
islo use my-sandbox \
  --source "github://myorg/frontend" \
  --source "github://myorg/backend" \
  --agent openclaw \
  --task "Update the API client in frontend to match the new backend endpoints"
```

## Updating

OpenClaw is installed fresh in each new sandbox. Existing sandboxes can be updated:

```bash
islo exec my-sandbox -- npm i -g openclaw@latest
```

## Cleanup

```bash
islo rm my-sandbox -f
```

Guide: [Updating](/install/updating)
