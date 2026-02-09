---
summary: "Pinagsamang serbisyo ng kontrol sa browser + mga command ng aksyon"
read_when:
  - Pagdaragdag ng agent-controlled na browser automation
  - Pag-debug kung bakit nakikialam ang openclaw sa sarili mong Chrome
  - Pagpapatupad ng mga setting at lifecycle ng browser sa macOS app
title: "Browser (pinamamahalaan ng OpenClaw)"
---

# Browser (pinamamahalaan ng openclaw)

33. Maaaring magpatakbo ang OpenClaw ng isang **dedikadong Chrome/Brave/Edge/Chromium profile** na kinokontrol ng agent.
34. Ito ay nakahiwalay sa iyong personal na browser at pinamamahalaan sa pamamagitan ng isang maliit na lokal na control service sa loob ng Gateway (loopback lamang).

Pananaw ng baguhan:

- Isipin ito bilang isang **hiwalay, para-lang-sa-agent na browser**.
- Ang `openclaw` profile ay **hindi** humahawak sa personal mong browser profile.
- Kayang **magbukas ng mga tab, magbasa ng mga page, mag-click, at mag-type** ng agent sa isang ligtas na lane.
- Ang default na `chrome` profile ay gumagamit ng **system default Chromium browser** sa pamamagitan ng
  extension relay; lumipat sa `openclaw` para sa hiwalay na pinamamahalaang browser.

## Ano ang makukuha mo

- Isang hiwalay na browser profile na pinangalanang **openclaw** (orange ang accent bilang default).
- Deterministikong kontrol sa tab (list/open/focus/close).
- Mga aksyon ng agent (click/type/drag/select), snapshots, screenshots, PDFs.
- Opsyonal na multi-profile support (`openclaw`, `work`, `remote`, ...).

35. Ang browser na ito ay **hindi** para sa pang-araw-araw na paggamit. 17. Ito ay isang ligtas at hiwalay na surface para sa
    agent automation at beripikasyon.

## Mabilis na pagsisimula

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

Kung makuha mo ang “Browser disabled”, i-enable ito sa config (tingnan sa ibaba) at i-restart ang
Gateway.

## Mga Profile: `openclaw` vs `chrome`

- `openclaw`: pinamamahalaang, hiwalay na browser (walang extension na kailangan).
- `chrome`: extension relay papunta sa **system browser** mo (kailangan na nakakabit ang OpenClaw
  extension sa isang tab).

Itakda ang `browser.defaultProfile: "openclaw"` kung gusto mo ng managed mode bilang default.

## Konpigurasyon

Ang mga setting ng browser ay nasa `~/.openclaw/openclaw.json`.

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

Mga tala:

- 37. Ang browser control service ay nagbi-bind sa loopback sa isang port na hinango mula sa `gateway.port` (default: `18791`, na gateway + 2). 38. Ginagamit ng relay ang susunod na port (`18792`).
- Kung i-o-override mo ang Gateway port (`gateway.port` o `OPENCLAW_GATEWAY_PORT`),
  lilipat ang mga hinangong browser port para manatili sa parehong “family”.
- Ang `cdpUrl` ay default sa relay port kapag hindi nakatakda.
- Ang `remoteCdpTimeoutMs` ay nalalapat sa mga remote (non-loopback) CDP reachability check.
- Ang `remoteCdpHandshakeTimeoutMs` ay nalalapat sa mga remote CDP WebSocket reachability check.
- Ang `attachOnly: true` ay nangangahulugang “huwag kailanman mag-launch ng lokal na browser; kumabit lang kung tumatakbo na.”
- Ang `color` + per-profile na `color` ay nagbibigay-kulay sa UI ng browser para makita mo kung aling profile ang aktibo.
- 39. Ang default na profile ay `chrome` (extension relay). 18. Gamitin ang `defaultProfile: "openclaw"` para sa managed browser.
- Auto-detect order: system default browser kung Chromium-based; kung hindi, Chrome → Brave → Edge → Chromium → Chrome Canary.
- Ang mga lokal na `openclaw` profile ay awtomatikong nag-a-assign ng `cdpPort`/`cdpUrl` — itakda lang ang mga iyon para sa remote CDP.

