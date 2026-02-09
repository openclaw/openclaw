---
summary: "Hoe OpenClaw-sandboxing werkt: modi, scopes, werkruimte-toegang en images"
title: Sandboxing
read_when: "Je wilt een toegewijde uitleg van sandboxing of moet agents.defaults.sandbox afstemmen."
status: active
---

# Sandboxing

OpenClaw kan **tools in Docker-containers** uitvoeren om de impact te beperken.
Dit is **optioneel** en wordt aangestuurd via configuratie (`agents.defaults.sandbox` of
`agents.list[].sandbox`). Als sandboxing uit staat, draaien tools op de host.
De Gateway blijft op de host; tooluitvoering draait in een geïsoleerde sandbox
wanneer ingeschakeld.

Dit is geen perfecte beveiligingsgrens, maar het beperkt de toegang tot het bestandssysteem
en processen aanzienlijk wanneer het model iets doms doet.

## Wat wordt gesandboxed

- Tooluitvoering (`exec`, `read`, `write`, `edit`, `apply_patch`, `process`, enz.).
- Optionele gesandboxde browser (`agents.defaults.sandbox.browser`).
  - Standaard start de sandboxbrowser automatisch (zorgt dat CDP bereikbaar is) wanneer de browsertool dit nodig heeft.
    Configureer via `agents.defaults.sandbox.browser.autoStart` en `agents.defaults.sandbox.browser.autoStartTimeoutMs`.
  - `agents.defaults.sandbox.browser.allowHostControl` laat gesandboxde sessies expliciet de hostbrowser targeten.
  - Optionele toegestane lijsten begrenzen `target: "custom"`: `allowedControlUrls`, `allowedControlHosts`, `allowedControlPorts`.

Niet gesandboxed:

- Het Gateway-proces zelf.
- Elke tool die expliciet is toegestaan om op de host te draaien (bijv. `tools.elevated`).
  - **Uitvoering met verhoogde rechten draait op de host en omzeilt sandboxing.**
  - Als sandboxing uit staat, verandert `tools.elevated` de uitvoering niet (al op de host). Zie [Elevated Mode](/tools/elevated).

## Modi

`agents.defaults.sandbox.mode` bepaalt **wanneer** sandboxing wordt gebruikt:

- `"off"`: geen sandboxing.
- `"non-main"`: sandbox alleen **niet-hoofd**sessies (standaard als je normale chats op de host wilt).
- `"all"`: elke sessie draait in een sandbox.
  Let op: `"non-main"` is gebaseerd op `session.mainKey` (standaard `"main"`), niet op agent-id.
  Groep-/kanaalsessies gebruiken hun eigen sleutels, tellen dus als niet-hoofd en worden gesandboxed.

## Scope

`agents.defaults.sandbox.scope` bepaalt **hoeveel containers** worden aangemaakt:

- `"session"` (standaard): één container per sessie.
- `"agent"`: één container per agent.
- `"shared"`: één container gedeeld door alle gesandboxde sessies.

## Werkruimte-toegang

`agents.defaults.sandbox.workspaceAccess` bepaalt **wat de sandbox kan zien**:

- `"none"` (standaard): tools zien een sandbox-werkruimte onder `~/.openclaw/sandboxes`.
- `"ro"`: mount de agent-werkruimte alleen-lezen op `/agent` (schakelt `write`/`edit`/`apply_patch` uit).
- `"rw"`: mount de agent-werkruimte lees/schrijf op `/workspace`.

Binnenkomende media worden gekopieerd naar de actieve sandbox-werkruimte (`media/inbound/*`).
Skills-opmerking: de `read`-tool is sandbox-geroot. Met `workspaceAccess: "none"`
spiegelt OpenClaw in aanmerking komende skills naar de sandbox-werkruimte (`.../skills`), zodat
ze gelezen kunnen worden. Met `"rw"` zijn werkruimte-skills leesbaar vanaf
`/workspace/skills`.

