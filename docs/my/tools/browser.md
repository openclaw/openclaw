---
summary: "ပေါင်းစည်းထားသော ဘရောက်ဇာ ထိန်းချုပ်ရေး ဝန်ဆောင်မှု + လုပ်ဆောင်ချက် အမိန့်များ"
read_when:
  - အေးဂျင့်မှ ထိန်းချုပ်သော ဘရောက်ဇာ အလိုအလျောက်လုပ်ဆောင်မှုကို ထည့်သွင်းသည့်အခါ
  - openclaw က သင့်ကိုယ်ပိုင် Chrome ကို ဘာကြောင့် အနှောင့်အယှက်ပေးနေသလဲ ဆိုတာကို ချို့ယွင်းချက်ရှာဖွေသည့်အခါ
  - macOS အက်ပ်အတွင်း ဘရောက်ဇာ ဆက်တင်များနှင့် lifecycle ကို အကောင်အထည်ဖော်သည့်အခါ
title: "Browser (OpenClaw-စီမံခန့်ခွဲထားသော)"
---

# Browser (openclaw-managed)

OpenClaw သည် agent က ထိန်းချုပ်နိုင်သော **သီးသန့် Chrome/Brave/Edge/Chromium profile** ကို အလုပ်လုပ်စေနိုင်ပါသည်။
၎င်းသည် သင်၏ ကိုယ်ရေးကိုယ်တာ browser နှင့် သီးခြားဖြစ်ပြီး Gateway အတွင်းရှိ သေးငယ်သော local control service (loopback သာ) မှတစ်ဆင့် စီမံခန့်ခွဲပါသည်။

Beginner view:

- ၎င်းကို **အေးဂျင့်သီးသန့် ဘရောက်ဇာ တစ်ခု** ဟု စဉ်းစားပါ။
- `openclaw` ပရိုဖိုင်သည် သင့်ကိုယ်ပိုင် ဘရောက်ဇာ ပရိုဖိုင်ကို **လုံးဝ မထိပါ**။
- အေးဂျင့်သည် လုံခြုံသော လမ်းကြောင်းအတွင်း **တက်ဘ်များ ဖွင့်ခြင်း၊ စာမျက်နှာ ဖတ်ခြင်း၊ ကလစ်နှိပ်ခြင်း၊ စာရိုက်ခြင်း** ကို ပြုလုပ်နိုင်သည်။
- ပုံမှန် `chrome` ပရိုဖိုင်သည် **စနစ်ပုံမှန် Chromium ဘရောက်ဇာ** ကို
  extension relay ဖြင့် အသုံးပြုသည်; ခွဲခြားထားသော managed ဘရောက်ဇာကို အသုံးပြုရန် `openclaw` သို့ ပြောင်းပါ။

## What you get

- **openclaw** ဟု အမည်ပေးထားသော သီးခြား ဘရောက်ဇာ ပရိုဖိုင် (ပုံမှန်အားဖြင့် လိမ္မော်ရောင် accent)။
- သတ်မှတ်နိုင်သော တက်ဘ် ထိန်းချုပ်မှု (စာရင်း/ဖွင့်/အာရုံစိုက်/ပိတ်)။
- အေးဂျင့် လုပ်ဆောင်ချက်များ (ကလစ်/စာရိုက်/ဆွဲ/ရွေးချယ်), snapshots, screenshots, PDFs။
- ရွေးချယ်နိုင်သော မျိုးစုံ ပရိုဖိုင် ပံ့ပိုးမှု (`openclaw`, `work`, `remote`, ...)။

ဤ browser သည် သင်၏ နေ့စဉ် အသုံးပြုသော browser မဟုတ်ပါ။ Agent automation နှင့် verification အတွက် လုံခြုံပြီး သီးခြားထားသော မျက်နှာပြင်တစ်ခု ဖြစ်ပါသည်။

## Quick start

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

“Browser disabled” ဟု မြင်ပါက config တွင် ဖွင့်ပြီး (အောက်တွင် ကြည့်ပါ) Gateway ကို ပြန်လည်စတင်ပါ။

## Profiles: `openclaw` vs `chrome`

