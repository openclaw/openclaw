---
summary: "Geïntegreerde browserbesturingsservice + actieopdrachten"
read_when:
  - Browserautomatisering toevoegen die door een agent wordt bestuurd
  - Debuggen waarom OpenClaw interfereert met je eigen Chrome
  - Browserinstellingen + levenscyclus implementeren in de macOS-app
title: "Browser (door OpenClaw beheerd)"
---

# Browser (door openclaw beheerd)

OpenClaw kan een **toegewijd Chrome/Brave/Edge/Chromium-profiel** draaien dat door de agent wordt bestuurd.
Het is geïsoleerd van je persoonlijke browser en wordt beheerd via een kleine lokale
control service binnen de Gateway (alleen loopback).

Beginnerweergave:

- Zie het als een **aparte, agent-only browser**.
- Het `openclaw`-profiel raakt je persoonlijke browserprofiel **niet** aan.
- De agent kan **tabbladen openen, pagina’s lezen, klikken en typen** in een veilige omgeving.
- Het standaard `chrome`-profiel gebruikt de **systeemstandaard Chromium-browser** via de
  extension relay; schakel naar `openclaw` voor de geïsoleerde beheerde browser.

## Wat je krijgt

- Een apart browserprofiel met de naam **openclaw** (standaard met oranje accent).
- Deterministische tabbladbesturing (lijst/openen/focussen/sluiten).
- Agentacties (klikken/typen/slepen/selecteren), snapshots, screenshots, PDF’s.
- Optionele ondersteuning voor meerdere profielen (`openclaw`, `work`, `remote`, ...).

Deze browser is **niet** je dagelijkse browser. Het is een veilig, geïsoleerd oppervlak voor
agentautomatisering en verificatie.

## Snelle start

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

Als je “Browser disabled” krijgt, schakel deze in de config in (zie hieronder) en herstart de
Gateway.

## Profielen: `openclaw` vs `chrome`

- `openclaw`: beheerde, geïsoleerde browser (geen extensie vereist).
- `chrome`: extension relay naar je **systeembrowser** (vereist dat de OpenClaw-
  extensie aan een tabblad is gekoppeld).

Stel `browser.defaultProfile: "openclaw"` in als je de beheerde modus standaard wilt gebruiken.

## Configuratie

Browserinstellingen staan in `~/.openclaw/openclaw.json`.

```json5
{
  browser: {
    enabled: true, // default: true
    // cdpUrl: "http://127.0.0.1:18792", // legacy single-profile override
    remoteCdpTimeoutMs: 1500, // remote CDP HTTP timeout (ms)
    remoteCdpHandshakeTimeoutMs: 3000, // remote CDP WebSocket handshake timeout (ms)
    defaultProfile: "chrome",
    color: "#FF4500",
    headless: false,
    noSandbox: false,
    attachOnly: false,
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    profiles: {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
      work: { cdpPort: 18801, color: "#0066CC" },
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" },
    },
  },
}
```

Notities:

- De browser control service bindt aan loopback op een poort afgeleid van `gateway.port`
  (standaard: `18791`, wat gateway + 2 is). De relay gebruikt de volgende poort (`18792`).
- Als je de Gateway-poort overschrijft (`gateway.port` of `OPENCLAW_GATEWAY_PORT`),
  verschuiven de afgeleide browserpoorten om in dezelfde “familie” te blijven.
- `cdpUrl` gebruikt standaard de relaypoort wanneer niet ingesteld.
- `remoteCdpTimeoutMs` geldt voor remote (niet-loopback) CDP-bereikbaarheidschecks.
- `remoteCdpHandshakeTimeoutMs` geldt voor remote CDP WebSocket-bereikbaarheidschecks.
- `attachOnly: true` betekent “start nooit een lokale browser; alleen koppelen als deze al draait.”
- `color` + per-profiel `color` kleuren de browser-UI zodat je ziet welk profiel actief is.
- Het standaardprofiel is `chrome` (extension relay). Gebruik `defaultProfile: "openclaw"` voor de beheerde browser.
- Auto-detectievolgorde: systeembrowser als die op Chromium is gebaseerd; anders Chrome → Brave → Edge → Chromium → Chrome Canary.
- Lokale `openclaw`-profielen wijzen automatisch `cdpPort`/`cdpUrl` toe — stel die alleen in voor remote CDP.

## Brave gebruiken (of een andere Chromium-browser)

