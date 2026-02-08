---
summary: "Exec-godkendelser, tilladelseslister og prompts for sandbox-udbrud"
read_when:
  - Konfiguration af exec-godkendelser eller tilladelseslister
  - Implementering af exec-godkendelses-UX i macOS-appen
  - Gennemgang af prompts for sandbox-udbrud og konsekvenser
title: "Exec-godkendelser"
x-i18n:
  source_path: tools/exec-approvals.md
  source_hash: 66630b5d79671dd4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:00Z
---

# Exec-godkendelser

Exec-godkendelser er **companion-app / node host-sikkerhedsværnet** for at lade en sandboxet agent køre
kommandoer på en rigtig vært (`gateway` eller `node`). Tænk på det som en sikkerhedsafbryder:
kommandoer er kun tilladt, når politik + tilladelsesliste + (valgfri) bruger­godkendelse alle er enige.
Exec-godkendelser er **ud over** værktøjspolitik og forhøjet gating (medmindre elevated er sat til `full`, som springer godkendelser over).
Effektiv politik er den **strengeste** af `tools.exec.*` og standarderne for godkendelser; hvis et godkendelsesfelt udelades, bruges værdien `tools.exec`.

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

Tilladelseslister er **per agent**. Hvis der findes flere agenter, skift hvilken agent
du redigerer i macOS-appen. Mønstre er **versaluafhængige glob-match**.
Mønstre skal resolve til **binære stier** (poster kun med basename ignoreres).
Legacy `agents.default`-poster migreres til `agents.main` ved indlæsning.

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

Når **Auto-allow skill CLIs** er aktiveret, behandles eksekverbare filer, som refereres af kendte Skills,
som tilladte på noder (macOS-node eller headless node host). Dette bruger
`skills.bins` over Gateway RPC til at hente listen over skill-binære filer. Deaktiver dette, hvis du ønsker strenge manuelle tilladelseslister.

## Sikker-binære filer (kun stdin)

`tools.exec.safeBins` definerer en lille liste af **kun-stdin**-binære filer (for eksempel `jq`),
som kan køre i allowlist-tilstand **uden** eksplicitte tilladelseslisteposter. Safe bins afviser
positionelle filargumenter og sti-lignende tokens, så de kun kan arbejde på den indkommende strøm.
Shell-kædning og omdirigeringer auto-tillades ikke i allowlist-tilstand.

Shell-kædning (`&&`, `||`, `;`) er tilladt, når hvert topniveau-segment opfylder tilladelseslisten
(inklusive safe bins eller auto-tilladte Skills). Omdirigeringer forbliver ikke understøttet i allowlist-tilstand.
Kommandosubstitution (`$()` / backticks) afvises under allowlist-parsing, også inde i
dobbelte anførselstegn; brug enkelte anførselstegn, hvis du har brug for bogstavelig `$()`-tekst.

Standard safe bins: `jq`, `grep`, `cut`, `sort`, `uniq`, `head`, `tail`, `tr`, `wc`.

## Redigering i Control UI

Brug **Control UI → Nodes → Exec approvals**-kortet til at redigere standarder, per-agent
overrides og tilladelseslister. Vælg et scope (Standarder eller en agent), justér politikken,
tilføj/fjern tilladelseslistemønstre, og klik derefter **Save**. UI’et viser **last used**-metadata
per mønster, så du kan holde listen ryddelig.

Målvælgeren vælger **Gateway** (lokale godkendelser) eller en **Node**. Noder
skal annoncere `system.execApprovals.get/set` (macOS-app eller headless node host).
Hvis en node endnu ikke annoncerer exec-godkendelser, redigér dens lokale
`~/.openclaw/exec-approvals.json` direkte.

CLI: `openclaw approvals` understøtter redigering af gateway eller node (se [Approvals CLI](/cli/approvals)).

## Godkendelsesflow

Når en prompt er påkrævet, broadcaster gateway’en `exec.approval.requested` til operatørklienter.
Control UI og macOS-appen afgør den via `exec.approval.resolve`, hvorefter gateway’en videresender den
godkendte anmodning til node-værten.

Når godkendelser er påkrævet, returnerer exec-værktøjet straks med et godkendelses-id. Brug dette id til at
korrelere senere systemhændelser (`Exec finished` / `Exec denied`). Hvis der ikke ankommer en beslutning før
timeout, behandles anmodningen som en godkendelsestimeout og vises som en afvisningsårsag.

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

Du kan videresende exec-godkendelsesprompts til enhver chatkanal (inklusive plugin-kanaler) og godkende
dem med `/approve`. Dette bruger den normale udgående leveringspipeline.

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

Disse postes til agentens session, efter at noden har rapporteret hændelsen.
Gateway-værtens exec-godkendelser udsender de samme livscyklus-hændelser, når kommandoen afsluttes (og valgfrit når den kører længere end tærsklen).
Execs med godkendelseskrav genbruger godkendelses-id’et som `runId` i disse beskeder for nem korrelation.

## Konsekvenser

- **full** er kraftfuld; foretræk tilladelseslister, når det er muligt.
- **ask** holder dig i loopet og muliggør stadig hurtige godkendelser.
- Tilladelseslister per agent forhindrer, at én agents godkendelser lækker til andre.
- Godkendelser gælder kun for host-exec-anmodninger fra **autoriserede afsendere**. Uautoriserede afsendere kan ikke udstede `/exec`.
- `/exec security=full` er en sessionsniveau-bekvemmelighed for autoriserede operatører og springer godkendelser over per design.
  For at hårdblokkere host-exec skal du sætte godkendelsessikkerhed til `deny` eller afvise værktøjet `exec` via værktøjspolitik.

Relateret:

- [Exec tool](/tools/exec)
- [Elevated mode](/tools/elevated)
- [Skills](/tools/skills)
