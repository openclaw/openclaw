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
pnpm, GitHub CLI, GitHub Copilot (gh extension), and Claude CLI out of the box.

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

3. The container builds, installs dependencies, and runs an auth check that
   reports what is ready and what needs attention.

## What is included

| Tool                          | Purpose                       |
| ----------------------------- | ----------------------------- |
| Node 22 (Debian bookworm)     | Runtime                       |
| pnpm (via corepack)           | Package manager               |
| GitHub CLI (`gh`)             | PR and issue workflows        |
| GitHub Copilot (`gh copilot`) | AI-assisted terminal commands |
| Claude CLI (`claude`)         | AI coding agent               |
| git, curl, jq, openssh-client | Standard dev utilities        |

## Authentication

The dev container uses **environment variable passthrough** for authentication.
No host directory mounts are needed, so the container starts reliably on any OS
without prerequisites.

The `on-create.sh` script runs automatically after the container is created. It
installs dependencies and checks authentication, auto-configuring git identity
from your GitHub account when possible.

### Host passthrough (recommended)

Set these environment variables on your host before opening the container:

| Credential         | Host env var        | How to set it                                              |
| ------------------ | ------------------- | ---------------------------------------------------------- |
| GitHub CLI         | `GH_TOKEN`          | `export GH_TOKEN="$(gh auth token)"`                       |
| Anthropic (Claude) | `ANTHROPIC_API_KEY` | `export ANTHROPIC_API_KEY="sk-ant-..."`                    |
| SSH keys           | Automatic           | VS Code forwards your ssh-agent automatically              |
| Git identity       | Automatic           | Auto-configured from your GitHub account via `gh api user` |

Add the exports to your shell profile (`.bashrc`, `.zshrc`, or PowerShell
`$PROFILE`) so they persist across sessions.

### In-container authentication (fallback)

If host env vars are not set, authenticate directly inside the container
terminal:

```bash
# GitHub CLI
gh auth login

# Claude CLI
claude login

# Git identity (if not auto-configured)
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
