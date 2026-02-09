---
summary: "Integreret browserkontroltjeneste + handlingskommandoer"
read_when:
  - Tilføjelse af agentstyret browserautomatisering
  - Fejlsøgning af hvorfor openclaw interfererer med din egen Chrome
  - Implementering af browserindstillinger + livscyklus i macOS-appen
title: "Browser (OpenClaw-administreret)"
---

# Browser (openclaw-managed)

OpenClaw kan køre en **dedikeret Chrome/Brave/Edge/Chrom profil**, som agenten kontrollerer.
Det er isoleret fra din personlige browser og styres gennem en lille lokal
kontroltjeneste inde i Gateway (loopback kun).

Begynderblik:

- Tænk på den som en **separat, agent-kun browser**.
- Profilen `openclaw` rører **ikke** din personlige browserprofil.
- Agenten kan **åbne faner, læse sider, klikke og skrive** i en sikker bane.
- Standardprofilen `chrome` bruger **systemets standard Chromium-browser** via
  udvidelsesrelæet; skift til `openclaw` for den isolerede, administrerede browser.

## Hvad du får

- En separat browserprofil med navnet **openclaw** (orange accent som standard).
- Deterministisk fanekontrol (liste/åbn/fokusér/luk).
- Agenthandlinger (klik/skriv/træk/vælg), snapshots, skærmbilleder, PDF’er.
- Valgfri understøttelse af flere profiler (`openclaw`, `work`, `remote`, ...).

Denne browser er **ikke** din daglige driver. Det er en sikker, isoleret overflade for
agent automatisering og verifikation.

## Hurtig start

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

Hvis du får “Browser disabled”, så aktivér den i konfigurationen (se nedenfor) og genstart
Gateway.

## Profiler: `openclaw` vs `chrome`

- `openclaw`: administreret, isoleret browser (ingen udvidelse krævet).
- `chrome`: udvidelsesrelæ til din **systembrowser** (kræver at OpenClaw-
  udvidelsen er knyttet til en fane).

Sæt `browser.defaultProfile: "openclaw"` hvis du vil have administreret tilstand som standard.

## Konfiguration

Browserindstillinger findes i `~/.openclaw/openclaw.json`.

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

Noter:

- Browserkontroltjenesten binder til loopback på en port afledt af `gateway.port`
  (standard: `18791`, som er gateway + 2). Relæet bruger den næste port (`18792`).
- Hvis du overskriver Gateway-porten (`gateway.port` eller `OPENCLAW_GATEWAY_PORT`),
  forskydes de afledte browserporte for at blive i samme “familie”.
- `cdpUrl` bruger som standard relæporten, når den ikke er sat.
- `remoteCdpTimeoutMs` gælder for fjern (ikke-loopback) CDP-tilgængelighedstjek.
- `remoteCdpHandshakeTimeoutMs` gælder for fjern CDP WebSocket-tilgængelighedstjek.
- `attachOnly: true` betyder “start aldrig en lokal browser; tilknyt kun, hvis den allerede kører.”
- `color` + pr.-profil `color` farver browser-UI’en, så du kan se, hvilken profil der er aktiv.
- Standard profil er 'chrome' (udvidelse relæ). Brug `defaultProfile: "openclaw"` til den administrerede browser.
- Automatisk registreringsrækkefølge: systemets standardbrowser hvis Chromium-baseret; ellers Chrome → Brave → Edge → Chromium → Chrome Canary.
- Lokale `openclaw`-profiler tildeler automatisk `cdpPort`/`cdpUrl` — sæt dem kun for fjern CDP.

## Brug Brave (eller en anden Chromium-baseret browser)

Hvis din **systemstandard** browser er Chromium-baseret (Chrome/Brave/Edge/etc), bruger
OpenClaw det automatisk. Sæt `browser.executablePath` for at tilsidesætte
auto-detektion:

CLI-eksempel:

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

## Lokal vs. fjern kontrol

- **Lokal kontrol (standard):** Gateway starter loopback-kontroltjenesten og kan starte en lokal browser.
- **Fjern kontrol (node-vært):** kør en node-vært på maskinen, der har browseren; Gateway proxy’er browserhandlinger til den.
- **Fjern-CDP:** sæt `browser.profiler.<name>.cdpUrl` (eller `browser.cdpUrl`) til
  vedhæfte til en ekstern Chrom-baseret browser. I dette tilfælde vil OpenClaw ikke starte en lokal browser.