Als je **systeemstandaard** browser op Chromium is gebaseerd (Chrome/Brave/Edge/etc),
gebruikt OpenClaw die automatisch. Stel `browser.executablePath` in om
auto-detectie te overschrijven:

CLI-voorbeeld:

```bash
openclaw config set browser.executablePath "/usr/bin/google-chrome"
```

```json5
// macOS
{
  browser: {
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  }
}

// Windows
{
  browser: {
    executablePath: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
  }
}

// Linux
{
  browser: {
    executablePath: "/usr/bin/brave-browser"
  }
}
```

## Lokale vs. remote besturing

- **Lokale besturing (standaard):** de Gateway start de loopback control service en kan een lokale browser starten.
- **Remote besturing (node-host):** draai een node-host op de machine met de browser; de Gateway proxyt browseracties daarheen.
- **Remote CDP:** stel `browser.profiles.<name>.cdpUrl` (of `browser.cdpUrl`) in om
  aan een remote Chromium-browser te koppelen. In dit geval start OpenClaw geen lokale browser.

Remote CDP-URL’s kunnen authenticatie bevatten:

- Querytokens (bijv. `https://provider.example?token=<token>`)
- HTTP Basic auth (bijv. `https://user:pass@provider.example`)

OpenClaw behoudt de auth bij het aanroepen van `/json/*`-endpoints en bij het verbinden
met de CDP WebSocket. Gebruik bij voorkeur omgevingsvariabelen of secrets managers voor
tokens in plaats van ze in configbestanden vast te leggen.

## Node browser proxy (zero-config standaard)

Als je een **node-host** draait op de machine met je browser, kan OpenClaw
browser-toolcalls automatisch naar die node routeren zonder extra browserconfig.
Dit is het standaardpad voor remote gateways.

Notities:

- De node-host stelt zijn lokale browser control server beschikbaar via een **proxy-opdracht**.
- Profielen komen uit de eigen `browser.profiles`-config van de node (hetzelfde als lokaal).
- Uitschakelen als je dit niet wilt:
  - Op de node: `nodeHost.browserProxy.enabled=false`
  - Op de gateway: `gateway.nodes.browser.mode="off"`

## Browserless (gehoste remote CDP)

[Browserless](https://browserless.io) is een gehoste Chromium-service die
CDP-endpoints via HTTPS aanbiedt. Je kunt een OpenClaw-browserprofiel naar een
Browserless-regio-endpoint laten wijzen en authenticeren met je API-sleutel.

Voorbeeld:

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "browserless",
    remoteCdpTimeoutMs: 2000,
    remoteCdpHandshakeTimeoutMs: 4000,
    profiles: {
      browserless: {
        cdpUrl: "https://production-sfo.browserless.io?token=<BROWSERLESS_API_KEY>",
        color: "#00AA00",
      },
    },
  },
}
```

Notities:

- Vervang `<BROWSERLESS_API_KEY>` door je echte Browserless-token.
- Kies het regio-endpoint dat past bij je Browserless-account (zie hun documentatie).

## Beveiliging

Sleutel ideeën:

- Browserbesturing is alleen loopback; toegang loopt via de Gateway-authenticatie of node-koppeling.
- Houd de Gateway en eventuele node-hosts op een privénetwerk (Tailscale); vermijd publieke blootstelling.
- Behandel remote CDP-URL’s/tokens als geheimen; gebruik bij voorkeur env vars of een secrets manager.

Remote CDP-tips:

- Geef waar mogelijk de voorkeur aan HTTPS-endpoints en kortlevende tokens.
- Vermijd het direct insluiten van langlevende tokens in configbestanden.

## Profielen (meerdere browsers)

OpenClaw ondersteunt meerdere benoemde profielen (routeringsconfiguraties). Profielen kunnen zijn:

- **openclaw-managed**: een toegewijde Chromium-browserinstantie met eigen user data directory + CDP-poort
- **remote**: een expliciete CDP-URL (Chromium-browser die elders draait)
- **extension relay**: je bestaande Chrome-tabbladen via de lokale relay + Chrome-extensie

Standaarden:

- Het `openclaw`-profiel wordt automatisch aangemaakt als het ontbreekt.
- Het `chrome`-profiel is ingebouwd voor de Chrome extension relay (wijst standaard naar `http://127.0.0.1:18792`).
- Lokale CDP-poorten worden standaard toegewezen uit **18800–18899**.
- Het verwijderen van een profiel verplaatst de lokale datadirectory naar de prullenmand.

