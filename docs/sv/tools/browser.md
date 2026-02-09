---
summary: "Integrerad webbläsarkontrolltjänst + åtgärdskommandon"
read_when:
  - Lägga till agentstyrd webbläsarautomation
  - Felsöka varför openclaw stör din egen Chrome
  - Implementera webbläsarinställningar + livscykel i macOS-appen
title: "Webbläsare (OpenClaw-hanterad)"
---

# Webbläsare (openclaw-hanterad)

OpenClaw kan köra en **dedikerad Chrome/Brave/Edge/Chromium-profil** som agenten kontrollerar.
Den är isolerad från din personliga webbläsare och hanteras genom en liten lokal
kontrolltjänst inne i Gateway (loopback endast).

Nybörjarvy:

- Tänk på den som en **separat, agent‑endast webbläsare**.
- Profilen `openclaw` rör **inte** din personliga webbläsarprofil.
- Agenten kan **öppna flikar, läsa sidor, klicka och skriva** i en säker zon.
- Standardprofilen `chrome` använder **systemets standard‑Chromium‑webbläsare** via
  tilläggsreläet; växla till `openclaw` för den isolerade hanterade webbläsaren.

## Vad du får

- En separat webbläsarprofil med namnet **openclaw** (orange accent som standard).
- Deterministisk flikkontroll (lista/öppna/fokusera/stäng).
- Agentåtgärder (klicka/skriva/dra/välja), ögonblicksbilder, skärmdumpar, PDF:er.
- Valfritt stöd för flera profiler (`openclaw`, `work`, `remote`, ...).

Denna webbläsare är **inte** din dagliga förare. Det är en säker, isolerad yta för
agentautomatisering och verifiering.

## Snabbstart

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

Om du får ”Browser disabled”, aktivera den i konfigen (se nedan) och starta om
Gateway.

## Profiler: `openclaw` vs `chrome`

- `openclaw`: hanterad, isolerad webbläsare (inga tillägg krävs).
- `chrome`: tilläggsrelä till din **systemwebbläsare** (kräver att OpenClaw‑
  tillägget är kopplat till en flik).

Ställ in `browser.defaultProfile: "openclaw"` om du vill ha hanterat läge som standard.

## Konfiguration

Webbläsarinställningar finns i `~/.openclaw/openclaw.json`.

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

Noteringar:

- Webbläsarens kontrolltjänst binder till loopback på en port som härrör från `gateway.port`
  (standard: `18791`, som är gateway + 2). Reläet använder nästa port (`18792`).
- Om du åsidosätter Gateway‑porten (`gateway.port` eller `OPENCLAW_GATEWAY_PORT`),
  flyttas de härledda webbläsarportarna för att stanna i samma ”familj”.
- `cdpUrl` använder som standard reläporten när den inte är satt.
- `remoteCdpTimeoutMs` gäller kontroller av fjärr‑CDP‑åtkomlighet (icke‑loopback).
- `remoteCdpHandshakeTimeoutMs` gäller kontroller av fjärr‑CDP WebSocket‑åtkomlighet.
- `attachOnly: true` betyder ”starta aldrig en lokal webbläsare; anslut endast om den redan körs”.
- `color` + per‑profil `color` färgar webbläsar‑UI:t så att du ser vilken profil som är aktiv.
- Standardprofilen är `chrome` (förlängningsrelä). Använd `defaultProfil: "openclaw"` för den hanterade webbläsaren.
- Automatisk detekteringsordning: systemets standardwebbläsare om Chromium‑baserad; annars Chrome → Brave → Edge → Chromium → Chrome Canary.
- Lokala `openclaw`‑profiler tilldelar automatiskt `cdpPort`/`cdpUrl` — sätt dem endast för fjärr‑CDP.

## Använd Brave (eller annan Chromium‑baserad webbläsare)

Om din **systemstandard** webbläsare är Chromium-baserad (Chrome/Brave/Edge/etc), använder
OpenClaw den automatiskt. Set `browser.executablePath` to override
auto-detection:

CLI‑exempel:

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

## Lokal vs fjärrkontroll

- **Lokal kontroll (standard):** Gateway startar loopback‑kontrolltjänsten och kan starta en lokal webbläsare.
- **Fjärrkontroll (node‑värd):** kör en node‑värd på maskinen som har webbläsaren; Gateway proxyar webbläsaråtgärder till den.
- **Fjärr-CDP:** sätt `browser.profiles.<name>.cdpUrl` (eller `browser.cdpUrl`) till
  bifoga till en fjärrbaserad Chromium-baserad webbläsare. I detta fall kommer OpenClaw inte att starta en lokal webbläsare.

