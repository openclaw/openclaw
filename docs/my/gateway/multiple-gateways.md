---
summary: "ဟို့စ်တစ်ခုတည်းပေါ်တွင် OpenClaw Gateways အများအပြားကို လည်ပတ်စေခြင်း (ခွဲခြားမှု၊ ပေါက်များနှင့် ပရိုဖိုင်များ)"
read_when:
  - စက်တစ်လုံးတည်းပေါ်တွင် Gateway တစ်ခုထက်ပို၍ လည်ပတ်ရန်လိုအပ်သောအခါ
  - Gateway တစ်ခုချင်းစီအတွက် သီးခြား config/state/ports များလိုအပ်သောအခါ
title: "Gateways အများအပြား"
---

# Gateways အများအပြား (ဟို့စ်တစ်ခုတည်း)

Setup အများစုအတွက် Gateway တစ်ခုတည်းကို အသုံးပြုသင့်သည်၊ Gateway တစ်ခုက messaging connection များနှင့် agent များ အများအပြားကို ကိုင်တွယ်နိုင်သောကြောင့်ဖြစ်သည်။ ပိုမိုကောင်းမွန်သော isolation သို့မဟုတ် redundancy (ဥပမာ rescue bot) လိုအပ်ပါက profile/port များကို ခွဲထားသော Gateway များကို သီးခြားစီ chạy ပါ။

## Isolation စစ်ဆေးရန်စာရင်း (မဖြစ်မနေလိုအပ်)

- `OPENCLAW_CONFIG_PATH` — instance တစ်ခုချင်းစီအတွက် config ဖိုင်
- `OPENCLAW_STATE_DIR` — instance တစ်ခုချင်းစီအတွက် sessions, creds, caches
- `agents.defaults.workspace` — instance တစ်ခုချင်းစီအတွက် workspace root
- `gateway.port` (သို့မဟုတ် `--port`) — instance တစ်ခုချင်းစီအတွက် မတူညီရမည်
- Derived ports (browser/canvas) များ အပြန်အလှန် မထပ်ရပါ

ဤအချက်များကို မျှဝေထားပါက config race များနှင့် port conflict များကို ကြုံတွေ့ရပါမည်။

## အကြံပြုချက်: profiles (`--profile`)

Profiles များသည် `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` ကို အလိုအလျောက် scope ချထားပြီး service အမည်များတွင် suffix ထည့်ပေးပါသည်။

```bash
# main
openclaw --profile main setup
openclaw --profile main gateway --port 18789

# rescue
openclaw --profile rescue setup
openclaw --profile rescue gateway --port 19001
```

Per-profile services:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

## Rescue-bot လမ်းညွှန်

ဟို့စ်တစ်ခုတည်းပေါ်တွင် ဒုတိယ Gateway တစ်ခုကို အောက်ပါအရာများကို ကိုယ်ပိုင်အဖြစ်ထား၍ လည်ပတ်စေပါ—

- profile/config
- state dir
- workspace
- base port (နှင့် derived ports များ)

ဤနည်းဖြင့် rescue bot ကို အဓိက bot နှင့် ခွဲခြားထားနိုင်ပြီး အဓိက bot ပိတ်သွားပါက debug လုပ်ခြင်း သို့မဟုတ် config ပြောင်းလဲမှုများကို အသုံးချနိုင်ပါသည်။

Port spacing: base port များအကြား အနည်းဆုံး port 20 ခန့် ချန်ထားပါ၊ derived browser/canvas/CDP ports များ မတိုင်မိစေရန်အတွက် ဖြစ်ပါသည်။

### တပ်ဆင်နည်း (rescue bot)

```bash
# Main bot (existing or fresh, without --profile param)
# Runs on port 18789 + Chrome CDC/Canvas/... Ports
openclaw onboard
openclaw gateway install

# Rescue bot (isolated profile + ports)
openclaw --profile rescue onboard
# Notes:
# - workspace name will be postfixed with -rescue per default
# - Port should be at least 18789 + 20 Ports,
#   better choose completely different base port, like 19789,
# - rest of the onboarding is the same as normal

# To install the service (if not happened automatically during onboarding)
openclaw --profile rescue gateway install
```

## Port mapping (derived)

Base port = `gateway.port` (သို့မဟုတ် `OPENCLAW_GATEWAY_PORT` / `--port`) ဖြစ်ပါသည်။

- browser control service port = base + 2 (local loopback သာ)
- `canvasHost.port = base + 4`
- Browser profile CDP port များကို `browser.controlPort + 9 .. + 108` မှ အလိုအလျောက် ခွဲဝေသတ်မှတ်သည်။

Config သို့မဟုတ် env တွင် ဤအရာများထဲမှ မည်သည့်အရာကိုမဆို override လုပ်ပါက instance တစ်ခုချင်းစီအတွက် မတူညီအောင် ထားရှိရပါမည်။

## Browser/CDP မှတ်ချက်များ (အများဆုံးဖြစ်တတ်သော အမှား)

- `browser.cdpUrl` ကို instance အများအပြားတွင် တန်ဖိုးတူညီအောင် မချိန်ထားပါနှင့်။
- Instance တစ်ခုချင်းစီအတွက် ကိုယ်ပိုင် browser control port နှင့် CDP range (gateway port မှ ဆင်းသက်လာသော) လိုအပ်ပါသည်။
- သတ်မှတ်ထားသော CDP port များ လိုအပ်ပါက `browser.profiles.<name>.cdpPort` ကို instance တစ်ခုချင်းစီအတွက် သတ်မှတ်ပါ။
- Remote Chrome: `browser.profiles.<name>.cdpUrl` ကို အသုံးပြုပါ (profile တစ်ခုချင်း၊ instance တစ်ခုချင်း)။

## Manual env ဥပမာ

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/main.json \
OPENCLAW_STATE_DIR=~/.openclaw-main \
openclaw gateway --port 18789

OPENCLAW_CONFIG_PATH=~/.openclaw/rescue.json \
OPENCLAW_STATE_DIR=~/.openclaw-rescue \
openclaw gateway --port 19001
```

## Quick checks

```bash
openclaw --profile main status
openclaw --profile rescue status
openclaw --profile rescue browser status
```
