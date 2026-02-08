---
summary: "Sådan fungerer OpenClaw sandboxing: tilstande, omfang, workspace-adgang og images"
title: Sandboxing
read_when: "Du vil have en dedikeret forklaring af sandboxing eller skal finjustere agents.defaults.sandbox."
status: active
x-i18n:
  source_path: gateway/sandboxing.md
  source_hash: c1bb7fd4ac37ef73
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:24Z
---

# Sandboxing

OpenClaw kan køre **værktøjer inde i Docker-containere** for at reducere blast radius.
Dette er **valgfrit** og styres af konfiguration (`agents.defaults.sandbox` eller
`agents.list[].sandbox`). Hvis sandboxing er slået fra, kører værktøjer på værten.
Gateway bliver på værten; værktøjseksekvering kører i en isoleret sandbox,
når det er aktiveret.

Dette er ikke en perfekt sikkerhedsgrænse, men det begrænser markant filsystem-
og procesadgang, når modellen gør noget dumt.

## Hvad bliver sandboxet

- Værktøjseksekvering (`exec`, `read`, `write`, `edit`, `apply_patch`, `process`, osv.).
- Valgfri sandboxet browser (`agents.defaults.sandbox.browser`).
  - Som standard starter sandbox-browseren automatisk (sikrer at CDP er tilgængelig), når browser-værktøjet har brug for den.
    Konfigurer via `agents.defaults.sandbox.browser.autoStart` og `agents.defaults.sandbox.browser.autoStartTimeoutMs`.
  - `agents.defaults.sandbox.browser.allowHostControl` lader sandboxede sessioner målrette værtsbrowseren eksplicit.
  - Valgfrie tilladelseslister afgrænser `target: "custom"`: `allowedControlUrls`, `allowedControlHosts`, `allowedControlPorts`.

Ikke sandboxet:

- Selve Gateway-processen.
- Ethvert værktøj, der eksplicit er tilladt at køre på værten (fx `tools.elevated`).
  - **Elevated exec kører på værten og omgår sandboxing.**
  - Hvis sandboxing er slået fra, ændrer `tools.elevated` ikke eksekveringen (allerede på værten). Se [Elevated Mode](/tools/elevated).

## Tilstande

`agents.defaults.sandbox.mode` styrer **hvornår** sandboxing bruges:

- `"off"`: ingen sandboxing.
- `"non-main"`: sandbox kun **ikke-hoved** sessioner (standard, hvis du vil have normale chats på værten).
- `"all"`: hver session kører i en sandbox.
  Bemærk: `"non-main"` er baseret på `session.mainKey` (standard `"main"`), ikke agent-id.
  Gruppe-/kanalsessioner bruger deres egne nøgler, så de tæller som ikke-hoved og vil blive sandboxet.

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

Indgående medier kopieres ind i det aktive sandbox-workspace (`media/inbound/*`).
Skills-note: `read`-værktøjet er sandbox-rodfæstet. Med `workspaceAccess: "none"`
spejler OpenClaw egnede skills ind i sandbox-workspacet (`.../skills`), så
de kan læses. Med `"rw"` er workspace-skills læsbare fra
`/workspace/skills`.

## Brugerdefinerede bind mounts

`agents.defaults.sandbox.docker.binds` monterer ekstra værtsmapper ind i containeren.
Format: `host:container:mode` (fx `"/home/user/source:/source:rw"`).

Globale og pr.-agent binds **flettes** (ikke erstattes). Under `scope: "shared"` ignoreres pr.-agent binds.

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

Bemærk: standard-imaget inkluderer **ikke** Node. Hvis en skill kræver Node (eller
andre runtimes), så enten bag et custom image eller installér via
`sandbox.docker.setupCommand` (kræver netværksudgang + skrivbar root +
root-bruger).

Sandboxet browser-image:

```bash
scripts/sandbox-browser-setup.sh
```

Som standard kører sandbox-containere **uden netværk**.
Tilsidesæt med `agents.defaults.sandbox.docker.network`.

Docker-installationer og den containeriserede gateway findes her:
[Docker](/install/docker)

## setupCommand (engangs container-opsætning)

`setupCommand` kører **én gang** efter sandbox-containeren er oprettet (ikke ved hver kørsel).
Den eksekveres inde i containeren via `sh -lc`.

Stier:

- Global: `agents.defaults.sandbox.docker.setupCommand`
- Pr. agent: `agents.list[].sandbox.docker.setupCommand`

Almindelige faldgruber:

- Standard `docker.network` er `"none"` (ingen egress), så pakkeinstallationer vil fejle.
- `readOnlyRoot: true` forhindrer skrivninger; sæt `readOnlyRoot: false` eller bag et custom image.
- `user` skal være root for pakkeinstallationer (udelad `user` eller sæt `user: "0:0"`).
- Sandbox exec arver **ikke** værts-`process.env`. Brug
  `agents.defaults.sandbox.docker.env` (eller et custom image) til skill API-nøgler.

## Værktøjspolitik + flugtveje

Tillad/afvis-politikker for værktøjer gælder stadig før sandbox-regler. Hvis et værktøj er afvist
globalt eller pr. agent, bringer sandboxing det ikke tilbage.

`tools.elevated` er en eksplicit flugtvej, der kører `exec` på værten.
`/exec`-direktiver gælder kun for autoriserede afsendere og vedvarer pr. session; for hårdt at deaktivere
`exec`, brug værktøjspolitik-afvis (se [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)).

Fejlfinding:

- Brug `openclaw sandbox explain` til at inspicere effektiv sandbox-tilstand, værktøjspolitik og fix-it-konfigurationsnøgler.
- Se [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) for den mentale model “hvorfor er dette blokeret?”.
  Hold det låst ned.

## Multi-agent-tilsidesættelser

Hver agent kan tilsidesætte sandbox + værktøjer:
`agents.list[].sandbox` og `agents.list[].tools` (plus `agents.list[].tools.sandbox.tools` for sandbox-værktøjspolitik).
Se [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) for præcedens.

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
