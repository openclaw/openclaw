---
summary: "Uitvoeringsgoedkeuringen, toegestane lijsten en prompts voor sandbox-ontsnapping"
read_when:
  - Configureren van uitvoeringsgoedkeuringen of toegestane lijsten
  - Implementeren van UX voor uitvoeringsgoedkeuringen in de macOS-app
  - Beoordelen van prompts voor sandbox-ontsnapping en de implicaties
title: "Uitvoeringsgoedkeuringen"
---

# Uitvoeringsgoedkeuringen

Uitvoeringsgoedkeuringen zijn de **companion-app / node-host vangrail** om een gesandboxde agent
opdrachten te laten uitvoeren op een echte host (`gateway` of `node`). Zie het als een veiligheidsvergrendeling:
opdrachten zijn alleen toegestaan wanneer beleid + toegestane lijst + (optionele) gebruikersgoedkeuring het allemaal eens zijn.
Uitvoeringsgoedkeuringen zijn **aanvullend** op toolbeleid en verhoogde gating (tenzij elevated is ingesteld op `full`, wat goedkeuringen overslaat).
Het effectieve beleid is het **strengere** van `tools.exec.*` en de standaardwaarden voor goedkeuringen; als een goedkeuringsveld ontbreekt, wordt de waarde `tools.exec` gebruikt.

Als de UI van de companion-app **niet beschikbaar** is, wordt elke aanvraag die een prompt vereist
afgehandeld door de **ask fallback** (standaard: weigeren).

## Waar het van toepassing is

Uitvoeringsgoedkeuringen worden lokaal afgedwongen op de uitvoeringshost:

- **Gateway-host** → `openclaw`-proces op de Gateway-machine
- **node-host** → node-runner (macOS companion-app of headless node-host)

macOS-splitsing:

- **node-hostservice** stuurt `system.run` door naar de **macOS-app** via lokale IPC.
- **macOS-app** handhaaft goedkeuringen + voert de opdracht uit in UI-context.

## Instellingen en opslag

Goedkeuringen staan in een lokaal JSON-bestand op de uitvoeringshost:

`~/.openclaw/exec-approvals.json`

Voorbeeldschema:

```json
{
  "version": 1,
  "socket": {
    "path": "~/.openclaw/exec-approvals.sock",
    "token": "base64url-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny",
    "autoAllowSkills": false
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "askFallback": "deny",
      "autoAllowSkills": true,
      "allowlist": [
        {
          "id": "B0C8C0B3-2C2D-4F8A-9A3C-5A4B3C2D1E0F",
          "pattern": "~/Projects/**/bin/rg",
          "lastUsedAt": 1737150000000,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```

## Beleidsknoppen

### Beveiliging (`exec.security`)

- **deny**: blokkeer alle host-exec-aanvragen.
- **allowlist**: sta alleen opdrachten toe die op de toegestane lijst staan.
- **full**: sta alles toe (gelijk aan elevated).

### Ask (`exec.ask`)

- **off**: nooit prompten.
- **on-miss**: alleen prompten wanneer de toegestane lijst niet overeenkomt.
- **always**: bij elke opdracht prompten.

### Ask fallback (`askFallback`)

Als een prompt vereist is maar geen UI bereikbaar is, bepaalt fallback:

- **deny**: blokkeren.
- **allowlist**: alleen toestaan als de toegestane lijst overeenkomt.
- **full**: toestaan.

## Toegestane lijst (per agent)

Toegestane lijsten zijn **per agent**. Als er meerdere agents bestaan, wissel dan welke agent je
bewerkt in de macOS-app. Patronen zijn **hoofdletterongevoelige glob-matches**.
Patronen moeten worden opgelost naar **binaire paden** (vermeldingen met alleen de bestandsnaam worden genegeerd).
Legacy `agents.default`-vermeldingen worden bij het laden gemigreerd naar `agents.main`.

Voorbeelden:

- `~/Projects/**/bin/peekaboo`
- `~/.local/bin/*`
- `/opt/homebrew/bin/rg`

Elke vermelding in de toegestane lijst houdt bij:

- **id** stabiele UUID gebruikt voor UI-identiteit (optioneel)
- **last used**-tijdstempel
- **last used command**
- **last resolved path**

## Skill-CLI’s automatisch toestaan

Wanneer **Auto-allow skill CLIs** is ingeschakeld, worden uitvoerbare bestanden waarnaar bekende Skills verwijzen
behandeld als toegestaan op nodes (macOS-node of headless node-host). Dit gebruikt
`skills.bins` via de Gateway RPC om de lijst met skill-binaries op te halen. Schakel dit uit als je strikte handmatige toegestane lijsten wilt.

## Veilige binaries (alleen stdin)

`tools.exec.safeBins` definieert een kleine lijst **stdin-only**-binaries (bijvoorbeeld `jq`)
die in allowlist-modus **zonder** expliciete vermeldingen in de toegestane lijst kunnen draaien. Veilige binaries weigeren
positionele bestandsargumenten en padachtige tokens, zodat ze alleen op de inkomende stream kunnen werken.
Shell-koppeling en omleidingen worden niet automatisch toegestaan in allowlist-modus.

