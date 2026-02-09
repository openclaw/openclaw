---
summary: "Chrome extension: OpenClaw ကို သင့်လက်ရှိ Chrome tab ကို မောင်းနှင်ခိုင်းစေနိုင်သည်"
read_when:
  - အေးဂျင့်ကို လက်ရှိ Chrome tab (toolbar ခလုတ်) ကို မောင်းနှင်စေချင်သောအခါ
  - Remote Gateway + local browser automation ကို Tailscale ဖြင့် လိုအပ်သောအခါ
  - browser takeover ၏ လုံခြုံရေးဆိုင်ရာ သက်ရောက်မှုများကို နားလည်လိုသောအခါ
title: "Chrome Extension"
---

# Chrome extension (browser relay)

OpenClaw Chrome extension သည် အေးဂျင့်ကို **လက်ရှိ Chrome tab များ** (သင်၏ ပုံမှန် Chrome ဝင်းဒိုး) ကို ထိန်းချုပ်စေနိုင်ပြီး openclaw မှ စီမံခန့်ခွဲသော Chrome profile သီးသန့်တစ်ခုကို စတင်ဖွင့်စရာမလိုပါ။

ချိတ်ဆက်ခြင်း / ဖြုတ်ခြင်းကို **Chrome toolbar ခလုတ် တစ်ခုတည်း** ဖြင့် ပြုလုပ်နိုင်သည်။

## What it is (concept)

အစိတ်အပိုင်း သုံးခု ပါဝင်သည်-

- **Browser control service** (Gateway သို့မဟုတ် နိုဒ်): အေးဂျင့်/ကိရိယာက (Gateway မှတစ်ဆင့်) ခေါ်သုံးသည့် API
- **Local relay server** (loopback CDP): control server နှင့် extension အကြား ချိတ်ဆက်ပေးသည် (`http://127.0.0.1:18792` ကို မူလအဖြစ် အသုံးပြုသည်)
- **Chrome MV3 extension**: `chrome.debugger` ကို အသုံးပြုပြီး လက်ရှိ tab ကို ချိတ်ဆက်ကာ CDP မက်ဆေ့ချ်များကို relay သို့ ပို့ပေးသည်

ထို့နောက် OpenClaw သည် သင့်တော်သော profile ကို ရွေးချယ်ခြင်းဖြင့် ပုံမှန် `browser` tool surface မှတစ်ဆင့် ချိတ်ဆက်ထားသော tab ကို ထိန်းချုပ်သည်။

## Install / load (unpacked)

1. Extension ကို တည်ငြိမ်သော local path တစ်ခုတွင် ထည့်သွင်းပါ-

```bash
openclaw browser extension install
```

2. ထည့်သွင်းပြီးသား extension directory path ကို ထုတ်ပြပါ-

```bash
openclaw browser extension path
```

3. Chrome → `chrome://extensions`

- “Developer mode” ကို ဖွင့်ပါ
- “Load unpacked” → အထက်တွင် ထုတ်ပြထားသော directory ကို ရွေးပါ

4. Extension ကို pin လုပ်ပါ။

## Updates (no build step)

The extension ships inside the OpenClaw release (npm package) as static files. 10. သီးခြား “build” အဆင့် မရှိပါ။

OpenClaw ကို အဆင့်မြှင့်ပြီးနောက်-

- OpenClaw state directory အောက်ရှိ ထည့်သွင်းထားသော ဖိုင်များကို ပြန်လည် refresh လုပ်ရန် `openclaw browser extension install` ကို ထပ်မံ chạy ပါ။
- Chrome → `chrome://extensions` → extension ပေါ်ရှိ “Reload” ကို နှိပ်ပါ။

## Use it (no extra config)

OpenClaw တွင် default port ပေါ်ရှိ extension relay ကို ဦးတည်သည့် `chrome` ဟု အမည်ပေးထားသော built-in browser profile တစ်ခု ပါဝင်လာပါသည်။

အသုံးပြုနည်း-

- CLI: `openclaw browser --browser-profile chrome tabs`
- Agent tool: `browser` ကို `profile="chrome"` နှင့် အသုံးပြုပါ

အမည်ကွဲပြားစေလိုပါက သို့မဟုတ် relay port ကို ပြောင်းလိုပါက ကိုယ်ပိုင် profile တစ်ခု ဖန်တီးပါ-

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

