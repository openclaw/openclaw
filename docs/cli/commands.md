---
summary: "Generated reference for OpenClaw command inventory and effect metadata"
read_when:
  - Looking up available top-level OpenClaw commands
  - Reviewing command effect or provenance metadata
title: "Command inventory"
---

# Command inventory

This page is generated from OpenClaw's static command descriptors. Do not edit it by hand.
Regenerate it with `pnpm docs:commands:gen`; CI verifies freshness with
`pnpm docs:commands:check`.

Use [`openclaw commands list`](/cli/index#command-inventory) for the current
invocation's runtime tree and opt-in plugin descriptors. Runtime plugin, paired-node,
and external-provider state is deployment-specific and is not checked into this page.

An **Unknown** effect means the owning command descriptor has not classified the
command. It does not mean read-only, low risk, or confirmation-free.

Generated entries: 63.

| Command          | Description                                                                                                         | Effect                                    | Source   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------- |
| `setup`          | Chat with OpenClaw; onboard when setup is incomplete                                                                | Unknown                                   | `core`   |
| `onboard`        | Guided setup for auth, models, Gateway, workspace, channels, and skills                                             | Unknown                                   | `core`   |
| `configure`      | Interactive configuration for credentials, channels, gateway, and agent defaults                                    | Unknown                                   | `core`   |
| `config`         | Non-interactive config helpers (get/set/patch/unset/file/schema/validate). Run without subcommand for guided setup. | Unknown                                   | `core`   |
| `backup`         | Create and verify backup archives and SQLite snapshots                                                              | Unknown                                   | `core`   |
| `migrate`        | Import state from another agent system                                                                              | Unknown                                   | `core`   |
| `doctor`         | Health checks + quick fixes for the gateway and channels                                                            | Unknown                                   | `core`   |
| `dashboard`      | Open the Control UI with your current token                                                                         | Unknown                                   | `core`   |
| `reset`          | Reset local config/state (keeps the CLI installed)                                                                  | Unknown                                   | `core`   |
| `uninstall`      | Uninstall the gateway service + local data (CLI remains)                                                            | Unknown                                   | `core`   |
| `message`        | Send, read, and manage messages and channel actions                                                                 | Unknown                                   | `core`   |
| `mcp`            | Manage OpenClaw mcp.servers config and channel bridge                                                               | Unknown                                   | `core`   |
| `transcripts`    | Inspect stored transcripts                                                                                          | Unknown                                   | `core`   |
| `agent`          | Run an agent turn via the Gateway (use --local for embedded)                                                        | Unknown                                   | `core`   |
| `agents`         | Manage isolated agents (workspaces + auth + routing)                                                                | Unknown                                   | `core`   |
| `status`         | Show channel health and recent session recipients                                                                   | Unknown                                   | `core`   |
| `health`         | Fetch health from the running gateway                                                                               | Unknown                                   | `core`   |
| `audit`          | Inspect metadata-only run, tool, and message lifecycle records                                                      | Unknown                                   | `core`   |
| `sessions`       | List stored conversation sessions                                                                                   | Unknown                                   | `core`   |
| `commitments`    | List and manage inferred follow-up commitments                                                                      | Unknown                                   | `core`   |
| `tasks`          | Inspect durable background tasks and TaskFlow state                                                                 | Unknown                                   | `core`   |
| `acp`            | Run an ACP bridge backed by the Gateway                                                                             | Unknown                                   | `subcli` |
| `gateway`        | Run, inspect, and query the WebSocket Gateway                                                                       | mixed; medium risk; confirmation required | `subcli` |
| `daemon`         | Manage the Gateway service (launchd/systemd/schtasks)                                                               | Unknown                                   | `subcli` |
| `logs`           | Tail gateway file logs via RPC                                                                                      | Unknown                                   | `subcli` |
| `system`         | System tools (events, heartbeat, presence)                                                                          | Unknown                                   | `subcli` |
| `models`         | Model discovery, scanning, and configuration                                                                        | Unknown                                   | `subcli` |
| `promos`         | Discover and claim promotional model offers from ClawHub                                                            | Unknown                                   | `subcli` |
| `commands`       | List and inspect OpenClaw commands                                                                                  | Unknown                                   | `subcli` |
| `infer`          | Run provider-backed inference commands through a stable CLI surface                                                 | Unknown                                   | `subcli` |
| `capability`     | Run provider capability commands (fallback alias: infer)                                                            | Unknown                                   | `subcli` |
| `approvals`      | Manage approval policy and pending requests                                                                         | Unknown                                   | `subcli` |
| `exec-approvals` | Manage exec approvals (alias for approvals)                                                                         | Unknown                                   | `subcli` |
| `exec-policy`    | Show or synchronize requested exec policy with host approvals                                                       | Unknown                                   | `subcli` |
| `nodes`          | Manage gateway-owned nodes (pairing, status, invoke, and media)                                                     | Unknown                                   | `subcli` |
| `devices`        | Device pairing and auth tokens                                                                                      | Unknown                                   | `subcli` |
| `users`          | Manage durable user profiles and email aliases                                                                      | Unknown                                   | `subcli` |
| `node`           | Run and manage the headless node host service                                                                       | Unknown                                   | `subcli` |
| `worker`         | Run the restricted cloud worker runtime                                                                             | Unknown                                   | `subcli` |
| `sandbox`        | Manage sandbox containers (Docker-based agent isolation)                                                            | Unknown                                   | `subcli` |
| `fleet`          | Provision and manage isolated tenant cells (experimental)                                                           | Unknown                                   | `subcli` |
| `worktrees`      | Create, inspect, restore, and clean up managed worktrees                                                            | Unknown                                   | `subcli` |
| `attach`         | Attach Claude Code to a gateway session with scoped MCP tools                                                       | Unknown                                   | `subcli` |
| `tui`            | Open a terminal UI connected to the Gateway                                                                         | Unknown                                   | `subcli` |
| `terminal`       | Open a local terminal UI (alias for tui --local)                                                                    | Unknown                                   | `subcli` |
| `chat`           | Open a local terminal UI (alias for tui --local)                                                                    | Unknown                                   | `subcli` |
| `cron`           | Manage cron jobs (via Gateway)                                                                                      | Unknown                                   | `subcli` |
| `dns`            | DNS helpers for wide-area discovery (Tailscale + CoreDNS)                                                           | Unknown                                   | `subcli` |
| `docs`           | Search the live OpenClaw docs                                                                                       | Unknown                                   | `subcli` |
| `proxy`          | Run the OpenClaw debug proxy and inspect captured traffic                                                           | Unknown                                   | `subcli` |
| `hooks`          | Manage internal agent hooks                                                                                         | Unknown                                   | `subcli` |
| `webhooks`       | Webhook helpers and integrations                                                                                    | Unknown                                   | `subcli` |
| `qr`             | Generate a mobile pairing QR code and setup code                                                                    | Unknown                                   | `subcli` |
| `clawbot`        | Legacy clawbot command aliases                                                                                      | Unknown                                   | `subcli` |
| `pairing`        | Secure DM pairing (approve inbound requests)                                                                        | Unknown                                   | `subcli` |
| `plugins`        | Manage OpenClaw plugins and extensions                                                                              | Unknown                                   | `subcli` |
| `channels`       | Manage connected chat channels and accounts                                                                         | Unknown                                   | `subcli` |
| `directory`      | Lookup contact and group IDs (self, peers, groups) for supported chat channels                                      | Unknown                                   | `subcli` |
| `security`       | Audit local config and state for common security foot-guns                                                          | Unknown                                   | `subcli` |
| `secrets`        | Secrets runtime controls                                                                                            | Unknown                                   | `subcli` |
| `skills`         | List and inspect available skills                                                                                   | Unknown                                   | `subcli` |
| `update`         | Update OpenClaw and inspect update channel status                                                                   | Unknown                                   | `subcli` |
| `completion`     | Generate shell completion script                                                                                    | Unknown                                   | `subcli` |