## Gumamit ng Brave (o ibang Chromium-based na browser)

41. Kung ang iyong **system default** browser ay batay sa Chromium (Chrome/Brave/Edge/etc), awtomatikong ginagamit ito ng OpenClaw. 42. Itakda ang `browser.executablePath` para i-override ang auto-detection:

Halimbawa sa CLI:

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

## Lokal vs remote na kontrol

- **Lokal na kontrol (default):** sinisimulan ng Gateway ang loopback control service at kayang mag-launch ng lokal na browser.
- **Remote na kontrol (node host):** magpatakbo ng node host sa machine na may browser; ipo-proxy ng Gateway ang mga aksyon ng browser papunta rito.
- 43. **Remote CDP:** itakda ang `browser.profiles.<name>`.cdpUrl`(or`browser.cdpUrl\`) to
      attach to a remote Chromium-based browser. 20. Sa kasong ito, hindi maglulunsad ang OpenClaw ng lokal na browser.

Maaaring magsama ng auth ang mga remote CDP URL:

- Query tokens (hal., `https://provider.example?token=<token>`)
- HTTP Basic auth (hal., `https://user:pass@provider.example`)

21. Pinananatili ng OpenClaw ang auth kapag tumatawag sa mga endpoint na `/json/*` at kapag kumokonekta
    sa CDP WebSocket. 22. Mas mainam ang mga environment variable o secrets manager para sa
    mga token sa halip na i-commit ang mga ito sa mga config file.

## Node browser proxy (zero-config na default)

48. Kung nagpapatakbo ka ng **node host** sa makinang may browser mo, maaaring awtomatikong i-route ng OpenClaw ang mga tawag ng browser tool sa node na iyon nang walang karagdagang browser config.
49. Ito ang default na path para sa mga remote gateway.

Mga tala:

- Inilalantad ng node host ang lokal nitong browser control server sa pamamagitan ng isang **proxy command**.
- Ang mga profile ay mula sa sariling `browser.profiles` config ng node (kapareho ng lokal).
- I-disable kung ayaw mo nito:
  - Sa node: `nodeHost.browserProxy.enabled=false`
  - Sa gateway: `gateway.nodes.browser.mode="off"`

## Browserless (hosted remote CDP)

