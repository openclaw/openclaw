---
summary: "Sådan fungerer OpenClaw sandboxing: tilstande, omfang, workspace-adgang og images"
title: Sandboxing
read_when: "Du vil have en dedikeret forklaring af sandboxing eller skal finjustere agents.defaults.sandbox."
status: active
---

# Sandboxing

OpenClaw kan køre **værktøjer inde Docker containere** for at reducere blastradius.
Dette er **valgfri** og styres af konfiguration (`agents.defaults.sandbox` eller
`agents.list[].sandbox`). Hvis sandkassen er slukket, skal værktøjerne køres på værten.
Gatewayen forbliver på værten; udførelse af værktøj kører i en isoleret sandkasse
når aktiveret.

Dette er ikke en perfekt sikkerhedsgrænse, men det begrænser markant filsystem-
og procesadgang, når modellen gør noget dumt.

## Hvad bliver sandboxet

- Værktøjseksekvering (`exec`, `read`, `write`, `edit`, `apply_patch`, `process`, osv.).
- Valgfri sandboxet browser (`agents.defaults.sandbox.browser`).
  - Som standard starter sandkasse-browseren auto-starter (sikrer, at CDP er tilgængelig), når browserværktøjet har brug for det.
    Konfigurere via `agents.defaults.sandbox.browser.autoStart` og `agents.defaults.sandbox.browser.autoStartTimeoutMs`.
  - `agents.defaults.sandbox.browser.allowHostControl` lader sandboxede sessioner målrette værtsbrowseren eksplicit.
  - Valgfrie tilladelseslister afgrænser `target: "custom"`: `allowedControlUrls`, `allowedControlHosts`, `allowedControlPorts`.

Ikke sandboxet:

- Selve Gateway-processen.
- Ethvert værktøj, der eksplicit er tilladt at køre på værten (fx `tools.elevated`).
  - **Elevated exec kører på værten og omgår sandboxing.**
  - Hvis sandboxing er slukket, ændrer 'tools.elevated' ikke kørsel (allerede på vært). Se [Elevated Mode](/tools/elevated).

## Tilstande

`agents.defaults.sandbox.mode` styrer **hvornår** sandboxing bruges:

- `"off"`: ingen sandboxing.
- `"non-main"`: sandbox kun **ikke-hoved** sessioner (standard, hvis du vil have normale chats på værten).
- `"alle"`: hver session kører i en sandkasse.
  Bemærk: `"non-main"` er baseret på `session.mainKey` (standard `"main"`), ikke agent id.
  Gruppe/kanal sessioner bruger deres egne nøgler, så de tæller som ikke-main og vil blive sandboxed.

## Omfang

`agents.defaults.sandbox.scope` styrer **hvor mange containere** der oprettes:

- `"session"` (standard): én container pr. session.
- `"agent"`: én container pr. agent.
- `"shared"`: én container delt af alle sandboxede sessioner.

## Workspace-adgang

`agents.defaults.sandbox.workspaceAccess` styrer **hvad sandboxen kan se**:

- `"none"` (standard): værktøjer ser et sandbox-workspace under `~/.openclaw/sandboxes`.
- `"ro"`: monterer agent-workspacet skrivebeskyttet på `/agent` (deaktiverer `write`/`edit`/`apply_patch`).
- `"rw"`: monterer agent-workspacet med læse/skrive på `/workspace`.

Indgående medier kopieres ind i det aktive arbejdsområde for sandkasse (`media/inbound/*`).
Noter om færdigheder: værktøjet 'læst' er sandkasse-rooted. Med `workspaceAccess: "none"`,
OpenClaw spejler kvalificerede færdigheder i sandkasse-arbejdsområdet (`.../skills`) så
de kan læses. Med `"rw"`, arbejdsområde færdigheder kan læses fra
`/workspace/skills`.

## Brugerdefinerede bind mounts

`agents.defaults.sandbox.docker.binds` monterer yderligere værtsmapper i beholderen.
Format: `vært:container:mode` (fx, `"/home/user/source:/source:rw"`).