- `openclaw`: စီမံခန့်ခွဲထားသော၊ ခွဲခြားထားသော ဘရောက်ဇာ (extension မလိုအပ်)။
- `chrome`: သင့် **စနစ်ဘရောက်ဇာ** သို့ extension relay (OpenClaw extension ကို တက်ဘ်တစ်ခုနှင့် ချိတ်ထားရန် လိုအပ်)။

ပုံမှန်အားဖြင့် managed mode ကို အသုံးပြုလိုပါက `browser.defaultProfile: "openclaw"` ကို သတ်မှတ်ပါ။

## Configuration

ဘရောက်ဇာ ဆက်တင်များသည် `~/.openclaw/openclaw.json` အတွင်း ရှိသည်။

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

- Browser control service သည် `gateway.port` မှ ဆင်းသက်လာသော port တွင် loopback သို့ bind လုပ်ပါသည် (ပုံမှန်: `18791`, gateway + 2)။ Relay သည် နောက်ထပ် port (`18792`) ကို အသုံးပြုပါသည်။
- Gateway ပေါက်ကို `gateway.port` သို့မဟုတ် `OPENCLAW_GATEWAY_PORT` ဖြင့် ပြောင်းလဲပါက
  ဆင်းသက်လာသော ဘရောက်ဇာ ပေါက်များသည် တူညီသော “family” အတွင်း နေစေရန် ရွှေ့ပြောင်းသွားမည်။
- `cdpUrl` ကို မသတ်မှတ်ပါက relay ပေါက်ကို ပုံမှန်အသုံးပြုသည်။
- `remoteCdpTimeoutMs` သည် အဝေးမှ (loopback မဟုတ်သော) CDP ရောက်ရှိနိုင်မှု စစ်ဆေးမှုများအတွက် အသုံးပြုသည်။
- `remoteCdpHandshakeTimeoutMs` သည် အဝေးမှ CDP WebSocket ရောက်ရှိနိုင်မှု စစ်ဆေးမှုများအတွက် အသုံးပြုသည်။
- `attachOnly: true` ဆိုသည်မှာ “local ဘရောက်ဇာကို မစတင်ပါနှင့်; လည်ပတ်နေပြီးသား ဖြစ်ပါကသာ ချိတ်ဆက်ပါ” ဟု အဓိပ္ပါယ်ရသည်။
- `color` + ပရိုဖိုင်တစ်ခုချင်းစီ၏ `color` သည် မည်သည့် ပရိုဖိုင် လှုပ်ရှားနေသည်ကို မြင်နိုင်ရန် ဘရောက်ဇာ UI ကို အရောင်ညှိပေးသည်။
- Default profile is `chrome` (extension relay). Managed browser အတွက် `defaultProfile: "openclaw"` ကို အသုံးပြုပါ။
- Auto-detect အစဉ်: စနစ်ပုံမှန် ဘရောက်ဇာ (Chromium အခြေပြု ဖြစ်ပါက); မဟုတ်ပါက Chrome → Brave → Edge → Chromium → Chrome Canary။
- Local `openclaw` ပရိုဖိုင်များသည် `cdpPort`/`cdpUrl` ကို အလိုအလျောက် သတ်မှတ်ပေးသည် — အဝေးမှ CDP အတွက်သာ ၎င်းတို့ကို သတ်မှတ်ပါ။

## Use Brave (or another Chromium-based browser)

သင်၏ **system default** browser သည် Chromium-based (Chrome/Brave/Edge/etc) ဖြစ်ပါက OpenClaw က အလိုအလျောက် အသုံးပြုပါသည်။ Auto-detection ကို override လုပ်ရန် `browser.executablePath` ကို သတ်မှတ်ပါ:

CLI ဥပမာ:

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

- **Local control (ပုံမှန်):** Gateway သည် loopback ထိန်းချုပ်ရေး ဝန်ဆောင်မှုကို စတင်ပြီး local ဘရောက်ဇာကို လွှင့်တင်နိုင်သည်။
- **Remote control (node host):** ဘရောက်ဇာ ရှိသည့် စက်ပေါ်တွင် node host ကို လည်ပတ်စေပြီး Gateway သည် ဘရောက်ဇာ လုပ်ဆောင်ချက်များကို proxy လုပ်ပေးသည်။
- **Remote CDP:** `browser.profiles.<name>` ကို သတ်မှတ်ပါ.cdpUrl`(သို့မဟုတ်`browser.cdpUrl\`) ကို သတ်မှတ်၍ remote Chromium-based browser နှင့် ချိတ်ဆက်ပါ။ ဤအခြေအနေတွင် OpenClaw သည် local browser ကို မဖွင့်ပါ။

Remote CDP URL များတွင် auth ပါဝင်နိုင်သည်:

- Query tokens (ဥပမာ `https://provider.example?token=<token>`)
- HTTP Basic auth (ဥပမာ `https://user:pass@provider.example`)

