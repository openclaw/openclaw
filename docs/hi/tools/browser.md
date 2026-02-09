---
summary: "एकीकृत ब्राउज़र नियंत्रण सेवा + एक्शन कमांड"
read_when:
  - एजेंट-नियंत्रित ब्राउज़र ऑटोमेशन जोड़ते समय
  - यह डिबग करते समय कि OpenClaw आपके अपने Chrome में हस्तक्षेप क्यों कर रहा है
  - macOS ऐप में ब्राउज़र सेटिंग्स + लाइफसाइकल लागू करते समय
title: "Browser (OpenClaw-प्रबंधित)"
---

# Browser (openclaw-managed)

OpenClaw एक **डेडिकेटेड Chrome/Brave/Edge/Chromium प्रोफ़ाइल** चला सकता है जिसे एजेंट नियंत्रित करता है।
It is isolated from your personal browser and is managed through a small local
control service inside the Gateway (loopback only).

शुरुआती दृष्टिकोण:

- इसे एक **अलग, केवल-एजेंट ब्राउज़र** के रूप में समझें।
- `openclaw` प्रोफ़ाइल आपके व्यक्तिगत ब्राउज़र प्रोफ़ाइल को **छूती नहीं** है।
- एजेंट एक सुरक्षित लेन में **टैब खोल सकता है, पेज पढ़ सकता है, क्लिक कर सकता है और टाइप कर सकता है**।
- डिफ़ॉल्ट `chrome` प्रोफ़ाइल **सिस्टम डिफ़ॉल्ट Chromium ब्राउज़र** का उपयोग
  एक्सटेंशन रिले के माध्यम से करती है; अलग-थलग प्रबंधित ब्राउज़र के लिए `openclaw` पर स्विच करें।

## आपको क्या मिलता है

- **openclaw** नाम की एक अलग ब्राउज़र प्रोफ़ाइल (डिफ़ॉल्ट रूप से नारंगी एक्सेंट)।
- नियतात्मक टैब नियंत्रण (सूची/खोलना/फ़ोकस/बंद करना)।
- एजेंट क्रियाएँ (क्लिक/टाइप/ड्रैग/चयन), स्नैपशॉट, स्क्रीनशॉट, PDF।
- वैकल्पिक मल्टी-प्रोफ़ाइल समर्थन (`openclaw`, `work`, `remote`, ...)।

This browser is **not** your daily driver. It is a safe, isolated surface for
agent automation and verification.

## त्वरित प्रारंभ

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

यदि आपको “Browser disabled” मिलता है, तो इसे config में सक्षम करें (नीचे देखें) और
Gateway को पुनः प्रारंभ करें।

## प्रोफ़ाइल्स: `openclaw` बनाम `chrome`

- `openclaw`: प्रबंधित, अलग-थलग ब्राउज़र (किसी एक्सटेंशन की आवश्यकता नहीं)।
- `chrome`: आपके **सिस्टम ब्राउज़र** के लिए एक्सटेंशन रिले
  (OpenClaw एक्सटेंशन को किसी टैब से अटैच करना आवश्यक)।

यदि आप डिफ़ॉल्ट रूप से प्रबंधित मोड चाहते हैं तो `browser.defaultProfile: "openclaw"` सेट करें।

## विन्यास

ब्राउज़र सेटिंग्स `~/.openclaw/openclaw.json` में रहती हैं।

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

नोट्स:

- The browser control service binds to loopback on a port derived from `gateway.port`
  (default: `18791`, which is gateway + 2). The relay uses the next port (`18792`).
- यदि आप Gateway पोर्ट (`gateway.port` या `OPENCLAW_GATEWAY_PORT`) ओवरराइड करते हैं,
  तो व्युत्पन्न ब्राउज़र पोर्ट उसी “परिवार” में रहने के लिए शिफ्ट हो जाते हैं।