Alle control endpoints accepteren `?profile=<name>`; de CLI gebruikt `--browser-profile`.

## Chrome extension relay (gebruik je bestaande Chrome)

OpenClaw kan ook **je bestaande Chrome-tabbladen** aansturen (geen aparte “openclaw” Chrome-instantie)
via een lokale CDP relay + een Chrome-extensie.

Volledige gids: [Chrome extension](/tools/chrome-extension)

Stroom:

- De Gateway draait lokaal (dezelfde machine) of een node-host draait op de browsermachine.
- Een lokale **relayserver** luistert op een loopback `cdpUrl` (standaard: `http://127.0.0.1:18792`).
- Je klikt op het extensiepictogram **OpenClaw Browser Relay** op een tabblad om te koppelen (het koppelt niet automatisch).
- De agent bestuurt dat tabblad via de normale `browser`-tool, door het juiste profiel te selecteren.

Als de Gateway elders draait, start dan een node-host op de browsermachine zodat de Gateway browseracties kan proxieën.

### Gesandboxte sessies

Als de agentsessie gesandboxed is, kan de `browser`-tool standaard naar `target="sandbox"` (sandboxbrowser) gaan.
Overname via de Chrome extension relay vereist hostbrowserbesturing, dus:

- draai de sessie ongesandboxed, of
- stel `agents.defaults.sandbox.browser.allowHostControl: true` in en gebruik `target="host"` bij het aanroepen van de tool.

### Installatie

1. Laad de extensie (dev/unpacked):

```bash
openclaw browser extension install
```

- Chrome → `chrome://extensions` → schakel “Developer mode” in
- “Load unpacked” → selecteer de directory die door `openclaw browser extension path` wordt weergegeven
- Pin de extensie en klik erop op het tabblad dat je wilt besturen (badge toont `ON`).

2. Gebruik het:

- CLI: `openclaw browser --browser-profile chrome tabs`
- Agenttool: `browser` met `profile="chrome"`

Optioneel: als je een andere naam of relaypoort wilt, maak je eigen profiel:

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

Notities:

- Deze modus vertrouwt voor de meeste bewerkingen op Playwright-on-CDP (screenshots/snapshots/acties).
- Ontkoppelen doe je door opnieuw op het extensiepictogram te klikken.

## Isolatiegaranties

- **Toegewijde user data dir**: raakt je persoonlijke browserprofiel nooit aan.
- **Toegewijde poorten**: vermijdt `9222` om botsingen met dev-workflows te voorkomen.
- **Deterministische tabbladbesturing**: richt tabbladen op `targetId`, niet op “laatste tabblad”.

## Browserselectie

Bij lokaal starten kiest OpenClaw de eerste beschikbare:

1. Chrome
2. Brave
3. Edge
4. Chromium
5. Chrome Canary

Je kunt dit overschrijven met `browser.executablePath`.

Platformen:

- macOS: controleert `/Applications` en `~/Applications`.
- Linux: zoekt naar `google-chrome`, `brave`, `microsoft-edge`, `chromium`, enz.
- Windows: controleert veelvoorkomende installatielocaties.

## Control API (optioneel)

Alleen voor lokale integraties stelt de Gateway een kleine loopback HTTP-API beschikbaar:

- Status/start/stop: `GET /`, `POST /start`, `POST /stop`
- Tabbladen: `GET /tabs`, `POST /tabs/open`, `POST /tabs/focus`, `DELETE /tabs/:targetId`
- Snapshot/screenshot: `GET /snapshot`, `POST /screenshot`
- Acties: `POST /navigate`, `POST /act`
- Hooks: `POST /hooks/file-chooser`, `POST /hooks/dialog`
- Downloads: `POST /download`, `POST /wait/download`
- Debugging: `GET /console`, `POST /pdf`
- Debugging: `GET /errors`, `GET /requests`, `POST /trace/start`, `POST /trace/stop`, `POST /highlight`
- Netwerk: `POST /response/body`
- Status: `GET /cookies`, `POST /cookies/set`, `POST /cookies/clear`
- Status: `GET /storage/:kind`, `POST /storage/:kind/set`, `POST /storage/:kind/clear`
- Instellingen: `POST /set/offline`, `POST /set/headers`, `POST /set/credentials`, `POST /set/geolocation`, `POST /set/media`, `POST /set/timezone`, `POST /set/locale`, `POST /set/device`

