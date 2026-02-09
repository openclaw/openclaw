---
summary: "Chrome-tillägg: låt OpenClaw styra din befintliga Chrome-flik"
read_when:
  - Du vill att agenten ska styra en befintlig Chrome-flik (verktygsfältsknapp)
  - Du behöver fjärr-Gateway + lokal webbläsarautomatisering via Tailscale
  - Du vill förstå säkerhetsimplikationerna av webbläsarövertagande
title: "Chrome-tillägg"
---

# Chrome-tillägg (webbläsarrelä)

OpenClaws Chrome-tillägg låter agenten styra dina **befintliga Chrome-flikar** (ditt vanliga Chrome-fönster) i stället för att starta en separat openclaw-hanterad Chrome-profil.

Anslutning/frånkoppling sker via **en enda knapp i Chromes verktygsfält**.

## Vad det är (koncept)

Det finns tre delar:

- **Webbläsarkontrolltjänst** (Gateway eller nod): API:t som agenten/verktyget anropar (via Gateway)
- **Lokalt reläserver** (loopback CDP): brygga mellan kontrollservern och tillägget (`http://127.0.0.1:18792` som standard)
- **Chrome MV3-tillägg**: ansluter till den aktiva fliken med `chrome.debugger` och skickar CDP-meddelanden till reläet

OpenClaw styr sedan den anslutna fliken via den vanliga verktygsytan `browser` (genom att välja rätt profil).

## Installera / ladda (opackat)

1. Installera tillägget till en stabil lokal sökväg:

```bash
openclaw browser extension install
```

2. Skriv ut sökvägen till den installerade tilläggskatalogen:

```bash
openclaw browser extension path
```

3. Chrome → `chrome://extensions`

- Aktivera ”Developer mode”
- ”Load unpacked” → välj katalogen som skrevs ut ovan

4. Fäst tillägget.

## Uppdateringar (inget byggsteg)

Tillägget fartyg inuti OpenClaw release (npm paket) som statiska filer. Det finns inget separat “bygga” steg.

Efter uppgradering av OpenClaw:

- Kör `openclaw browser extension install` igen för att uppdatera de installerade filerna under din OpenClaw-tillståndskatalog.
- Chrome → `chrome://extensions` → klicka ”Reload” på tillägget.

## Använd det (ingen extra konfig)

OpenClaw levereras med en inbyggd webbläsarprofil med namnet `chrome` som riktar sig mot tilläggsreläet på standardporten.

Använd den:

- CLI: `openclaw browser --browser-profile chrome tabs`
- Agentverktyg: `browser` med `profile="chrome"`

Om du vill ha ett annat namn eller en annan reläport, skapa din egen profil:

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

## Anslut / koppla från (verktygsfältsknapp)

- Öppna fliken du vill att OpenClaw ska styra.
- Klicka på tilläggsikonen.
  - Märket visar `ON` när den är ansluten.
- Klicka igen för att koppla från.

## Vilken flik styrs?

- Den styr **inte** automatiskt ”vilken flik du tittar på”.
- Den styr **endast de flikar du uttryckligen har anslutit** genom att klicka på verktygsfältsknappen.
- För att byta: öppna den andra fliken och klicka på tilläggsikonen där.

## Märke + vanliga fel

- `ON`: ansluten; OpenClaw kan styra den fliken.
- `…`: ansluter till det lokala reläet.
- `!`: reläet är inte nåbart (vanligast: webbläsarreläserven körs inte på den här maskinen).

Om du ser `!`:

- Säkerställ att Gateway körs lokalt (standardupplägg), eller kör en nodvärd på den här maskinen om Gateway körs någon annanstans.
- Öppna tilläggets inställningssida; den visar om reläet är nåbart.

## Fjärr-Gateway (använd en nodvärd)

### Lokal Gateway (samma maskin som Chrome) — vanligtvis **inga extra steg**

Om Gateway körs på samma maskin som Chrome startar den webbläsarens kontrolltjänst på loopback
och startar reläservern automatiskt. Förlängningen samtal till det lokala reläet; CLI/tool samtal gå till Gateway.

### Fjärr-Gateway (Gateway körs någon annanstans) — **kör en nodvärd**

Om din Gateway körs på en annan maskin, starta en nod värd på maskinen som kör Chrome.
Gateway kommer proxy webbläsare åtgärder till den noden, förlängning + relä stanna lokal till webbläsarmaskinen.

Om flera noder är anslutna, fäst en med `gateway.nodes.browser.node` eller sätt `gateway.nodes.browser.mode`.

## Sandboxing (verktygscontainrar)

Om din agentsession är sandboxed (`agents.defaults.sandbox.mode != "off"`) kan verktyget `browser` vara begränsat:

- Som standard riktar sandboxade sessioner ofta in sig på **sandbox-webbläsaren** (`target="sandbox"`), inte din värd-Chrome.
- Övertagande via Chrome-tilläggets relä kräver kontroll av **värdens** webbläsarkontrollserver.

Alternativ:

- Enklast: använd tillägget från en **icke-sandboxad** session/agent.
- Eller tillåt värdwebbläsarkontroll för sandboxade sessioner:

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

Säkerställ sedan att verktyget inte nekas av verktygspolicyn och (vid behov) anropa `browser` med `target="host"`.

Felsökning: `openclaw sandbox explain`

## Tips för fjärråtkomst

- Håll Gateway och nodvärd på samma tailnet; undvik att exponera reläportar mot LAN eller publika internet.
- Para noder avsiktligt; inaktivera webbläsarproxy-routing om du inte vill ha fjärrstyrning (`gateway.nodes.browser.mode="off"`).

## Hur ”extension path” fungerar

`openclaw browser extension path` skriver ut den **installerade** katalogen på disk som innehåller tilläggsfilerna.

CLI skriver medvetet **inte** ut en `node_modules`-sökväg. Kör alltid `openclaw browser extension install` först att kopiera tillägget till en stabil plats under din OpenClaw state katalog.

Om du flyttar eller tar bort den installationskatalogen kommer Chrome att markera tillägget som trasigt tills du laddar om det från en giltig sökväg.

## Säkerhetsimplikationer (läs detta)

Detta är kraftfullt och riskabelt. Behandla det som att ge modellen “händerna på din webbläsare”.

- Tillägget använder Chromes debugger API (`chrome.debugger`). När den bifogas kan modellen:
  - klicka/skriva/navigera i den fliken
  - läsa sidinnehåll
  - komma åt allt som flikens inloggade session har åtkomst till
- **Detta är inte isolerat** som den dedikerade openclaw-hanterade profilen.
  - Om du ansluter till din dagliga profil/flik ger du åtkomst till det kontotillståndet.

Rekommendationer:

- Föredra en dedikerad Chrome-profil (separat från din personliga surfning) för användning med tilläggsrelä.
- Håll Gateway och eventuella nodvärdar endast på tailnet; förlita dig på Gateway-autentisering + nodparning.
- Undvik att exponera reläportar över LAN (`0.0.0.0`) och undvik Funnel (publik).
- Reläet blockerar ursprung som inte är tillägg och kräver en intern autentiseringstoken för CDP-klienter.

Relaterat:

- Översikt över webbläsarverktyg: [Browser](/tools/browser)
- Säkerhetsgranskning: [Security](/gateway/security)
- Tailscale-konfigurering: [Tailscale](/gateway/tailscale)
