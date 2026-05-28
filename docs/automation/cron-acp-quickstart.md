---
summary: "Install OpenClaw from source and run isolated cron jobs through acpx (Cursor / Codex / Claude)"
read_when:
  - Setting up acpTurn cron jobs on a source checkout or fork
  - Debugging cron manual runs that should use cursor-agent instead of embedded models
title: "Cron + ACP quickstart"
sidebarTitle: "Cron + ACP quickstart"
---

This guide covers **isolated cron jobs** with `payload.kind: "acpTurn"`. Each run starts a **oneshot** ACP session via the **acpx** backend, sends one prompt, collects output, and closes the session. It does not reuse `/acp spawn` thread bindings.

For the full cron reference, see [Scheduled tasks](/automation/cron-jobs). For ACP harness setup, see [ACP agents — setup](/tools/acp-agents-setup).

## Prerequisites

- Node.js **22.19+**
- A working **acpx** plugin (`@openclaw/acpx` or the bundled workspace copy)
- The harness CLI you want (for example **Cursor**: `cursor-agent` on `PATH`)
- Gateway built from a checkout that includes `acpTurn` (this fork / branch)

## Install from source

### One-command upgrade (recommended)

```powershell
# Windows — clone/pull, build, ui:build, npm link, refresh gateway.cmd
irm https://raw.githubusercontent.com/lxf-lxf/openclaw/main/scripts/fork-upgrade.ps1 | iex

# With gateway restart
irm https://raw.githubusercontent.com/lxf-lxf/openclaw/main/scripts/fork-upgrade.ps1 | iex -RestartGateway
```

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/lxf-lxf/openclaw/main/scripts/fork-upgrade.sh | bash

# Custom directory + restart gateway
curl -fsSL https://raw.githubusercontent.com/lxf-lxf/openclaw/main/scripts/fork-upgrade.sh | bash -s -- \
  --install-dir ~/Projects/openclaw --restart-gateway
```

From an existing checkout:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/fork-upgrade.ps1 -RestartGateway
```

```bash
./scripts/fork-upgrade.sh --restart-gateway
```

### Manual steps

```bash
git clone https://github.com/lxf-lxf/openclaw.git
cd openclaw
pnpm install   # or npm install
pnpm run build # or npm run build
pnpm run ui:build # or npm run ui:build — required for Control UI at :18789
```

Point your Gateway launcher at this checkout (not an older global `openclaw` package):

```bash
node openclaw.mjs gateway --port 18789
```

On Windows, prefer a `gateway.cmd` that invokes `node …\openclaw.mjs gateway` from this repo. After code changes, **restart the Gateway** so cron validation and `acpTurn` execution load the new build.

Optional: link the CLI globally while developing:

```bash
npm link
openclaw --version
```

## Minimal `openclaw.json`

Enable ACP dispatch and the acpx plugin. Keep `plugins.entries.acpx.config` compatible with the installed `@openclaw/acpx` schema (avoid keys your plugin manifest does not list).

```json5
{
  acp: {
    enabled: true,
    backend: "acpx",
    dispatch: { enabled: true },
    defaultAgent: "cursor",
    allowedAgents: ["cursor", "codex", "claude"],
  },
  agents: {
    list: [
      {
        id: "cursor",
        runtime: {
          type: "acp",
          acp: {
            agent: "cursor",
            backend: "acpx",
            mode: "persistent",
            cwd: "~/.openclaw/workspace-cursor-acp",
          },
        },
      },
    ],
  },
  plugins: {
    allow: ["acpx", "memory-core"],
    entries: {
      acpx: {
        enabled: true,
        config: {
          permissionMode: "approve-all",
          nonInteractivePermissions: "deny",
          timeoutSeconds: 300,
        },
      },
    },
  },
}
```

If your install uses a **new** `@openclaw/acpx` manifest, you may also set `openClawToolsMcpBridge: true` under `plugins.entries.acpx.config` when you want ACP sessions to call OpenClaw cron/tools via MCP.

Add an agent with `runtime.type: "acp"` (see [ACP agents — setup](/tools/acp-agents-setup)). Cron uses `agentId` on the job to pick that agent.

## Create a job (CLI)

```bash
openclaw cron add \
  --name "ACP smoke test" \
  --every 24h \
  --session isolated \
  --acp \
  --agent cursor \
  --cwd "$HOME/.openclaw/workspace-cursor-acp" \
  --message "Reply with one line only: ACP cron OK" \
  --timeout-seconds 300
```

Equivalent payload in `~/.openclaw/cron/jobs.json`:

```json
{
  "sessionTarget": "isolated",
  "wakeMode": "now",
  "payload": {
    "kind": "acpTurn",
    "message": "Reply with one line only: ACP cron OK",
    "cwd": "/path/to/workspace",
    "timeoutSeconds": 300
  },
  "delivery": { "mode": "none" }
}
```

Optional payload fields: `harness`, `model`, `thinking` (see [ACP harness jobs](/automation/cron-jobs#acp-harness-jobs-acpturn)).

## Control UI

1. Build UI assets: `pnpm run ui:build` (or `npm run ui:build`).
2. Open `http://127.0.0.1:18789` and hard-refresh after Gateway restarts.
3. In **Cron**, add or edit a job: session target **isolated**, payload type **ACP turn**, set message and working directory.

## Verify

```bash
openclaw config validate
openclaw cron list
openclaw cron run <job-id> --url http://127.0.0.1:18789 --token <gateway-token>
```

A successful run should **not** show `payload.kind="agentTurn"` validation errors. Check Gateway logs for ACP/cron execution rather than embedded model runs.

## Troubleshooting

| Symptom | What to do |
| -------- | ----------- |
| `Control UI assets not found` | Run `pnpm run ui:build`, restart Gateway, hard-refresh the browser. |
| `isolated/... require payload.kind="agentTurn"` | Gateway is on an **old build**; rebuild, restart Gateway from this checkout. |
| `plugins.entries.*.config: additional properties` | Plugin JSON schema mismatch (often an old `openclaw` copy nested under another extension). Trim `plugins.entries` config to allowed keys or run `openclaw doctor --fix`. |
| `unknown cron job id` / skipped `acpTurn` | Another Gateway instance (global npm) is serving port 18789; stop it and start this checkout. |
| Manual run OK but no Cursor output | Confirm `cursor-agent` on `PATH`, `cwd` exists, and `plugins.entries.acpx` is enabled. |

## See also

- [Scheduled tasks — ACP harness jobs](/automation/cron-jobs#acp-harness-jobs-acpturn)
- [ACP agents — setup](/tools/acp-agents-setup)
- [acpx plugin reference](/plugins/reference/acpx)
