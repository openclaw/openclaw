---
summary: "Exec-godkännanden, tillåtelselistor och sandbox‑escape‑prompter"
read_when:
  - Konfigurering av exec-godkännanden eller tillåtelselistor
  - Implementering av UX för exec-godkännanden i macOS-appen
  - Granskning av sandbox‑escape‑prompter och deras konsekvenser
title: "Exec-godkännanden"
x-i18n:
  source_path: tools/exec-approvals.md
  source_hash: 66630b5d79671dd4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:56Z
---

# Exec-godkännanden

Exec-godkännanden är **companion‑appens / node‑värdens skyddsräcke** för att låta en sandboxad agent köra
kommandon på en verklig värd (`gateway` eller `node`). Se det som ett säkerhetslås:
kommandon tillåts endast när policy + tillåtelselista + (valfritt) användargodkännande alla är överens.
Exec-godkännanden är **utöver** verktygspolicy och förhöjd spärr (såvida inte elevated är satt till `full`, vilket hoppar över godkännanden).
Effektiv policy är den **striktare** av `tools.exec.*` och standardvärden för godkännanden; om ett godkännandefält utelämnas används värdet `tools.exec`.

Om companion‑appens UI **inte är tillgängligt**, löses varje begäran som kräver en prompt
av **ask fallback** (standard: neka).

## Var det gäller

Exec-godkännanden tillämpas lokalt på exekveringsvärden:

- **gateway‑värd** → `openclaw`‑process på gateway‑maskinen
- **node‑värd** → node‑runner (macOS companion‑app eller headless node‑värd)

macOS‑uppdelning:

- **node‑värdtjänst** vidarebefordrar `system.run` till **macOS‑appen** via lokal IPC.
- **macOS‑appen** verkställer godkännanden + kör kommandot i UI‑kontext.

## Inställningar och lagring

Godkännanden lagras i en lokal JSON‑fil på exekveringsvärden:

`~/.openclaw/exec-approvals.json`

Exempelschema:

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

## Policyreglage

### Säkerhet (`exec.security`)

- **deny**: blockera alla host‑exec‑begäranden.
- **allowlist**: tillåt endast kommandon i tillåtelselistan.
- **full**: tillåt allt (motsvarar elevated).

### Ask (`exec.ask`)

- **off**: fråga aldrig.
- **on-miss**: fråga endast när tillåtelselistan inte matchar.
- **always**: fråga vid varje kommando.

### Ask fallback (`askFallback`)

Om en prompt krävs men inget UI kan nås avgör fallback:

- **deny**: blockera.
- **allowlist**: tillåt endast om tillåtelselistan matchar.
- **full**: tillåt.

## Tillåtelselista (per agent)

Tillåtelselistor är **per agent**. Om flera agenter finns, växla vilken agent du redigerar i macOS‑appen. Mönster är **skiftlägesokänsliga glob‑matchningar**.
Mönster ska lösas till **binärsökvägar** (poster med endast basnamn ignoreras).
Äldre `agents.default`‑poster migreras till `agents.main` vid inläsning.

Exempel:

- `~/Projects/**/bin/peekaboo`
- `~/.local/bin/*`
- `/opt/homebrew/bin/rg`

Varje tillåtelselistepost spårar:

- **id** stabil UUID som används för UI‑identitet (valfritt)
- **senast använd** tidsstämpel
- **senast använt kommando**
- **senast löst sökväg**

## Auto‑tillåt skill‑CLI:er

När **Auto‑allow skill CLIs** är aktiverat behandlas körbara filer som refereras av kända Skills
som tillåtna på noder (macOS‑node eller headless node‑värd). Detta använder
`skills.bins` över Gateway‑RPC för att hämta listan över skill‑binärer. Inaktivera detta om du vill ha strikta manuella tillåtelselistor.

## Säkra binärer (endast stdin)

`tools.exec.safeBins` definierar en liten lista med **endast‑stdin**‑binärer (till exempel `jq`)
som kan köras i allowlist‑läge **utan** explicita tillåtelselisteposter. Säkra binärer avvisar
positionella filargument och sökvägsliknande token, så de kan endast arbeta på inkommande ström.
Shell‑kedjning och omdirigeringar auto‑tillåts inte i allowlist‑läge.

