---
summary: "Development container setup for contributing to OpenClaw on any OS"
read_when:
  - You want a portable dev environment for OpenClaw
  - You are developing on Windows and need Linux tooling
  - You want pre-configured GitHub, Copilot, and Claude CLI tools
title: "Dev Container"
---

# Dev Container

A [dev container](https://containers.dev/) provides a full Linux development
environment for OpenClaw that works on any host OS. The setup includes Node 22,
pnpm, GitHub CLI, Copilot CLI, and Claude CLI out of the box.

The configuration works with both **Docker** and **Podman** as the container
runtime.

## Prerequisites

- [VS Code](https://code.visualstudio.com/) with the
  [Dev Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
  extension, or another dev container client
- **Docker Desktop** or **Podman** installed on your host

### Using Podman instead of Docker

If you prefer Podman, tell VS Code to use it as the container engine:

```json
// settings.json
{
  "dev.containers.dockerPath": "podman"
}
```

On Linux you may also need to start the Podman socket:

```bash
systemctl --user enable --now podman.socket
```

## Quick start

1. Clone the repo and open it in VS Code:

   ```bash
   git clone https://github.com/openclaw/openclaw.git
   cd openclaw
   code .
   ```

2. When prompted, click **Reopen in Container** (or run the
   `Dev Containers: Reopen in Container` command).

3. The container builds, installs dependencies via `pnpm install`, and you are
   ready to develop.

## What is included

| Tool                          | Purpose                       |
| ----------------------------- | ----------------------------- |
| Node 22 (Debian bookworm)     | Runtime                       |
| pnpm (via corepack)           | Package manager               |
| GitHub CLI (`gh`)             | PR and issue workflows        |
| Copilot CLI (`copilot`)       | AI-assisted terminal commands |
| Claude CLI (`claude`)         | AI coding agent               |
| git, curl, jq, openssh-client | Standard dev utilities        |

## Authentication

The dev container supports two authentication strategies: **host passthrough**
(recommended) and **in-container login**.

### Host passthrough (recommended)

The container automatically mounts your host credentials so tools work without
extra login steps:

| Credential        | How it is passed                                            |
| ----------------- | ----------------------------------------------------------- |
| SSH keys          | `~/.ssh` is bind-mounted read-only into the container       |
| GitHub CLI        | `~/.config/gh` is bind-mounted read-only into the container |
| Anthropic API key | `ANTHROPIC_API_KEY` env var is forwarded from the host      |
| GitHub token      | `GH_TOKEN` env var is forwarded from the host               |

**Setup on your host before opening the container:**

```bash
# Authenticate GitHub CLI (creates ~/.config/gh/hosts.yml)
gh auth login

# Export your Anthropic API key (add to your shell profile)
export ANTHROPIC_API_KEY="sk-ant-..."

# Optionally export GH_TOKEN for Copilot CLI
export GH_TOKEN="ghp_..."
```

<Note>
  On Windows the mounts resolve `USERPROFILE` (typically `C:\Users\<name>`).
  Ensure your `~/.ssh` and `~/.config/gh` directories exist before opening the
  container.
</Note>

### In-container authentication (fallback)

If host passthrough is not available, authenticate directly inside the
container terminal:

```bash
# GitHub CLI
gh auth login

# Claude CLI
claude login

# Copilot CLI
copilot

# Git (if SSH keys are not mounted)
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

## Running tests

All tests run natively inside the container:

```bash
pnpm check          # lint + format
pnpm test           # full test suite
pnpm test <path>    # scoped test
pnpm build          # production build
```

## Customization

### Extra system packages

If you need additional apt packages, edit `.devcontainer/Dockerfile`:

```dockerfile
RUN apt-get update && \
    apt-get install -y --no-install-recommends your-package
```

Then rebuild the container (`Dev Containers: Rebuild Container`).

### VS Code extensions

Add extensions to the `customizations.vscode.extensions` array in
`.devcontainer/devcontainer.json`. The default set includes GitHub Copilot,
Copilot Chat, GitHub PR extension, and Oxc.

## Troubleshooting

### Mount errors on first open

If `~/.ssh` or `~/.config/gh` do not exist on your host, the container may fail
to start. Create the directories first:

```bash
mkdir -p ~/.ssh ~/.config/gh
```

### Podman rootless permission issues

If bind mounts fail with permission errors under Podman, ensure your user
namespaces are configured:

```bash
podman system migrate
```

### Rebuilding the container

After changing the Dockerfile or devcontainer.json, rebuild:

```
Dev Containers: Rebuild Container
```
