---
summary: "macOS ပေါ်ရှိ Gateway runtime (အပြင်ဘက် launchd ဝန်ဆောင်မှု)"
read_when:
  - OpenClaw.app ကို ထုပ်ပိုးနေစဉ်
  - macOS gateway launchd ဝန်ဆောင်မှုကို အမှားရှာဖွေပြင်ဆင်နေစဉ်
  - macOS အတွက် gateway CLI ကို ထည့်သွင်းနေစဉ်
title: "macOS ပေါ်ရှိ Gateway"
---

# macOS ပေါ်ရှိ Gateway (အပြင်ဘက် launchd)

17. OpenClaw.app သည် Node/Bun သို့မဟုတ် Gateway runtime ကို မပါဝင်တော့ပါ။ 18. macOS app သည် **external** `openclaw` CLI ထည့်သွင်းထားမှုကို မျှော်လင့်ထားပြီး Gateway ကို child process အဖြစ် မဖန်တီးပါ၊ ထို့အပြင် Gateway ကို ဆက်လက် လည်ပတ်စေရန် per‑user launchd service ကို စီမံခန့်ခွဲပေးသည် (သို့မဟုတ် local Gateway တစ်ခု ရှိပြီးသားဖြစ်ပါက ၎င်းသို့ ချိတ်ဆက်ပါသည်)။

## CLI ကို ထည့်သွင်းခြင်း (local mode အတွက် လိုအပ်သည်)

Mac ပေါ်တွင် Node 22+ လိုအပ်ပြီး၊ ထို့နောက် `openclaw` ကို global အနေဖြင့် ထည့်သွင်းပါ:

```bash
npm install -g openclaw@<version>
```

macOS အက်ပ်၏ **Install CLI** ခလုတ်သည် npm/pnpm ဖြင့် အလားတူ လုပ်ငန်းစဉ်ကို လုပ်ဆောင်သည် (Gateway runtime အတွက် bun ကို မအကြံပြုပါ)။

## Launchd (Gateway ကို LaunchAgent အဖြစ်)

Label:

- 19. `bot.molt.gateway` (သို့မဟုတ် `bot.molt.<profile>``; legacy `com.openclaw.\*\` may remain)

Plist တည်နေရာ (per‑user):

- `~/Library/LaunchAgents/bot.molt.gateway.plist`
  (or `~/Library/LaunchAgents/bot.molt.<profile>.plist`)

Manager:

- Local mode တွင် LaunchAgent ကို ထည့်သွင်း/အပ်ဒိတ်လုပ်ခြင်းကို macOS အက်ပ်က ပိုင်ဆိုင်စီမံခန့်ခွဲသည်။
- CLI မှလည်း ထည့်သွင်းနိုင်သည်: `openclaw gateway install`။

Behavior:

- “OpenClaw Active” သည် LaunchAgent ကို ဖွင့်/ပိတ် ပြုလုပ်ပေးသည်။
- အက်ပ်ကို ပိတ်လိုက်သော်လည်း gateway ကို **မရပ်တန့်** ပါ (launchd က ဆက်လက်လည်ပတ်စေသည်)။
- သတ်မှတ်ထားသော port ပေါ်တွင် Gateway တစ်ခု ရှိပြီးသားဖြစ်ပါက၊ အသစ်တစ်ခု စတင်မလုပ်ဘဲ ထို Gateway သို့ အက်ပ်က ချိတ်ဆက်သည်။

Logging:

- launchd stdout/err: `/tmp/openclaw/openclaw-gateway.log`

## ဗားရှင်း ကိုက်ညီမှု

23. macOS app သည် Gateway version ကို ကိုယ်ပိုင် version နှင့် နှိုင်းယှဉ်စစ်ဆေးပါသည်။ 24. မကိုက်ညီပါက global CLI ကို app version နှင့် ကိုက်ညီအောင် update လုပ်ပါ။

## Smoke check

```bash
openclaw --version

OPENCLAW_SKIP_CHANNELS=1 \
OPENCLAW_SKIP_CANVAS_HOST=1 \
openclaw gateway --port 18999 --bind loopback
```

ထို့နောက်:

```bash
openclaw gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