- `cdpUrl` अनसेट होने पर रिले पोर्ट पर डिफ़ॉल्ट होता है।
- `remoteCdpTimeoutMs` रिमोट (non-loopback) CDP पहुँच-योग्यता जाँच पर लागू होता है।
- `remoteCdpHandshakeTimeoutMs` रिमोट CDP WebSocket पहुँच-योग्यता जाँच पर लागू होता है।
- `attachOnly: true` का अर्थ है “कभी भी लोकल ब्राउज़र लॉन्च न करें; केवल तभी अटैच करें जब वह पहले से चल रहा हो।”
- `color` + प्रति-प्रोफ़ाइल `color` ब्राउज़र UI को टिंट करते हैं ताकि आप देख सकें कि कौन-सी प्रोफ़ाइल सक्रिय है।
- Default profile is `chrome` (extension relay). Use `defaultProfile: "openclaw"` for the managed browser.
- ऑटो-डिटेक्ट क्रम: यदि Chromium-आधारित हो तो सिस्टम डिफ़ॉल्ट ब्राउज़र; अन्यथा Chrome → Brave → Edge → Chromium → Chrome Canary।
- लोकल `openclaw` प्रोफ़ाइल्स स्वतः `cdpPort`/`cdpUrl` असाइन करती हैं — इन्हें केवल रिमोट CDP के लिए सेट करें।

## Brave (या अन्य Chromium-आधारित ब्राउज़र) का उपयोग करें

If your **system default** browser is Chromium-based (Chrome/Brave/Edge/etc),
OpenClaw uses it automatically. Set `browser.executablePath` to override
auto-detection:

CLI उदाहरण:

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

## लोकल बनाम रिमोट नियंत्रण

- **लोकल नियंत्रण (डिफ़ॉल्ट):** Gateway loopback नियंत्रण सेवा शुरू करता है और लोकल ब्राउज़र लॉन्च कर सकता है।
- **रिमोट नियंत्रण (node होस्ट):** उस मशीन पर node होस्ट चलाएँ जहाँ ब्राउज़र है; Gateway ब्राउज़र क्रियाओं को वहाँ प्रॉक्सी करता है।
- **Remote CDP:** set `browser.profiles.<name>.cdpUrl` (or `browser.cdpUrl`) to
  attach to a remote Chromium-based browser. In this case, OpenClaw will not launch a local browser.

रिमोट CDP URL में auth शामिल हो सकता है:

- क्वेरी टोकन (उदा., `https://provider.example?token=<token>`)
- HTTP Basic auth (उदा., `https://user:pass@provider.example`)

OpenClaw preserves the auth when calling `/json/*` endpoints and when connecting
to the CDP WebSocket. Prefer environment variables or secrets managers for
tokens instead of committing them to config files.

## Node browser proxy (ज़ीरो-कॉन्फ़िग डिफ़ॉल्ट)

If you run a **node host** on the machine that has your browser, OpenClaw can
auto-route browser tool calls to that node without any extra browser config.
This is the default path for remote gateways.

नोट्स:

- node होस्ट अपने लोकल ब्राउज़र नियंत्रण सर्वर को **proxy command** के माध्यम से एक्सपोज़ करता है।
- प्रोफ़ाइल्स node की अपनी `browser.profiles` config से आती हैं (लोकल के समान)।
- यदि आप इसे नहीं चाहते हैं तो अक्षम करें:
  - node पर: `nodeHost.browserProxy.enabled=false`
  - gateway पर: `gateway.nodes.browser.mode="off"`

## Browserless (होस्टेड रिमोट CDP)