Fjerne CDP-URL’er kan inkludere autentificering:

- Forespørgsel tokens (f.eks. `https://provider.example?token=<token>`)
- HTTP Basic auth (f.eks. `https://user:pass@provider.example`)

OpenClaw bevarer auth når du ringer `/json/*` endepunkter og når du forbinder
til CDP WebSocket. Foretræk miljøvariabler eller hemmeligheder managere for
tokens i stedet for at forpligte dem til at konfigurere filer.

## Node browser-proxy (nul-konfigurationsstandard)

Hvis du kører en \*\* node vært \*\* på den maskine, der har din browser, OpenClaw kan
auto-rute browser værktøj opkald til denne node uden nogen ekstra browser konfiguration.
Dette er standardstien for eksterne gateways.

Noter:

- Node-værten eksponerer sin lokale browserkontrolserver via en **proxy-kommando**.
- Profiler kommer fra nodens egen `browser.profiles`-konfiguration (samme som lokalt).
- Deaktivér, hvis du ikke vil have det:
  - På noden: `nodeHost.browserProxy.enabled=false`
  - På gatewayen: `gateway.nodes.browser.mode="off"`

## Browserless (hostet fjern CDP)

[Browserless](https://browserless.io) er en hosted Chrom tjeneste, der udsætter
CDP endepunkter over HTTPS. Du kan pege en OpenClaw browser profil på et
Browserless region endpoint og godkende med din API-nøgle.

Eksempel:

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

Noter:

- Erstat `<BROWSERLESS_API_KEY>` med din rigtige Browserless-token.
- Vælg det regionsendepunkt, der matcher din Browserless-konto (se deres dokumentation).

## Sikkerhed

Kerneidéer:

- Browserkontrol er kun loopback; adgang går via Gateway’ens autentificering eller node-parring.
- Hold Gateway og eventuelle node-værter på et privat netværk (Tailscale); undgå offentlig eksponering.
- Behandl fjerne CDP-URL’er/tokens som hemmeligheder; foretræk miljøvariabler eller en secrets manager.

Tips til fjern CDP:

- Foretræk HTTPS-endepunkter og kortlivede tokens, hvor det er muligt.
- Undgå at indlejre langlivede tokens direkte i konfigurationsfiler.

## Profiler (flere browsere)

OpenClaw understøtter flere navngivne profiler (routing configs). Profiler kan være:

- **openclaw-managed**: en dedikeret Chromium-baseret browserinstans med sin egen brugerdata-mappe + CDP-port
- **remote**: en eksplicit CDP-URL (Chromium-baseret browser kører et andet sted)
- **extension relay**: dine eksisterende Chrome-faner via det lokale relæ + Chrome-udvidelsen

Standarder:

- Profilen `openclaw` oprettes automatisk, hvis den mangler.
- Profilen `chrome` er indbygget til Chrome-udvidelsesrelæet (peger på `http://127.0.0.1:18792` som standard).
- Lokale CDP-porte tildeles fra **18800–18899** som standard.
- Sletning af en profil flytter dens lokale datamappe til Papirkurven.

Alle kontrolendepunkter accepterer `?profile=<name>`; CLI’en bruger `--browser-profile`.

## Chrome-udvidelsesrelæ (brug din eksisterende Chrome)

OpenClaw kan også styre **dine eksisterende Chrome-faner** (ingen separat “openclaw” Chrome-instans)
via et lokalt CDP-relæ + en Chrome-udvidelse.

Fuld guide: [Chrome-udvidelse](/tools/chrome-extension)

Flow:

- Gateway kører lokalt (samme maskine), eller en node-vært kører på browsermaskinen.
- En lokal **relæserver** lytter på et loopback `cdpUrl` (standard: `http://127.0.0.1:18792`).
- Du klikker på **OpenClaw Browser Relay**-udvidelsesikonet på en fane for at tilknytte (den tilknytter ikke automatisk).
- Agenten styrer den fane via det normale `browser`-værktøj ved at vælge den rigtige profil.

Hvis Gateway kører et andet sted, så kør en node-vært på browsermaskinen, så Gateway kan proxy’e browserhandlinger.

### Sandkasse-sessioner

Hvis agentsessionen er sandboxed, kan værktøjet `browser` standard til `target="sandbox"` (sandkasse browser).
Chrome udvidelse relæ overtagelse kræver vært browser kontrol, så enten:

- kør sessionen usandboxed, eller
- sæt `agents.defaults.sandbox.browser.allowHostControl: true` og brug `target="host"` ved kald af værktøjet.

### Opsætning

1. Indlæs udvidelsen (dev/udpakket):

```bash
openclaw browser extension install
```

- Chrome → `chrome://extensions` → aktivér “Developer mode”
- “Load unpacked” → vælg mappen, der udskrives af `openclaw browser extension path`
- Fastgør udvidelsen, og klik den derefter på den fane, du vil styre (badge viser `ON`).

2. Brug den:

- CLI: `openclaw browser --browser-profile chrome tabs`
- Agentværktøj: `browser` med `profile="chrome"`

Valgfrit: hvis du vil have et andet navn eller relæport, så opret din egen profil:

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

Noter:

- Denne tilstand er afhængig af Playwright-on-CDP til de fleste operationer (skærmbilleder/snapshots/handlinger).
- Afbryd ved at klikke på udvidelsesikonet igen.

## Isolationsgarantier

- **Dedikeret brugerdata-mappe**: rører aldrig din personlige browserprofil.
- **Dedikerede porte**: undgår `9222` for at forhindre kollisioner med udviklingsworkflows.
- **Deterministisk fanekontrol**: målret faner via `targetId`, ikke “sidste fane”.

## Browservalg

Ved lokal start vælger OpenClaw den første tilgængelige:

1. Chrome
2. Brave
3. Edge
4. Chromium
5. Chrome Canary

Du kan tilsidesætte med `browser.executablePath`.

Platforme:

- macOS: tjekker `/Applications` og `~/Applications`.
- Linux: leder efter `google-chrome`, `brave`, `microsoft-edge`, `chromium`, osv.
- Windows: tjekker almindelige installationsplaceringer.

## Kontrol-API (valgfrit)

Kun til lokale integrationer eksponerer Gateway et lille loopback HTTP-API:

- Status/start/stop: `GET /`, `POST /start`, `POST /stop`
- Faner: `GET /tabs`, `POST /tabs/open`, `POST /tabs/focus`, `DELETE /tabs/:targetId`
- Snapshot/skærmbillede: `GET /snapshot`, `POST /screenshot`
- Handlinger: `POST /navigate`, `POST /act`
- Hooks: `POST /hooks/file-chooser`, `POST /hooks/dialog`
- Downloads: `POST /download`, `POST /wait/download`
- Fejlfinding: `GET /console`, `POST /pdf`
- Fejlfinding: `GET /errors`, `GET /requests`, `POST /trace/start`, `POST /trace/stop`, `POST /highlight`
- Netværk: `POST /response/body`
- Tilstand: `GET /cookies`, `POST /cookies/set`, `POST /cookies/clear`
- Tilstand: `GET /storage/:kind`, `POST /storage/:kind/set`, `POST /storage/:kind/clear`
- Indstillinger: `POST /set/offline`, `POST /set/headers`, `POST /set/credentials`, `POST /set/geolocation`, `POST /set/media`, `POST /set/timezone`, `POST /set/locale`, `POST /set/device`

Alle endepunkter accepterer `?profile=<name>`.

### Playwright-krav

Nogle funktioner (navigér/act/AI snapshot/role snapshot, element screenshots, PDF) kræver
Playwright. Hvis Playwright ikke er installeret, disse endepunkter returnerer en klar 501
fejl. ARIA snapshots og grundlæggende screenshots stadig arbejde for openclaw-managed Chrome.
For Chrome udvidelse relæ driver, ARIA snapshots og screenshots kræver Playwright.

Hvis du ser `Playwright is not available in this gateway build`, så installér den fulde
Playwright-pakke (ikke `playwright-core`) og genstart gatewayen, eller geninstallér
OpenClaw med browsersupport.

#### Docker Playwright-installation

Hvis din Gateway kører i Docker, undgå `npx playwright` (npm tilsidesætte konflikter).
Brug den bundtede CLI i stedet:

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

For at fortsætte browserdownloads, angiv `PLAYWRIGHT_BROWSERS_PATH` (for eksempel,
`/home/node/.cache/ms-playwright`) og sørg for `/home/node` er persisted via
`OPENCLAW_HOME_VOLUME` eller et bindingsmount. Se [Docker](/install/docker).

## Sådan virker det (internt)

Overordnet flow:

- En lille **kontrolserver** accepterer HTTP-forespørgsler.
- Den forbinder til Chromium-baserede browsere (Chrome/Brave/Edge/Chromium) via **CDP**.
- Til avancerede handlinger (klik/skriv/snapshot/PDF) bruger den **Playwright** oven på
  CDP.
- Når Playwright mangler, er kun ikke-Playwright-operationer tilgængelige.

Dette design holder agenten på en stabil, deterministisk grænseflade, mens du kan
skifte lokale/fjerne browsere og profiler.

## CLI hurtig reference

Alle kommandoer accepterer `--browser-profil <name>` for at målrette en bestemt profil.
Alle kommandoer accepterer også `--json` for maskinlæsbar output (stabil nyttelast).

Grundlæggende:

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

Handlinger:

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

Tilstand:

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

Noter:

- `upload` og `dialog` er **armeringskald**; kør dem før klik/tryk,
  der udløser vælgeren/dialogen.
- `upload` kan også sætte fil-inputs direkte via `--input-ref` eller `--element`.
- `snapshot`:
  - `--format ai` (standard når Playwright er installeret): returnerer et AI-snapshot med numeriske referencer (`aria-ref="<n>"`).
  - `--format aria`: returnerer tilgængelighedstræet (ingen referencer; kun inspektion).
  - `--efficient` (eller `--mode efficient`): kompakt rolle-snapshot forudindstilling (interaktiv + kompakt + dybde + lavere maxChars).
  - Konfigurationsstandard (kun værktøj/CLI): sæt `browser.snapshotDefaults.mode: "efficient"` for at bruge effektive snapshots, når kalderen ikke angiver en tilstand (se [Gateway-konfiguration](/gateway/configuration#browser-openclaw-managed-browser)).
  - Rolle-snapshot-indstillinger (`--interactive`, `--compact`, `--depth`, `--selector`) tvinger et rollebaseret snapshot med referencer som `ref=e12`.
  - `--frame "<iframe selector>"` afgrænser rolle-snapshots til en iframe (parres med rolreferencer som `e12`).
  - `--interactive` giver en flad, let-at-vælge liste over interaktive elementer (bedst til at drive handlinger).
  - `--labels` tilføjer et skærmbillede kun af viewport med overlayede ref-etiketter (udskriver `MEDIA:<path>`).
- `click`/`type`/etc kræver en `ref` fra `snapshot` (enten numerisk `12` eller rolleref `e12`).
  CSS-vælgere understøttes med vilje ikke for handlinger.

## Snapshots og referencer

OpenClaw understøtter to “snapshot”-stile:

- **AI-snapshot (numeriske referencer)**: `openclaw browser snapshot` (standard; `--format ai`)
  - Output: et tekst-snapshot, der inkluderer numeriske referencer.
  - Handlinger: `openclaw browser click 12`, `openclaw browser type 23 "hello"`.
  - Internt løses referencen via Playwrights `aria-ref`.

- **Rolle-snapshot (rolreferencer som `e12`)**: `openclaw browser snapshot --interactive` (eller `--compact`, `--depth`, `--selector`, `--frame`)
  - Output: en rollebaseret liste/træ med `[ref=e12]` (og valgfrit `[nth=1]`).
  - Handlinger: `openclaw browser click e12`, `openclaw browser highlight e12`.
  - Internt løses referencen via `getByRole(...)` (plus `nth()` for dubletter).
  - Tilføj `--labels` for at inkludere et viewport-skærmbillede med overlayede `e12`-etiketter.

Ref-adfærd:

- Referencer er **ikke stabile på tværs af navigationer**; hvis noget fejler, så kør `snapshot` igen og brug en frisk reference.
- Hvis rolle-snapshot blev taget med `--frame`, er rolreferencer afgrænset til den iframe indtil næste rolle-snapshot.

## Vent-forstærkninger

Du kan vente på mere end bare tid/tekst:

- Vent på URL (globs understøttet af Playwright):
  - `openclaw browser wait --url "**/dash"`
- Vent på load state:
  - `openclaw browser wait --load networkidle`
- Vent på et JS-prædikat:
  - `openclaw browser wait --fn "window.ready===true"`
- Vent på at en selektor bliver synlig:
  - `openclaw browser wait "#main"`

Disse kan kombineres:

```bash
openclaw browser wait "#main" \
  --url "**/dash" \
  --load networkidle \
  --fn "window.ready===true" \
  --timeout-ms 15000
```

## Debug-workflows

Hvis en handling mislykkes (f.eks. »ikke synlig«, »streng tilstand overtrædelse«, »dækket«):

1. `openclaw browser snapshot --interactive`
2. Brug `click <ref>` / `type <ref>` (foretræk rolreferencer i interaktiv tilstand)
3. Hvis det stadig fejler: `openclaw browser highlight <ref>` for at se, hvad Playwright målretter
4. Hvis siden opfører sig mærkeligt:
   - `openclaw browser errors --clear`
   - `openclaw browser requests --filter api --clear`
5. Til dyb fejlfinding: optag en trace:
   - `openclaw browser trace start`
   - reproducer problemet
   - `openclaw browser trace stop` (udskriver `TRACE:<path>`)

## JSON-output

`--json` er til scripting og strukturerede værktøjer.

Eksempler:

```bash
openclaw browser status --json
openclaw browser snapshot --interactive --json
openclaw browser requests --filter api --json
openclaw browser cookies --json
```

Rolle-snapshots i JSON inkluderer `refs` plus en lille `stats`-blok (linjer/tegn/referencer/interaktiv), så værktøjer kan ræsonnere om payload-størrelse og -tæthed.

## Tilstands- og miljøknapper

Disse er nyttige til “få sitet til at opføre sig som X”-workflows:

- Cookies: `cookies`, `cookies set`, `cookies clear`
- Lager: `storage local|session get|set|clear`
- Offline: `set offline on|off`
- Headere: `set headers --json '{"X-Debug":"1"}'` (eller `--clear`)
- HTTP basic auth: `set credentials user pass` (eller `--clear`)
- Geolokation: `set geo <lat> <lon> --origin "https://example.com"` (eller `--clear`)
- Medier: `set media dark|light|no-preference|none`
- Tidszone / locale: `set timezone ...`, `set locale ...`
- Enhed / viewport:
  - `set device "iPhone 14"` (Playwright-enhedsforudindstillinger)
  - `set viewport 1280 720`

## Sikkerhed & privatliv

- openclaw-browserprofilen kan indeholde indloggede sessioner; behandl den som følsom.
- `browser act kind=evaluate` / `openclaw browser evaluate` and `wait --fn`
  execute arbitrary JavaScript in the page context. Øjeblikkelig injektion kan styre
  dette. Deaktivér det med `browser.evaluateEnabled=false` hvis du ikke har brug for det.
- For login- og anti-bot-noter (X/Twitter osv.), se [Browser login + X/Twitter posting](/tools/browser-login).
- Hold Gateway/node-værten privat (loopback eller kun tailnet).
- Fjerne CDP-endepunkter er kraftfulde; tunnelér og beskyt dem.

## Fejlfinding

For Linux-specifikke problemer (især snap Chromium), se
[Browser troubleshooting](/tools/browser-linux-troubleshooting).

## Agentværktøjer + hvordan kontrol virker

Agenten får **ét værktøj** til browserautomatisering:

- `browser` — status/start/stop/faner/åbn/fokusér/luk/snapshot/skærmbillede/navigér/handl

Sådan kortlægges det:

- `browser snapshot` returnerer et stabilt UI-træ (AI eller ARIA).
- `browser act` bruger snapshot `ref`-ID’er til at klikke/skrive/trække/vælge.
- `browser screenshot` fanger pixels (fuld side eller element).
- `browser` accepterer:
  - `profile` for at vælge en navngiven browserprofil (openclaw, chrome eller fjern CDP).
  - `target` (`sandbox` | `host` | `node`) for at vælge, hvor browseren bor.
  - I sandboxed sessioner kræver `target: "host"` `agents.defaults.sandbox.browser.allowHostControl=true`.
  - Hvis `target` udelades: sandboxed sessioner bruger som standard `sandbox`, ikke-sandbox sessioner bruger som standard `host`.
  - Hvis en browser-kompatibel node er forbundet, kan værktøjet automatisk route til den, medmindre du fastlåser `target="host"` eller `target="node"`.

Dette holder agenten deterministisk og undgår skrøbelige selektorer.