OpenClaw သည် `/json/*` endpoints ကို ခေါ်သောအခါနှင့် CDP WebSocket သို့ ချိတ်ဆက်သောအခါ auth ကို ထိန်းသိမ်းထားပါသည်။ Token များကို config ဖိုင်များတွင် commit မလုပ်ဘဲ environment variables သို့မဟုတ် secrets manager များကို ဦးစားပေးအသုံးပြုပါ။

## Node browser proxy (zero-config default)

သင်၏ browser ရှိသည့် စက်ပေါ်တွင် **node host** ကို လုပ်ဆောင်ထားပါက OpenClaw သည် အပို browser config မလိုဘဲ browser tool calls များကို ထို node သို့ အလိုအလျောက် route လုပ်နိုင်ပါသည်။
၎င်းသည် remote gateways အတွက် ပုံမှန်လမ်းကြောင်း ဖြစ်ပါသည်။

Notes:

- node host သည် ၎င်း၏ local ဘရောက်ဇာ ထိန်းချုပ်ရေး ဆာဗာကို **proxy command** ဖြင့် ဖော်ထုတ်ပေးသည်။
- ပရိုဖိုင်များသည် node ၏ ကိုယ်ပိုင် `browser.profiles` config မှ ရယူသည် (local နှင့် တူညီ)။
- မလိုလားပါက ပိတ်နိုင်သည်:
  - node တွင်: `nodeHost.browserProxy.enabled=false`
  - gateway တွင်: `gateway.nodes.browser.mode="off"`

## Browserless (hosted remote CDP)

