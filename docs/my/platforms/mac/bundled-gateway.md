---
summary: "macOS ပေါ်ရှိ Gateway runtime (အပြင်ဘက် launchd ဝန်ဆောင်မှု)"
read_when:
  - OpenClaw.app ကို ထုပ်ပိုးနေစဉ်
  - macOS gateway launchd ဝန်ဆောင်မှုကို အမှားရှာဖွေပြင်ဆင်နေစဉ်
  - macOS အတွက် gateway CLI ကို ထည့်သွင်းနေစဉ်
title: "macOS ပေါ်ရှိ Gateway"
x-i18n:
  source_path: platforms/mac/bundled-gateway.md
  source_hash: 4a3e963d13060b12
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:38Z
---

# macOS ပေါ်ရှိ Gateway (အပြင်ဘက် launchd)

OpenClaw.app သည် Node/Bun သို့မဟုတ် Gateway runtime ကို မထုပ်ပိုးတော့ပါ။ macOS အက်ပ်သည် **အပြင်ဘက်** `openclaw` CLI ကို ထည့်သွင်းထားရန် မျှော်လင့်ထားပြီး Gateway ကို ကလေး process အဖြစ် မဖွင့်ပါ။ ထို့အပြင် Gateway ကို ဆက်လက်လည်ပတ်နေစေရန် per‑user launchd ဝန်ဆောင်မှုကို စီမံခန့်ခွဲပေးသည် (သို့မဟုတ် local Gateway တစ်ခု ရှိပြီးသားဖြစ်ပါက ထို Gateway သို့ ချိတ်ဆက်သည်)။

## CLI ကို ထည့်သွင်းခြင်း (local mode အတွက် လိုအပ်သည်)

Mac ပေါ်တွင် Node 22+ လိုအပ်ပြီး၊ ထို့နောက် `openclaw` ကို global အနေဖြင့် ထည့်သွင်းပါ:

```bash
npm install -g openclaw@<version>
```

macOS အက်ပ်၏ **Install CLI** ခလုတ်သည် npm/pnpm ဖြင့် အလားတူ လုပ်ငန်းစဉ်ကို လုပ်ဆောင်သည် (Gateway runtime အတွက် bun ကို မအကြံပြုပါ)။

## Launchd (Gateway ကို LaunchAgent အဖြစ်)

Label:

- `bot.molt.gateway` (သို့မဟုတ် `bot.molt.<profile>`; legacy `com.openclaw.*` သည် ဆက်လက်ရှိနေနိုင်သည်)

Plist တည်နေရာ (per‑user):

- `~/Library/LaunchAgents/bot.molt.gateway.plist`
  (သို့မဟုတ် `~/Library/LaunchAgents/bot.molt.<profile>.plist`)

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

macOS အက်ပ်သည် gateway ဗားရှင်းကို ကိုယ်ပိုင်ဗားရှင်းနှင့် နှိုင်းယှဉ်စစ်ဆေးသည်။ မကိုက်ညီပါက အက်ပ်ဗားရှင်းနှင့် ကိုက်ညီအောင် global CLI ကို အပ်ဒိတ်လုပ်ပါ။

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
