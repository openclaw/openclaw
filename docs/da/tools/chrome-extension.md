---
summary: "Chrome-udvidelse: lad OpenClaw styre din eksisterende Chrome-fane"
read_when:
  - Du vil have agenten til at styre en eksisterende Chrome-fane (værktøjslinjeknap)
  - Du har brug for fjern-Gateway + lokal browserautomatisering via Tailscale
  - Du vil forstå sikkerhedsmæssige konsekvenser ved overtagelse af browseren
title: "Chrome-udvidelse"
x-i18n:
  source_path: tools/chrome-extension.md
  source_hash: 3b77bdad7d3dab6a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:49Z
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

Udvidelsen leveres sammen med OpenClaw-udgivelsen (npm-pakken) som statiske filer. Der er intet separat “build”-trin.

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

Hvis Gateway kører på samme maskine som Chrome, starter den browser control service på loopback
og starter automatisk relæserveren. Udvidelsen taler med det lokale relæ; CLI-/værktøjskald går til Gateway.

### Fjern-Gateway (Gateway kører et andet sted) — **kør en node-vært**

Hvis din Gateway kører på en anden maskine, skal du starte en node-vært på den maskine, der kører Chrome.
Gateway vil proxy browserhandlinger til den node; udvidelsen + relæet forbliver lokale på browsermaskinen.

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

CLI’en udskriver bevidst **ikke** en `node_modules`-sti. Kør altid `openclaw browser extension install` først for at kopiere udvidelsen til en stabil placering under din OpenClaw-tilstandsmappe.

Hvis du flytter eller sletter den installationsmappe, vil Chrome markere udvidelsen som defekt, indtil du genindlæser den fra en gyldig sti.

## Sikkerhedsmæssige konsekvenser (læs dette)

Dette er kraftfuldt og risikabelt. Betragt det som at give modellen “hænder på din browser”.

- Udvidelsen bruger Chromes debugger-API (`chrome.debugger`). Når den er tilsluttet, kan modellen:
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
