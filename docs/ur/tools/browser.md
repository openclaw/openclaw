---
summary: "مربوط براؤزر کنٹرول سروس + ایکشن کمانڈز"
read_when:
  - ایجنٹ کے زیرِ کنٹرول براؤزر آٹومیشن شامل کرتے وقت
  - یہ جانچتے وقت کہ openclaw آپ کے اپنے Chrome میں مداخلت کیوں کر رہا ہے
  - macOS ایپ میں براؤزر سیٹنگز + لائف سائیکل نافذ کرتے وقت
title: "Browser (OpenClaw-managed)"
---

# Browser (openclaw-managed)

OpenClaw can run a **dedicated Chrome/Brave/Edge/Chromium profile** that the agent controls.
It is isolated from your personal browser and is managed through a small local
control service inside the Gateway (loopback only).

Beginner view:

- اسے ایک **علیحدہ، صرف ایجنٹ کے لیے براؤزر** سمجھیں۔
- `openclaw` پروفائل آپ کے ذاتی براؤزر پروفائل کو **بالکل نہیں** چھوتا۔
- ایجنٹ ایک محفوظ ماحول میں **ٹیب کھول سکتا ہے، صفحات پڑھ سکتا ہے، کلک اور ٹائپ** کر سکتا ہے۔
- ڈیفالٹ `chrome` پروفائل ایکسٹینشن ریلے کے ذریعے **سسٹم ڈیفالٹ Chromium براؤزر** استعمال کرتا ہے؛
  الگ تھلگ منیجڈ براؤزر کے لیے `openclaw` پر سوئچ کریں۔

## What you get

- **openclaw** نام کا ایک علیحدہ براؤزر پروفائل (بطورِ طے شدہ نارنجی ایکسنٹ کے ساتھ)۔
- قابلِ پیش گوئی ٹیب کنٹرول (list/open/focus/close)۔
- ایجنٹ ایکشنز (click/type/drag/select)، اسنیپ شاٹس، اسکرین شاٹس، PDFs۔
- اختیاری ملٹی پروفائل سپورٹ (`openclaw`, `work`, `remote`, ...)۔

This browser is **not** your daily driver. It is a safe, isolated surface for
agent automation and verification.

## Quick start

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

اگر آپ کو “Browser disabled” ملے، تو کنفیگ میں اسے فعال کریں (نیچے دیکھیں) اور
Gateway کو ری اسٹارٹ کریں۔

## Profiles: `openclaw` vs `chrome`

- `openclaw`: منیجڈ، الگ تھلگ براؤزر (کسی ایکسٹینشن کی ضرورت نہیں)۔
- `chrome`: آپ کے **سسٹم براؤزر** تک ایکسٹینشن ریلے (OpenClaw ایکسٹینشن کو کسی ٹیب سے منسلک کرنا ضروری ہے)۔

اگر آپ منیجڈ موڈ کو بطورِ طے شدہ چاہتے ہیں تو `browser.defaultProfile: "openclaw"` سیٹ کریں۔

## Configuration

براؤزر سیٹنگز `~/.openclaw/openclaw.json` میں ہوتی ہیں۔

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

Notes:

- The browser control service binds to loopback on a port derived from `gateway.port`
  (default: `18791`, which is gateway + 2). The relay uses the next port (`18792`).
- اگر آپ Gateway پورٹ (`gateway.port` یا `OPENCLAW_GATEWAY_PORT`) اوور رائیڈ کریں،
  تو اخذ شدہ براؤزر پورٹس اسی “فیملی” میں رہنے کے لیے شفٹ ہو جاتے ہیں۔
- `cdpUrl` اگر سیٹ نہ ہو تو بطورِ طے شدہ ریلے پورٹ لیتا ہے۔
- `remoteCdpTimeoutMs` ریموٹ (non-loopback) CDP رسائی کی جانچ پر لاگو ہوتا ہے۔
- `remoteCdpHandshakeTimeoutMs` ریموٹ CDP WebSocket رسائی کی جانچ پر لاگو ہوتا ہے۔
- `attachOnly: true` کا مطلب ہے “کبھی مقامی براؤزر لانچ نہ کریں؛ صرف اسی صورت منسلک کریں جب وہ پہلے سے چل رہا ہو۔”
- `color` + فی پروفائل `color` براؤزر UI کو رنگ دیتے ہیں تاکہ معلوم ہو سکے کون سا پروفائل فعال ہے۔
- Default profile is `chrome` (extension relay). Use `defaultProfile: "openclaw"` for the managed browser.
- آٹو ڈیٹیکٹ آرڈر: اگر Chromium-based ہو تو سسٹم ڈیفالٹ براؤزر؛ ورنہ Chrome → Brave → Edge → Chromium → Chrome Canary۔
- مقامی `openclaw` پروفائلز خود بخود `cdpPort`/`cdpUrl` اسائن کرتے ہیں — انہیں صرف ریموٹ CDP کے لیے سیٹ کریں۔

