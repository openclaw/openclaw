---
summary: "ClawDock shell helpers for Docker-based Mullusi installs"
read_when:
  - You run Mullusi with Docker often and want shorter day-to-day commands
  - You want a helper layer for dashboard, logs, token setup, and pairing flows
title: "ClawDock"
---

# ClawDock

ClawDock is a small shell-helper layer for Docker-based Mullusi installs.

It gives you short commands like `mullusiock-start`, `mullusiock-dashboard`, and `mullusiock-fix-token` instead of longer `docker compose ...` invocations.

If you have not set up Docker yet, start with [Docker](/install/docker).

## Install

Use the canonical helper path:

```bash
mkdir -p ~/.mullusiock && curl -sL https://raw.githubusercontent.com/mullusi/mullusi/main/scripts/mullusiock/mullusiock-helpers.sh -o ~/.mullusiock/mullusiock-helpers.sh
echo 'source ~/.mullusiock/mullusiock-helpers.sh' >> ~/.zshrc && source ~/.zshrc
```

If you previously installed ClawDock from `scripts/shell-helpers/mullusiock-helpers.sh`, reinstall from the new `scripts/mullusiock/mullusiock-helpers.sh` path. The old raw GitHub path was removed.

## What you get

### Basic operations

| Command            | Description            |
| ------------------ | ---------------------- |
| `mullusiock-start`   | Start the gateway      |
| `mullusiock-stop`    | Stop the gateway       |
| `mullusiock-restart` | Restart the gateway    |
| `mullusiock-status`  | Check container status |
| `mullusiock-logs`    | Follow gateway logs    |

### Container access

| Command                   | Description                                   |
| ------------------------- | --------------------------------------------- |
| `mullusiock-shell`          | Open a shell inside the gateway container     |
| `mullusiock-cli <command>`  | Run Mullusi CLI commands in Docker           |
| `mullusiock-exec <command>` | Execute an arbitrary command in the container |

### Web UI and pairing

| Command                 | Description                  |
| ----------------------- | ---------------------------- |
| `mullusiock-dashboard`    | Open the Control UI URL      |
| `mullusiock-devices`      | List pending device pairings |
| `mullusiock-approve <id>` | Approve a pairing request    |

### Setup and maintenance

| Command              | Description                                      |
| -------------------- | ------------------------------------------------ |
| `mullusiock-fix-token` | Configure the gateway token inside the container |
| `mullusiock-update`    | Pull, rebuild, and restart                       |
| `mullusiock-rebuild`   | Rebuild the Docker image only                    |
| `mullusiock-clean`     | Remove containers and volumes                    |

### Utilities

| Command                | Description                             |
| ---------------------- | --------------------------------------- |
| `mullusiock-health`      | Run a gateway health check              |
| `mullusiock-token`       | Print the gateway token                 |
| `mullusiock-cd`          | Jump to the Mullusi project directory  |
| `mullusiock-config`      | Open `~/.mullusi`                      |
| `mullusiock-show-config` | Print config files with redacted values |
| `mullusiock-workspace`   | Open the workspace directory            |

## First-time flow

```bash
mullusiock-start
mullusiock-fix-token
mullusiock-dashboard
```

If the browser says pairing is required:

```bash
mullusiock-devices
mullusiock-approve <request-id>
```

## Config and secrets

ClawDock works with the same Docker config split described in [Docker](/install/docker):

- `<project>/.env` for Docker-specific values like image name, ports, and the gateway token
- `~/.mullusi/.env` for env-backed provider keys and bot tokens
- `~/.mullusi/agents/<agentId>/agent/auth-profiles.json` for stored provider OAuth/API-key auth
- `~/.mullusi/mullusi.json` for behavior config

Use `mullusiock-show-config` when you want to inspect the `.env` files and `mullusi.json` quickly. It redacts `.env` values in its printed output.

## Related pages

- [Docker](/install/docker)
- [Docker VM Runtime](/install/docker-vm-runtime)
- [Updating](/install/updating)
