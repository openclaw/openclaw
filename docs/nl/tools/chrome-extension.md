---
summary: "Chrome-extensie: laat OpenClaw je bestaande Chrome-tab aansturen"
read_when:
  - Je wilt dat de agent een bestaande Chrome-tab aanstuurt (werkbalkknop)
  - Je hebt een externe Gateway + lokale browserautomatisering via Tailscale nodig
  - Je wilt de beveiligingsimplicaties van browserovername begrijpen
title: "Chrome-extensie"
---

# Chrome-extensie (browserrelais)

Met de OpenClaw Chrome-extensie kan de agent je **bestaande Chrome-tabs** (je normale Chrome-venster) bedienen in plaats van een apart door OpenClaw beheerd Chrome-profiel te starten.

Koppelen/ontkoppelen gebeurt via **één enkele Chrome-werkbalkknop**.

## Wat het is (concept)

Er zijn drie onderdelen:

- **Browser control service** (Gateway of node): de API die de agent/tool aanroept (via de Gateway)
- **Lokale relaisserver** (loopback CDP): vormt de brug tussen de control server en de extensie (`http://127.0.0.1:18792` standaard)
- **Chrome MV3-extensie**: koppelt aan de actieve tab met `chrome.debugger` en stuurt CDP-berichten door naar het relais

OpenClaw bestuurt vervolgens de gekoppelde tab via het normale `browser` tool-oppervlak (met selectie van het juiste profiel).

## Installeren / laden (unpacked)

1. Installeer de extensie naar een stabiel lokaal pad:

```bash
openclaw browser extension install
```

2. Print het pad van de geïnstalleerde extensiemap:

```bash
openclaw browser extension path
```

3. Chrome → `chrome://extensions`

- Schakel “Developer mode” in
- “Load unpacked” → selecteer de hierboven geprinte map

4. Pin de extensie.

## Updates (geen buildstap)

De extensie wordt meegeleverd in de OpenClaw-release (npm-pakket) als statische bestanden. Er is geen aparte “build”-stap.

Na het upgraden van OpenClaw:

- Voer `openclaw browser extension install` opnieuw uit om de geïnstalleerde bestanden onder je OpenClaw-statusmap te verversen.
- Chrome → `chrome://extensions` → klik “Reload” bij de extensie.

## Gebruik (geen extra configuratie)

OpenClaw wordt geleverd met een ingebouwd browserprofiel met de naam `chrome` dat het extensierelais op de standaardpoort gebruikt.

Gebruik het:

- CLI: `openclaw browser --browser-profile chrome tabs`
- Agent-tool: `browser` met `profile="chrome"`

Als je een andere naam of een andere relaispoort wilt, maak dan je eigen profiel:

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

## Koppelen / ontkoppelen (werkbalkknop)

- Open de tab die je door OpenClaw wilt laten bedienen.
- Klik op het extensiepictogram.
  - De badge toont `ON` wanneer gekoppeld.
- Klik opnieuw om te ontkoppelen.

## Welke tab wordt bestuurd?

- Het bestuurt **niet** automatisch “welke tab je ook bekijkt”.
- Het bestuurt **alleen de tab(s) die je expliciet hebt gekoppeld** door op de werkbalkknop te klikken.
- Wisselen: open de andere tab en klik daar op het extensiepictogram.

## Badge + veelvoorkomende fouten

- `ON`: gekoppeld; OpenClaw kan die tab aansturen.
- `…`: verbinding maken met het lokale relais.
- `!`: relais niet bereikbaar (meest voorkomend: de browserrelaisserver draait niet op deze machine).

Als je `!` ziet:

- Zorg dat de Gateway lokaal draait (standaardopzet), of start een node-host op deze machine als de Gateway elders draait.
- Open de Opties-pagina van de extensie; daar wordt getoond of het relais bereikbaar is.

## Externe Gateway (gebruik een node-host)

### Lokale Gateway (dezelfde machine als Chrome) — meestal **geen extra stappen**

Als de Gateway op dezelfde machine als Chrome draait, start deze de browser control service op loopback
en start automatisch de relaisserver. De extensie praat met het lokale relais; de CLI/tool-aanroepen gaan naar de Gateway.

### Externe Gateway (Gateway draait elders) — **start een node-host**

Als je Gateway op een andere machine draait, start dan een node-host op de machine waarop Chrome draait.
De Gateway proxyt browseracties naar die node; de extensie + het relais blijven lokaal op de browsermachine.

Als er meerdere nodes zijn verbonden, pin er één met `gateway.nodes.browser.node` of stel `gateway.nodes.browser.mode` in.

## Sandboxing (toolcontainers)

Als je agentsessie gesandboxed is (`agents.defaults.sandbox.mode != "off"`), kan de `browser` tool worden beperkt:

- Standaard richten gesandboxed sessies zich vaak op de **sandbox-browser** (`target="sandbox"`), niet op je host-Chrome.
- Overname via het Chrome-extensierelais vereist controle over de **host** browser control server.

Opties:

- Makkelijkst: gebruik de extensie vanuit een **niet-gesandboxed** sessie/agent.
- Of sta host-browserbesturing toe voor gesandboxed sessies:

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

Zorg er daarna voor dat de tool niet wordt geweigerd door het toolbeleid en (indien nodig) roep `browser` aan met `target="host"`.

Debuggen: `openclaw sandbox explain`

## Tips voor externe toegang

- Houd de Gateway en node-host op dezelfde tailnet; vermijd het blootstellen van relaispoorten aan LAN of het publieke internet.
- Koppel nodes bewust; schakel browser-proxyrouting uit als je geen externe besturing wilt (`gateway.nodes.browser.mode="off"`).

## Hoe “extension path” werkt

`openclaw browser extension path` print de **geïnstalleerde** map op schijf die de extensiebestanden bevat.

De CLI print bewust **geen** `node_modules`-pad. Voer altijd eerst `openclaw browser extension install` uit om de extensie naar een stabiele locatie onder je OpenClaw-statusmap te kopiëren.

Als je die installatiemap verplaatst of verwijdert, zal Chrome de extensie als defect markeren totdat je deze opnieuw laadt vanaf een geldig pad.

## Beveiligingsimplicaties (lees dit)

Dit is krachtig en riskant. Behandel het alsof je het model “handen op je browser” geeft.

- De extensie gebruikt Chrome’s debugger API (`chrome.debugger`). Wanneer gekoppeld, kan het model:
  - klikken/typen/navigeren in die tab
  - pagina-inhoud lezen
  - toegang krijgen tot alles waartoe de ingelogde sessie van die tab toegang heeft
- **Dit is niet geïsoleerd** zoals het speciale door OpenClaw beheerde profiel.
  - Als je koppelt aan je dagelijkse profiel/tab, verleen je toegang tot die accountstatus.

Aanbevelingen:

- Geef de voorkeur aan een speciaal Chrome-profiel (gescheiden van je persoonlijke browsen) voor gebruik met het extensierelais.
- Houd de Gateway en eventuele node-hosts uitsluitend op de tailnet; vertrouw op Gateway-authenticatie + node-koppeling.
- Vermijd het blootstellen van relaispoorten via LAN (`0.0.0.0`) en vermijd Funnel (publiek).
- Het relais blokkeert niet-extensie-oorsprongen en vereist een interne auth-token voor CDP-clients.

Gerelateerd:

- Overzicht van de browsertool: [Browser](/tools/browser)
- Beveiligingsaudit: [Security](/gateway/security)
- Tailscale-installatie: [Tailscale](/gateway/tailscale)
