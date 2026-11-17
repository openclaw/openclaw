---
summary: "GBrain: connect OpenClaw to a GBrain brain over MCP, with GBrain running as its own service"
read_when:
  - You want OpenClaw agents to use a GBrain brain
  - You are choosing between GBrain and the bundled Knowledge plugin
  - You run OpenClaw in Docker and want GBrain next to it
  - GBrain shows as blocked in the Control UI and you need the next step
title: "GBrain"
---

The `gbrain` plugin connects OpenClaw to [GBrain](https://github.com/garrytan/gbrain).
After you install it, OpenClaw has a `gbrain` MCP server that every agent run can use:
chat turns, cron jobs, heartbeats and subagents. You do not edit config by hand.

GBrain runs as its own service, which GBrain installs and supervises. OpenClaw never
starts or restarts it: it runs GBrain's own commands once for first-time setup, then
only connects and reports.

## What install does

On the first Gateway start after install, the plugin:

1. Uses the `gbrain` command when it is installed. When it is missing and Bun is
   installed, it runs GBrain's installer: `bun install -g github:garrytan/gbrain#stable`.
2. Starts GBrain's service with `gbrain mcp expose --no-tailscale --yes`. GBrain
   installs a launchd agent (`com.gbrain.serve`) on macOS or a systemd user unit
   (`gbrain-serve.service`) on Linux, on `127.0.0.1:3131`. When no brain exists yet,
   the plugin first runs `gbrain init --pglite --no-embedding` (a local brain with
   keyword search; see GBrain's docs to add embeddings).
3. Creates an OpenClaw key through the running server's owner API (read and write).
4. Writes `mcp.servers.gbrain` (streamable HTTP with that key). The Gateway applies it
   without a restart.

An existing GBrain service on the same machine is reused as it is. An
`mcp.servers.gbrain` entry that points somewhere else, or that uses an
environment template such as `${GBRAIN_MCP_TOKEN}`, is left as you configured it.
When the plugin replaces its key or follows a port change, it updates only the URL,
transport and `Authorization` header; your other settings on the entry stay.

Agents find GBrain's tools through tool search when a turn needs them. To make agents
check GBrain on every turn, run GBrain's own `gbrain setup openclaw`; it adds a
per-turn rule plugin. It is optional, and it adds a brain search to every turn.

## Docker

The OpenClaw image has no Bun and no service manager, so GBrain runs in its own
container next to the Gateway. Add the overlay when you start Compose:

```bash
docker compose -f docker-compose.yml -f deploy/gbrain/compose.yaml up -d
```

Compose builds a small image on first start (Bun plus `git`, which `gbrain upgrade`
uses). The `gbrain` service installs GBrain's stable release into a volume, creates the
brain, runs `gbrain mcp expose --no-tailscale --yes` for its owner credential, and
then runs `gbrain serve --http` as the container's main process. Compose restarts it.
In a container the plugin looks for GBrain at `127.0.0.1` and then at the `gbrain`
Compose service on the project network, so Gateway and GBrain restarts do not affect
each other. Nothing is published on the host. The Gateway mounts GBrain's data
read-only to create its key; it never opens the brain.

## Status and recovery

The plugin rechecks every minute and reports problems as plugin health in the Control
UI and in `openclaw plugins inspect gbrain --runtime --json`.

| You see                                                       | Cause                                                                                    | What to do                                                                                                                 |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| GBrain needs Bun 1.4.4 or newer                               | `gbrain` and `bun` are both missing                                                      | Install Bun (`curl -fsSL https://bun.sh/install \| bash`; on Linux it also needs `unzip`). Setup finishes within a minute. |
| GBrain is not running next to this container                  | Docker without the overlay                                                               | Start Compose with `deploy/gbrain/compose.yaml`.                                                                           |
| GBrain's service is not answering                             | The service stopped or crashed                                                           | `gbrain mcp expose --status`; GBrain's supervisor restarts it.                                                             |
| Another program answers on 127.0.0.1:3131                     | Port taken                                                                               | Free the port, or `gbrain mcp expose --no-tailscale --yes --port <port>`; the plugin follows GBrain's receipt.             |
| The gbrain memory server is running but cannot open its brain | Another `gbrain serve` (for example a stdio entry in another app) holds the PGLite brain | Stop that process. GBrain rechecks every 5 seconds.                                                                        |

A revoked or rotated OpenClaw key is replaced automatically within a minute.
`gbrain upgrade` needs no OpenClaw change.

## Uninstall

`openclaw plugins uninstall gbrain` removes the plugin. It does not stop GBrain's
service or touch the brain. The `mcp.servers.gbrain` entry stays, so agents keep the
brain; remove it with `openclaw mcp unset gbrain`. Remove GBrain's service with
`gbrain mcp expose --remove`.

## GBrain and Knowledge

[Knowledge](/plugins/knowledge) is a memory provider: it owns `plugins.slots.memory`.
The GBrain plugin owns no slot. It adds an MCP server, so you can use both: Knowledge
for OpenClaw's own memory prompt and recall, GBrain as a tool the agent calls.
