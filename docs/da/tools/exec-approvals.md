---
summary: "Exec-godkendelser, tilladelseslister og prompts for sandbox-udbrud"
read_when:
  - Konfiguration af exec-godkendelser eller tilladelseslister
  - Implementering af exec-godkendelses-UX i macOS-appen
  - Gennemgang af prompts for sandbox-udbrud og konsekvenser
title: "Exec-godkendelser"
---

# Exec-godkendelser

Exec godkendelser er \*\* følgesvend app / node vært guardrail\*\* for at lade en sandboxed agent køre
kommandoer på en rigtig vært (`gateway` eller `node`). Tænk på det som en sikkerheds interlock:
kommandoer er kun tilladt, når policy + allowlist + (valgfri) brugergodkendelse alle er enige.
Exec godkendelser er \*\* i tillæg \*\* til værktøjspolitik og forhøjet gating (medmindre forhøjet er indstillet til `full`, som springer godkendelser).
Effektiv politik er den **strengere** af `tools.exec.*` og godkendelser standard; hvis et godkendelsesfelt udelades, anvendes `tools.exec` værdien.

Hvis companion-appens UI **ikke er tilgængelig**, afgøres enhver anmodning, der kræver en prompt, af **ask fallback** (standard: afvis).

## Hvor det gælder

Exec-godkendelser håndhæves lokalt på eksekveringsværten:

- **gateway-vært** → `openclaw`-proces på gateway-maskinen
- **node-vært** → node runner (macOS companion-app eller headless node host)

macOS-opdeling:

- **node host-tjeneste** videresender `system.run` til **macOS-appen** via lokal IPC.
- **macOS-app** håndhæver godkendelser + eksekverer kommandoen i UI-kontekst.

## Indstillinger og lagring

Godkendelser ligger i en lokal JSON-fil på eksekveringsværten:

`~/.openclaw/exec-approvals.json`

Eksempelskema:

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

## Politikknapper

### Sikkerhed (`exec.security`)

- **deny**: bloker alle host-exec-anmodninger.
- **allowlist**: tillad kun kommandoer på tilladelseslisten.
- **full**: tillad alt (svarende til elevated).

### Ask (`exec.ask`)

- **off**: spørg aldrig.
- **on-miss**: spørg kun, når tilladelseslisten ikke matcher.
- **always**: spørg ved hver kommando.

### Ask fallback (`askFallback`)

Hvis en prompt er påkrævet, men intet UI kan nås, afgør fallback:

- **deny**: bloker.
- **allowlist**: tillad kun hvis tilladelseslisten matcher.
- **full**: tillad.

## Tilladelsesliste (per agent)

Tilladslister er **pr. agent**. Hvis der findes flere agenter, skal du skifte hvilken agent, du er
-redigering i macOS-appen. Mønstre er **case-ufølsomme glob matches**.
Mønstre skal opløses til **binære stier** (kun basename-indgange ignoreres).
Legacy `agents.default` poster migreres til `agents.main` ved belastning.

Eksempler:

- `~/Projects/**/bin/peekaboo`
- `~/.local/bin/*`
- `/opt/homebrew/bin/rg`

Hver tilladelseslistepost sporer:

- **id** stabil UUID brugt til UI-identitet (valgfri)
- **last used** tidsstempel
- **last used command**
- **last resolved path**

## Auto-tillad skill-CLI’er

Når **Auto-tillad færdigheder CLI'er** er aktiveret, behandles eksekverbare eksekverbare som refereret af kendte færdigheder
som tilladt på noder (macOS node eller headless node host). Dette bruger
`skills.bins` over Gateway RPC til at hente den dygtige bin liste. Deaktivér dette, hvis du ønsker strenge manuelle tilladelseslister.

## Sikker-binære filer (kun stdin)

`tools.exec.safeBins` definerer en lille liste af **stdin-only** binære filer (for eksempel `jq`)
, der kan køre i tilladtlistetilstand **uden** eksplicitte tilladte poster. Sikker bins afviser
positionelle fil args og sti-lignende tokens, så de kun kan operere på den indgående strøm.
Shell kædning og omdirigeringer er ikke automatisk tilladt i tilladte tilstand.