Globale og per-agent bindinger er **sammenflettede** (ikke erstattet). Under `scope: "shared"`, per-agent binds ignoreres.

Eksempel (skrivebeskyttet kilde + docker socket):

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

Sikkerhedsnoter:

- Binds omgår sandbox-filsystemet: de eksponerer værtsstier med den tilstand, du sætter (`:ro` eller `:rw`).
- Følsomme mounts (fx `docker.sock`, hemmeligheder, SSH-nøgler) bør være `:ro`, medmindre det er absolut nødvendigt.
- Kombinér med `workspaceAccess: "ro"`, hvis du kun har brug for læseadgang til workspacet; bind-tilstande forbliver uafhængige.
- Se [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) for hvordan binds interagerer med værktøjspolitik og elevated exec.

## Images + opsætning

Standard-image: `openclaw-sandbox:bookworm-slim`

Byg det én gang:

```bash
scripts/sandbox-setup.sh
```

Bemærk: Standardbilledet indeholder **ikke** Node. Hvis en dygtighed behøver Node (eller
andre runtimes), enten bage et brugerdefineret billede eller installere via
`sandbox. ocker.setupCommand` (kræver netværkegress + skrivbar root +
root bruger).

Sandboxet browser-image:

```bash
scripts/sandbox-browser-setup.sh
```

Som standard kører sandkasse containere med **intet netværk**.
Tilsidesæt med `agents.defaults.sandbox.docker.network`.

Docker-installationer og den containeriserede gateway findes her:
[Docker](/install/docker)

## setupCommand (engangs container-opsætning)

`setupCommand` kører **en gang** efter sandkassen er oprettet (ikke på hver kørsel).
Det udfører inde i beholderen via `sh -lc`.

Stier:

- Global: `agents.defaults.sandbox.docker.setupCommand`
- Per-agent: `agents.list[].sandbox.docker.setupCommand`

Almindelige faldgruber:

- Standard `docker.network` er `"none"` (ingen egress), så pakkeinstallationer vil fejle.
- `readOnlyRoot: true` forhindrer skrivninger; sæt `readOnlyRoot: false` eller bag et custom image.
- `user` skal være root for pakkeinstallationer (udelad `user` eller sæt `user: "0:0"`).
- Sandbox exec arver **ikke** vært `process.env`. Brug
  `agents.defaults.sandbox.docker.env` (eller et brugerdefineret billede) for dygtighed API nøgler.

## Værktøjspolitik + flugtveje

Værktøjet tillader/benægter politikker gælder stadig før sandkasse regler. Hvis et værktøj nægtes
globalt eller per agent, bringer sandboxing ikke det tilbage.

`tools.elevated` er en eksplicit undslippe luge, der kører `exec` på værten.
`/exec` direktiver gælder kun for autoriserede afsendere og varer ved pr. mødeperiode; til hard-deaktivere
`exec`, brug værktøj politik benægte (se [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)).

Fejlfinding:

- Brug `openclaw sandbox explain` til at inspicere effektiv sandbox-tilstand, værktøjspolitik og fix-it-konfigurationsnøgler.
- Se [Sandkasse vs værktøjspolitik vs forhøjet](/gateway/sandbox-vs-tool-policy-vs-elevated) for “hvorfor er denne blokeret?” mental model.
  Hold den låst nede.

## Multi-agent-tilsidesættelser

Hver agent kan tilsidesætte sandkasse + værktøjer:
`agents.list[].sandbox` og `agents.list[].tools` (plus `agents.list[].tools.sandbox.tools` for sandkasse værktøjspolitik).
Se [Multi-Agent Sandbox & Værktøjer](/tools/multi-agent-sandbox-tools) for forrang.

## Minimal aktiveringseksempel

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

## Relaterede dokumenter

- [Sandbox-konfiguration](/gateway/configuration#agentsdefaults-sandbox)
- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)
- [Sikkerhed](/gateway/security)