24. Ang [Browserless](https://browserless.io) ay isang hosted na serbisyo ng Chromium na naglalantad ng
    mga CDP endpoint sa pamamagitan ng HTTPS. Maaari mong ituro ang isang OpenClaw browser profile sa isang Browserless region endpoint at mag-authenticate gamit ang iyong API key.

Halimbawa:

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

Mga tala:

- Palitan ang `<BROWSERLESS_API_KEY>` ng iyong tunay na Browserless token.
- Piliin ang region endpoint na tumutugma sa iyong Browserless account (tingnan ang kanilang docs).

## Seguridad

Mga pangunahing ideya:

- Loopback-only ang kontrol sa browser; dumadaan ang access sa auth ng Gateway o sa node pairing.
- Panatilihing nasa pribadong network (Tailscale) ang Gateway at anumang node host; iwasan ang public exposure.
- Ituring na mga lihim ang mga remote CDP URL/token; mas mainam ang env vars o isang secrets manager.

Mga tip para sa remote CDP:

- Mas mainam ang mga HTTPS endpoint at mga short-lived token kung maaari.
- Iwasang i-embed ang mga long-lived token direkta sa mga config file.

## Mga Profile (multi-browser)

Sinusuportahan ng OpenClaw ang maraming pinangalanang profile (routing configs). Ang mga profile ay maaaring:

- **openclaw-managed**: isang dedikadong Chromium-based na browser instance na may sariling user data directory + CDP port
- **remote**: isang tahasang CDP URL (Chromium-based na browser na tumatakbo sa ibang lugar)
- **extension relay**: ang umiiral mong Chrome tab(s) sa pamamagitan ng lokal na relay + Chrome extension

Mga default:

- Ang `openclaw` profile ay awtomatikong ginagawa kapag wala.
- Ang `chrome` profile ay built-in para sa Chrome extension relay (nakapoint sa `http://127.0.0.1:18792` bilang default).
- Ang mga lokal na CDP port ay nag-a-allocate mula **18800–18899** bilang default.
- Ang pagbura ng isang profile ay inililipat ang lokal nitong data directory sa Trash.

Tinatanggap ng lahat ng control endpoint ang `?profile=<name>`; ginagamit ng CLI ang `--browser-profile`.

## Chrome extension relay (gamitin ang umiiral mong Chrome)

Maaari ring i-drive ng OpenClaw ang **umiiral mong mga Chrome tab** (walang hiwalay na “openclaw” Chrome instance) sa pamamagitan ng lokal na CDP relay + isang Chrome extension.

Buong gabay: [Chrome extension](/tools/chrome-extension)

Daloy:

- Ang Gateway ay tumatakbo nang lokal (parehong machine) o may node host na tumatakbo sa machine ng browser.
- Isang lokal na **relay server** ang nakikinig sa isang loopback na `cdpUrl` (default: `http://127.0.0.1:18792`).
- I-click mo ang **OpenClaw Browser Relay** extension icon sa isang tab para kumabit (hindi ito auto-attach).
- Kinokontrol ng agent ang tab na iyon sa pamamagitan ng normal na `browser` tool, sa pagpili ng tamang profile.

Kung tumatakbo ang Gateway sa ibang lugar, magpatakbo ng node host sa machine ng browser para ma-proxy ng Gateway ang mga aksyon ng browser.

### Mga sandboxed na session

Kung ang agent session ay naka-sandbox, ang `browser` tool ay maaaring mag-default sa `target="sandbox"` (sandbox browser).
Ang Chrome extension relay takeover ay nangangailangan ng kontrol sa host browser, kaya alinman sa:

- patakbuhin ang session na hindi naka-sandbox, o
- itakda ang `agents.defaults.sandbox.browser.allowHostControl: true` at gamitin ang `target="host"` kapag tinatawag ang tool.

### Setup

1. I-load ang extension (dev/unpacked):

```bash
openclaw browser extension install
```

- Chrome → `chrome://extensions` → i-enable ang “Developer mode”
- “Load unpacked” → piliin ang directory na ipiniprint ng `openclaw browser extension path`
- I-pin ang extension, pagkatapos ay i-click ito sa tab na gusto mong kontrolin (ipinapakita ng badge ang `ON`).

2. Gamitin ito:

- CLI: `openclaw browser --browser-profile chrome tabs`
- Agent tool: `browser` na may `profile="chrome"`

Opsyonal: kung gusto mo ng ibang pangalan o relay port, gumawa ng sarili mong profile:

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

Mga tala:

- Umaasa ang mode na ito sa Playwright-on-CDP para sa karamihan ng mga operasyon (screenshots/snapshots/actions).
- I-detach sa pamamagitan ng muling pag-click sa extension icon.

## Mga garantiya sa isolation

- **Dedikadong user data dir**: hindi kailanman hinahawakan ang personal mong browser profile.
- **Dedikadong mga port**: iniiwasan ang `9222` para maiwasan ang banggaan sa mga dev workflow.
- **Deterministikong kontrol sa tab**: tinatarget ang mga tab sa pamamagitan ng `targetId`, hindi “last tab”.

## Pagpili ng browser

Kapag nagla-launch nang lokal, pipili ang OpenClaw ng unang available:

1. Chrome
2. Brave
3. Edge
4. Chromium
5. Chrome Canary

Maaari mong i-override gamit ang `browser.executablePath`.

Mga platform:

- macOS: sinusuri ang `/Applications` at `~/Applications`.
- Linux: hinahanap ang `google-chrome`, `brave`, `microsoft-edge`, `chromium`, atbp.
- Windows: sinusuri ang mga karaniwang install location.

## Control API (opsyonal)

Para sa mga lokal na integration lamang, inilalantad ng Gateway ang isang maliit na loopback HTTP API:

- Status/start/stop: `GET /`, `POST /start`, `POST /stop`
- Mga tab: `GET /tabs`, `POST /tabs/open`, `POST /tabs/focus`, `DELETE /tabs/:targetId`
- Snapshot/screenshot: `GET /snapshot`, `POST /screenshot`
- Mga aksyon: `POST /navigate`, `POST /act`
- Mga hook: `POST /hooks/file-chooser`, `POST /hooks/dialog`
- Mga download: `POST /download`, `POST /wait/download`
- Debugging: `GET /console`, `POST /pdf`
- Debugging: `GET /errors`, `GET /requests`, `POST /trace/start`, `POST /trace/stop`, `POST /highlight`
- Network: `POST /response/body`
- State: `GET /cookies`, `POST /cookies/set`, `POST /cookies/clear`
- State: `GET /storage/:kind`, `POST /storage/:kind/set`, `POST /storage/:kind/clear`
- Settings: `POST /set/offline`, `POST /set/headers`, `POST /set/credentials`, `POST /set/geolocation`, `POST /set/media`, `POST /set/timezone`, `POST /set/locale`, `POST /set/device`

Tinatanggap ng lahat ng endpoint ang `?profile=<name>`.

### Kinakailangan ang Playwright

Ang ilang feature (navigate/act/AI snapshot/role snapshot, element screenshots, PDF) ay nangangailangan ng
Playwright. Kung hindi naka-install ang Playwright, ang mga endpoint na iyon ay magbabalik ng malinaw na 501
error. Gumagana pa rin ang ARIA snapshots at mga basic screenshot para sa openclaw-managed Chrome.
Para sa Chrome extension relay driver, ang ARIA snapshots at screenshots ay nangangailangan ng Playwright.

Kung makita mo ang `Playwright is not available in this gateway build`, i-install ang buong
Playwright package (hindi `playwright-core`) at i-restart ang gateway, o muling i-install ang
OpenClaw na may browser support.

#### Docker Playwright install

Kung ang iyong Gateway ay tumatakbo sa Docker, iwasan ang `npx playwright` (mga conflict sa npm override).
25. Gamitin na lang ang bundled CLI:

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

Upang mapanatili ang browser downloads, itakda ang `PLAYWRIGHT_BROWSERS_PATH` (halimbawa,
`/home/node/.cache/ms-playwright`) at tiyaking ang `/home/node` ay naka-persist sa pamamagitan ng `OPENCLAW_HOME_VOLUME` o isang bind mount. See [Docker](/install/docker).

## Paano ito gumagana (internal)

High-level na daloy:

- Isang maliit na **control server** ang tumatanggap ng mga HTTP request.
- Kumokonekta ito sa mga Chromium-based na browser (Chrome/Brave/Edge/Chromium) sa pamamagitan ng **CDP**.
- Para sa mga advanced na aksyon (click/type/snapshot/PDF), gumagamit ito ng **Playwright** sa ibabaw ng CDP.
- Kapag wala ang Playwright, tanging mga non-Playwright na operasyon lang ang available.

Pinananatili ng disenyong ito ang agent sa isang stable at deterministikong interface habang hinahayaan kang
magpalit ng lokal/remote na mga browser at profile.

## Mabilisang sanggunian ng CLI

27. Lahat ng command ay tumatanggap ng `--browser-profile <name>` upang tukuyin ang isang partikular na profile.
    Lahat ng command ay tumatanggap din ng `--json` para sa machine-readable na output (stable payloads).

Mga basic:

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

Pag-inspeksyon:

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

Mga aksyon:

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

State:

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

Mga tala:

- Ang `upload` at `dialog` ay mga **arming** call; patakbuhin ang mga ito bago ang click/press
  na magti-trigger ng chooser/dialog.
- Maaari ring itakda ng `upload` ang mga file input direkta sa pamamagitan ng `--input-ref` o `--element`.
- `snapshot`:
  - `--format ai` (default kapag naka-install ang Playwright): nagbabalik ng AI snapshot na may numeric refs (`aria-ref="<n>"`).
  - `--format aria`: nagbabalik ng accessibility tree (walang refs; para sa inspeksyon lang).
  - `--efficient` (o `--mode efficient`): compact role snapshot preset (interactive + compact + depth + mas mababang maxChars).
  - Config default (tool/CLI lang): itakda ang `browser.snapshotDefaults.mode: "efficient"` para gumamit ng efficient snapshots kapag hindi nagpapasa ng mode ang caller (tingnan ang [Gateway configuration](/gateway/configuration#browser-openclaw-managed-browser)).
  - Mga opsyon sa role snapshot (`--interactive`, `--compact`, `--depth`, `--selector`) ay pinipilit ang role-based snapshot na may refs tulad ng `ref=e12`.
  - Ang `--frame "<iframe selector>"` ay naglilimita ng role snapshot sa isang iframe (kapareha ng mga role ref tulad ng `e12`).
  - Ang `--interactive` ay naglalabas ng flat at madaling piliing listahan ng mga interactive element (pinakamainam para sa pag-drive ng mga aksyon).
  - Ang `--labels` ay nagdaragdag ng viewport-only screenshot na may overlayed na mga ref label (nagpi-print ng `MEDIA:<path>`).
- Ang `click`/`type`/atbp ay nangangailangan ng isang `ref` mula sa `snapshot` (alinman sa numeric na `12` o role ref na `e12`).
  Ang mga CSS selector ay sadyang hindi sinusuportahan para sa mga action.

## Mga snapshot at ref

Sinusuportahan ng OpenClaw ang dalawang “snapshot” na estilo:

- **AI snapshot (numeric refs)**: `openclaw browser snapshot` (default; `--format ai`)
  - Output: isang text snapshot na may kasamang numeric refs.
  - Mga aksyon: `openclaw browser click 12`, `openclaw browser type 23 "hello"`.
  - Sa loob, nireresolba ang ref sa pamamagitan ng `aria-ref` ng Playwright.

- **Role snapshot (role refs tulad ng `e12`)**: `openclaw browser snapshot --interactive` (o `--compact`, `--depth`, `--selector`, `--frame`)
  - Output: isang role-based na list/tree na may `[ref=e12]` (at opsyonal na `[nth=1]`).
  - Mga aksyon: `openclaw browser click e12`, `openclaw browser highlight e12`.
  - Sa loob, nireresolba ang ref sa pamamagitan ng `getByRole(...)` (kasama ang `nth()` para sa mga duplicate).
  - Idagdag ang `--labels` para magsama ng viewport screenshot na may overlayed na mga label na `e12`.

Pag-uugali ng ref:

- Ang mga ref ay **hindi stable sa iba’t ibang navigation**; kung may pumalya, patakbuhin muli ang `snapshot` at gumamit ng sariwang ref.
- Kung ang role snapshot ay kinuha gamit ang `--frame`, naka-scope ang mga role ref sa iframe na iyon hanggang sa susunod na role snapshot.

## Mga wait power-up

Maaari kang maghintay ng higit pa sa oras/text lang:

- Maghintay sa URL (sinusuportahan ng Playwright ang globs):
  - `openclaw browser wait --url "**/dash"`
- Maghintay sa load state:
  - `openclaw browser wait --load networkidle`
- Maghintay sa isang JS predicate:
  - `openclaw browser wait --fn "window.ready===true"`
- Maghintay na maging visible ang isang selector:
  - `openclaw browser wait "#main"`

Maaaring pagsamahin ang mga ito:

```bash
openclaw browser wait "#main" \
  --url "**/dash" \
  --load networkidle \
  --fn "window.ready===true" \
  --timeout-ms 15000
```

## Mga workflow sa pag-debug

Kapag pumalya ang isang aksyon (hal., “not visible”, “strict mode violation”, “covered”):

1. `openclaw browser snapshot --interactive`
2. Gamitin ang `click <ref>` / `type <ref>` (mas mainam ang role refs sa interactive mode)
3. Kung pumalya pa rin: `openclaw browser highlight <ref>` para makita kung ano ang tina-target ng Playwright
4. Kung kakaiba ang kilos ng page:
   - `openclaw browser errors --clear`
   - `openclaw browser requests --filter api --clear`
5. Para sa malalim na pag-debug: mag-record ng trace:
   - `openclaw browser trace start`
   - ulitin ang isyu
   - `openclaw browser trace stop` (nagpi-print ng `TRACE:<path>`)

## JSON output

Ang `--json` ay para sa scripting at structured tooling.

Mga halimbawa:

```bash
openclaw browser status --json
openclaw browser snapshot --interactive --json
openclaw browser requests --filter api --json
openclaw browser cookies --json
```

Ang mga role snapshot sa JSON ay may kasamang `refs` pati isang maliit na `stats` block (lines/chars/refs/interactive) para makapag-reason ang mga tool tungkol sa laki at density ng payload.

## State at environment knobs

Kapaki-pakinabang ang mga ito para sa mga workflow na “gawing umasal ang site na parang X”:

- Cookies: `cookies`, `cookies set`, `cookies clear`
- Storage: `storage local|session get|set|clear`
- Offline: `set offline on|off`
- Headers: `set headers --json '{"X-Debug":"1"}'` (o `--clear`)
- HTTP basic auth: `set credentials user pass` (o `--clear`)
- Geolocation: `set geo <lat> <lon> --origin "https://example.com"` (o `--clear`)
- Media: `set media dark|light|no-preference|none`
- Timezone / locale: `set timezone ...`, `set locale ...`
- Device / viewport:
  - `set device "iPhone 14"` (Playwright device presets)
  - `set viewport 1280 720`

## Seguridad at privacy

- Ang openclaw browser profile ay maaaring maglaman ng mga naka-login na session; ituring itong sensitibo.
- Ang `browser act kind=evaluate` / `openclaw browser evaluate` at `wait --fn`
  ay nagsasagawa ng arbitrary JavaScript sa page context. Maaaring idirekta ng prompt injection
  ito. 28. I-disable ito gamit ang `browser.evaluateEnabled=false` kung hindi mo ito kailangan.
- Para sa mga login at anti-bot na tala (X/Twitter, atbp.), tingnan ang [Browser login + X/Twitter posting](/tools/browser-login).
- Panatilihing pribado ang Gateway/node host (loopback o tailnet-only).
- Makapangyarihan ang mga remote CDP endpoint; i-tunnel at protektahan ang mga ito.

## Pag-troubleshoot

Para sa mga isyung partikular sa Linux (lalo na sa snap Chromium), tingnan ang
[Browser troubleshooting](/tools/browser-linux-troubleshooting).

## Mga agent tool + kung paano gumagana ang kontrol

Nakakakuha ang agent ng **isang tool** para sa browser automation:

- `browser` — status/start/stop/tabs/open/focus/close/snapshot/screenshot/navigate/act

Paano ito nagma-map:

- Ang `browser snapshot` ay nagbabalik ng stable na UI tree (AI o ARIA).
- Ang `browser act` ay gumagamit ng mga snapshot `ref` ID para mag-click/mag-type/mag-drag/mag-select.
- Ang `browser screenshot` ay kumukuha ng pixels (buong page o element).
- Tinatanggap ng `browser` ang:
  - `profile` para pumili ng pinangalanang browser profile (openclaw, chrome, o remote CDP).
  - `target` (`sandbox` | `host` | `node`) para piliin kung saan naninirahan ang browser.
  - Sa mga sandboxed na session, ang `target: "host"` ay nangangailangan ng `agents.defaults.sandbox.browser.allowHostControl=true`.
  - Kapag inalis ang `target`: ang mga sandboxed na session ay nagde-default sa `sandbox`, at ang mga non-sandbox session ay nagde-default sa `host`.
  - Kung may nakakonektang browser-capable na node, maaaring auto-route ang tool papunta rito maliban kung i-pin mo ang `target="host"` o `target="node"`.

Pinananatili nitong deterministiko ang agent at iniiwasan ang marurupok na selector.