## Use Brave (or another Chromium-based browser)

If your **system default** browser is Chromium-based (Chrome/Brave/Edge/etc),
OpenClaw uses it automatically. Set `browser.executablePath` to override
auto-detection:

CLI example:

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

## Local vs remote control

- **Local control (default):** Gateway loopback کنٹرول سروس شروع کرتا ہے اور مقامی براؤزر لانچ کر سکتا ہے۔
- **Remote control (node host):** اس مشین پر node host چلائیں جہاں براؤزر موجود ہو؛ Gateway براؤزر ایکشنز کو وہاں پروکسی کرتا ہے۔
- **Remote CDP:** set `browser.profiles.<name>.cdpUrl` (or `browser.cdpUrl`) to
  attach to a remote Chromium-based browser. In this case, OpenClaw will not launch a local browser.

Remote CDP URLs میں auth شامل ہو سکتا ہے:

- Query tokens (مثلاً `https://provider.example?token=<token>`)
- HTTP Basic auth (مثلاً `https://user:pass@provider.example`)

OpenClaw preserves the auth when calling `/json/*` endpoints and when connecting
to the CDP WebSocket. Prefer environment variables or secrets managers for
tokens instead of committing them to config files.

## Node browser proxy (zero-config default)

If you run a **node host** on the machine that has your browser, OpenClaw can
auto-route browser tool calls to that node without any extra browser config.
This is the default path for remote gateways.

Notes:

- node host ایک **proxy command** کے ذریعے اپنا مقامی براؤزر کنٹرول سرور ایکسپوز کرتا ہے۔
- پروفائلز node کی اپنی `browser.profiles` کنفیگ سے آتے ہیں (بالکل مقامی کی طرح)۔
- اگر آپ نہیں چاہتے تو غیر فعال کریں:
  - node پر: `nodeHost.browserProxy.enabled=false`
  - gateway پر: `gateway.nodes.browser.mode="off"`

## Browserless (hosted remote CDP)