## Aangepaste bind mounts

`agents.defaults.sandbox.docker.binds` mount extra hostmappen in de container.
Formaat: `host:container:mode` (bijv. `"/home/user/source:/source:rw"`).

Globale en per-agent binds worden **samengevoegd** (niet vervangen). Onder `scope: "shared"` worden per-agent binds genegeerd.

Voorbeeld (alleen-lezen bron + docker-socket):

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

Beveiligingsnotities:

- Binds omzeilen het sandbox-bestandssysteem: ze stellen hostpaden bloot met de ingestelde modus (`:ro` of `:rw`).
- Gevoelige mounts (bijv. `docker.sock`, secrets, SSH-sleutels) moeten `:ro` zijn, tenzij absoluut vereist.
- Combineer met `workspaceAccess: "ro"` als je alleen leestoegang tot de werkruimte nodig hebt; bind-modi blijven onafhankelijk.
- Zie [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) voor hoe binds samenwerken met tool policy en elevated exec.

## Images + installatie

Standaard image: `openclaw-sandbox:bookworm-slim`

Bouw deze één keer:

```bash
scripts/sandbox-setup.sh
```

Let op: de standaard image bevat **geen** Node. Als een skill Node (of
andere runtimes) nodig heeft, bak dan een aangepaste image of installeer via
`sandbox.docker.setupCommand` (vereist netwerk-egress + schrijfbare root +
root-gebruiker).

Gesandboxde browser image:

```bash
scripts/sandbox-browser-setup.sh
```

Standaard draaien sandbox-containers **zonder netwerk**.
Overschrijf met `agents.defaults.sandbox.docker.network`.

Docker-installaties en de gecontaineriseerde Gateway vind je hier:
[Docker](/install/docker)

## setupCommand (eenmalige container-setup)

`setupCommand` draait **één keer** nadat de sandbox-container is aangemaakt (niet bij elke run).
Het wordt in de container uitgevoerd via `sh -lc`.

Paths:

- Globaal: `agents.defaults.sandbox.docker.setupCommand`
- Per agent: `agents.list[].sandbox.docker.setupCommand`

Veelvoorkomende valkuilen:

- Standaard `docker.network` is `"none"` (geen egress), dus pakketinstallaties mislukken.
- `readOnlyRoot: true` voorkomt schrijven; stel `readOnlyRoot: false` in of bak een aangepaste image.
- `user` moet root zijn voor pakketinstallaties (laat `user` weg of stel `user: "0:0"` in).
- Sandbox-exec erft **niet** de host-`process.env`. Gebruik
  `agents.defaults.sandbox.docker.env` (of een aangepaste image) voor skill-API-sleutels.

## Tool policy + ontsnappingsluiken

Tool allow/deny-beleid blijft van kracht vóór sandboxregels. Als een tool
globaal of per agent is geweigerd, brengt sandboxing deze niet terug.

`tools.elevated` is een expliciet ontsnappingsluik dat `exec` op de host uitvoert.
`/exec`-directieven gelden alleen voor geautoriseerde afzenders en blijven per sessie behouden; om
`exec` hard uit te schakelen, gebruik tool policy deny (zie [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)).

Debuggen:

- Gebruik `openclaw sandbox explain` om de effectieve sandbox-modus, tool policy en fix-it-config-sleutels te inspecteren.
- Zie [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) voor het mentale model “waarom is dit geblokkeerd?”.
  Houd het vergrendeld.

## Multi-agent overrides

Elke agent kan sandbox + tools overschrijven:
`agents.list[].sandbox` en `agents.list[].tools` (plus `agents.list[].tools.sandbox.tools` voor sandbox-toolbeleid).
Zie [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) voor prioriteit.

## Minimale inschakelvoorbeeld

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

## Gerelateerde documentatie

- [Sandbox Configuration](/gateway/configuration#agentsdefaults-sandbox)
- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)
- [Security](/gateway/security)