## Attach / detach (toolbar button)

- OpenClaw က ထိန်းချုပ်စေလိုသော tab ကို ဖွင့်ပါ။
- Extension icon ကို နှိပ်ပါ။
  - ချိတ်ဆက်ပြီးပါက badge တွင် `ON` ကို ပြပါသည်။
- ထပ်မံ နှိပ်ပါက ဖြုတ်ချပါမည်။

## Which tab does it control?

- “သင်ကြည့်နေသော tab ကို အလိုအလျောက် ထိန်းချုပ်ခြင်း” မဟုတ်ပါ။
- Toolbar ခလုတ်ကို နှိပ်ပြီး **သင်ကိုယ်တိုင် ချိတ်ဆက်ထားသော tab(များ)** ကိုသာ ထိန်းချုပ်ပါသည်။
- ပြောင်းလိုပါက အခြား tab ကို ဖွင့်ပြီး အဲဒီ tab မှာ extension icon ကို နှိပ်ပါ။

## Badge + common errors

- `ON`: ချိတ်ဆက်ပြီးဖြစ်သည်; OpenClaw သည် ထို tab ကို မောင်းနှင်နိုင်သည်။
- `…`: local relay သို့ ချိတ်ဆက်နေသည်။
- `!`: relay ကို မရောက်နိုင်ပါ (အများဆုံးဖြစ်ရပ်—ဤစက်ပေါ်တွင် browser relay server မလုပ်ဆောင်နေခြင်း)။

`!` ကို မြင်ရပါက-

- Gateway ကို local (default setup) တွင် လုပ်ဆောင်နေကြောင်း သေချာစေပါ၊ သို့မဟုတ် Gateway ကို အခြားနေရာတွင် လုပ်ဆောင်နေပါက ဤစက်ပေါ်တွင် node host ကို chạy ပါ။
- Extension Options စာမျက်နှာကို ဖွင့်ပါ; relay ရောက်နိုင်/မရောက်နိုင်ကို ပြသပေးပါသည်။

## Remote Gateway (use a node host)

### Local Gateway (Chrome နှင့် တူညီသော စက်) — ပုံမှန်အားဖြင့် **အပိုအဆင့် မလို**

11. Gateway သည် Chrome နှင့် တူညီသော စက်ပေါ်တွင် လည်ပတ်နေပါက loopback ပေါ်တွင် browser control service ကို စတင်ပြီး relay server ကို အလိုအလျောက် စတင်ပါသည်။ 12. extension သည် local relay နှင့် ဆက်သွယ်ပြီး CLI/tool ခေါ်ဆိုမှုများသည် Gateway သို့ သွားပါသည်။

### Remote Gateway (Gateway ကို အခြားစက်တွင် chạy) — **node host ကို chạy ပါ**

13. သင့် Gateway သည် အခြားစက်ပေါ်တွင် လည်ပတ်နေပါက Chrome လည်ပတ်နေသော စက်ပေါ်တွင် node host တစ်ခုကို စတင်ပါ။
    The Gateway will proxy browser actions to that node; the extension + relay stay local to the browser machine.

Node များ အများအပြား ချိတ်ဆက်ထားပါက `gateway.nodes.browser.node` ဖြင့် တစ်ခုကို pin လုပ်ပါ သို့မဟုတ် `gateway.nodes.browser.mode` ကို သတ်မှတ်ပါ။

## Sandboxing (tool containers)

သင့်အေးဂျင့် ဆက်ရှင်သည် sandboxed (`agents.defaults.sandbox.mode != "off"`) ဖြစ်ပါက `browser` tool ကို ကန့်သတ်ထားနိုင်ပါသည်-

- မူလအတိုင်း sandboxed ဆက်ရှင်များသည် သင့် host Chrome မဟုတ်ဘဲ **sandbox browser** (`target="sandbox"`) ကို မကြာခဏ ဦးတည်ပါသည်။
- Chrome extension relay takeover သည် **host** browser control server ကို ထိန်းချုပ်နိုင်ရပါမည်။

ရွေးချယ်စရာများ-

- အလွယ်ဆုံး: **non-sandboxed** ဆက်ရှင်/အေးဂျင့် မှ extension ကို အသုံးပြုပါ။
- သို့မဟုတ် sandboxed ဆက်ရှင်များအတွက် host browser control ကို ခွင့်ပြုပါ-

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