Alle endpoints accepteren `?profile=<name>`.

### Playwright-vereiste

Sommige functies (navigeren/acteren/AI-snapshot/rolesnapshot, elementscreenshots, PDF)
vereisen Playwright. Als Playwright niet is geïnstalleerd, geven die endpoints een duidelijke
501-fout. ARIA-snapshots en basis-screenshots werken nog steeds voor door openclaw beheerde Chrome.
Voor de Chrome extension relay-driver vereisen ARIA-snapshots en screenshots Playwright.

Als je `Playwright is not available in this gateway build` ziet, installeer het volledige
Playwright-pakket (niet `playwright-core`) en herstart de gateway, of installeer
OpenClaw opnieuw met browserondersteuning.

#### Docker Playwright-installatie

Als je Gateway in Docker draait, vermijd `npx playwright` (npm override-conflicten).
Gebruik in plaats daarvan de gebundelde CLI:

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

Om browserdownloads te behouden, stel `PLAYWRIGHT_BROWSERS_PATH` in (bijvoorbeeld
`/home/node/.cache/ms-playwright`) en zorg dat `/home/node` wordt behouden via
`OPENCLAW_HOME_VOLUME` of een bind mount. Zie [Docker](/install/docker).

## Hoe het werkt (intern)

Stroom op hoog niveau:

- Een kleine **control server** accepteert HTTP-verzoeken.
- Deze verbindt met Chromium-browsers (Chrome/Brave/Edge/Chromium) via **CDP**.
- Voor geavanceerde acties (klikken/typen/snapshot/PDF) gebruikt hij **Playwright** bovenop
  CDP.
- Wanneer Playwright ontbreekt, zijn alleen niet-Playwright-bewerkingen beschikbaar.

Dit ontwerp houdt de agent op een stabiele, deterministische interface terwijl je
lokale/remote browsers en profielen kunt wisselen.

## CLI snelle referentie

Alle opdrachten accepteren `--browser-profile <name>` om een specifiek profiel te targeten.
Alle opdrachten accepteren ook `--json` voor machineleesbare uitvoer (stabiele payloads).

Basis:

- `openclaw browser status`
- `openclaw browser start`
- `openclaw browser stop`
- `openclaw browser tabs`
- `openclaw browser tab`
- `openclaw browser tab new`
- `openclaw browser tab select 2`
- `openclaw browser tab close 2`
- `openclaw browser open https://example.com`
- `openclaw browser focus abcd1234`
- `openclaw browser close abcd1234`

Inspectie:

- `openclaw browser screenshot`
- `openclaw browser screenshot --full-page`
- `openclaw browser screenshot --ref 12`
- `openclaw browser screenshot --ref e12`
- `openclaw browser snapshot`
- `openclaw browser snapshot --format aria --limit 200`
- `openclaw browser snapshot --interactive --compact --depth 6`
- `openclaw browser snapshot --efficient`
- `openclaw browser snapshot --labels`
- `openclaw browser snapshot --selector "#main" --interactive`
- `openclaw browser snapshot --frame "iframe#main" --interactive`
- `openclaw browser console --level error`
- `openclaw browser errors --clear`
- `openclaw browser requests --filter api --clear`
- `openclaw browser pdf`
- `openclaw browser responsebody "**/api" --max-chars 5000`

Acties:

- `openclaw browser navigate https://example.com`
- `openclaw browser resize 1280 720`
- `openclaw browser click 12 --double`
- `openclaw browser click e12 --double`
- `openclaw browser type 23 "hello" --submit`
- `openclaw browser press Enter`
- `openclaw browser hover 44`
- `openclaw browser scrollintoview e12`
- `openclaw browser drag 10 11`
- `openclaw browser select 9 OptionA OptionB`
- `openclaw browser download e12 /tmp/report.pdf`
- `openclaw browser waitfordownload /tmp/report.pdf`
- `openclaw browser upload /tmp/file.pdf`
- `openclaw browser fill --fields '[{"ref":"1","type":"text","value":"Ada"}]'`
- `openclaw browser dialog --accept`
- `openclaw browser wait --text "Done"`
- `openclaw browser wait "#main" --url "**/dash" --load networkidle --fn "window.ready===true"`
- `openclaw browser evaluate --fn '(el) => el.textContent' --ref 7`
- `openclaw browser highlight e12`
- `openclaw browser trace start`
- `openclaw browser trace stop`

