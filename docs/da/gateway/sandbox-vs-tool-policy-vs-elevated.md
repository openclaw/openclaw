---
title: Sandbox vs Tool Policy vs Elevated
summary: "Hvorfor et værktøj er blokeret: sandbox-runtime, værktøjs tillad/afvis-politik og elevated exec-gates"
read_when: "Du rammer 'sandbox jail' eller ser et værktøjs-/elevated-afslag og vil have den præcise konfigurationsnøgle, der skal ændres."
status: active
---

# Sandbox vs Tool Policy vs Elevated

OpenClaw har tre relaterede (men forskellige) kontroller:

1. **Sandbox** (`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`) afgør **hvor værktøjer kører** (Docker vs vært).
2. **Værktøjspolitik** (`tools.*`, `tools.sandbox.tools.*`, `agents.list[].tools.*`) afgør **hvilke værktøjer der er tilgængelige/tilladt**.
3. **Elevated** (`tools.elevated.*`, `agents.list[].tools.elevated.*`) er en **kun-exec nødudgang** til at køre på værten, når du er sandboxed.

## Hurtig fejlsøgning

Brug inspektøren til at se, hvad OpenClaw _faktisk_ gør:

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

Den udskriver:

- effektiv sandbox-tilstand/omfang/workspace-adgang
- om sessionen aktuelt er sandboxed (main vs non-main)
- effektiv sandbox-værktøjs tillad/afvis (og om den kommer fra agent/global/standard)
- elevated-gates og fix-it-nøglestier

## Sandbox: hvor værktøjer kører

Sandboxing styres af `agents.defaults.sandbox.mode`:

- `"off"`: alt kører på værten.
- `"non-main"`: kun non-main-sessioner er sandboxed (almindelig “overraskelse” for grupper/kanaler).
- `"all"`: alt er sandboxed.

Se [Sandboxing](/gateway/sandboxing) for den fulde matrix (omfang, workspace-mounts, images).

### Bind mounts (hurtig sikkerhedstjek)

- `docker.binds` _gennembryder_ sandbox-filsystemet: det, du monterer, er synligt inde i containeren med den tilstand, du angiver (`:ro` eller `:rw`).
- Standard er læs-skriv, hvis du udelader tilstanden; foretræk `:ro` for kilde/hemmeligheder.
- `scope: "shared"` ignorerer per-agent-binds (kun globale binds gælder).
- At binde `/var/run/docker.sock` overdrager reelt værtskontrol til sandboxen; gør dette kun bevidst.
- Workspace-adgang (`workspaceAccess: "ro"`/`"rw"`) er uafhængig af bind-tilstande.

## Tool policy: hvilke værktøjer findes/kan kaldes

To lag er vigtige:

- **Værktøjsprofil**: `tools.profile` og `agents.list[].tools.profile` (basis-tilladelsesliste)
- **Udbyder-værktøjsprofil**: `tools.byProvider[provider].profile` og `agents.list[].tools.byProvider[provider].profile`
- **Global/per-agent værktøjspolitik**: `tools.allow`/`tools.deny` og `agents.list[].tools.allow`/`agents.list[].tools.deny`
- **Udbyder-værktøjspolitik**: `tools.byProvider[provider].allow/deny` og `agents.list[].tools.byProvider[provider].allow/deny`
- **Sandbox-værktøjspolitik** (gælder kun når sandboxed): `tools.sandbox.tools.allow`/`tools.sandbox.tools.deny` og `agents.list[].tools.sandbox.tools.*`

Tommelfingerregler:

- `deny` vinder altid.
- Hvis `allow` er ikke-tom, behandles alt andet som blokeret.
- Værktøjspolitik er den hårde stopklods: `/exec` kan ikke tilsidesætte et afvist `exec`-værktøj.
- `/exec` kun ændringer session standarder for autoriserede afsendere; det giver ikke værktøj adgang.
  Udbyderværktøjstaster accepterer enten `provider` (f.eks. `google-antigravity`) eller `provider/model` (f.eks. `openai/gpt-5.2`).

### Værktøjsgrupper (genveje)

Værktøjspolitikker (global, agent, sandbox) understøtter `group:*`-poster, der udvider til flere værktøjer:

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

Tilgængelige grupper:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: alle indbyggede OpenClaw-værktøjer (udelukker udbyder-plugins)

## Elevated: kun-exec “kør på værten”

Elevated giver **ikke** ekstra værktøjer; det påvirker kun `exec`.

- Hvis du er sandboxed, kører `/elevated on` (eller `exec` med `elevated: true`) på værten (godkendelser kan stadig gælde).
- Brug `/elevated full` for at springe exec-godkendelser over for sessionen.
- Hvis du allerede kører direkte, er elevated reelt en no-op (stadig gated).
- Elevated er **ikke** skill-afgrænset og tilsidesætter **ikke** værktøjs tillad/afvis.
- `/exec` er adskilt fra forhøjet. Det justerer kun per-session exec standarder for autoriserede afsendere.

Gates:

- Enablement: `tools.elevated.enabled` (og valgfrit `agents.list[].tools.elevated.enabled`)
- Afsenderen tillader: `tools.elevated.allowFrom.<provider>` (og valgfrit `agents.list[].tools.elevated.allowFrom.<provider>`)

Se [Elevated Mode](/tools/elevated).

## Almindelige “sandbox jail”-løsninger

### “Værktøj X blokeret af sandbox-værktøjspolitik”

Fix-it-nøgler (vælg én):

- Deaktivér sandbox: `agents.defaults.sandbox.mode=off` (eller per-agent `agents.list[].sandbox.mode=off`)
- Tillad værktøjet inde i sandbox:
  - fjern det fra `tools.sandbox.tools.deny` (eller per-agent `agents.list[].tools.sandbox.tools.deny`)
  - eller tilføj det til `tools.sandbox.tools.allow` (eller per-agent tillad)

### “Jeg troede, dette var main, hvorfor er det sandboxed?”

I `"ikke-main"` tilstand, gruppe / kanal nøgler er _not_ main. Brug hovedsessionsnøglen (vist ved `sandbox explain`) eller skift tilstand til `"off"`.