Skalkædning (`&`, `~`, `;`) er tilladt, når hvert segment på øverste niveau opfylder tilladelseslisten
(herunder sikre bins eller færdighed auto-tilladelse). Omdirigeringer forbliver uunderstøttede i tillads-tilstand.
Kommandosubstitution (`$()` / backticks) afvises under den tilladte parsing, herunder inde i
dobbelte citationstegn; brug enkelte citationstegn, hvis du har brug for bogstavelig '$()\` tekst.

Standard safe bins: `jq`, `grep`, `cut`, `sort`, `uniq`, `head`, `tail`, `tr`, `wc`.

## Redigering i Control UI

Brug **Control UI → Nodes → Exec approvals**-kortet til at redigere standardværdier, per-agent
-overrides, og tillader. Vælg et anvendelsesområde (Standard eller en agent), justere politikken,
tilføje / fjerne tilladte mønstre, derefter **Gem**. Brugergrænsefladen viser \*\*sidst brugte \*\* metadata
pr. mønster, så du kan holde listen ryddet.

Målvælgeren vælger **Gateway** (lokale godkendelser) eller et **Node**. Nodes
skal annoncere `system.execApprovals.get/set` (macOS app eller hovedløs node vært).
Hvis en node ikke reklamerer exec godkendelser endnu, skal du redigere sin lokale
`~/.openclaw/exec-approvals.json` direkte.

CLI: `openclaw approvals` understøtter redigering af gateway eller node (se [Approvals CLI](/cli/approvals)).

## Godkendelsesflow

Når en prompt er påkrævet, gateway udsendelser `exec.approval.requested` til operatør klienter.
Control UI og macOS app løse det via `exec.approval.resolve`, derefter gatewayen fremad
godkendte anmodning til node værten.

Når der kræves godkendelser, returnerer exec værktøjet straks med et godkendelsesid. Brug dette id til
korrelerer senere systembegivenheder (`Exec færdiggjort` / `Exec nægtet`). Hvis der ikke træffes nogen afgørelse inden
-tidspunktet, behandles anmodningen som en godkendelsestimeout og dukkede op som en lammelsesgrund.

Bekræftelsesdialogen indeholder:

- kommando + argumenter
- cwd
- agent-id
- resolved sti til eksekverbar fil
- vært + politikmetadata

Handlinger:

- **Allow once** → kør nu
- **Always allow** → tilføj til tilladelsesliste + kør
- **Deny** → bloker

## Videresendelse af godkendelser til chatkanaler

Du kan videresende exec godkendelse beder til enhver chat kanal (herunder plugin kanaler) og godkende
dem med `/approve`. Dette bruger den normale udgående leveringsledning.

Konfiguration:

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

Svar i chat:

```
/approve <id> allow-once
/approve <id> allow-always
/approve <id> deny
```

### macOS IPC-flow

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + approvals + system.run)
```

Sikkerhedsnoter:

- Unix-socket-tilstand `0600`, token gemt i `exec-approvals.json`.
- Same-UID peer-check.
- Challenge/response (nonce + HMAC-token + request-hash) + kort TTL.

## Systemhændelser

Exec-livscyklussen vises som systembeskeder:

- `Exec running` (kun hvis kommandoen overskrider tærsklen for kører-notifikation)
- `Exec finished`
- `Exec denied`

Disse er udstationeret til agentens session efter node rapporterer begivenheden.
Gateway-host exec godkendelser udsender de samme livscyklusbegivenheder, når kommandoen er færdig (og valgfri, når de kører længere end tærsklen).
Godkendelse-gated udfører genbrug godkendelse id som `runId` i disse meddelelser for nem korrelation.

## Konsekvenser

- **full** er kraftfuld; foretræk tilladelseslister, når det er muligt.
- **ask** holder dig i loopet og muliggør stadig hurtige godkendelser.
- Tilladelseslister per agent forhindrer, at én agents godkendelser lækker til andre.
- Godkendelser gælder kun for host exec anmodninger fra **autoriserede afsender**. Uautoriserede afsendere kan ikke udstede `/exec`.
- `/exec security=full` er en bekvemmelighed på sessionsniveau for autoriserede operatører og springer godkendelser over efter design.
  Indstil sikkerheden til `benægt` eller benægte `exec` værktøjet til udførelse af hard-blok-vært, ved hjælp af værktøjspolitikken.

Relateret:

- [Exec tool](/tools/exec)
- [Elevated mode](/tools/elevated)
- [Skills](/tools/skills)
