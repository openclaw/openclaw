---
summary: "Gateway ဒက်ရှ်ဘုတ် (Control UI) ဝင်ရောက်အသုံးပြုမှုနှင့် အတည်ပြုခြင်း"
read_when:
  - Dashboard အတည်ပြုခြင်း သို့မဟုတ် ထုတ်ဖော်အသုံးပြုမှု မုဒ်များကို ပြောင်းလဲသည့်အခါ
title: "Dashboard"
---

# Dashboard (Control UI)

Gateway dashboard သည် ပုံမှန်အားဖြင့် `/` တွင် ဝန်ဆောင်မှုပေးထားသော ဘရောက်ဇာ Control UI ဖြစ်သည်
(`gateway.controlUi.basePath` ဖြင့် အစားထိုးသတ်မှတ်နိုင်သည်)။

အမြန်ဖွင့်ရန် (local Gateway):

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (သို့မဟုတ် [http://localhost:18789/](http://localhost:18789/))

အရေးပါသော ကိုးကားချက်များ:

- အသုံးပြုနည်းနှင့် UI စွမ်းဆောင်ရည်များအတွက် [Control UI](/web/control-ui)။
- Serve/Funnel အလိုအလျောက်ပြုလုပ်မှုအတွက် [Tailscale](/gateway/tailscale)။
- bind မုဒ်များနှင့် လုံခြုံရေးမှတ်ချက်များအတွက် [Web surfaces](/web)။

14. Authentication ကို WebSocket handshake အချိန်တွင် `connect.params.auth` (token သို့မဟုတ် password) ဖြင့် အတည်ပြုပါသည်။ 15. [Gateway configuration](/gateway/configuration) တွင် `gateway.auth` ကို ကြည့်ပါ။

16. လုံခြုံရေး မှတ်ချက်: Control UI သည် **admin surface** (chat, config, exec approvals) ဖြစ်ပါသည်။
17. အများပြည်သူအတွက် မဖွင့်ပြပါနှင့်။ 18. UI သည် ပထမဆုံး load ပြီးနောက် token ကို `localStorage` တွင် သိမ်းဆည်းပါသည်။
18. localhost, Tailscale Serve သို့မဟုတ် SSH tunnel ကို ဦးစားပေး အသုံးပြုပါ။

## Fast path (အကြံပြု)

- onboarding ပြီးနောက် CLI သည် dashboard ကို အလိုအလျောက် ဖွင့်ပေးပြီး သန့်ရှင်းသော (token မပါသော) လင့်ခ်ကို ပရင့်ထုတ်ပေးသည်။
- မည်သည့်အချိန်မဆို ပြန်ဖွင့်ရန်: `openclaw dashboard` (လင့်ခ်ကို ကူးယူပေးပြီး ဖြစ်နိုင်ပါက ဘရောက်ဇာကို ဖွင့်ပေးသည်၊ headless ဖြစ်ပါက SSH အညွှန်းကို ပြသည်)။
- UI က auth ကို တောင်းဆိုပါက `gateway.auth.token` (သို့မဟုတ် `OPENCLAW_GATEWAY_TOKEN`) မှ token ကို Control UI settings ထဲသို့ ကူးထည့်ပါ။

## Token အခြေခံများ (local vs remote)

- **Localhost**: `http://127.0.0.1:18789/` ကို ဖွင့်ပါ။
- **Token ရယူရာနေရာ**: `gateway.auth.token` (သို့မဟုတ် `OPENCLAW_GATEWAY_TOKEN`)၊ ချိတ်ဆက်ပြီးနောက် UI သည် localStorage တွင် မိတ္တူတစ်စောင် သိမ်းဆည်းထားသည်။
- 20. **localhost မဟုတ်ပါက**: Tailscale Serve ( `gateway.auth.allowTailscale: true` ဖြစ်ပါက token မလိုအပ်), token ဖြင့် tailnet bind, သို့မဟုတ် SSH tunnel ကို အသုံးပြုပါ။ 21. [Web surfaces](/web) ကို ကြည့်ပါ။

## “unauthorized” / 1008 ကို တွေ့ပါက

- Gateway ကို ရောက်ရှိနိုင်ကြောင်း သေချာပါစေ (local: `openclaw status`; remote: SSH တန်နယ် `ssh -N -L 18789:127.0.0.1:18789 user@host` ထူထောင်ပြီး `http://127.0.0.1:18789/` ကို ဖွင့်ပါ)။
- Gateway ဟို့စ် မှ token ကို ပြန်လည်ရယူပါ: `openclaw config get gateway.auth.token` (သို့မဟုတ် အသစ်တစ်ခု ဖန်တီးရန်: `openclaw doctor --generate-gateway-token`)။
- Dashboard settings တွင် auth field ထဲသို့ token ကို ကူးထည့်ပြီး ချိတ်ဆက်ပါ။