[Browserless](https://browserless.io) သည် HTTPS မှတစ်ဆင့် CDP endpoints များကို ဖော်ထုတ်ပေးသော hosted Chromium service တစ်ခု ဖြစ်ပါသည်။ OpenClaw browser profile တစ်ခုကို Browserless region endpoint သို့ ချိတ်ဆက်ပြီး သင်၏ API key ဖြင့် authenticate လုပ်နိုင်ပါသည်။

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

- `<BROWSERLESS_API_KEY>` ကို သင့်၏ အမှန်တကယ် Browserless token ဖြင့် အစားထိုးပါ။
- သင့် Browserless အကောင့်နှင့် ကိုက်ညီသော region endpoint ကို ရွေးချယ်ပါ (၎င်းတို့၏ docs ကို ကြည့်ပါ)။

## Security

Key ideas:

- ဘရောက်ဇာ ထိန်းချုပ်မှုသည် loopback သာဖြစ်ပြီး ဝင်ရောက်မှုသည် Gateway ၏ auth သို့မဟုတ် node pairing မှတဆင့်သာ လုပ်ဆောင်သည်။
- Gateway နှင့် node hosts များကို ကိုယ်ပိုင် ကွန်ယက် (Tailscale) တွင် ထားရှိပြီး အများပြည်သူသို့ ဖော်ထုတ်ခြင်းကို ရှောင်ကြဉ်ပါ။
- Remote CDP URL/tokens များကို လျှို့ဝှက်ချက်အဖြစ် ဆက်ဆံပါ; env vars သို့မဟုတ် secrets manager ကို အသုံးပြုပါ။

Remote CDP tips:

- ဖြစ်နိုင်ပါက HTTPS endpoints နှင့် သက်တမ်းတို tokens များကို ဦးစားပေးပါ။
- သက်တမ်းရှည် tokens များကို config ဖိုင်များထဲတွင် တိုက်ရိုက် မထည့်ပါနှင့်။

## Profiles (multi-browser)

OpenClaw သည် အမည်ပေးထားသော profile များ (routing configs) အများအပြားကို ထောက်ပံ့ပါသည်။ Profile များမှာ အောက်ပါအတိုင်း ဖြစ်နိုင်ပါသည်:

- **openclaw-managed**: ကိုယ်ပိုင် user data directory + CDP port ပါရှိသော သီးသန့် Chromium အခြေပြု ဘရောက်ဇာ instance
- **remote**: အခြားနေရာတွင် လည်ပတ်နေသော Chromium အခြေပြု ဘရောက်ဇာသို့ ညွှန်ပြသော CDP URL
- **extension relay**: local relay + Chrome extension ဖြင့် သင့်ရှိပြီးသား Chrome တက်ဘ်များ

Defaults:

- `openclaw` ပရိုဖိုင်ကို မရှိပါက အလိုအလျောက် ဖန်တီးပေးသည်။
- `chrome` ပရိုဖိုင်သည် Chrome extension relay အတွက် built-in ဖြစ်ပြီး ပုံမှန်အားဖြင့် `http://127.0.0.1:18792` ကို ညွှန်ပြသည်။
- Local CDP ports များကို ပုံမှန်အားဖြင့် **18800–18899** မှ ခွဲဝေသည်။
- ပရိုဖိုင်တစ်ခုကို ဖျက်လျှင် ၎င်း၏ local data directory ကို Trash သို့ ရွှေ့သည်။

Control endpoints အားလုံးသည် `?profile=<name>` ကို လက်ခံပြီး CLI သည် `--browser-profile` ကို အသုံးပြုသည်။

## Chrome extension relay (use your existing Chrome)

OpenClaw သည် local CDP relay + Chrome extension ဖြင့်
**သင့်ရှိပြီးသား Chrome တက်ဘ်များ** ကိုလည်း ထိန်းချုပ်နိုင်သည် (သီးခြား “openclaw” Chrome instance မလိုအပ်ပါ)။

Full guide: [Chrome extension](/tools/chrome-extension)

Flow:

- Gateway ကို local (တူညီသော စက်) တွင် လည်ပတ်စေပါ သို့မဟုတ် ဘရောက်ဇာ စက်ပေါ်တွင် node host ကို လည်ပတ်စေပါ။
- local **relay server** သည် loopback `cdpUrl` (ပုံမှန်: `http://127.0.0.1:18792`) တွင် နားထောင်သည်။
- ထိန်းချုပ်လိုသော တက်ဘ်ပေါ်တွင် **OpenClaw Browser Relay** extension အိုင်ကွန်ကို နှိပ်ပါ (အလိုအလျောက် မချိတ်ပါ)။
- အေးဂျင့်သည် မှန်ကန်သော ပရိုဖိုင်ကို ရွေးချယ်ခြင်းဖြင့် ပုံမှန် `browser` tool မှတဆင့် ထိုတက်ဘ်ကို ထိန်းချုပ်သည်။

Gateway သည် အခြားနေရာတွင် လည်ပတ်နေပါက Gateway သည် ဘရောက်ဇာ လုပ်ဆောင်ချက်များကို proxy လုပ်နိုင်ရန်
ဘရောက်ဇာ စက်ပေါ်တွင် node host ကို လည်ပတ်စေပါ။

### Sandboxed sessions

Agent session သည် sandboxed ဖြစ်ပါက `browser` tool သည် `target="sandbox"` (sandbox browser) သို့ ပုံမှန်ထားနိုင်ပါသည်။
Chrome extension relay takeover အတွက် host browser control လိုအပ်သဖြင့် အောက်ပါအတိုင်း လုပ်ဆောင်ပါ:

- ဆက်ရှင်ကို unsandboxed အဖြစ် လည်ပတ်စေပါ၊ သို့မဟုတ်
- `agents.defaults.sandbox.browser.allowHostControl: true` ကို သတ်မှတ်ပြီး tool ကို ခေါ်သည့်အခါ `target="host"` ကို အသုံးပြုပါ။

### Setup

1. Extension ကို (dev/unpacked) အဖြစ် load လုပ်ပါ:

```bash
openclaw browser extension install
```

- Chrome → `chrome://extensions` → “Developer mode” ကို ဖွင့်ပါ
- “Load unpacked” → `openclaw browser extension path` မှ ထုတ်ပြထားသော directory ကို ရွေးပါ
- Extension ကို pin လုပ်ပြီး ထိန်းချုပ်လိုသော တက်ဘ်ပေါ်တွင် နှိပ်ပါ (badge တွင် `ON` ပြမည်)

2. အသုံးပြုပါ:

- CLI: `openclaw browser --browser-profile chrome tabs`
- Agent tool: `browser` နှင့် `profile="chrome"`

Optional: အမည် သို့မဟုတ် relay ပေါက်ကို ပြောင်းလိုပါက ကိုယ်ပိုင် ပရိုဖိုင်တစ်ခု ဖန်တီးပါ:

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

Notes:

- ဤ mode သည် အများစု လုပ်ဆောင်ချက်များအတွက် Playwright-on-CDP ကို အားထားသည် (screenshots/snapshots/actions)။
- Extension အိုင်ကွန်ကို ထပ်မံ နှိပ်ခြင်းဖြင့် detach လုပ်နိုင်သည်။

## Isolation guarantees

- **Dedicated user data dir**: သင့်ကိုယ်ပိုင် ဘရောက်ဇာ ပရိုဖိုင်ကို လုံးဝ မထိပါ။
- **Dedicated ports**: dev workflows နှင့် တိုက်မိမှု မဖြစ်စေရန် `9222` ကို ရှောင်ရှားသည်။
- **Deterministic tab control**: “နောက်ဆုံး တက်ဘ်” မဟုတ်ဘဲ `targetId` ဖြင့် တက်ဘ်ကို ရည်ညွှန်းသည်။

## Browser selection

Local လွှင့်တင်ရာတွင် OpenClaw သည် ရရှိနိုင်သည့် ပထမဆုံးကို ရွေးချယ်သည်:

1. Chrome
2. Brave
3. Edge
4. Chromium
5. Chrome Canary

`browser.executablePath` ဖြင့် override လုပ်နိုင်သည်။

Platforms:

- macOS: `/Applications` နှင့် `~/Applications` ကို စစ်ဆေးသည်။
- Linux: `google-chrome`, `brave`, `microsoft-edge`, `chromium` စသည်တို့ကို ရှာဖွေသည်။
- Windows: အများဆုံး တွေ့ရသော install တည်နေရာများကို စစ်ဆေးသည်။

## Control API (optional)

Local integrations အတွက်သာ Gateway သည် loopback HTTP API သေးငယ်တစ်ခုကို ဖော်ထုတ်ပေးသည်:

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

Endpoints အားလုံးသည် `?profile=<name>` ကို လက်ခံသည်။

### Playwright requirement

အချို့ feature များ (navigate/act/AI snapshot/role snapshot, element screenshots, PDF) သည် Playwright ကို လိုအပ်ပါသည်။ Playwright မတပ်ဆင်ထားပါက ထို endpoints များသည် ပြတ်သားသော 501 error ကို ပြန်ပေးပါသည်။ ARIA snapshots နှင့် အခြေခံ screenshots များသည် openclaw-managed Chrome အတွက် ဆက်လက် အလုပ်လုပ်ပါသည်။
Chrome extension relay driver အတွက် ARIA snapshots နှင့် screenshots များသည် Playwright ကို လိုအပ်ပါသည်။

`Playwright is not available in this gateway build` ကို မြင်ပါက Playwright package အပြည့်အစုံကို
(`playwright-core` မဟုတ်) တပ်ဆင်ပြီး gateway ကို ပြန်လည်စတင်ပါ သို့မဟုတ်
OpenClaw ကို browser support ပါဝင်အောင် ပြန်လည် ထည့်သွင်းပါ။

#### Docker Playwright install

သင်၏ Gateway သည် Docker အတွင်း လုပ်ဆောင်နေပါက `npx playwright` ကို ရှောင်ကြဉ်ပါ (npm override conflicts ရှိနိုင်သည်)။
အစား bundled CLI ကို အသုံးပြုပါ:

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

Browser downloads များကို သိမ်းဆည်းထားရန် `PLAYWRIGHT_BROWSERS_PATH` ကို သတ်မှတ်ပါ (ဥပမာ၊ `/home/node/.cache/ms-playwright`) နှင့် `/home/node` ကို `OPENCLAW_HOME_VOLUME` သို့မဟုတ် bind mount ဖြင့် persist ဖြစ်အောင် ပြုလုပ်ထားပါ။ 1. [Docker](/install/docker) ကို ကြည့်ပါ။

## How it works (internal)

High-level flow:

- သေးငယ်သော **control server** တစ်ခုက HTTP requests များကို လက်ခံသည်။
- ၎င်းသည် **CDP** မှတဆင့် Chromium အခြေပြု ဘရောက်ဇာများ (Chrome/Brave/Edge/Chromium) သို့ ချိတ်ဆက်သည်။
- အဆင့်မြင့် လုပ်ဆောင်ချက်များ (ကလစ်/စာရိုက်/snapshot/PDF) အတွက် CDP အပေါ်တွင် **Playwright** ကို အသုံးပြုသည်။
- Playwright မရှိပါက non-Playwright လုပ်ဆောင်ချက်များသာ ရရှိနိုင်သည်။

ဤဒီဇိုင်းသည် အေးဂျင့်ကို တည်ငြိမ်ပြီး သတ်မှတ်နိုင်သော interface ပေါ်တွင် ထားရှိရင်း
local/remote ဘရောက်ဇာများနှင့် ပရိုဖိုင်များကို လွယ်ကူစွာ အစားထိုးနိုင်စေသည်။

## CLI quick reference

2. အမိန့်အားလုံးသည် သတ်မှတ်ထားသော ပရိုဖိုင်ကို ဦးတည်ရန် `--browser-profile <name>` ကို လက်ခံပါသည်။
3. အမိန့်အားလုံးသည် စက်ဖတ်ရှုနိုင်သော အထွက်အပေါ် (တည်ငြိမ်သော payloads) အတွက် `--json` ကိုလည်း လက်ခံပါသည်။

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

- `upload` နှင့် `dialog` သည် **arming** ခေါ်ဆိုမှုများ ဖြစ်ပြီး chooser/dialog ကို ဖြစ်ပေါ်စေမည့် click/press မတိုင်မီ လည်ပတ်စေပါ။
- `upload` သည် `--input-ref` သို့မဟုတ် `--element` ဖြင့် file inputs များကို တိုက်ရိုက် သတ်မှတ်နိုင်သည်။
- `snapshot`:
  - `--format ai` (Playwright တပ်ဆင်ထားပါက ပုံမှန်): numeric refs (`aria-ref="<n>"`) ပါသော AI snapshot ကို ပြန်ပေးသည်။
  - `--format aria`: accessibility tree ကို ပြန်ပေးသည် (refs မပါ; inspection အတွက်သာ)။
  - `--efficient` (သို့မဟုတ် `--mode efficient`): compact role snapshot preset (interactive + compact + depth + lower maxChars)။
  - Config default (tool/CLI သာ): caller က mode မပေးပါက efficient snapshots ကို အသုံးပြုရန် `browser.snapshotDefaults.mode: "efficient"` ကို သတ်မှတ်ပါ ( [Gateway configuration](/gateway/configuration#browser-openclaw-managed-browser) ကို ကြည့်ပါ)။
  - Role snapshot options (`--interactive`, `--compact`, `--depth`, `--selector`) သည် `ref=e12` ကဲ့သို့ refs ပါသော role-based snapshot ကို မဖြစ်မနေ အသုံးပြုစေသည်။
  - `--frame "<iframe selector>"` သည် role snapshots များကို iframe တစ်ခုအတွင်း ကန့်သတ်ပေးသည် (role refs များ `e12` နှင့် တွဲဖက်)။
  - `--interactive` သည် လွယ်ကူစွာ ရွေးနိုင်သော interactive elements စာရင်းပြားတစ်ခုကို ထုတ်ပေးသည် (actions မောင်းနှင်ရန် အကောင်းဆုံး)။
  - `--labels` သည် overlayed ref labels ပါသော viewport-only screenshot ကို ထည့်ပေါင်းပေးသည် (`MEDIA:<path>` ကို ထုတ်ပြ)။
- 4. `click`/`type`/စသည်တို့သည် `snapshot` မှ `ref` တစ်ခု (ကိန်းဂဏန်း `12` သို့မဟုတ် role ref `e12`) လိုအပ်ပါသည်။
     CSS selectors are intentionally not supported for actions.

## Snapshots and refs

OpenClaw သည် “snapshot” စတိုင် နှစ်မျိုးကို ပံ့ပိုးသည်:

- **AI snapshot (numeric refs)**: `openclaw browser snapshot` (ပုံမှန်; `--format ai`)
  - Output: numeric refs ပါဝင်သော text snapshot။
  - Actions: `openclaw browser click 12`, `openclaw browser type 23 "hello"`။
  - အတွင်းပိုင်းတွင် ref ကို Playwright ၏ `aria-ref` ဖြင့် ဖြေရှင်းသည်။

- **Role snapshot (role refs เช่น `e12`)**: `openclaw browser snapshot --interactive` (သို့မဟုတ် `--compact`, `--depth`, `--selector`, `--frame`)
  - Output: `[ref=e12]` (နှင့် ရွေးချယ်နိုင်သော `[nth=1]`) ပါသော role-based စာရင်း/သစ်ပင်။
  - Actions: `openclaw browser click e12`, `openclaw browser highlight e12`။
  - အတွင်းပိုင်းတွင် ref ကို `getByRole(...)` ဖြင့် ဖြေရှင်းသည် (ထပ်တူများအတွက် `nth()`)။
  - overlayed `e12` labels ပါသော viewport screenshot ကို ထည့်ရန် `--labels` ကို ပေါင်းထည့်ပါ။

Ref behavior:

- Refs များသည် **navigation များကြားတွင် တည်ငြိမ်မှု မရှိပါ**; တစ်ခုခု မအောင်မြင်ပါက `snapshot` ကို ပြန်လည် လည်ပတ်ပြီး ref အသစ်ကို အသုံးပြုပါ။
- Role snapshot ကို `--frame` ဖြင့် ယူထားပါက နောက် role snapshot မတိုင်မီ role refs များသည် ထို iframe အတွင်းသာ အကျုံးဝင်သည်။

## Wait power-ups

အချိန်/စာသား သာမက အခြားအရာများကိုလည်း စောင့်နိုင်သည်:

- URL ကို စောင့်ရန် (Playwright မှ glob ပံ့ပိုး):
  - `openclaw browser wait --url "**/dash"`
- Load state ကို စောင့်ရန်:
  - `openclaw browser wait --load networkidle`
- JS predicate ကို စောင့်ရန်:
  - `openclaw browser wait --fn "window.ready===true"`
- Selector တစ်ခု ပေါ်လာသည်အထိ စောင့်ရန်:
  - `openclaw browser wait "#main"`

ဤအရာများကို ပေါင်းစပ် အသုံးပြုနိုင်သည်:

```bash
openclaw browser wait "#main" \
  --url "**/dash" \
  --load networkidle \
  --fn "window.ready===true" \
  --timeout-ms 15000
```

## Debug workflows

လုပ်ဆောင်ချက်တစ်ခု မအောင်မြင်ပါက (ဥပမာ “not visible”, “strict mode violation”, “covered”):

1. `openclaw browser snapshot --interactive`
2. `click <ref>` / `type <ref>` ကို အသုံးပြုပါ (interactive mode တွင် role refs ကို ဦးစားပေးပါ)
3. မအောင်မြင်သေးပါက: Playwright က ဘာကို ဦးတည်နေသည်ကို ကြည့်ရန် `openclaw browser highlight <ref>`
4. စာမျက်နှာ အပြုအမူ ထူးဆန်းပါက:
   - `openclaw browser errors --clear`
   - `openclaw browser requests --filter api --clear`
5. နက်ရှိုင်းသော debugging အတွက် trace ကို မှတ်တမ်းတင်ပါ:
   - `openclaw browser trace start`
   - ပြဿနာကို ပြန်လည် ဖြစ်ပေါ်စေပါ
   - `openclaw browser trace stop` (`TRACE:<path>` ကို ထုတ်ပြ)

## JSON output

`--json` သည် scripting နှင့် structured tooling အတွက် ဖြစ်သည်။

Examples:

```bash
openclaw browser status --json
openclaw browser snapshot --interactive --json
openclaw browser requests --filter api --json
openclaw browser cookies --json
```

JSON ထဲရှိ role snapshots များတွင် `refs` နှင့်
payload အရွယ်အစားနှင့် သိပ်သည်းမှုကို ကိရိယာများက ခန့်မှန်းနိုင်ရန်
`stats` block သေးငယ်တစ်ခု (lines/chars/refs/interactive) ပါဝင်သည်။

## State and environment knobs

“ဆိုဒ်ကို X လို ဖြစ်အောင် လုပ်ပါ” ဆိုသော workflows များအတွက် အသုံးဝင်သည်:

- Cookies: `cookies`, `cookies set`, `cookies clear`
- Storage: `storage local|session get|set|clear`
- Offline: `set offline on|off`
- Headers: `set headers --json '{"X-Debug":"1"}'` (သို့မဟုတ် `--clear`)
- HTTP basic auth: `set credentials user pass` (သို့မဟုတ် `--clear`)
- Geolocation: `set geo <lat> <lon> --origin "https://example.com"` (သို့မဟုတ် `--clear`)
- Media: `set media dark|light|no-preference|none`
- Timezone / locale: `set timezone ...`, `set locale ...`
- Device / viewport:
  - `set device "iPhone 14"` (Playwright device presets)
  - `set viewport 1280 720`

## Security & privacy

- openclaw ဘရောက်ဇာ ပရိုဖိုင်တွင် logged-in sessions များ ပါဝင်နိုင်သဖြင့် အရေးကြီးအချက်အလက်အဖြစ် ဆက်ဆံပါ။
- 6. `browser act kind=evaluate` / `openclaw browser evaluate` နှင့် `wait --fn`
     သည် စာမျက်နှာ context အတွင်း arbitrary JavaScript ကို အကောင်အထည်ဖော် လုပ်ဆောင်ပါသည်။ 7. Prompt injection သည်
     ဤအရာကို လမ်းကြောင်းပြောင်းစေနိုင်ပါသည်။ 8. မလိုအပ်ပါက `browser.evaluateEnabled=false` ဖြင့် ပိတ်နိုင်ပါသည်။
- Logins နှင့် anti-bot မှတ်ချက်များ (X/Twitter စသည်) အတွက် [Browser login + X/Twitter posting](/tools/browser-login) ကို ကြည့်ပါ။
- Gateway/node host ကို private (loopback သို့မဟုတ် tailnet-only) အဖြစ် ထားရှိပါ။
- Remote CDP endpoints များသည် အားကောင်းပါသည်; tunnel လုပ်ပြီး ကာကွယ်ပါ။

## Troubleshooting

Linux အထူးပြဿနာများ (အထူးသဖြင့် snap Chromium) အတွက်
[Browser troubleshooting](/tools/browser-linux-troubleshooting) ကို ကြည့်ပါ။

## Agent tools + how control works

အေးဂျင့်သည် ဘရောက်ဇာ အလိုအလျောက်လုပ်ဆောင်မှုအတွက် **tool တစ်ခုတည်း** ကို ရရှိသည်:

- `browser` — status/start/stop/tabs/open/focus/close/snapshot/screenshot/navigate/act

How it maps:

- `browser snapshot` သည် တည်ငြိမ်သော UI tree (AI သို့မဟုတ် ARIA) ကို ပြန်ပေးသည်။
- `browser act` သည် snapshot `ref` IDs များကို အသုံးပြု၍ ကလစ်/စာရိုက်/ဆွဲ/ရွေးချယ် လုပ်ဆောင်သည်။
- `browser screenshot` သည် pixels များကို ဖမ်းယူသည် (စာမျက်နှာအပြည့် သို့မဟုတ် element)။
- `browser` သည် အောက်ပါအရာများကို လက်ခံသည်:
  - အမည်ပေးထားသော ဘရောက်ဇာ ပရိုဖိုင် (openclaw, chrome, သို့မဟုတ် remote CDP) ကို ရွေးချယ်ရန် `profile`
  - ဘရောက်ဇာ တည်နေရာကို ရွေးရန် `target` (`sandbox` | `host` | `node`)
  - sandboxed sessions တွင် `target: "host"` သည် `agents.defaults.sandbox.browser.allowHostControl=true` ကို လိုအပ်သည်။
  - `target` ကို မပေးပါက: sandboxed sessions တွင် ပုံမှန်အားဖြင့် `sandbox`, non-sandbox sessions တွင် `host` ကို အသုံးပြုသည်။
  - ဘရောက်ဇာ စွမ်းရည်ရှိ node တစ်ခု ချိတ်ဆက်ထားပါက `target="host"` သို့မဟုတ် `target="node"` ကို pin မလုပ်လျှင် tool သည် အလိုအလျောက် ထို node သို့ လမ်းကြောင်းချနိုင်သည်။

ဤနည်းလမ်းသည် အေးဂျင့်ကို သတ်မှတ်နိုင်စေပြီး brittle selectors များကို ရှောင်ရှားစေသည်။