Fjärr‑CDP‑URL:er kan inkludera autentisering:

- Frågepolletter (t.ex., `https://provider.exempel?token=<token>`)
- HTTP Basic auth (t.ex., `https://user:pass@provider.exempel`)

OpenClaw bevarar auth när du ringer `/json/*` slutpunkter och när du ansluter
till CDP WebSocket. Föredrar miljövariabler eller hemligheter chefer för
tokens istället för att överlåta dem till konfigurationsfiler.

## Node‑webbläsarproxy (nollkonfig‑standard)

Om du kör en **nod värd** på maskinen som har din webbläsare, OpenClaw kan
automatiskt dirigera webbläsarverktygets samtal till den noden utan någon extra webbläsarkonfiguration.
Detta är standardsökvägen för fjärr-gateways.

Noteringar:

- Node‑värden exponerar sin lokala webbläsarkontrollserver via ett **proxykommando**.
- Profiler kommer från nodens egen `browser.profiles`‑konfig (samma som lokalt).
- Inaktivera om du inte vill ha det:
  - På noden: `nodeHost.browserProxy.enabled=false`
  - På gatewayen: `gateway.nodes.browser.mode="off"`

## Browserless (hostad fjärr‑CDP)

[Browserless](https://browserless.io) är en hostad krom tjänst som exponerar
CDP-slutpunkter över HTTPS. Du kan peka en OpenClaw webbläsarprofil på en
Webbläsarlös regionslutpunkt och autentisera med din API-nyckel.

Exempel:

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

Noteringar:

- Ersätt `<BROWSERLESS_API_KEY>` med din riktiga Browserless‑token.
- Välj regionsendpoint som matchar ditt Browserless‑konto (se deras dokumentation).

## Säkerhet

Grundidéer:

- Webbläsarkontroll är endast loopback; åtkomst går via Gatewayns autentisering eller node‑parning.
- Håll Gateway och eventuella node‑värdar på ett privat nätverk (Tailscale); undvik publik exponering.
- Behandla fjärr‑CDP‑URL:er/tokens som hemligheter; föredra miljövariabler eller en hemlighetshanterare.

Tips för fjärr‑CDP:

- Föredra HTTPS‑endpoints och kortlivade tokens där det är möjligt.
- Undvik att bädda in långlivade tokens direkt i konfigfiler.

## Profiler (flera webbläsare)

OpenClaw stöder flera namngivna profiler (routingkonfigurationer). Profiler kan vara:

- **openclaw‑managed**: en dedikerad Chromium‑baserad webbläsarinstans med egen användardatakatalog + CDP‑port
- **remote**: en explicit CDP‑URL (Chromium‑baserad webbläsare som körs någon annanstans)
- **extension relay**: dina befintliga Chrome‑flikar via det lokala reläet + Chrome‑tillägg

Standarder:

- Profilen `openclaw` skapas automatiskt om den saknas.
- Profilen `chrome` är inbyggd för Chrome‑tilläggsreläet (pekar på `http://127.0.0.1:18792` som standard).
- Lokala CDP‑portar allokeras från **18800–18899** som standard.
- Att ta bort en profil flyttar dess lokala datakatalog till Papperskorgen.

Alla kontrollendpoints accepterar `?profile=<name>`; CLI använder `--browser-profile`.

## Chrome‑tilläggsrelä (använd din befintliga Chrome)

OpenClaw kan också styra **dina befintliga Chrome‑flikar** (ingen separat ”openclaw”‑Chrome‑instans) via ett lokalt CDP‑relä + ett Chrome‑tillägg.

Fullständig guide: [Chrome‑tillägg](/tools/chrome-extension)

Flöde:

- Gateway kör lokalt (samma maskin) eller en node‑värd körs på webbläsarmaskinen.
- En lokal **reläserver** lyssnar på en loopback `cdpUrl` (standard: `http://127.0.0.1:18792`).
- Du klickar på tilläggets ikon **OpenClaw Browser Relay** på en flik för att ansluta (det ansluter inte automatiskt).
- Agenten styr den fliken via det vanliga verktyget `browser` genom att välja rätt profil.

Om Gateway kör någon annanstans, kör en node‑värd på webbläsarmaskinen så att Gateway kan proxyera webbläsaråtgärder.

### Sandboxade sessioner

Om agenten sessionen är sandlåda, "webbläsare" verktyget kan standard till "target="sandbox"\` (sandlåda webbläsare).
Chrome extension relay takeover kräver värd webbläsarkontroll, så antingen:

- kör sessionen utan sandbox, eller
- sätt `agents.defaults.sandbox.browser.allowHostControl: true` och använd `target="host"` när du anropar verktyget.

### Konfigurering

1. Ladda tillägget (dev/uppackat):

```bash
openclaw browser extension install
```

- Chrome → `chrome://extensions` → aktivera ”Developer mode”
- ”Load unpacked” → välj katalogen som skrivs ut av `openclaw browser extension path`
- Fäst tillägget och klicka sedan på det på fliken du vill styra (märket visar `ON`).

2. Använd det:

- CLI: `openclaw browser --browser-profile chrome tabs`
- Agentverktyg: `browser` med `profile="chrome"`

Valfritt: om du vill ha ett annat namn eller reläport, skapa din egen profil:

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

Noteringar:

- Detta läge förlitar sig på Playwright‑on‑CDP för de flesta operationer (skärmdumpar/ögonblicksbilder/åtgärder).
- Koppla från genom att klicka på tilläggsikonen igen.

## Isoleringsgarantier

- **Dedikerad användardatakatalog**: rör aldrig din personliga webbläsarprofil.
- **Dedikerade portar**: undviker `9222` för att förhindra kollisioner med utvecklingsarbetsflöden.
- **Deterministisk flikkontroll**: rikta flikar via `targetId`, inte ”senaste fliken”.

## Val av webbläsare

Vid lokal start väljer OpenClaw den första tillgängliga:

1. Chrome
2. Brave
3. Edge
4. Chromium
5. Chrome Canary

Du kan åsidosätta med `browser.executablePath`.

Plattformar:

- macOS: kontrollerar `/Applications` och `~/Applications`.
- Linux: letar efter `google-chrome`, `brave`, `microsoft-edge`, `chromium`, etc.
- Windows: kontrollerar vanliga installationsplatser.

## Kontroll‑API (valfritt)

Endast för lokala integrationer exponerar Gateway ett litet loopback‑HTTP‑API:

- Status/start/stop: `GET /`, `POST /start`, `POST /stop`
- Flikar: `GET /tabs`, `POST /tabs/open`, `POST /tabs/focus`, `DELETE /tabs/:targetId`
- Ögonblicksbild/skärmdump: `GET /snapshot`, `POST /screenshot`
- Åtgärder: `POST /navigate`, `POST /act`
- Hooks: `POST /hooks/file-chooser`, `POST /hooks/dialog`
- Nedladdningar: `POST /download`, `POST /wait/download`
- Felsökning: `GET /console`, `POST /pdf`
- Felsökning: `GET /errors`, `GET /requests`, `POST /trace/start`, `POST /trace/stop`, `POST /highlight`
- Nätverk: `POST /response/body`
- Tillstånd: `GET /cookies`, `POST /cookies/set`, `POST /cookies/clear`
- Tillstånd: `GET /storage/:kind`, `POST /storage/:kind/set`, `POST /storage/:kind/clear`
- Inställningar: `POST /set/offline`, `POST /set/headers`, `POST /set/credentials`, `POST /set/geolocation`, `POST /set/media`, `POST /set/timezone`, `POST /set/locale`, `POST /set/device`

Alla endpoints accepterar `?profile=<name>`.

### Playwright‑krav

Vissa funktioner (navigera/agera/AI-ögonblicksbilder/rollbilder, elementskärmdumpar, PDF) kräver
Playwright. Om Playwright inte är installerat, dessa slutpunkter returnerar en tydlig 501
fel. ARIA ögonblicksbilder och grundläggande skärmbilder fungerar fortfarande för openclaw-managed Chrome.
För Chrome-tilläggsrelä drivrutinen kräver ARIA-ögonblicksbilder och skärmbilder Playwright.

Om du ser `Playwright is not available in this gateway build`, installera hela
Playwright‑paketet (inte `playwright-core`) och starta om gatewayen, eller installera om
OpenClaw med webbläsarstöd.

#### Docker‑installation av Playwright

Om din Gateway körs i Docker, undvik `npx playwright` (npm åsidosätta konflikter).
Använd den medföljande CLI istället:

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

För att hålla fast vid webbläsarhämtningar, sätt `PLAYWRIGHT_BROWSERS_PATH` (till exempel,
`/home/node/.cache/ms-playwright`) och se till att `/home/node` är ihållande via
`OPENCLAW_HOME_VOLUME` eller ett bindfäste. Se [Docker](/install/docker).

## Hur det fungerar (internt)

Övergripande flöde:

- En liten **kontrollserver** tar emot HTTP‑förfrågningar.
- Den ansluter till Chromium‑baserade webbläsare (Chrome/Brave/Edge/Chromium) via **CDP**.
- För avancerade åtgärder (klicka/skriva/ögonblicksbild/PDF) använder den **Playwright** ovanpå
  CDP.
- När Playwright saknas är endast icke‑Playwright‑operationer tillgängliga.

Denna design håller agenten på ett stabilt, deterministiskt gränssnitt samtidigt som
du kan byta lokala/fjärrwebbläsare och profiler.

## CLI‑snabbreferens

Alla kommandon accepterar `--browser-profile <name>` för att rikta en specifik profil.
Alla kommandon accepterar också `--json` för maskinläsbar utdata (stabila nyttolaster).

Grunder:

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

Inspektion:

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

Åtgärder:

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

Tillstånd:

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

Noteringar:

- `upload` och `dialog` är **armerings**‑anrop; kör dem före klick/tryck
  som utlöser väljaren/dialogen.
- `upload` kan också sätta filinmatningar direkt via `--input-ref` eller `--element`.
- `snapshot`:
  - `--format ai` (standard när Playwright är installerat): returnerar en AI‑ögonblicksbild med numeriska refar (`aria-ref="<n>"`).
  - `--format aria`: returnerar tillgänglighetsträdet (inga refar; endast inspektion).
  - `--efficient` (eller `--mode efficient`): kompakt roll‑ögonblicksbild‑preset (interaktiv + kompakt + djup + lägre maxChars).
  - Konfig‑standard (endast verktyg/CLI): sätt `browser.snapshotDefaults.mode: "efficient"` för att använda effektiva ögonblicksbilder när anroparen inte anger ett läge (se [Gateway‑konfiguration](/gateway/configuration#browser-openclaw-managed-browser)).
  - Alternativ för roll‑ögonblicksbild (`--interactive`, `--compact`, `--depth`, `--selector`) tvingar en rollbaserad ögonblicksbild med refar som `ref=e12`.
  - `--frame "<iframe selector>"` begränsar roll‑ögonblicksbilder till en iframe (paras med rollrefar som `e12`).
  - `--interactive` ger en platt, lättplockad lista över interaktiva element (bäst för att driva åtgärder).
  - `--labels` lägger till en skärmdump av endast viewporten med överlagrade refetiketter (skriver ut `MEDIA:<path>`).
- `click`/`type`/etc kräver en `ref` från `snapshot` (antingen numerisk `12` eller rollref `e12`).
  CSS-selektorer stöds avsiktligt inte för åtgärder.

## Ögonblicksbilder och refar

OpenClaw stöder två ”ögonblicksbild”‑stilar:

- **AI‑ögonblicksbild (numeriska refar)**: `openclaw browser snapshot` (standard; `--format ai`)
  - Utdata: en textögonblicksbild som inkluderar numeriska refar.
  - Åtgärder: `openclaw browser click 12`, `openclaw browser type 23 "hello"`.
  - Internt löses refen via Playwrights `aria-ref`.

- **Roll‑ögonblicksbild (rollrefar som `e12`)**: `openclaw browser snapshot --interactive` (eller `--compact`, `--depth`, `--selector`, `--frame`)
  - Utdata: en rollbaserad lista/träd med `[ref=e12]` (och valfri `[nth=1]`).
  - Åtgärder: `openclaw browser click e12`, `openclaw browser highlight e12`.
  - Internt löses refen via `getByRole(...)` (plus `nth()` för dubbletter).
  - Lägg till `--labels` för att inkludera en viewport‑skärmdump med överlagrade `e12`‑etiketter.

Ref‑beteende:

- Refar är **inte stabila över navigeringar**; om något misslyckas, kör `snapshot` igen och använd en ny ref.
- Om roll‑ögonblicksbilden togs med `--frame` är rollrefar begränsade till den iframen tills nästa roll‑ögonblicksbild.

## Vänt‑power‑ups

Du kan vänta på mer än bara tid/text:

- Vänta på URL (globs stöds av Playwright):
  - `openclaw browser wait --url "**/dash"`
- Vänta på laddningsläge:
  - `openclaw browser wait --load networkidle`
- Vänta på ett JS‑predikat:
  - `openclaw browser wait --fn "window.ready===true"`
- Vänta på att en selektor blir synlig:
  - `openclaw browser wait "#main"`

Dessa kan kombineras:

```bash
openclaw browser wait "#main" \
  --url "**/dash" \
  --load networkidle \
  --fn "window.ready===true" \
  --timeout-ms 15000
```

## Felsökningsarbetsflöden

När en åtgärd misslyckas (t.ex. “inte synligt”, “strikt läge kränkning”, “täckt”):

1. `openclaw browser snapshot --interactive`
2. Använd `click <ref>` / `type <ref>` (föredra rollrefar i interaktivt läge)
3. Om det fortfarande misslyckas: `openclaw browser highlight <ref>` för att se vad Playwright riktar in sig på
4. Om sidan beter sig konstigt:
   - `openclaw browser errors --clear`
   - `openclaw browser requests --filter api --clear`
5. För djup felsökning: spela in en trace:
   - `openclaw browser trace start`
   - reproducera problemet
   - `openclaw browser trace stop` (skriver ut `TRACE:<path>`)

## JSON‑utdata

`--json` är för skriptning och strukturerade verktyg.

Exempel:

```bash
openclaw browser status --json
openclaw browser snapshot --interactive --json
openclaw browser requests --filter api --json
openclaw browser cookies --json
```

Roll‑ögonblicksbilder i JSON inkluderar `refs` plus ett litet `stats`‑block (rader/tecken/refar/interaktivt) så att verktyg kan resonera om payload‑storlek och täthet.

## Tillstånds‑ och miljöreglage

Dessa är användbara för arbetsflöden av typen ”få webbplatsen att bete sig som X”:

- Cookies: `cookies`, `cookies set`, `cookies clear`
- Lagring: `storage local|session get|set|clear`
- Offline: `set offline on|off`
- Headers: `set headers --json '{"X-Debug":"1"}'` (eller `--clear`)
- HTTP basic‑auth: `set credentials user pass` (eller `--clear`)
- Geolokalisering: `set geo <lat> <lon> --origin "https://example.com"` (eller `--clear`)
- Media: `set media dark|light|no-preference|none`
- Tidszon / språk: `set timezone ...`, `set locale ...`
- Enhet / viewport:
  - `set device "iPhone 14"` (Playwright‑enhetsförinställningar)
  - `set viewport 1280 720`

## Säkerhet & integritet

- Webbläsarprofilen openclaw kan innehålla inloggade sessioner; behandla den som känslig.
- `browser act kind=evaluate` / `openclaw browser evaluate` och `wait --fn`
  kör godtyckligt JavaScript i sidsammanhanget. Snabb injektion kan styra
  detta. Inaktivera det med `browser.evaluateEnabled=false` om du inte behöver det.
- För inloggningar och anti‑bot‑noteringar (X/Twitter, etc.), se [Webbläsarinloggning + X/Twitter‑postning](/tools/browser-login).
- Håll Gateway/node‑värd privat (loopback eller endast tailnet).
- Fjärr‑CDP‑endpoints är kraftfulla; tunnla och skydda dem.

## Felsökning

För Linux‑specifika problem (särskilt snap‑Chromium), se
[Webbläsarfelsökning](/tools/browser-linux-troubleshooting).

## Agentverktyg + hur kontroll fungerar

Agenten får **ett verktyg** för webbläsarautomation:

- `browser` — status/start/stop/flikar/öppna/fokusera/stäng/ögonblicksbild/skärmdump/navigera/agera

Hur det mappas:

- `browser snapshot` returnerar ett stabilt UI‑träd (AI eller ARIA).
- `browser act` använder ögonblicksbildens `ref`‑ID:n för att klicka/skriva/dra/välja.
- `browser screenshot` fångar pixlar (hel sida eller element).
- `browser` accepterar:
  - `profile` för att välja en namngiven webbläsarprofil (openclaw, chrome eller fjärr‑CDP).
  - `target` (`sandbox` | `host` | `node`) för att välja var webbläsaren finns.
  - I sandboxade sessioner kräver `target: "host"` `agents.defaults.sandbox.browser.allowHostControl=true`.
  - Om `target` utelämnas: sandboxade sessioner använder som standard `sandbox`, icke‑sandboxade sessioner använder som standard `host`.
  - Om en webbläsarkapabel nod är ansluten kan verktyget autorouta till den om du inte fäster `target="host"` eller `target="node"`.

Detta håller agenten deterministisk och undviker sköra selektorer.
