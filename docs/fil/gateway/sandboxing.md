---
summary: "Paano gumagana ang sandboxing ng OpenClaw: mga mode, saklaw, access sa workspace, at mga image"
title: Sandboxing
read_when: "Gusto mo ng dedikadong paliwanag ng sandboxing o kailangan mong i-tune ang agents.defaults.sandbox."
status: active
---

# Sandboxing

OpenClaw can run **tools inside Docker containers** to reduce blast radius.
This is **optional** and controlled by configuration (`agents.defaults.sandbox` or
`agents.list[].sandbox`). If sandboxing is off, tools run on the host.
The Gateway stays on the host; tool execution runs in an isolated sandbox
when enabled.

Hindi ito perpektong security boundary, ngunit malaki ang nababawas nito sa access sa filesystem
at mga process kapag may ginawang hindi tama ang model.

## Ano ang naka-sandbox

- Pagpapatakbo ng tool (`exec`, `read`, `write`, `edit`, `apply_patch`, `process`, atbp.).
- Opsyonal na sandboxed browser (`agents.defaults.sandbox.browser`).
  - By default, the sandbox browser auto-starts (ensures CDP is reachable) when the browser tool needs it.
    Configure via `agents.defaults.sandbox.browser.autoStart` and `agents.defaults.sandbox.browser.autoStartTimeoutMs`.
  - Pinapahintulutan ng `agents.defaults.sandbox.browser.allowHostControl` ang mga sandboxed session na tahasang i-target ang host browser.
  - Mga opsyonal na allowlist ang nagga-gate sa `target: "custom"`: `allowedControlUrls`, `allowedControlHosts`, `allowedControlPorts`.

Hindi naka-sandbox:

- Ang mismong Gateway process.
- Anumang tool na tahasang pinayagang tumakbo sa host (hal., `tools.elevated`).
  - **Ang elevated exec ay tumatakbo sa host at nilalampasan ang sandboxing.**
  - If sandboxing is off, `tools.elevated` does not change execution (already on host). Tingnan ang [Elevated Mode](/tools/elevated).

## Mga mode

Kinokontrol ng `agents.defaults.sandbox.mode` **kung kailan** ginagamit ang sandboxing:

- `"off"`: walang sandboxing.
- `"non-main"`: sandbox lang ang mga **non-main** session (default kung gusto mo ng normal na chats sa host).
- `"all"`: every session runs in a sandbox.
  Note: `"non-main"` is based on `session.mainKey` (default `"main"`), not agent id.
  Group/channel sessions use their own keys, so they count as non-main and will be sandboxed.

## Saklaw

Kinokontrol ng `agents.defaults.sandbox.scope` **kung ilang container** ang nililikha:

- `"session"` (default): isang container bawat session.
- `"agent"`: isang container bawat agent.
- `"shared"`: isang container na pinaghahatian ng lahat ng sandboxed session.

## Access sa workspace

Kinokontrol ng `agents.defaults.sandbox.workspaceAccess` **kung ano ang nakikita ng sandbox**:

- `"none"` (default): nakakakita ang mga tool ng sandbox workspace sa ilalim ng `~/.openclaw/sandboxes`.
- `"ro"`: mina-mount ang agent workspace bilang read-only sa `/agent` (dinidisable ang `write`/`edit`/`apply_patch`).
- `"rw"`: mina-mount ang agent workspace bilang read/write sa `/workspace`.

Inbound media is copied into the active sandbox workspace (`media/inbound/*`).
Skills note: the `read` tool is sandbox-rooted. With `workspaceAccess: "none"`,
OpenClaw mirrors eligible skills into the sandbox workspace (`.../skills`) so
they can be read. With `"rw"`, workspace skills are readable from
`/workspace/skills`.

## Mga custom bind mount

`agents.defaults.sandbox.docker.binds` mounts additional host directories into the container.
Format: `host:container:mode` (e.g., `"/home/user/source:/source:rw"`).

Global and per-agent binds are **merged** (not replaced). Under `scope: "shared"`, per-agent binds are ignored.

Halimbawa (read-only source + docker socket):

```json5
{
  agents: {
    defaults: {
      sandbox: {
        docker: {
          binds: ["/home/user/source:/source:ro", "/var/run/docker.sock:/var/run/docker.sock"],
        },
      },
    },
    list: [
      {
        id: "build",
        sandbox: {
          docker: {
            binds: ["/mnt/cache:/cache:rw"],
          },
        },
      },
    ],
  },
}
```

Mga tala sa seguridad:

- Nilalampasan ng mga bind ang sandbox filesystem: inilalantad nila ang mga host path ayon sa mode na itinakda mo (`:ro` o `:rw`).
- Ang mga sensitibong mount (hal., `docker.sock`, mga secret, SSH keys) ay dapat `:ro` maliban na lang kung talagang kailangan.
- Pagsamahin sa `workspaceAccess: "ro"` kung read access lang sa workspace ang kailangan; mananatiling independent ang mga bind mode.
- Tingnan ang [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) para sa kung paano nakikipag-ugnayan ang mga bind sa tool policy at elevated exec.

## Mga image + setup

Default na image: `openclaw-sandbox:bookworm-slim`

I-build ito nang isang beses:

```bash
scripts/sandbox-setup.sh
```

Note: the default image does **not** include Node. If a skill needs Node (or
other runtimes), either bake a custom image or install via
`sandbox.docker.setupCommand` (requires network egress + writable root +
root user).

Sandboxed browser image:

```bash
scripts/sandbox-browser-setup.sh
```

By default, sandbox containers run with **no network**.
Override with `agents.defaults.sandbox.docker.network`.

Narito ang mga Docker install at ang containerized gateway:
[Docker](/install/docker)

## setupCommand (one-time na setup ng container)

`setupCommand` runs **once** after the sandbox container is created (not on every run).
It executes inside the container via `sh -lc`.

Mga path:

- Global: `agents.defaults.sandbox.docker.setupCommand`
- Per-agent: `agents.list[].sandbox.docker.setupCommand`

Karaniwang pitfalls:

- Ang default na `docker.network` ay `"none"` (walang egress), kaya babagsak ang mga package install.
- Pinipigilan ng `readOnlyRoot: true` ang mga write; itakda ang `readOnlyRoot: false` o mag-bake ng custom image.
- Dapat root ang `user` para sa mga package install (alisin ang `user` o itakda ang `user: "0:0"`).
- Sandbox exec does **not** inherit host `process.env`. Use
  `agents.defaults.sandbox.docker.env` (or a custom image) for skill API keys.

## Tool policy + mga escape hatch

Tool allow/deny policies still apply before sandbox rules. If a tool is denied
globally or per-agent, sandboxing doesn’t bring it back.

`tools.elevated` is an explicit escape hatch that runs `exec` on the host.
`/exec` directives only apply for authorized senders and persist per session; to hard-disable
`exec`, use tool policy deny (see [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)).

Debugging:

- Gamitin ang `openclaw sandbox explain` para siyasatin ang epektibong sandbox mode, tool policy, at mga fix-it config key.
- See [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) for the “why is this blocked?” mental model.
  Keep it locked down.

## Mga override sa multi-agent

Each agent can override sandbox + tools:
`agents.list[].sandbox` and `agents.list[].tools` (plus `agents.list[].tools.sandbox.tools` for sandbox tool policy).
See [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) for precedence.

## Minimal na halimbawa ng pag-enable

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
      },
    },
  },
}
```

## Kaugnay na docs

- [Sandbox Configuration](/gateway/configuration#agentsdefaults-sandbox)
- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)
- [Security](/gateway/security)
