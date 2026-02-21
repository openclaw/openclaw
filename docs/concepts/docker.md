---
summary: "Automated Docker management: installation, startup, and cross-platform support"
read_when:
  - You are using Docker-dependent features (Sandboxes, Mind Memory)
  - You want to understand how Moltbot auto-starts Docker Desktop
---

# Docker Management

Moltbot uses **Docker** for several advanced features that require isolated or specialized environments:
- **[Sandboxes](/agents/sandbox)**: For safe execution of untrusted code.
- **[Mind Memory](/plugins/mind-memory)**: For running the Graphiti knowledge graph.

To make the setup as seamless as possible, Moltbot includes an **automated Docker management system**.

## Cross-Platform Automation

Moltbot can automatically manage the Docker lifecycle across macOS, Windows, and Linux.

### 1. Auto-Installation
If the `docker` command is missing, several Moltbot components (like the Mind Memory plugin) offer an automated installation path:
- **macOS**: Uses [Homebrew](https://brew.sh) (`brew install --cask docker`).
- **Windows**: Uses the native [winget](https://learn.microsoft.com/en-us/windows/package-manager/winget/) tool (`winget install Docker.DockerDesktop`).
- **Linux**: Uses `apt-get` (`sudo apt-get install docker.io`).

### 2. Auto-Start (Cold Boot)
Even if Docker is installed, the background daemon or the "Docker Desktop" application might be closed. Moltbot will attempt to launch it automatically when it's needed:
- **macOS**: Executes `open -a Docker`.
- **Windows**: Launches `Docker Desktop.exe` from its standard installation path.
- **Linux**: Starts the service via `systemctl start docker`.

## Shared Infrastructure

This logic is centralized in the core Moltbot infrastructure (`src/infra/docker.ts`), ensuring that all systems (Sandbox, Plugins, etc.) benefit from the same robust management.

### Features
- **Retries & Timeouts**: Moltbot waits up to 60 seconds for the Docker daemon to become fully ready after a launch attempt.
- **Health Checks**: Uses `docker info` to verify the connection to the Docker socket.
- **Transparent Logging**: You will see status updates in the console (e.g., `🐳 [DOCKER] Daemon not running. Attempting to start Docker...`).

## Manual Setup

If the automated system fails or if you prefer manual control, you can always install Docker Desktop from the [official website](https://www.docker.com/products/docker-desktop).

Once installed, ensure that:
1. The Docker daemon is running.
2. Your user has permission to access the Docker socket (on Linux, this typically means being in the `docker` group).