[Browserless](https://browserless.io) is a hosted Chromium service that exposes
CDP endpoints over HTTPS. You can point a OpenClaw browser profile at a
Browserless region endpoint and authenticate with your API key.

Example:

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

Notes:

- `<BROWSERLESS_API_KEY>` کو اپنے اصل Browserless ٹوکن سے بدلیں۔
- اپنے Browserless اکاؤنٹ کے مطابق ریجن endpoint منتخب کریں (ان کی دستاویزات دیکھیں)۔

## Security

اہم نکات:

- براؤزر کنٹرول صرف loopback تک محدود ہے؛ رسائی Gateway کی auth یا node pairing کے ذریعے ہوتی ہے۔
- Gateway اور کسی بھی node host کو نجی نیٹ ورک (Tailscale) پر رکھیں؛ عوامی ایکسپوژر سے بچیں۔
- Remote CDP URLs/ٹوکنز کو راز سمجھیں؛ env vars یا secrets manager کو ترجیح دیں۔

Remote CDP tips:

- جہاں ممکن ہو HTTPS endpoints اور قلیل مدتی ٹوکنز استعمال کریں۔
- طویل مدتی ٹوکنز کو براہِ راست کنفیگ فائلز میں شامل کرنے سے گریز کریں۔

## Profiles (multi-browser)

OpenClaw supports multiple named profiles (routing configs). Profiles can be:

- **openclaw-managed**: ایک وقف شدہ Chromium-based براؤزر انسٹینس جس کی اپنی user data directory + CDP پورٹ ہو
- **remote**: ایک واضح CDP URL (کہیں اور چل رہا Chromium-based براؤزر)
- **extension relay**: مقامی ریلے + Chrome ایکسٹینشن کے ذریعے آپ کے موجودہ Chrome ٹیبز

Defaults:

- اگر موجود نہ ہو تو `openclaw` پروفائل خود بخود بنایا جاتا ہے۔
- `chrome` پروفائل Chrome ایکسٹینشن ریلے کے لیے built-in ہے (بطورِ طے شدہ `http://127.0.0.1:18792` کی طرف اشارہ کرتا ہے)۔
- مقامی CDP پورٹس بطورِ طے شدہ **18800–18899** سے الاٹ ہوتے ہیں۔
- کسی پروفائل کو حذف کرنے سے اس کی مقامی data directory Trash میں منتقل ہو جاتی ہے۔

تمام کنٹرول endpoints `?profile=<name>` قبول کرتے ہیں؛ CLI `--browser-profile` استعمال کرتا ہے۔

## Chrome extension relay (use your existing Chrome)

OpenClaw مقامی CDP ریلے + Chrome ایکسٹینشن کے ذریعے **آپ کے موجودہ Chrome ٹیبز** کو بھی کنٹرول کر سکتا ہے
(کوئی علیحدہ “openclaw” Chrome انسٹینس نہیں)۔

مکمل رہنمائی: [Chrome extension](/tools/chrome-extension)

Flow:

- Gateway مقامی طور پر چلتا ہے (اسی مشین پر) یا براؤزر مشین پر node host چلتا ہے۔
- ایک مقامی **relay server** loopback `cdpUrl` پر سنتا ہے (ڈیفالٹ: `http://127.0.0.1:18792`)۔
- آپ جس ٹیب کو کنٹرول کرنا چاہتے ہیں اس پر **OpenClaw Browser Relay** ایکسٹینشن آئیکن پر کلک کرتے ہیں (یہ خودکار طور پر منسلک نہیں ہوتی)۔
- ایجنٹ درست پروفائل منتخب کر کے عام `browser` ٹول کے ذریعے اس ٹیب کو کنٹرول کرتا ہے۔

اگر Gateway کہیں اور چل رہا ہو، تو براؤزر مشین پر node host چلائیں تاکہ Gateway براؤزر ایکشنز کو پروکسی کر سکے۔

### Sandboxed sessions

If the agent session is sandboxed, the `browser` tool may default to `target="sandbox"` (sandbox browser).
Chrome extension relay takeover requires host browser control, so either:

- سیشن unsandboxed چلائیں، یا
- `agents.defaults.sandbox.browser.allowHostControl: true` سیٹ کریں اور ٹول کال کرتے وقت `target="host"` استعمال کریں۔

### Setup

1. ایکسٹینشن لوڈ کریں (dev/unpacked):

```bash
openclaw browser extension install
```

- Chrome → `chrome://extensions` → “Developer mode” فعال کریں
- “Load unpacked” → وہ ڈائریکٹری منتخب کریں جو `openclaw browser extension path` پرنٹ کرتا ہے
- ایکسٹینشن کو پن کریں، پھر جس ٹیب کو کنٹرول کرنا ہے اس پر کلک کریں (بیج `ON` دکھاتا ہے)۔

2. استعمال کریں:

- CLI: `openclaw browser --browser-profile chrome tabs`
- Agent tool: `browser` مع `profile="chrome"`

اختیاری: اگر آپ مختلف نام یا ریلے پورٹ چاہتے ہیں تو اپنا پروفائل بنائیں:

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

Notes:

- یہ موڈ زیادہ تر آپریشنز (screenshots/snapshots/actions) کے لیے Playwright-on-CDP پر انحصار کرتا ہے۔
- ایکسٹینشن آئیکن دوبارہ کلک کر کے detach کریں۔

## Isolation guarantees

- **وقف شدہ user data dir**: آپ کے ذاتی براؤزر پروفائل کو کبھی نہیں چھوتا۔
- **وقف شدہ پورٹس**: dev workflows کے ساتھ ٹکراؤ سے بچنے کے لیے `9222` سے گریز۔
- **قابلِ پیش گوئی ٹیب کنٹرول**: “آخری ٹیب” کے بجائے `targetId` کے ذریعے ٹیب ہدف بنائیں۔

## Browser selection

مقامی لانچ پر، OpenClaw دستیاب ہونے پر پہلا منتخب کرتا ہے:

1. Chrome
2. Brave
3. Edge
4. Chromium
5. Chrome Canary

آپ `browser.executablePath` کے ساتھ اوور رائیڈ کر سکتے ہیں۔

Platforms:

- macOS: `/Applications` اور `~/Applications` چیک کرتا ہے۔
- Linux: `google-chrome`, `brave`, `microsoft-edge`, `chromium` وغیرہ تلاش کرتا ہے۔
- Windows: عام انسٹال لوکیشنز چیک کرتا ہے۔

## Control API (optional)

صرف مقامی انضمام کے لیے، Gateway ایک چھوٹی loopback HTTP API ایکسپوز کرتا ہے:

- Status/start/stop: `GET /`, `POST /start`, `POST /stop`
- Tabs: `GET /tabs`, `POST /tabs/open`, `POST /tabs/focus`, `DELETE /tabs/:targetId`
- Snapshot/screenshot: `GET /snapshot`, `POST /screenshot`
- Actions: `POST /navigate`, `POST /act`
- Hooks: `POST /hooks/file-chooser`, `POST /hooks/dialog`
- Downloads: `POST /download`, `POST /wait/download`
- Debugging: `GET /console`, `POST /pdf`
- Debugging: `GET /errors`, `GET /requests`, `POST /trace/start`, `POST /trace/stop`, `POST /highlight`
- Network: `POST /response/body`
- State: `GET /cookies`, `POST /cookies/set`, `POST /cookies/clear`
- State: `GET /storage/:kind`, `POST /storage/:kind/set`, `POST /storage/:kind/clear`
- Settings: `POST /set/offline`, `POST /set/headers`, `POST /set/credentials`, `POST /set/geolocation`, `POST /set/media`, `POST /set/timezone`, `POST /set/locale`, `POST /set/device`

تمام endpoints `?profile=<name>` قبول کرتے ہیں۔

### Playwright requirement

Some features (navigate/act/AI snapshot/role snapshot, element screenshots, PDF) require
Playwright. If Playwright isn’t installed, those endpoints return a clear 501
error. ARIA snapshots and basic screenshots still work for openclaw-managed Chrome.
For the Chrome extension relay driver, ARIA snapshots and screenshots require Playwright.

اگر آپ `Playwright is not available in this gateway build` دیکھیں، تو مکمل
Playwright پیکج انسٹال کریں ( `playwright-core` نہیں ) اور gateway ری اسٹارٹ کریں، یا
براؤزر سپورٹ کے ساتھ OpenClaw دوبارہ انسٹال کریں۔

#### Docker Playwright install

If your Gateway runs in Docker, avoid `npx playwright` (npm override conflicts).
Use the bundled CLI instead:

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

To persist browser downloads, set `PLAYWRIGHT_BROWSERS_PATH` (for example,
`/home/node/.cache/ms-playwright`) and make sure `/home/node` is persisted via
`OPENCLAW_HOME_VOLUME` or a bind mount. See [Docker](/install/docker).

## How it works (internal)

High-level flow:

- ایک چھوٹا **control server** HTTP درخواستیں قبول کرتا ہے۔
- یہ **CDP** کے ذریعے Chromium-based براؤزرز (Chrome/Brave/Edge/Chromium) سے جڑتا ہے۔
- جدید ایکشنز (click/type/snapshot/PDF) کے لیے، یہ CDP کے اوپر **Playwright** استعمال کرتا ہے۔
- جب Playwright موجود نہ ہو، تو صرف non-Playwright آپریشنز دستیاب ہوتے ہیں۔

یہ ڈیزائن ایجنٹ کو ایک مستحکم، قابلِ پیش گوئی انٹرفیس پر رکھتا ہے جبکہ
آپ کو مقامی/ریموٹ براؤزرز اور پروفائلز تبدیل کرنے کی سہولت دیتا ہے۔

## CLI quick reference

All commands accept `--browser-profile <name>` to target a specific profile.
All commands also accept `--json` for machine-readable output (stable payloads).

Basics:

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

Inspection:

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

Actions:

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

Notes:

- `upload` اور `dialog` **arming** کالز ہیں؛ chooser/dialog کو ٹرگر کرنے والے click/press سے پہلے انہیں چلائیں۔
- `upload` فائل ان پٹس کو براہِ راست `--input-ref` یا `--element` کے ذریعے بھی سیٹ کر سکتا ہے۔
- `snapshot`:
  - `--format ai` (جب Playwright انسٹال ہو تو ڈیفالٹ): عددی refs (`aria-ref="<n>"`) کے ساتھ AI snapshot لوٹاتا ہے۔
  - `--format aria`: accessibility tree لوٹاتا ہے (کوئی refs نہیں؛ صرف معائنہ)۔
  - `--efficient` (یا `--mode efficient`): compact role snapshot preset (interactive + compact + depth + کم maxChars)۔
  - کنفیگ ڈیفالٹ (صرف tool/CLI): `browser.snapshotDefaults.mode: "efficient"` سیٹ کریں تاکہ جب کالر موڈ نہ دے تو مؤثر snapshots استعمال ہوں (دیکھیں [Gateway configuration](/gateway/configuration#browser-openclaw-managed-browser))۔
  - Role snapshot options (`--interactive`, `--compact`, `--depth`, `--selector`) role-based snapshot کو refs جیسے `ref=e12` کے ساتھ مجبور کرتے ہیں۔
  - `--frame "<iframe selector>"` role snapshots کو کسی iframe تک محدود کرتا ہے (role refs جیسے `e12` کے ساتھ جوڑا جاتا ہے)۔
  - `--interactive` interactive عناصر کی ایک سادہ، آسان فہرست آؤٹ پٹ کرتا ہے (ایکشنز چلانے کے لیے بہترین)۔
  - `--labels` viewport-only اسکرین شاٹ شامل کرتا ہے جس پر overlayed ref labels ہوتے ہیں ( `MEDIA:<path>` پرنٹ کرتا ہے)۔
- `click`/`type`/etc require a `ref` from `snapshot` (either numeric `12` or role ref `e12`).
  CSS selectors are intentionally not supported for actions.

## Snapshots and refs

OpenClaw دو “snapshot” طرزیں سپورٹ کرتا ہے:

- **AI snapshot (numeric refs)**: `openclaw browser snapshot` (ڈیفالٹ؛ `--format ai`)
  - Output: ایک ٹیکسٹ snapshot جس میں عددی refs شامل ہوتے ہیں۔
  - Actions: `openclaw browser click 12`, `openclaw browser type 23 "hello"`۔
  - اندرونی طور پر، ref Playwright کے `aria-ref` کے ذریعے resolve ہوتا ہے۔

- **Role snapshot (role refs جیسے `e12`)**: `openclaw browser snapshot --interactive` (یا `--compact`, `--depth`, `--selector`, `--frame`)
  - Output: `[ref=e12]` کے ساتھ role-based فہرست/درخت (اور اختیاری `[nth=1]`)۔
  - Actions: `openclaw browser click e12`, `openclaw browser highlight e12`۔
  - اندرونی طور پر، ref `getByRole(...)` کے ذریعے resolve ہوتا ہے (ڈپلیکیٹس کے لیے `nth()` کے ساتھ)۔
  - viewport اسکرین شاٹ شامل کرنے کے لیے `--labels` شامل کریں جس پر overlayed `e12` لیبلز ہوں۔

Ref behavior:

- Refs **نیویگیشن کے بعد مستحکم نہیں رہتے**؛ اگر کچھ ناکام ہو جائے تو `snapshot` دوبارہ چلائیں اور نیا ref استعمال کریں۔
- اگر role snapshot `--frame` کے ساتھ لیا گیا ہو، تو role refs اگلے role snapshot تک اسی iframe تک محدود رہتے ہیں۔

## Wait power-ups

آپ صرف وقت/متن ہی نہیں بلکہ مزید چیزوں کا انتظار کر سکتے ہیں:

- URL کا انتظار (Playwright کے globs سپورٹڈ):
  - `openclaw browser wait --url "**/dash"`
- load state کا انتظار:
  - `openclaw browser wait --load networkidle`
- JS predicate کا انتظار:
  - `openclaw browser wait --fn "window.ready===true"`
- کسی selector کے visible ہونے کا انتظار:
  - `openclaw browser wait "#main"`

انہیں یکجا بھی کیا جا سکتا ہے:

```bash
openclaw browser wait "#main" \
  --url "**/dash" \
  --load networkidle \
  --fn "window.ready===true" \
  --timeout-ms 15000
```

## Debug workflows

جب کوئی ایکشن ناکام ہو (مثلاً “not visible”، “strict mode violation”، “covered”):

1. `openclaw browser snapshot --interactive`
2. `click <ref>` / `type <ref>` استعمال کریں (interactive موڈ میں role refs کو ترجیح دیں)
3. اگر پھر بھی ناکام ہو: `openclaw browser highlight <ref>` تاکہ دیکھا جا سکے Playwright کیا ہدف بنا رہا ہے
4. اگر صفحہ عجیب برتاؤ کرے:
   - `openclaw browser errors --clear`
   - `openclaw browser requests --filter api --clear`
5. گہری ڈیبگنگ کے لیے: trace ریکارڈ کریں:
   - `openclaw browser trace start`
   - مسئلہ دوبارہ پیدا کریں
   - `openclaw browser trace stop` ( `TRACE:<path>` پرنٹ کرتا ہے)

## JSON output

`--json` اسکرپٹنگ اور ساختی ٹولنگ کے لیے ہے۔

Examples:

```bash
openclaw browser status --json
openclaw browser snapshot --interactive --json
openclaw browser requests --filter api --json
openclaw browser cookies --json
```

JSON میں role snapshots میں `refs` کے ساتھ ایک چھوٹا `stats` بلاک (lines/chars/refs/interactive) شامل ہوتا ہے تاکہ ٹولز payload کے سائز اور کثافت پر غور کر سکیں۔

## State and environment knobs

یہ “سائٹ کو X کی طرح برتاؤ کرو” والے ورک فلو کے لیے مفید ہیں:

- Cookies: `cookies`, `cookies set`, `cookies clear`
- Storage: `storage local|session get|set|clear`
- Offline: `set offline on|off`
- Headers: `set headers --json '{"X-Debug":"1"}'` (یا `--clear`)
- HTTP basic auth: `set credentials user pass` (یا `--clear`)
- Geolocation: `set geo <lat> <lon> --origin "https://example.com"` (یا `--clear`)
- Media: `set media dark|light|no-preference|none`
- Timezone / locale: `set timezone ...`, `set locale ...`
- Device / viewport:
  - `set device "iPhone 14"` (Playwright device presets)
  - `set viewport 1280 720`

## Security & privacy

- openclaw براؤزر پروفائل میں لاگ اِن سیشنز ہو سکتے ہیں؛ اسے حساس سمجھیں۔
- `browser act kind=evaluate` / `openclaw browser evaluate` and `wait --fn`
  execute arbitrary JavaScript in the page context. Prompt injection can steer
  this. Disable it with `browser.evaluateEnabled=false` if you do not need it.
- لاگ اِنز اور anti-bot نوٹس (X/Twitter وغیرہ) کے لیے دیکھیں [Browser login + X/Twitter posting](/tools/browser-login)۔
- Gateway/node host کو نجی رکھیں (loopback یا tailnet-only)۔
- Remote CDP endpoints طاقتور ہوتے ہیں؛ انہیں tunnel اور محفوظ رکھیں۔

## Troubleshooting

Linux مخصوص مسائل (خصوصاً snap Chromium) کے لیے دیکھیں
[Browser troubleshooting](/tools/browser-linux-troubleshooting)۔

## Agent tools + how control works

ایجنٹ کو براؤزر آٹومیشن کے لیے **ایک ٹول** ملتا ہے:

- `browser` — status/start/stop/tabs/open/focus/close/snapshot/screenshot/navigate/act

How it maps:

- `browser snapshot` ایک مستحکم UI درخت (AI یا ARIA) لوٹاتا ہے۔
- `browser act` snapshot کے `ref` IDs استعمال کر کے click/type/drag/select کرتا ہے۔
- `browser screenshot` پکسلز کیپچر کرتا ہے (پورا صفحہ یا عنصر)۔
- `browser` قبول کرتا ہے:
  - `profile` نامی براؤزر پروفائل منتخب کرنے کے لیے (openclaw، chrome، یا remote CDP)۔
  - `target` (`sandbox` | `host` | `node`) یہ منتخب کرنے کے لیے کہ براؤزر کہاں ہے۔
  - sandboxed سیشنز میں، `target: "host"` کے لیے `agents.defaults.sandbox.browser.allowHostControl=true` درکار ہوتا ہے۔
  - اگر `target` چھوڑ دیا جائے: sandboxed سیشنز بطورِ طے شدہ `sandbox`، غیر sandbox سیشنز بطورِ طے شدہ `host` لیتے ہیں۔
  - اگر براؤزر-قابل node منسلک ہو، تو ٹول خودکار طور پر اسی کی طرف روٹ کر سکتا ہے جب تک کہ آپ `target="host"` یا `target="node"` پن نہ کریں۔

یہ ایجنٹ کو قابلِ پیش گوئی رکھتا ہے اور نازک selectors سے بچاتا ہے۔