ထို့နောက် tool policy ဖြင့် tool ကို ပိတ်မထားကြောင်း သေချာစေပြီး (လိုအပ်ပါက) `browser` ကို `target="host"` နှင့် ခေါ်သုံးပါ။

Debugging: `openclaw sandbox explain`

## Remote access tips

- Gateway နှင့် node host ကို တူညီသော tailnet အတွင်း ထားရှိပါ; relay port များကို LAN သို့မဟုတ် အများပြည်သူအင်တာနက်သို့ မဖွင့်ပါနှင့်။
- Node များကို ရည်ရွယ်ချက်ရှိစွာ pair လုပ်ပါ; remote control မလိုပါက browser proxy routing ကို ပိတ်ပါ (`gateway.nodes.browser.mode="off"`)။

## How “extension path” works

`openclaw browser extension path` သည် extension ဖိုင်များ ပါဝင်သော **ထည့်သွင်းပြီးသား** disk ပေါ်ရှိ directory ကို ထုတ်ပြပါသည်။

15. CLI သည် ရည်ရွယ်ချက်ရှိရှိ `node_modules` လမ်းကြောင်းကို မပုံနှိပ်ပါ။ 16. OpenClaw state directory အောက်ရှိ တည်ငြိမ်သော တည်နေရာသို့ extension ကို မိတ္တူကူးရန် `openclaw browser extension install` ကို အရင်ဆုံး အမြဲတမ်း လည်ပတ်ပါ။

ထို install directory ကို ရွှေ့ သို့မဟုတ် ဖျက်လိုက်ပါက Chrome သည် extension ကို broken အဖြစ် အမှတ်အသားပြုမည်ဖြစ်ပြီး မှန်ကန်သော path မှ ပြန်လည် load မလုပ်မချင်း အသုံးမပြုနိုင်ပါ။

## Security implications (read this)

17. ဤအရာသည် အင်အားကြီးပြီး အန္တရာယ်ရှိပါသည်။ 18. မော်ဒယ်အား “သင့် browser ပေါ်တွင် လက်များ ပေးထားခြင်း” လို သဘောထားဖြင့် ဆက်ဆံပါ။

- 19. extension သည် Chrome ၏ debugger API (`chrome.debugger`) ကို အသုံးပြုပါသည်။ 20. ချိတ်ဆက်ထားချိန်တွင် မော်ဒယ်သည် လုပ်ဆောင်နိုင်သည်မှာ:
  - ထို tab အတွင်း click/type/navigate လုပ်နိုင်သည်
  - စာမျက်နှာအကြောင်းအရာကို ဖတ်နိုင်သည်
  - ထို tab တွင် လော့ဂ်အင်လုပ်ထားသော session က ရနိုင်သမျှကို ဝင်ရောက်နိုင်သည်
- **ဤသည်မှာ** openclaw-managed profile သီးသန့်ကဲ့သို့ **ခွဲခြားကာကွယ်ထားခြင်း မရှိပါ**။
  - သင်၏ နေ့စဉ်အသုံးပြုသော profile/tab ကို ချိတ်ဆက်ပါက ထိုအကောင့်အခြေအနေအားလုံးကို ဝင်ရောက်ခွင့် ပေးထားခြင်းဖြစ်သည်။

အကြံပြုချက်များ-

- Extension relay အသုံးပြုရန် သင့်ကိုယ်ရေးကိုယ်တာ browsing နှင့် ခွဲထားသော Chrome profile သီးသန့်တစ်ခုကို ဦးစားပေး အသုံးပြုပါ။
- Gateway နှင့် node host များကို tailnet-only အဖြစ် ထားရှိပြီး Gateway auth + node pairing ကို ယုံကြည်အသုံးပြုပါ။
- Relay port များကို LAN ပေါ်တွင် မဖွင့်ပါနှင့် (`0.0.0.0`) နှင့် Funnel (public) ကို ရှောင်ကြဉ်ပါ။
- Relay သည် extension မဟုတ်သော origin များကို ပိတ်ပင်ပြီး CDP clients အတွက် internal auth token ကို လိုအပ်ပါသည်။

Related:

- Browser tool overview: [Browser](/tools/browser)
- Security audit: [Security](/gateway/security)
- Tailscale setup: [Tailscale](/gateway/tailscale)
