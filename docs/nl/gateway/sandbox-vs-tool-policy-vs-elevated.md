---
title: Sandbox vs Toolbeleid vs Elevated
summary: "Waarom een tool is geblokkeerd: sandbox-runtime, tool-toestaan/weigeren-beleid en elevated exec-gates"
read_when: "Je tegen een 'sandbox jail' aanloopt of een tool/elevated-weigering ziet en exact wilt weten welke config-sleutel je moet aanpassen."
status: active
---

# Sandbox vs Toolbeleid vs Elevated

OpenClaw heeft drie gerelateerde (maar verschillende) controles:

1. **Sandbox** (`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`) bepaalt **waar tools draaien** (Docker vs host).
2. **Toolbeleid** (`tools.*`, `tools.sandbox.tools.*`, `agents.list[].tools.*`) bepaalt **welke tools beschikbaar/toegestaan zijn**.
3. **Elevated** (`tools.elevated.*`, `agents.list[].tools.elevated.*`) is een **alleen-exec ontsnappingsluik** om op de host te draaien wanneer je gesandboxed bent.

## Snelle debug

Gebruik de inspector om te zien wat OpenClaw _daadwerkelijk_ doet:

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

Het drukt:

- effectieve sandbox-modus/scope/werkruimte-toegang
- of de sessie momenteel gesandboxed is (main vs non-main)
- effectief sandbox-tool toestaan/weigeren (en of dit van agent/globaal/standaard komt)
- elevated-gates en fix-it sleutel-paden

## Sandbox: waar tools draaien

Sandboxing wordt aangestuurd door `agents.defaults.sandbox.mode`:

- `"off"`: alles draait op de host.
- `"non-main"`: alleen non-main sessies zijn gesandboxed (veelvoorkomende “verrassing” voor groepen/kanalen).
- `"all"`: alles is gesandboxed.

Zie [Sandboxing](/gateway/sandboxing) voor de volledige matrix (scope, werkruimte-mounts, images).

### Bind mounts (snelle beveiligingscheck)

- `docker.binds` _doorboort_ het sandbox-bestandssysteem: wat je mount is zichtbaar in de container met de ingestelde modus (`:ro` of `:rw`).
- Standaard is lezen-schrijven als je de modus weglaat; geef de voorkeur aan `:ro` voor broncode/secrets.
- `scope: "shared"` negeert per-agent binds (alleen globale binds gelden).
- Het binden van `/var/run/docker.sock` geeft feitelijk hostcontrole aan de sandbox; doe dit alleen bewust.
- Werkruimte-toegang (`workspaceAccess: "ro"`/`"rw"`) staat los van bind-modi.

## Toolbeleid: welke tools bestaan/zijn aanroepbaar

Twee lagen zijn van belang:

- **Toolprofiel**: `tools.profile` en `agents.list[].tools.profile` (basis-toegestane lijst)
- **Provider-toolprofiel**: `tools.byProvider[provider].profile` en `agents.list[].tools.byProvider[provider].profile`
- **Globaal/per-agent toolbeleid**: `tools.allow`/`tools.deny` en `agents.list[].tools.allow`/`agents.list[].tools.deny`
- **Provider-toolbeleid**: `tools.byProvider[provider].allow/deny` en `agents.list[].tools.byProvider[provider].allow/deny`
- **Sandbox-toolbeleid** (alleen van toepassing wanneer gesandboxed): `tools.sandbox.tools.allow`/`tools.sandbox.tools.deny` en `agents.list[].tools.sandbox.tools.*`

Vuistregels:

- `deny` wint altijd.
- Als `allow` niet leeg is, wordt al het andere als geblokkeerd beschouwd.
- Toolbeleid is de harde stop: `/exec` kan een geweigerde `exec` tool niet overrulen.
- `/exec` wijzigt alleen sessiestandaarden voor geautoriseerde afzenders; het verleent geen tooltoegang.
  Provider-tool-sleutels accepteren zowel `provider` (bijv. `google-antigravity`) als `provider/model` (bijv. `openai/gpt-5.2`).

### Toolgroepen (afkortingen)

Toolbeleidsregels (globaal, agent, sandbox) ondersteunen `group:*`-items die uitklappen naar meerdere tools:

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

Beschikbare groepen:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: alle ingebouwde OpenClaw-tools (exclusief provider-plugins)

## Elevated: alleen-exec “draaien op de host”

Elevated verleent **geen** extra tools; het beïnvloedt alleen `exec`.

- Als je gesandboxed bent, draait `/elevated on` (of `exec` met `elevated: true`) op de host (goedkeuringen kunnen nog steeds gelden).
- Gebruik `/elevated full` om exec-goedkeuringen voor de sessie over te slaan.
- Als je al direct draait, is elevated feitelijk een no-op (nog steeds gegate).
- Elevated is **niet** skill-scoped en overridet het tool toestaan/weigeren niet.
- `/exec` staat los van elevated. Het past alleen per-sessie exec-standaarden aan voor geautoriseerde afzenders.

Gates:

- Inschakeling: `tools.elevated.enabled` (en optioneel `agents.list[].tools.elevated.enabled`)
- Afzender-toegestane lijsten: `tools.elevated.allowFrom.<provider>` (en optioneel `agents.list[].tools.elevated.allowFrom.<provider>`)

Zie [Elevated Mode](/tools/elevated).

## Veelvoorkomende “sandbox jail”-oplossingen

### “Tool X geblokkeerd door sandbox-toolbeleid”

Fix-it-sleutels (kies er één):

- Sandbox uitschakelen: `agents.defaults.sandbox.mode=off` (of per-agent `agents.list[].sandbox.mode=off`)
- De tool toestaan binnen de sandbox:
  - verwijder deze uit `tools.sandbox.tools.deny` (of per-agent `agents.list[].tools.sandbox.tools.deny`)
  - of voeg deze toe aan `tools.sandbox.tools.allow` (of per-agent toestaan)

### “Ik dacht dat dit main was, waarom is het gesandboxed?”

In de modus `"non-main"` zijn groep-/kanaalsleutels _niet_ main. Gebruik de main-sessiesleutel (getoond door `sandbox explain`) of schakel de modus om naar `"off"`.
