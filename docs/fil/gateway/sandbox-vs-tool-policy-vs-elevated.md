---
title: Sandbox vs Tool Policy vs Elevated
summary: "Bakit naka-block ang isang tool: sandbox runtime, tool allow/deny policy, at mga elevated exec gate"
read_when: "Kapag tumama ka sa 'sandbox jail' o nakakita ng pagtanggi sa tool/elevated at gusto mo ang eksaktong config key na babaguhin."
status: active
---

# Sandbox vs Tool Policy vs Elevated

May tatlong magkaugnay (pero magkaiba) na kontrol ang OpenClaw:

1. **Sandbox** (`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`) ang nagdedesisyon **kung saan tatakbo ang mga tool** (Docker vs host).
2. **Tool policy** (`tools.*`, `tools.sandbox.tools.*`, `agents.list[].tools.*`) ang nagdedesisyon **kung aling mga tool ang available/pinapahintulutan**.
3. **Elevated** (`tools.elevated.*`, `agents.list[].tools.elevated.*`) ay isang **exec-only escape hatch** para tumakbo sa host kapag naka-sandbox ka.

## Quick debug

Gamitin ang inspector para makita kung ano ang _talagang_ ginagawa ng OpenClaw:

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

Ipinapakita nito ang:

- epektibong sandbox mode/scope/workspace access
- kung ang session ay kasalukuyang naka-sandbox (main vs non-main)
- epektibong sandbox tool allow/deny (at kung galing ito sa agent/global/default)
- mga elevated gate at fix-it key path

## Sandbox: kung saan tumatakbo ang mga tool

Kinokontrol ang sandboxing ng `agents.defaults.sandbox.mode`:

- `"off"`: lahat ay tumatakbo sa host.
- `"non-main"`: tanging mga non-main session ang naka-sandbox (karaniwang “surprise” para sa mga group/channel).
- `"all"`: lahat ay naka-sandbox.

Tingnan ang [Sandboxing](/gateway/sandboxing) para sa buong matrix (scope, workspace mounts, images).

### Bind mounts (security quick check)

- `docker.binds` ay _tumutusok_ sa sandbox filesystem: anuman ang i-mount mo ay makikita sa loob ng container ayon sa mode na itinakda mo (`:ro` o `:rw`).
- Ang default ay read-write kapag inalis mo ang mode; mas mainam ang `:ro` para sa source/secrets.
- `scope: "shared"` ay binabalewala ang per-agent bind (global binds lang ang naa-apply).
- Ang pag-bind ng `/var/run/docker.sock` ay epektibong nagbibigay ng kontrol sa host sa sandbox; gawin lang ito kung sinasadya.
- Ang workspace access (`workspaceAccess: "ro"`/`"rw"`) ay hiwalay sa bind modes.

## Tool policy: kung aling mga tool ang umiiral/maaaring tawagin

Dalawang layer ang mahalaga:

- **Tool profile**: `tools.profile` at `agents.list[].tools.profile` (base allowlist)
- **Provider tool profile**: `tools.byProvider[provider].profile` at `agents.list[].tools.byProvider[provider].profile`
- **Global/per-agent tool policy**: `tools.allow`/`tools.deny` at `agents.list[].tools.allow`/`agents.list[].tools.deny`
- **Provider tool policy**: `tools.byProvider[provider].allow/deny` at `agents.list[].tools.byProvider[provider].allow/deny`
- **Sandbox tool policy** (naa-apply lang kapag naka-sandbox): `tools.sandbox.tools.allow`/`tools.sandbox.tools.deny` at `agents.list[].tools.sandbox.tools.*`

Mga panuntunang pangkalahatan:

- `deny` ang laging nananaig.
- Kapag ang `allow` ay hindi empty, ang lahat ng iba pa ay itinuturing na naka-block.
- Ang tool policy ang hard stop: hindi maaaring i-override ng `/exec` ang tinanggihang `exec` na tool.
- `/exec` only changes session defaults for authorized senders; it does not grant tool access.
  Provider tool keys accept either `provider` (e.g. `google-antigravity`) or `provider/model` (e.g. `openai/gpt-5.2`).

### Tool groups (mga shorthand)

Sinusuportahan ng mga tool policy (global, agent, sandbox) ang mga `group:*` na entry na lumalawak sa maraming tool:

```json5
{
  tools: {
    sandbox: {
      tools: {
        allow: ["group:runtime", "group:fs", "group:sessions", "group:memory"],
      },
    },
  },
}
```

Mga available na grupo:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: lahat ng built-in na OpenClaw tool (hindi kasama ang provider plugins)

## Elevated: exec-only “run on host”

Hindi nagbibigay ang Elevated ng dagdag na mga tool; naaapektuhan lang nito ang `exec`.

- Kapag naka-sandbox ka, ang `/elevated on` (o `exec` na may `elevated: true`) ay tatakbo sa host (maaari pa ring kailanganin ang mga approval).
- Gamitin ang `/elevated full` para laktawan ang exec approvals para sa session.
- Kung direkta ka nang tumatakbo, ang elevated ay epektibong no-op (naka-gate pa rin).
- Ang Elevated ay **hindi** skill-scoped at **hindi** nag-o-override ng tool allow/deny.
- `/exec` is separate from elevated. It only adjusts per-session exec defaults for authorized senders.

Mga gate:

- Enablement: `tools.elevated.enabled` (at opsyonal na `agents.list[].tools.elevated.enabled`)
- Sender allowlists: `tools.elevated.allowFrom.<provider>` (and optionally `agents.list[].tools.elevated.allowFrom.<provider>`)

Tingnan ang [Elevated Mode](/tools/elevated).

## Mga karaniwang “sandbox jail” na ayos

### “Tool X blocked by sandbox tool policy”

Mga fix-it key (pumili ng isa):

- I-disable ang sandbox: `agents.defaults.sandbox.mode=off` (o per-agent `agents.list[].sandbox.mode=off`)
- Payagan ang tool sa loob ng sandbox:
  - alisin ito mula sa `tools.sandbox.tools.deny` (o per-agent `agents.list[].tools.sandbox.tools.deny`)
  - o idagdag ito sa `tools.sandbox.tools.allow` (o per-agent allow)

### “Akala ko main ito, bakit naka-sandbox?”

In `"non-main"` mode, group/channel keys are _not_ main. Use the main session key (shown by `sandbox explain`) or switch mode to `"off"`.