[Browserless](https://browserless.io) is a hosted Chromium service that exposes
CDP endpoints over HTTPS. You can point a OpenClaw browser profile at a
Browserless region endpoint and authenticate with your API key.

उदाहरण:

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

नोट्स:

- `<BROWSERLESS_API_KEY>` को अपने वास्तविक Browserless टोकन से बदलें।
- अपने Browserless खाते से मेल खाने वाला क्षेत्रीय एंडपॉइंट चुनें (उनके दस्तावेज़ देखें)।

## सुरक्षा

मुख्य विचार:

- ब्राउज़र नियंत्रण केवल loopback है; पहुँच Gateway के auth या node pairing के माध्यम से प्रवाहित होती है।
- Gateway और किसी भी node होस्ट को निजी नेटवर्क (Tailscale) पर रखें; सार्वजनिक एक्सपोज़र से बचें।
- रिमोट CDP URL/टोकन को सीक्रेट्स की तरह संभालें; env vars या सीक्रेट्स मैनेजर को प्राथमिकता दें।

रिमोट CDP सुझाव:

- जहाँ संभव हो HTTPS एंडपॉइंट्स और अल्प-कालिक टोकन को प्राथमिकता दें।
- config फ़ाइलों में दीर्घ-कालिक टोकन एम्बेड करने से बचें।

## प्रोफ़ाइल्स (मल्टी-ब्राउज़र)

OpenClaw supports multiple named profiles (routing configs). Profiles can be:

- **openclaw-managed**: अपनी user data directory + CDP पोर्ट के साथ एक समर्पित Chromium-आधारित ब्राउज़र इंस्टेंस
- **remote**: एक स्पष्ट CDP URL (कहीं और चल रहा Chromium-आधारित ब्राउज़र)
- **extension relay**: लोकल रिले + Chrome एक्सटेंशन के माध्यम से आपके मौजूदा Chrome टैब्स

डिफ़ॉल्ट्स:

- `openclaw` प्रोफ़ाइल अनुपस्थित होने पर स्वतः बनाई जाती है।
- `chrome` प्रोफ़ाइल Chrome एक्सटेंशन रिले के लिए बिल्ट-इन है (डिफ़ॉल्ट रूप से `http://127.0.0.1:18792` की ओर इंगित करती है)।
- लोकल CDP पोर्ट डिफ़ॉल्ट रूप से **18800–18899** से आवंटित होते हैं।
- किसी प्रोफ़ाइल को हटाने पर उसकी लोकल data directory Trash में स्थानांतरित हो जाती है।

सभी नियंत्रण एंडपॉइंट्स `?profile=<name>` स्वीकार करते हैं; CLI `--browser-profile` का उपयोग करता है।

## Chrome extension relay (अपने मौजूदा Chrome का उपयोग करें)

OpenClaw लोकल CDP रिले + Chrome एक्सटेंशन के माध्यम से
**आपके मौजूदा Chrome टैब्स** को भी चला सकता है (कोई अलग “openclaw” Chrome इंस्टेंस नहीं)।

पूर्ण मार्गदर्शिका: [Chrome extension](/tools/chrome-extension)

फ़्लो:

- Gateway लोकल रूप से (उसी मशीन पर) चलता है या ब्राउज़र मशीन पर node होस्ट चलता है।
- एक लोकल **रिले सर्वर** loopback `cdpUrl` पर सुनता है (डिफ़ॉल्ट: `http://127.0.0.1:18792`)।
- आप अटैच करने के लिए किसी टैब पर **OpenClaw Browser Relay** एक्सटेंशन आइकन क्लिक करते हैं (यह ऑटो-अटैच नहीं होता)।
- एजेंट सही प्रोफ़ाइल चुनकर सामान्य `browser` टूल के माध्यम से उस टैब को नियंत्रित करता है।

यदि Gateway कहीं और चलता है, तो ब्राउज़र मशीन पर node होस्ट चलाएँ ताकि Gateway ब्राउज़र क्रियाओं को प्रॉक्सी कर सके।

### Sandboxed सत्र

If the agent session is sandboxed, the `browser` tool may default to `target="sandbox"` (sandbox browser).
Chrome एक्सटेंशन रिले टेकओवर के लिए होस्ट ब्राउज़र नियंत्रण आवश्यक है, इसलिए या तो:

- सत्र को unsandboxed चलाएँ, या
- `agents.defaults.sandbox.browser.allowHostControl: true` सेट करें और टूल कॉल करते समय `target="host"` का उपयोग करें।

### सेटअप

1. एक्सटेंशन लोड करें (dev/unpacked):

```bash
openclaw browser extension install
```

- Chrome → `chrome://extensions` → “Developer mode” सक्षम करें
- “Load unpacked” → `openclaw browser extension path` द्वारा मुद्रित डायरेक्टरी चुनें
- एक्सटेंशन पिन करें, फिर जिस टैब को आप नियंत्रित करना चाहते हैं उस पर क्लिक करें (बैज `ON` दिखाता है)।

2. इसका उपयोग करें:

- CLI: `openclaw browser --browser-profile chrome tabs`
- एजेंट टूल: `browser` के साथ `profile="chrome"`

वैकल्पिक: यदि आप अलग नाम या रिले पोर्ट चाहते हैं, तो अपनी स्वयं की प्रोफ़ाइल बनाएँ:

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

नोट्स:

- यह मोड अधिकांश ऑपरेशनों (स्क्रीनशॉट/स्नैपशॉट/क्रियाएँ) के लिए Playwright-on-CDP पर निर्भर करता है।
- अलग करने के लिए एक्सटेंशन आइकन फिर से क्लिक करें।

## अलगाव की गारंटी

- **समर्पित user data dir**: आपके व्यक्तिगत ब्राउज़र प्रोफ़ाइल को कभी नहीं छूता।
- **समर्पित पोर्ट्स**: dev workflows के साथ टकराव से बचने के लिए `9222` से बचता है।
- **नियतात्मक टैब नियंत्रण**: “last tab” के बजाय `targetId` द्वारा टैब लक्षित करें।

## ब्राउज़र चयन

लोकल रूप से लॉन्च करते समय, OpenClaw पहला उपलब्ध चुनता है:

1. Chrome
2. Brave
3. Edge
4. Chromium
5. Chrome Canary

आप `browser.executablePath` के साथ ओवरराइड कर सकते हैं।

प्लैटफ़ॉर्म्स:

- macOS: `/Applications` और `~/Applications` की जाँच करता है।
- Linux: `google-chrome`, `brave`, `microsoft-edge`, `chromium`, आदि खोजता है।
- Windows: सामान्य इंस्टॉल लोकेशन्स की जाँच करता है।

## Control API (वैकल्पिक)

केवल लोकल इंटीग्रेशन्स के लिए, Gateway एक छोटा loopback HTTP API एक्सपोज़ करता है:

- स्थिति/शुरू/बंद: `GET /`, `POST /start`, `POST /stop`
- टैब्स: `GET /tabs`, `POST /tabs/open`, `POST /tabs/focus`, `DELETE /tabs/:targetId`
- स्नैपशॉट/स्क्रीनशॉट: `GET /snapshot`, `POST /screenshot`
- क्रियाएँ: `POST /navigate`, `POST /act`
- हुक्स: `POST /hooks/file-chooser`, `POST /hooks/dialog`
- डाउनलोड्स: `POST /download`, `POST /wait/download`
- डिबगिंग: `GET /console`, `POST /pdf`
- डिबगिंग: `GET /errors`, `GET /requests`, `POST /trace/start`, `POST /trace/stop`, `POST /highlight`
- नेटवर्क: `POST /response/body`
- स्टेट: `GET /cookies`, `POST /cookies/set`, `POST /cookies/clear`
- स्टेट: `GET /storage/:kind`, `POST /storage/:kind/set`, `POST /storage/:kind/clear`
- सेटिंग्स: `POST /set/offline`, `POST /set/headers`, `POST /set/credentials`, `POST /set/geolocation`, `POST /set/media`, `POST /set/timezone`, `POST /set/locale`, `POST /set/device`

सभी एंडपॉइंट्स `?profile=<name>` स्वीकार करते हैं।

### Playwright आवश्यकता

2. कुछ फीचर्स (navigate/act/AI snapshot/role snapshot, element screenshots, PDF) के लिए
   Playwright आवश्यक है। 3. यदि Playwright इंस्टॉल नहीं है, तो वे endpoints एक स्पष्ट 501
   error लौटाते हैं। 4. ARIA snapshots और basic screenshots openclaw-managed Chrome के लिए अभी भी काम करते हैं।
3. Chrome extension relay driver के लिए, ARIA snapshots और screenshots के लिए Playwright आवश्यक है।

यदि आपको `Playwright is not available in this gateway build` दिखाई देता है, तो पूर्ण
Playwright पैकेज ( `playwright-core` नहीं ) इंस्टॉल करें और gateway को पुनः प्रारंभ करें,
या ब्राउज़र समर्थन के साथ OpenClaw पुनः इंस्टॉल करें।

#### Docker Playwright इंस्टॉल

6. यदि आपका Gateway Docker में चलता है, तो `npx playwright` से बचें (npm override conflicts)।
7. इसके बजाय bundled CLI का उपयोग करें:

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

8. ब्राउज़र downloads को persist करने के लिए, `PLAYWRIGHT_BROWSERS_PATH` सेट करें (उदाहरण के लिए,
   `/home/node/.cache/ms-playwright`) और सुनिश्चित करें कि `/home/node` को `OPENCLAW_HOME_VOLUME` या bind mount के माध्यम से persisted किया गया हो। 9. देखें [Docker](/install/docker)।

## यह कैसे काम करता है (आंतरिक)

उच्च-स्तरीय फ़्लो:

- एक छोटा **control server** HTTP अनुरोध स्वीकार करता है।
- यह **CDP** के माध्यम से Chromium-आधारित ब्राउज़रों (Chrome/Brave/Edge/Chromium) से कनेक्ट होता है।
- उन्नत क्रियाओं (क्लिक/टाइप/स्नैपशॉट/PDF) के लिए, यह CDP के ऊपर **Playwright** का उपयोग करता है।
- जब Playwright अनुपस्थित होता है, तब केवल non-Playwright ऑपरेशन्स उपलब्ध होते हैं।

यह डिज़ाइन एजेंट को एक स्थिर, नियतात्मक इंटरफ़ेस पर रखता है, जबकि आपको
लोकल/रिमोट ब्राउज़र और प्रोफ़ाइल्स बदलने देता है।

## CLI त्वरित संदर्भ

10. सभी commands किसी विशिष्ट profile को target करने के लिए `--browser-profile <name>` स्वीकार करते हैं।
11. सभी commands machine-readable output (stable payloads) के लिए `--json` भी स्वीकार करते हैं।

बेसिक्स:

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

निरीक्षण:

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

क्रियाएँ:

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

स्टेट:

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

नोट्स:

- `upload` और `dialog` **arming** कॉल्स हैं; chooser/dialog को ट्रिगर करने वाले क्लिक/प्रेस से पहले इन्हें चलाएँ।
- `upload` फ़ाइल इनपुट्स को सीधे `--input-ref` या `--element` के माध्यम से भी सेट कर सकता है।
- `snapshot`:
  - `--format ai` (Playwright इंस्टॉल होने पर डिफ़ॉल्ट): संख्यात्मक refs (`aria-ref="<n>"`) के साथ AI स्नैपशॉट लौटाता है।
  - `--format aria`: एक्सेसिबिलिटी ट्री लौटाता है (कोई refs नहीं; केवल निरीक्षण)।
  - `--efficient` (या `--mode efficient`): कॉम्पैक्ट role स्नैपशॉट प्रीसेट (interactive + compact + depth + कम maxChars)।
  - Config डिफ़ॉल्ट (केवल tool/CLI): कॉलर द्वारा मोड न देने पर कुशल स्नैपशॉट्स उपयोग करने के लिए `browser.snapshotDefaults.mode: "efficient"` सेट करें (देखें [Gateway configuration](/gateway/configuration#browser-openclaw-managed-browser))।
  - Role स्नैपशॉट विकल्प (`--interactive`, `--compact`, `--depth`, `--selector`) `ref=e12` जैसे refs के साथ role-आधारित स्नैपशॉट को बाध्य करते हैं।
  - `--frame "<iframe selector>"` role स्नैपशॉट्स को किसी iframe तक सीमित करता है ( `e12` जैसे role refs के साथ जोड़ा जाता है)।
  - `--interactive` इंटरैक्टिव एलिमेंट्स की एक समतल, आसानी से चुनने योग्य सूची आउटपुट करता है (क्रियाएँ चलाने के लिए सर्वोत्तम)।
  - `--labels` overlayed ref लेबल्स के साथ केवल viewport का स्क्रीनशॉट जोड़ता है ( `MEDIA:<path>` प्रिंट करता है)।
- 12. `click`/`type`/आदि को `snapshot` से एक `ref` की आवश्यकता होती है (या तो numeric `12` या role ref `e12`)।
  13. Actions के लिए CSS selectors को जानबूझकर support नहीं किया गया है।

## स्नैपशॉट्स और refs

OpenClaw दो “स्नैपशॉट” शैलियों का समर्थन करता है:

- **AI स्नैपशॉट (संख्यात्मक refs)**: `openclaw browser snapshot` (डिफ़ॉल्ट; `--format ai`)
  - आउटपुट: संख्यात्मक refs सहित एक टेक्स्ट स्नैपशॉट।
  - क्रियाएँ: `openclaw browser click 12`, `openclaw browser type 23 "hello"`।
  - आंतरिक रूप से, ref को Playwright के `aria-ref` के माध्यम से resolve किया जाता है।

- **Role स्नैपशॉट ( `e12` जैसे role refs)**: `openclaw browser snapshot --interactive` (या `--compact`, `--depth`, `--selector`, `--frame`)
  - आउटपुट: `[ref=e12]` (और वैकल्पिक `[nth=1]`) के साथ role-आधारित सूची/ट्री।
  - क्रियाएँ: `openclaw browser click e12`, `openclaw browser highlight e12`।
  - आंतरिक रूप से, ref को `getByRole(...)` (डुप्लिकेट्स के लिए `nth()`) के माध्यम से resolve किया जाता है।
  - overlayed `e12` लेबल्स के साथ viewport स्क्रीनशॉट शामिल करने के लिए `--labels` जोड़ें।

Ref व्यवहार:

- Refs **नेविगेशन के बीच स्थिर नहीं** होते; यदि कुछ विफल हो, तो `snapshot` फिर से चलाएँ और नया ref उपयोग करें।
- यदि role स्नैपशॉट `--frame` के साथ लिया गया था, तो role refs अगले role स्नैपशॉट तक उसी iframe तक सीमित रहते हैं।

## Wait पावर-अप्स

आप केवल समय/टेक्स्ट से अधिक पर प्रतीक्षा कर सकते हैं:

- URL के लिए प्रतीक्षा करें (Playwright द्वारा समर्थित globs):
  - `openclaw browser wait --url "**/dash"`
- लोड स्टेट के लिए प्रतीक्षा करें:
  - `openclaw browser wait --load networkidle`
- JS predicate के लिए प्रतीक्षा करें:
  - `openclaw browser wait --fn "window.ready===true"`
- किसी selector के दृश्यमान होने की प्रतीक्षा करें:
  - `openclaw browser wait "#main"`

इन्हें संयोजित किया जा सकता है:

```bash
openclaw browser wait "#main" \
  --url "**/dash" \
  --load networkidle \
  --fn "window.ready===true" \
  --timeout-ms 15000
```

## डिबग वर्कफ़्लो

14. जब कोई action fail होता है (जैसे “not visible”, “strict mode violation”, “covered”):

1. `openclaw browser snapshot --interactive`
2. `click <ref>` / `type <ref>` का उपयोग करें (interactive मोड में role refs को प्राथमिकता दें)
3. यदि फिर भी विफल हो: Playwright क्या लक्षित कर रहा है यह देखने के लिए `openclaw browser highlight <ref>`
4. यदि पेज अजीब व्यवहार करता है:
   - `openclaw browser errors --clear`
   - `openclaw browser requests --filter api --clear`
5. गहन डिबगिंग के लिए: एक trace रिकॉर्ड करें:
   - `openclaw browser trace start`
   - समस्या को पुनः उत्पन्न करें
   - `openclaw browser trace stop` ( `TRACE:<path>` प्रिंट करता है)

## JSON आउटपुट

`--json` स्क्रिप्टिंग और संरचित टूलिंग के लिए है।

उदाहरण:

```bash
openclaw browser status --json
openclaw browser snapshot --interactive --json
openclaw browser requests --filter api --json
openclaw browser cookies --json
```

JSON में role स्नैपशॉट्स में `refs` के साथ एक छोटा `stats` ब्लॉक (lines/chars/refs/interactive) शामिल होता है ताकि टूल्स payload आकार और घनत्व पर तर्क कर सकें।

## स्टेट और environment knobs

ये “साइट को X जैसा व्यवहार कराने” वाले वर्कफ़्लो के लिए उपयोगी हैं:

- Cookies: `cookies`, `cookies set`, `cookies clear`
- Storage: `storage local|session get|set|clear`
- Offline: `set offline on|off`
- Headers: `set headers --json '{"X-Debug":"1"}'` (या `--clear`)
- HTTP basic auth: `set credentials user pass` (या `--clear`)
- Geolocation: `set geo <lat> <lon> --origin "https://example.com"` (या `--clear`)
- Media: `set media dark|light|no-preference|none`
- Timezone / locale: `set timezone ...`, `set locale ...`
- Device / viewport:
  - `set device "iPhone 14"` (Playwright डिवाइस प्रीसेट्स)
  - `set viewport 1280 720`

## सुरक्षा और गोपनीयता

- openclaw ब्राउज़र प्रोफ़ाइल में लॉग-इन सत्र हो सकते हैं; इसे संवेदनशील मानें।
- 15. `browser act kind=evaluate` / `openclaw browser evaluate` और `wait --fn`
      page context में arbitrary JavaScript execute करते हैं। 16. Prompt injection इसे steer कर सकता है। 17. यदि आपको इसकी आवश्यकता नहीं है, तो `browser.evaluateEnabled=false` के साथ इसे disable करें।
- लॉग-इन और anti-bot नोट्स (X/Twitter, आदि) के लिए देखें
  [Browser login + X/Twitter posting](/tools/browser-login)।
- Gateway/node होस्ट को निजी रखें (loopback या tailnet-only)।
- रिमोट CDP एंडपॉइंट्स शक्तिशाली होते हैं; उन्हें टनल और सुरक्षित रखें।

## समस्या-निवारण

Linux-विशिष्ट समस्याओं (विशेषकर snap Chromium) के लिए देखें
[Browser troubleshooting](/tools/browser-linux-troubleshooting)।

## एजेंट टूल्स + नियंत्रण कैसे काम करता है

एजेंट को ब्राउज़र ऑटोमेशन के लिए **एक टूल** मिलता है:

- `browser` — status/start/stop/tabs/open/focus/close/snapshot/screenshot/navigate/act

मैपिंग:

- `browser snapshot` एक स्थिर UI ट्री (AI या ARIA) लौटाता है।
- `browser act` स्नैपशॉट `ref` IDs का उपयोग कर क्लिक/टाइप/ड्रैग/चयन करता है।
- `browser screenshot` पिक्सेल्स कैप्चर करता है (पूर्ण पेज या एलिमेंट)।
- `browser` स्वीकार करता है:
  - नामित ब्राउज़र प्रोफ़ाइल चुनने के लिए `profile` (openclaw, chrome, या remote CDP)।
  - ब्राउज़र कहाँ रहता है यह चुनने के लिए `target` (`sandbox` | `host` | `node`)।
  - sandboxed सत्रों में, `target: "host"` के लिए `agents.defaults.sandbox.browser.allowHostControl=true` आवश्यक है।
  - यदि `target` छोड़ा गया हो: sandboxed सत्र डिफ़ॉल्ट रूप से `sandbox` पर, और non-sandbox सत्र डिफ़ॉल्ट रूप से `host` पर जाते हैं।
  - यदि ब्राउज़र-क्षमता वाला node जुड़ा है, तो टूल स्वतः उसी पर रूट कर सकता है जब तक आप `target="host"` या `target="node"` पिन न करें।

यह एजेंट को नियतात्मक रखता है और नाज़ुक selectors से बचाता है।
