---
summary: "Chrome-udvidelse: lad OpenClaw styre din eksisterende Chrome-fane"
read_when:
  - Du vil have agenten til at styre en eksisterende Chrome-fane (værktøjslinjeknap)
  - Du har brug for fjern-Gateway + lokal browserautomatisering via Tailscale
  - Du vil forstå sikkerhedsmæssige konsekvenser ved overtagelse af browseren
title: "Chrome-udvidelse"
---

# Chrome-udvidelse (browser-relæ)

OpenClaw Chrome-udvidelsen lader agenten styre dine **eksisterende Chrome-faner** (dit normale Chrome-vindue) i stedet for at starte en separat OpenClaw-administreret Chrome-profil.

Tilslutning/frakobling sker via **én enkelt Chrome-værktøjslinjeknap**.

## Hvad det er (koncept)

Der er tre dele:

- **Browser control service** (Gateway eller node): API’et som agenten/værktøjet kalder (via Gateway)
- **Local relay server** (loopback CDP): bygger bro mellem kontrolserveren og udvidelsen (standard: `http://127.0.0.1:18792`)
- **Chrome MV3-udvidelse**: tilkobler den aktive fane ved hjælp af `chrome.debugger` og videresender CDP-beskeder til relæet

OpenClaw styrer derefter den tilkoblede fane gennem den normale `browser`-værktøjsflade (ved at vælge den rigtige profil).

## Installér / indlæs (unpacked)

1. Installér udvidelsen til en stabil lokal sti:

```bash
openclaw browser extension install
```

2. Udskriv stien til den installerede udvidelsesmappe:

```bash
openclaw browser extension path
```

3. Chrome → `chrome://extensions`

- Aktivér “Developer mode”
- “Load unpacked” → vælg den mappe, der blev udskrevet ovenfor

4. Fastgør udvidelsen.

## Opdateringer (ingen build-trin)

Udvidelsen skibe inde i OpenClaw frigivelse (npm pakke) som statiske filer. Der er ingen separat “build” trin.

Efter opgradering af OpenClaw:

- Kør `openclaw browser extension install` igen for at opdatere de installerede filer under din OpenClaw-tilstandsmappe.
- Chrome → `chrome://extensions` → klik “Reload” på udvidelsen.

## Brug den (ingen ekstra konfiguration)

OpenClaw leveres med en indbygget browserprofil ved navn `chrome`, der peger på udvidelsesrelæet på standardporten.

Brug den:

- CLI: `openclaw browser --browser-profile chrome tabs`
- Agentværktøj: `browser` med `profile="chrome"`

Hvis du vil have et andet navn eller en anden relæport, kan du oprette din egen profil:

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

## Tilslut / frakobl (værktøjslinjeknap)

- Åbn den fane, du vil have OpenClaw til at styre.
- Klik på udvidelsesikonet.
  - Mærket viser `ON`, når den er tilsluttet.
- Klik igen for at frakoble.

## Hvilken fane styrer den?

- Den styrer **ikke** automatisk “den fane, du kigger på”.
- Den styrer **kun de faner, du eksplicit har tilsluttet** ved at klikke på værktøjslinjeknappen.
- For at skifte: åbn den anden fane og klik på udvidelsesikonet dér.

## Mærke + almindelige fejl

- `ON`: tilsluttet; OpenClaw kan styre den fane.
- `…`: forbinder til det lokale relæ.
- `!`: relæet kan ikke nås (oftest: browser-relæserveren kører ikke på denne maskine).

Hvis du ser `!`:

- Sørg for, at Gateway kører lokalt (standardopsætning), eller kør en node-vært på denne maskine, hvis Gateway kører et andet sted.
- Åbn udvidelsens indstillingsside; den viser, om relæet kan nås.

## Fjern-Gateway (brug en node-vært)

### Lokal Gateway (samme maskine som Chrome) — som regel **ingen ekstra trin**

Hvis Gateway kører på den samme maskine som Chrome, det starter browserens kontroltjeneste på loopback
og auto-starter relæserveren. Udvidelsen taler til den lokale relæ; CLI/tool opkald gå til Gateway.

### Fjern-Gateway (Gateway kører et andet sted) — **kør en node-vært**

Hvis din Gateway kører på en anden maskine, skal du starte en nodevært på den maskine, der kører Chrome.
Den Gateway vil proxy browser handlinger til det indholdselement; udvidelsen + relæ ophold lokalt til browsermaskinen.

Hvis flere noder er tilsluttet, kan du fastgøre én med `gateway.nodes.browser.node` eller sætte `gateway.nodes.browser.mode`.

## Sandboxing (værktøjscontainere)

Hvis din agent-session er sandboxed (`agents.defaults.sandbox.mode != "off"`), kan `browser`-værktøjet være begrænset:

- Som standard målretter sandboxed sessioner ofte **sandbox-browseren** (`target="sandbox"`), ikke din værts-Chrome.
- Overtagelse via Chrome-udvidelsesrelæ kræver kontrol over **værts** browser control service.

Muligheder:

- Nemst: brug udvidelsen fra en **ikke-sandboxed** session/agent.
- Eller tillad værtsbrowserkontrol for sandboxed sessioner:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

Sørg derefter for, at værktøjet ikke nægtes af værktøjspolitikken, og (om nødvendigt) kald `browser` med `target="host"`.

Fejlfinding: `openclaw sandbox explain`

## Tips til fjernadgang

- Hold Gateway og node-vært på samme tailnet; undgå at eksponere relæporte til LAN eller det offentlige internet.
- Par noder bevidst; deaktiver browser-proxy-routing, hvis du ikke vil have fjernstyring (`gateway.nodes.browser.mode="off"`).

## Sådan fungerer “extension path”

`openclaw browser extension path` udskriver den **installerede** mappe på disken, der indeholder udvidelsesfilerne.

CLI forsætligt gør \*\* ikke\*\* udskrive en `node_modules` sti. Altid køre `openclaw browser udvidelse install` først til at kopiere udvidelsen til en stabil placering under din OpenClaw stat mappe.

Hvis du flytter eller sletter den installationsmappe, vil Chrome markere udvidelsen som defekt, indtil du genindlæser den fra en gyldig sti.

## Sikkerhedsmæssige konsekvenser (læs dette)

Det er stærkt og risikabelt. Behandl det som at give modellen “hænder på din browser”.

- Udvidelsen bruger Chromes debugger API (`chrome.debugger`). Når den er fastgjort, kan modellen:
  - klikke/indtaste/navigere i den fane
  - læse sideindhold
  - få adgang til alt, hvad fanens indloggede session har adgang til
- **Dette er ikke isoleret** som den dedikerede OpenClaw-administrerede profil.
  - Hvis du tilslutter din daglige profil/fane, giver du adgang til den kontotilstand.

Anbefalinger:

- Foretræk en dedikeret Chrome-profil (adskilt fra din personlige browsing) til brug af udvidelsesrelæet.
- Hold Gateway og eventuelle node-værter tailnet-only; stol på Gateway-autentificering + node-parring.
- Undgå at eksponere relæporte over LAN (`0.0.0.0`) og undgå Funnel (offentlig).
- Relæet blokerer ikke-udvidelsesoprindelser og kræver et internt auth-token for CDP-klienter.

Relateret:

- Overblik over browser-værktøjet: [Browser](/tools/browser)
- Sikkerhedsrevision: [Security](/gateway/security)
- Tailscale-opsætning: [Tailscale](/gateway/tailscale)