Shell‑kedjning (`&&`, `||`, `;`) är tillåten när varje toppnivåsegment uppfyller tillåtelselistan
(inklusive säkra binärer eller auto‑tillåtna skills). Omdirigeringar förblir inte stödda i allowlist‑läge.
Kommandosubstitution (`$()` / backticks) avvisas under allowlist‑parsning, även inuti
dubbla citattecken; använd enkla citattecken om du behöver bokstavlig `$()`‑text.

Standard säkra binärer: `jq`, `grep`, `cut`, `sort`, `uniq`, `head`, `tail`, `tr`, `wc`.

## Redigering i Control UI

Använd kortet **Control UI → Nodes → Exec approvals** för att redigera standardvärden,
per‑agent‑överskrivningar och tillåtelselistor. Välj ett omfång (Standard eller en agent), justera policyn,
lägg till/ta bort tillåtelselistemönster och klicka sedan **Save**. UI:t visar metadata för **senast använd**
per mönster så att du kan hålla listan prydlig.

Målväljaren väljer **Gateway** (lokala godkännanden) eller en **Node**. Noder
måste annonsera `system.execApprovals.get/set` (macOS‑app eller headless node‑värd).
Om en node ännu inte annonserar exec‑godkännanden, redigera dess lokala
`~/.openclaw/exec-approvals.json` direkt.

CLI: `openclaw approvals` stöder redigering av gateway eller node (se [Approvals CLI](/cli/approvals)).

## Godkännandeflöde

När en prompt krävs sänder gatewayen `exec.approval.requested` till operatörsklienter.
Control UI och macOS‑appen löser den via `exec.approval.resolve`, därefter vidarebefordrar gatewayen den
godkända begäran till node‑värden.

När godkännanden krävs returnerar exec‑verktyget omedelbart med ett godkännandets id. Använd detta id för att
korrelera senare systemhändelser (`Exec finished` / `Exec denied`). Om inget beslut anländer före
timeout behandlas begäran som en timeout för godkännande och visas som ett avslagskäl.

Bekräftelsedialogen innehåller:

- kommando + argument
- cwd
- agent‑id
- löst sökväg till körbar fil
- värd‑ och policymetadata

Åtgärder:

- **Tillåt en gång** → kör nu
- **Tillåt alltid** → lägg till i tillåtelselistan + kör
- **Neka** → blockera

## Vidarebefordran av godkännanden till chattkanaler

Du kan vidarebefordra exec‑godkännandepromptar till valfri chattkanal (inklusive plugin‑kanaler) och godkänna
dem med `/approve`. Detta använder den normala utgående leveranspipelinen.

Konfig:

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

Svara i chatten:

```
/approve <id> allow-once
/approve <id> allow-always
/approve <id> deny
```

### macOS IPC‑flöde

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + approvals + system.run)
```

Säkerhetsnoteringar:

- Unix‑socket‑läge `0600`, token lagrad i `exec-approvals.json`.
- Kontroll av peer med samma UID.
- Challenge/response (nonce + HMAC‑token + begärans hash) + kort TTL.

## Systemhändelser

Exec‑livscykeln exponeras som systemmeddelanden:

- `Exec running` (endast om kommandot överskrider tröskeln för körningsnotis)
- `Exec finished`
- `Exec denied`

Dessa publiceras till agentens session efter att noden rapporterat händelsen.
Gateway‑värd‑exec‑godkännanden emitterar samma livscykelhändelser när kommandot avslutas (och valfritt när det kör längre än tröskeln).
Exec som är spärrade av godkännande återanvänder godkännandets id som `runId` i dessa meddelanden för enkel korrelation.

## Konsekvenser

- **full** är kraftfullt; föredra tillåtelselistor när det är möjligt.
- **ask** håller dig informerad samtidigt som snabba godkännanden tillåts.
- Tillåtelselistor per agent förhindrar att en agents godkännanden läcker till andra.
- Godkännanden gäller endast host‑exec‑begäranden från **auktoriserade avsändare**. Obehöriga avsändare kan inte utfärda `/exec`.
- `/exec security=full` är en sessionsnivå‑bekvämlighet för auktoriserade operatörer och hoppar över godkännanden avsiktligt.
  För att hårdblockera host‑exec, sätt godkännandenas säkerhet till `deny` eller neka verktyget `exec` via verktygspolicy.

Relaterat:

- [Exec‑verktyg](/tools/exec)
- [Förhöjt läge](/tools/elevated)
- [Skills](/tools/skills)
