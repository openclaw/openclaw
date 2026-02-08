---
summary: "Paano gumagana ang sandboxing ng OpenClaw: mga mode, saklaw, access sa workspace, at mga image"
title: Sandboxing
read_when: "Gusto mo ng dedikadong paliwanag ng sandboxing o kailangan mong i-tune ang agents.defaults.sandbox."
status: active
x-i18n:
  source_path: gateway/sandboxing.md
  source_hash: c1bb7fd4ac37ef73
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:45Z
---

# Sandboxing

Maaaring patakbuhin ng OpenClaw ang **mga tool sa loob ng Docker containers** para mabawasan ang blast radius.
Ito ay **opsyonal** at kontrolado ng configuration (`agents.defaults.sandbox` o
`agents.list[].sandbox`). Kapag naka-off ang sandboxing, tumatakbo ang mga tool sa host.
Nanatili ang Gateway sa host; ang pagpapatakbo ng tool ay nagaganap sa isang isolated sandbox
kapag naka-enable.

Hindi ito perpektong security boundary, ngunit malaki ang nababawas nito sa access sa filesystem
at mga process kapag may ginawang hindi tama ang model.

## Ano ang naka-sandbox

- Pagpapatakbo ng tool (`exec`, `read`, `write`, `edit`, `apply_patch`, `process`, atbp.).
- Opsyonal na sandboxed browser (`agents.defaults.sandbox.browser`).
  - Bilang default, auto-start ang sandbox browser (tinitiyak na reachable ang CDP) kapag kailangan ito ng browser tool.
    I-configure sa pamamagitan ng `agents.defaults.sandbox.browser.autoStart` at `agents.defaults.sandbox.browser.autoStartTimeoutMs`.
  - Pinapahintulutan ng `agents.defaults.sandbox.browser.allowHostControl` ang mga sandboxed session na tahasang i-target ang host browser.
  - Mga opsyonal na allowlist ang nagga-gate sa `target: "custom"`: `allowedControlUrls`, `allowedControlHosts`, `allowedControlPorts`.

Hindi naka-sandbox:

- Ang mismong Gateway process.
- Anumang tool na tahasang pinayagang tumakbo sa host (hal., `tools.elevated`).
  - **Ang elevated exec ay tumatakbo sa host at nilalampasan ang sandboxing.**
  - Kapag naka-off ang sandboxing, hindi binabago ng `tools.elevated` ang execution (nasa host na). Tingnan ang [Elevated Mode](/tools/elevated).

## Mga mode

Kinokontrol ng `agents.defaults.sandbox.mode` **kung kailan** ginagamit ang sandboxing:

- `"off"`: walang sandboxing.
- `"non-main"`: sandbox lang ang mga **non-main** session (default kung gusto mo ng normal na chats sa host).
- `"all"`: bawat session ay tumatakbo sa sandbox.
  Tandaan: ang `"non-main"` ay batay sa `session.mainKey` (default `"main"`), hindi sa agent id.
  Ang mga group/channel session ay gumagamit ng sarili nilang mga key, kaya itinuturing silang non-main at masasandbox.

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

Kinokopya ang inbound media papunta sa aktibong sandbox workspace (`media/inbound/*`).
Tala sa Skills: ang tool na `read` ay sandbox-rooted. Sa `workspaceAccess: "none"`,
ini-mi-mirror ng OpenClaw ang mga eligible na skill sa sandbox workspace (`.../skills`) para
mabasa ang mga ito. Sa `"rw"`, mababasa ang mga workspace skill mula sa
`/workspace/skills`.

## Mga custom bind mount

Ang `agents.defaults.sandbox.docker.binds` ay nagma-mount ng karagdagang host directory sa loob ng container.
Format: `host:container:mode` (hal., `"/home/user/source:/source:rw"`).

Ang global at per-agent binds ay **pinagsasama** (hindi pinapalitan). Sa ilalim ng `scope: "shared"`, hindi pinapansin ang per-agent binds.

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

Tandaan: ang default na image ay **walang** Node. Kung kailangan ng isang skill ang Node (o
ibang runtime), alinman sa mag-bake ng custom image o mag-install sa pamamagitan ng
`sandbox.docker.setupCommand` (nangangailangan ng network egress + writable root +
root user).

Sandboxed browser image:

```bash
scripts/sandbox-browser-setup.sh
```

Bilang default, tumatakbo ang mga sandbox container na **walang network**.
I-override gamit ang `agents.defaults.sandbox.docker.network`.

Narito ang mga Docker install at ang containerized gateway:
[Docker](/install/docker)

## setupCommand (one-time na setup ng container)

Ang `setupCommand` ay tumatakbo **isang beses** pagkatapos malikha ang sandbox container (hindi sa bawat run).
Isinasagawa ito sa loob ng container sa pamamagitan ng `sh -lc`.

Mga path:

- Global: `agents.defaults.sandbox.docker.setupCommand`
- Per-agent: `agents.list[].sandbox.docker.setupCommand`

Karaniwang pitfalls:

- Ang default na `docker.network` ay `"none"` (walang egress), kaya babagsak ang mga package install.
- Pinipigilan ng `readOnlyRoot: true` ang mga write; itakda ang `readOnlyRoot: false` o mag-bake ng custom image.
- Dapat root ang `user` para sa mga package install (alisin ang `user` o itakda ang `user: "0:0"`).
- Ang sandbox exec ay **hindi** nagmamana ng host `process.env`. Gamitin ang
  `agents.defaults.sandbox.docker.env` (o isang custom image) para sa mga skill API key.

## Tool policy + mga escape hatch

Nalalapat pa rin ang mga tool allow/deny policy bago ang mga sandbox rule. Kung ang isang tool ay denied
global o per-agent, hindi ito ibinabalik ng sandboxing.

Ang `tools.elevated` ay isang tahasang escape hatch na nagpapatakbo ng `exec` sa host.
Ang mga `/exec` directive ay nalalapat lang para sa mga awtorisadong sender at nananatili per session; para i-hard-disable
ang `exec`, gumamit ng tool policy deny (tingnan ang [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)).

Debugging:

- Gamitin ang `openclaw sandbox explain` para siyasatin ang epektibong sandbox mode, tool policy, at mga fix-it config key.
- Tingnan ang [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) para sa mental model ng “bakit ito naka-block?”
  Panatilihin itong naka-lock down.

## Mga override sa multi-agent

Maaaring i-override ng bawat agent ang sandbox + mga tool:
`agents.list[].sandbox` at `agents.list[].tools` (dagdag ang `agents.list[].tools.sandbox.tools` para sa sandbox tool policy).
Tingnan ang [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) para sa precedence.

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
