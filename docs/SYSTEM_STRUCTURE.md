# OpenClaw System Structure

This document provides a high-level overview of the OpenClaw architecture, package structure, and core logic flow.

## 1. Repository Overview

OpenClaw is a monorepo containing the core TypeScript runtime, mobile/desktop client applications, and extension packages.

### Root Directories
- **`src/`**: The core OpenClaw TypeScript runtime (CLI, Gateway, Daemon, Agents).
- **`apps/`**: Client applications.
  - `android/`: Native Android wrapper.
  - `ios/`: Native iOS wrapper.
  - `macos/`: Native macOS status bar app.
  - `shared/`: Shared code for mobile/desktop apps.
- **`packages/`**: Monorepo packages (workspaces).
  - `clawdbot/`: Specialized bot implementation.
  - `moltbot/`: Another bot variant.
- **`extensions/`**: Plugin directory (channel adapters, integrations).
- **`docs/`**: Documentation (Mintlify source).

## 2. Core Runtime (`src/`)

The core logic resides in `src/` and is distributed as the `openclaw` npm package.

### Entry Points
- **`openclaw.mjs`**: The CLI binary entry point.
- **`src/entry.ts`**: Main bootstrap logic. Handles environment normalization, experimental warning suppression, and process respawning before handing off to the CLI router.
- **`src/cli/run-main.ts`**: CLI router. Determines which subcommand to execute (`gateway`, `agent`, `config`, etc.) and loads the appropriate module.

### Key Modules
- **`src/cli/`**: Command-line interface definitions and routing.
- **`src/gateway/`**: The "Daemon" or "Gateway" service. This is the always-on process that manages connections, plugins, and HTTP API.
- **`src/agents/`**: Core agent logic, built on the Pi Agent Framework.
- **`src/channels/`**: Base logic for messaging channels (WhatsApp, Discord, Slack, etc.).
- **`src/plugins/`**: Plugin system loader and SDK (`src/plugin-sdk/`).
- **`src/infra/`**: Low-level infrastructure (Environment, Logging, Error handling).
- **`src/process/`**: Process management (child processes, signals).

## 3. Architecture Concepts

### The Gateway
The Gateway (`openclaw gateway` / `openclaw daemon`) is the central nervous system. It:
1.  **Hosts Channels**: Connects to messaging platforms (WhatsApp, Telegram, etc.).
2.  **Exposes API**: Provides a local HTTP/WebSocket API for clients and agents.
3.  **Manages State**: Handles sessions, device pairing, and configuration.

### The Agent
OpenClaw agents run as processes (often spawned by the Gateway or CLI). They use the **Agent Control Protocol (ACP)** to communicate.
- **Framework**: Built on `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai`.
- **Logic**: Agents consume prompts (`AGENTS.md`, `SOUL.md`), utilize tools (defined in `SKILL.md` or code), and interact with the world via the Gateway.

### Apps (Clients)
The apps in `apps/` are primarily **Control Interfaces**. They connect to a running Gateway (local or remote) to:
- Configure the system.
- View logs/status.
- Manage pairings.
- Provide a UI for the "Canvas" or other rich interactions.

## 4. CLI Capabilities

OpenClaw CLI is divided into subcommands (Capabilities):

| Command | Description |
| :--- | :--- |
| `gateway` | Starts the main Gateway/Daemon service. |
| `agent` | Runs an agent session (RPC or interactive). |
| `acp` | Agent Control Protocol tools. |
| `tui` | Terminal User Interface for monitoring/control. |
| `channels` | Manage active messaging channels. |
| `plugins` | Install/manage extensions. |
| `pairing` | Handle device pairing flows. |
| `nodes` | Manage paired nodes (distributed agents). |
| `config` | Read/Write configuration. |
| `doctor` | System health check and diagnostics. |

## 5. Technology Stack

- **Runtime**: Node.js (v22+)
- **Languages**: TypeScript (Core), Swift (iOS/macOS), Kotlin (Android).
- **Package Manager**: `pnpm`
- **Testing**: `vitest`
- **Documentation**: Mintlify (`docs/`)
- **Linting/Formatting**: `oxlint`, `oxfmt`

