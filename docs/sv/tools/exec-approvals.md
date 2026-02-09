---
summary: "Exec-godkännanden, tillåtelselistor och sandbox‑escape‑prompter"
read_when:
  - Konfigurering av exec-godkännanden eller tillåtelselistor
  - Implementering av UX för exec-godkännanden i macOS-appen
  - Granskning av sandbox‑escape‑prompter och deras konsekvenser
title: "Exec-godkännanden"
---

# Exec-godkännanden

Exec godkännanden är **följeslagare app / nod värd skyddsdrail** för att låta en sandlåda agent köra
kommandon på en riktig värd (`gateway` eller `node`). Tänk på det som ett säkerhetsinterlock:
-kommandon tillåts endast när policyn + tillåten lista + (frivillig) användargodkännande alla är överens.
Exec godkännanden är \*\*dessutom \*\* till verktygspolicyn och förhöjd gating (om inte förhöjt är satt till `full`, vilket hoppar över godkännanden).
Effektiv policy är **striktare** av `tools.exec.*` och godkännanden standard; om ett godkännandefält utelämnas används `tools.exec`-värdet.

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

Allowlists är **per agent**. Om flera agenter finns, byt vilken agent du är
redigering i macOS-appen. Mönster är **skiftlägesokänsliga glob matchningar**.
Mönster ska lösa **binära sökvägar** (endast basnamn ignoreras).
Äldre `agents.default` poster migreras till `agents.main` vid laddning.

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

När **Auto-allow skill CLI:er** är aktiverad, körs som refereras av kända färdigheter
behandlas som tillåtna på noder (macOS nod eller huvudlös nod värd). Detta använder
`skills.bins` över Gateway RPC för att hämta listan över skicklighetsbrickor. Inaktivera detta om du vill ha strikt manuell tillåtna listor.

## Säkra binärer (endast stdin)

`tools.exec.safeBins` definierar en liten lista med **stdin-only** binärer (till exempel `jq`)
som kan köras i allowlist-läge \*\*utan explicita tillåtna listposter. Safe bins avvisa
positionsfil args och sökvägs-liknande tokens, så att de bara kan fungera på den inkommande strömmen.
Shell kedja och omdirigering är inte automatiskt tillåtna i tillåten lista.

Shell chaining (`&&`, `<unk> `, `;`) är tillåten när varje toppsegment uppfyller den tillåtna listan
(inklusive säkra papperskorgar eller automatisk skicklighet). Omdirigeringar stöds inte i allowliste-läge.
Kommandosubstitution (`$()` / backticks) avvisas under allowlist parsing, inklusive inuti
dubbelcitattecken; använd enstaka citat om du behöver bokstavlig `$()` text.

Standard säkra binärer: `jq`, `grep`, `cut`, `sort`, `uniq`, `head`, `tail`, `tr`, `wc`.

## Redigering i Control UI

Använd **Control UI → Noder → Exec godkännanden** kort för att redigera standardinställningar, per-agent
åsidosättningar och tillåta listor. Välj ett omfång (standard eller agent), justera policyn,
lägga till/ta bort tillåtna mönster, sedan **Spara**. UI visar **senast användda** metadata
per mönster så att du kan hålla listan prydlig.

Målväljaren väljer **Gateway** (lokala godkännanden) eller en **Node**. Noder
måste annonsera `system.execApprovals.get/set` (macOS app eller headless nod host).
Om en nod inte annonserar exec godkännanden ännu, redigera dess lokala
`~/.openclaw/exec-approvals.json` direkt.

CLI: `openclaw approvals` stöder redigering av gateway eller node (se [Approvals CLI](/cli/approvals)).

## Godkännandeflöde

När en fråga krävs sänder gatewayen `exec.approval.requested` till operatörsklienter.
Appen Control UI och macOS löser det via `exec.approval.resolve`, och sedan vidarebefordrar gateway
godkänd begäran till noden värd.

När godkännanden krävs returnerar exec verktyget omedelbart med ett godkännande-id. Använd det id till
korrelerar senare systemhändelser (`Exec finished` / `Exec denied`). Om inget beslut kommer före
-timeout, behandlas begäran som en tidsgräns för godkännande och uppkommer som ett förnekande skäl.

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

Du kan vidarebefordra uppmaningar om godkännande av exec till alla chattkanaler (inklusive instickskanaler) och godkänna
dem med `/approve`. Detta använder den normala utgående leveransrörledningen.

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

Dessa postas till agentens session efter noden rapporterar händelsen.
Gateway-host exec godkänner avger samma livscykelhändelser när kommandot avslutas (och eventuellt när det körs längre än tröskeln).
Godkännande-gated execs återanvänder godkännande-id som `runId` i dessa meddelanden för enkel korrelation.

## Konsekvenser

- **full** är kraftfullt; föredra tillåtelselistor när det är möjligt.
- **ask** håller dig informerad samtidigt som snabba godkännanden tillåts.
- Tillåtelselistor per agent förhindrar att en agents godkännanden läcker till andra.
- Godkännanden gäller endast värdförfrågningar från **auktoriserade avsändare**. Obehöriga avsändare kan inte utfärda `/exec`.
- `/exec security=full` är en sessionsnivå bekvämlighet för auktoriserade operatörer och hoppar över godkännanden av design.
  För att hårt blockera värdkörning, ange godkännanden av säkerhet till `deny` eller neka `exec`-verktyget via verktygspolicyn.

Relaterat:

- [Exec‑verktyg](/tools/exec)
- [Förhöjt läge](/tools/elevated)
- [Skills](/tools/skills)