Status:

- `openclaw browser cookies`
- `openclaw browser cookies set session abc123 --url "https://example.com"`
- `openclaw browser cookies clear`
- `openclaw browser storage local get`
- `openclaw browser storage local set theme dark`
- `openclaw browser storage session clear`
- `openclaw browser set offline on`
- `openclaw browser set headers --json '{"X-Debug":"1"}'`
- `openclaw browser set credentials user pass`
- `openclaw browser set credentials --clear`
- `openclaw browser set geo 37.7749 -122.4194 --origin "https://example.com"`
- `openclaw browser set geo --clear`
- `openclaw browser set media dark`
- `openclaw browser set timezone America/New_York`
- `openclaw browser set locale en-US`
- `openclaw browser set device "iPhone 14"`

Notities:

- `upload` en `dialog` zijn **arming**-aanroepen; voer ze uit vóór de klik/toets
  die de chooser/dialog triggert.
- `upload` kan bestandsinputs ook direct instellen via `--input-ref` of `--element`.
- `snapshot`:
  - `--format ai` (standaard wanneer Playwright is geïnstalleerd): retourneert een AI-snapshot met numerieke refs (`aria-ref="<n>"`).
  - `--format aria`: retourneert de accessibility tree (geen refs; alleen inspectie).
  - `--efficient` (of `--mode efficient`): compact rolesnapshot-voorinstelling (interactief + compact + diepte + lagere maxChars).
  - Config-standaard (alleen tool/CLI): stel `browser.snapshotDefaults.mode: "efficient"` in om efficiënte snapshots te gebruiken wanneer de aanroeper geen modus meegeeft (zie [Gateway-configuratie](/gateway/configuration#browser-openclaw-managed-browser)).
  - Rolesnapshot-opties (`--interactive`, `--compact`, `--depth`, `--selector`) forceren een role-based snapshot met refs zoals `ref=e12`.
  - `--frame "<iframe selector>"` beperkt rolesnapshots tot een iframe (combineert met rolrefs zoals `e12`).
  - `--interactive` geeft een platte, gemakkelijk te kiezen lijst van interactieve elementen (het beste voor het aansturen van acties).
  - `--labels` voegt een screenshot toe dat alleen de viewport toont met overlappende reflabels (print `MEDIA:<path>`).
- `click`/`type`/etc vereisen een `ref` uit `snapshot` (ofwel numeriek `12` of rolref `e12`).
  CSS-selectors worden opzettelijk niet ondersteund voor acties.

## Snapshots en refs

OpenClaw ondersteunt twee “snapshot”-stijlen:

- **AI-snapshot (numerieke refs)**: `openclaw browser snapshot` (standaard; `--format ai`)
  - Uitvoer: een tekstsnapshot met numerieke refs.
  - Acties: `openclaw browser click 12`, `openclaw browser type 23 "hello"`.
  - Intern wordt de ref opgelost via Playwrights `aria-ref`.

- **Rolesnapshot (rolrefs zoals `e12`)**: `openclaw browser snapshot --interactive` (of `--compact`, `--depth`, `--selector`, `--frame`)
  - Uitvoer: een rolgebaseerde lijst/boom met `[ref=e12]` (en optioneel `[nth=1]`).
  - Acties: `openclaw browser click e12`, `openclaw browser highlight e12`.
  - Intern wordt de ref opgelost via `getByRole(...)` (plus `nth()` voor duplicaten).
  - Voeg `--labels` toe om een viewport-screenshot met overlappende `e12`-labels op te nemen.

Ref-gedrag:

- Refs zijn **niet stabiel over navigaties heen**; als iets faalt, voer `snapshot` opnieuw uit en gebruik een verse ref.
- Als de rolesnapshot is genomen met `--frame`, zijn rolrefs beperkt tot dat iframe tot de volgende rolesnapshot.

## Wacht-power-ups

Je kunt op meer wachten dan alleen tijd/tekst:

- Wachten op URL (globs ondersteund door Playwright):
  - `openclaw browser wait --url "**/dash"`
- Wachten op laadstatus:
  - `openclaw browser wait --load networkidle`
- Wachten op een JS-predicaat:
  - `openclaw browser wait --fn "window.ready===true"`
- Wachten tot een selector zichtbaar wordt:
  - `openclaw browser wait "#main"`

Deze kunnen worden gecombineerd:

```bash
openclaw browser wait "#main" \
  --url "**/dash" \
  --load networkidle \
  --fn "window.ready===true" \
  --timeout-ms 15000
```

## Debug-workflows

Wanneer een actie faalt (bijv. “not visible”, “strict mode violation”, “covered”):

1. `openclaw browser snapshot --interactive`
2. Gebruik `click <ref>` / `type <ref>` (gebruik bij voorkeur rolrefs in interactieve modus)
3. Als het nog steeds faalt: `openclaw browser highlight <ref>` om te zien waarop Playwright richt
4. Als de pagina zich vreemd gedraagt:
   - `openclaw browser errors --clear`
   - `openclaw browser requests --filter api --clear`
5. Voor diepgaande debugging: neem een trace op:
   - `openclaw browser trace start`
   - reproduceer het probleem
   - `openclaw browser trace stop` (print `TRACE:<path>`)

## JSON-uitvoer

`--json` is bedoeld voor scripting en gestructureerde tooling.

Voorbeelden:

```bash
openclaw browser status --json
openclaw browser snapshot --interactive --json
openclaw browser requests --filter api --json
openclaw browser cookies --json
```

Rolesnapshots in JSON bevatten `refs` plus een klein `stats`-blok (regels/tekens/refs/interactief) zodat tools kunnen redeneren over payloadgrootte en -dichtheid.

## Status- en omgevingsknoppen

Deze zijn handig voor workflows zoals “laat de site zich gedragen als X”:

- Cookies: `cookies`, `cookies set`, `cookies clear`
- Opslag: `storage local|session get|set|clear`
- Offline: `set offline on|off`
- Headers: `set headers --json '{"X-Debug":"1"}'` (of `--clear`)
- HTTP basic auth: `set credentials user pass` (of `--clear`)
- Geolocatie: `set geo <lat> <lon> --origin "https://example.com"` (of `--clear`)
- Media: `set media dark|light|no-preference|none`
- Tijdzone / locale: `set timezone ...`, `set locale ...`
- Apparaat / viewport:
  - `set device "iPhone 14"` (Playwright-apparaatvoorinstellingen)
  - `set viewport 1280 720`

## Beveiliging & privacy

- Het openclaw-browserprofiel kan ingelogde sessies bevatten; behandel dit als gevoelig.
- `browser act kind=evaluate` / `openclaw browser evaluate` en `wait --fn`
  voeren willekeurige JavaScript uit in de paginacontext. Prompt injection kan
  dit sturen. Schakel dit uit met `browser.evaluateEnabled=false` als je het niet nodig hebt.
- Voor logins en anti-botnotities (X/Twitter, enz.), zie [Browser login + X/Twitter posting](/tools/browser-login).
- Houd de Gateway/node-host privé (loopback of alleen tailnet).
- Remote CDP-endpoints zijn krachtig; tunnel en bescherm ze.

## Problemen oplossen

Voor Linux-specifieke problemen (vooral snap Chromium), zie
[Browser troubleshooting](/tools/browser-linux-troubleshooting).

## Agenttools + hoe besturing werkt

De agent krijgt **één tool** voor browserautomatisering:

- `browser` — status/start/stop/tabbladen/openen/focussen/sluiten/snapshot/screenshot/navigeren/acteren

Hoe het wordt gemapt:

- `browser snapshot` retourneert een stabiele UI-boom (AI of ARIA).
- `browser act` gebruikt de snapshot-`ref`-ID’s om te klikken/typen/slepen/selecteren.
- `browser screenshot` legt pixels vast (volledige pagina of element).
- `browser` accepteert:
  - `profile` om een benoemd browserprofiel te kiezen (openclaw, chrome of remote CDP).
  - `target` (`sandbox` | `host` | `node`) om te selecteren waar de browser draait.
  - In gesandboxte sessies vereist `target: "host"` `agents.defaults.sandbox.browser.allowHostControl=true`.
  - Als `target` wordt weggelaten: gesandboxte sessies gebruiken standaard `sandbox`, niet-gesandboxte sessies standaard `host`.
  - Als een browser-capabele node is verbonden, kan de tool automatisch daarnaar routeren tenzij je `target="host"` of `target="node"` vastzet.

Dit houdt de agent deterministisch en voorkomt broze selectors.