Shell-koppeling (`&&`, `||`, `;`) is toegestaan wanneer elk segment op het hoogste niveau voldoet aan de toegestane lijst
(inclusief veilige binaries of skill auto-allow). Omleidingen blijven niet ondersteund in allowlist-modus.
Command substitution (`$()` / backticks) wordt geweigerd tijdens het parsen van de toegestane lijst, ook binnen
dubbele aanhalingstekens; gebruik enkele aanhalingstekens als je letterlijke `$()`-tekst nodig hebt.

Standaard veilige binaries: `jq`, `grep`, `cut`, `sort`, `uniq`, `head`, `tail`, `tr`, `wc`.

## Bewerken via Control UI

Gebruik de kaart **Control UI → Nodes → Exec approvals** om standaardwaarden, per‑agent-
overschrijvingen en toegestane lijsten te bewerken. Kies een scope (Defaults of een agent), pas het beleid aan,
voeg patronen voor de toegestane lijst toe of verwijder ze, en klik vervolgens op **Save**. De UI toont **last used**-metadata
per patroon zodat je de lijst netjes kunt houden.

De doelkeuze selecteert **Gateway** (lokale goedkeuringen) of een **Node**. Nodes
moeten `system.execApprovals.get/set` adverteren (macOS-app of headless node-host).
Als een node nog geen uitvoeringsgoedkeuringen adverteert, bewerk dan lokaal
`~/.openclaw/exec-approvals.json` direct.

CLI: `openclaw approvals` ondersteunt bewerking voor Gateway of node (zie [Approvals CLI](/cli/approvals)).

## Toestemming stroom

Wanneer een prompt vereist is, broadcast de Gateway `exec.approval.requested` naar operatorclients.
De Control UI en macOS-app handelen dit af via `exec.approval.resolve`, waarna de Gateway de
goedgekeurde aanvraag doorstuurt naar de node-host.

Wanneer goedkeuringen vereist zijn, retourneert de exec-tool onmiddellijk met een goedkeurings-id. Gebruik die id om
latere systeemgebeurtenissen te correleren (`Exec finished` / `Exec denied`). Als er vóór de
timeout geen beslissing binnenkomt, wordt de aanvraag behandeld als een goedkeuringstime-out en weergegeven als een weigering.

Het bevestigingsdialoogvenster bevat:

- opdracht + argumenten
- cwd
- agent-id
- opgelost pad van het uitvoerbare bestand
- host- en beleidsmetadata

Acties:

- **Allow once** → nu uitvoeren
- **Always allow** → toevoegen aan toegestane lijst + uitvoeren
- **Deny** → blokkeren

## Goedkeuringen doorsturen naar chatkanalen

Je kunt prompts voor uitvoeringsgoedkeuringen doorsturen naar elk chatkanaal (inclusief pluginkanalenen) en ze goedkeuren
met `/approve`. Dit gebruikt de normale uitgaande leveringspipeline.

Config:

```json5
{
  approvals: {
    exec: {
      enabled: true,
      mode: "session", // "session" | "targets" | "both"
      agentFilter: ["main"],
      sessionFilter: ["discord"], // substring or regex
      targets: [
        { channel: "slack", to: "U12345678" },
        { channel: "telegram", to: "123456789" },
      ],
    },
  },
}
```

Antwoord in chat:

```
/approve <id> allow-once
/approve <id> allow-always
/approve <id> deny
```

### macOS IPC-stroom

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + approvals + system.run)
```

Beveiligingsnotities:

- Unix-socketmodus `0600`, token opgeslagen in `exec-approvals.json`.
- Controle op peer met dezelfde UID.
- Challenge/response (nonce + HMAC-token + request-hash) + korte TTL.

## Systeemgebeurtenissen

De exec-levenscyclus wordt weergegeven als systeemberichten:

- `Exec running` (alleen als de opdracht de drempel voor de running-notice overschrijdt)
- `Exec finished`
- `Exec denied`

Deze worden gepost naar de sessie van de agent nadat de node de gebeurtenis heeft gerapporteerd.
Uitvoeringsgoedkeuringen op de Gateway-host geven dezelfde levenscyclusgebeurtenissen af wanneer de opdracht is voltooid (en optioneel wanneer deze langer draait dan de drempel).
Execs met goedkeuringsvereiste hergebruiken de goedkeurings-id als de `runId` in deze berichten voor eenvoudige correlatie.

## Implicaties

- **full** is krachtig; geef waar mogelijk de voorkeur aan toegestane lijsten.
- **ask** houdt je betrokken terwijl snelle goedkeuringen mogelijk blijven.
- Toegestane lijsten per agent voorkomen dat goedkeuringen van de ene agent doorsijpelen naar andere.
- Goedkeuringen zijn alleen van toepassing op host-exec-aanvragen van **geautoriseerde afzenders**. Niet-geautoriseerde afzenders kunnen geen `/exec` uitgeven.
- `/exec security=full` is een sessie-niveau gemak voor geautoriseerde operators en slaat goedkeuringen bewust over.
  Om host-exec hard te blokkeren, stel de beveiliging voor goedkeuringen in op `deny` of weiger de `exec`-tool via toolbeleid.

Gerelateerd:

- [Exec tool](/tools/exec)
- [Elevated mode](/tools/elevated)
- [Skills](/tools/skills)
