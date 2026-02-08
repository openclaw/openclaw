---
summary: "macOS UI အလိုအလျောက်လုပ်ဆောင်မှုအတွက် PeekabooBridge ပေါင်းစည်းမှု"
read_when:
  - OpenClaw.app အတွင်း PeekabooBridge ကို ဟို့စ်တင်ခြင်း
  - Swift Package Manager ဖြင့် Peekaboo ကို ပေါင်းစည်းခြင်း
  - PeekabooBridge ပရိုတိုကော/လမ်းကြောင်းများ ပြောင်းလဲခြင်း
title: "Peekaboo Bridge"
x-i18n:
  source_path: platforms/mac/peekaboo.md
  source_hash: b5b9ddb9a7c59e15
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:44Z
---

# Peekaboo Bridge (macOS UI အလိုအလျောက်လုပ်ဆောင်မှု)

OpenClaw သည် **PeekabooBridge** ကို ဒေသခံ၊ ခွင့်ပြုချက်ကို သိရှိနားလည်ထားသော UI အလိုအလျောက်လုပ်ဆောင်မှု
broker အဖြစ် ဟို့စ်တင်နိုင်ပါသည်။ ၎င်းဖြင့် `peekaboo` CLI သည် macOS အက်ပ်၏ TCC ခွင့်ပြုချက်များကို ပြန်လည်အသုံးချပြီး UI အလိုအလျောက်လုပ်ဆောင်မှုကို ထိန်းချုပ်နိုင်စေပါသည်။

## ဒီအရာက ဘာလဲ (မဟုတ်တာက ဘာလဲ)

- **Host**: OpenClaw.app သည် PeekabooBridge ဟို့စ်အဖြစ် လုပ်ဆောင်နိုင်ပါသည်။
- **Client**: `peekaboo` CLI ကို အသုံးပြုပါ (သီးခြား `openclaw ui ...` မျက်နှာပြင် မလိုအပ်ပါ)။
- **UI**: မြင်ကွင်းအပေါ်ယံအလွှာများကို Peekaboo.app ထဲတွင်သာ ထားရှိပြီး OpenClaw သည် ပါးလွှာသော broker ဟို့စ်သာ ဖြစ်ပါသည်။

## Bridge ကို ဖွင့်ခြင်း

macOS အက်ပ်အတွင်း—

- Settings → **Enable Peekaboo Bridge**

ဖွင့်ထားသောအခါ OpenClaw သည် ဒေသခံ UNIX socket ဆာဗာကို စတင်ပါသည်။ ပိတ်ထားပါက ဟို့စ်ကို ရပ်တန့်ပြီး `peekaboo` သည် ရရှိနိုင်သည့် အခြား ဟို့စ်များသို့ ပြန်လည်အလိုအလျောက် ပြောင်းလဲသွားပါမည်။

## Client ရှာဖွေတွေ့ရှိမှု အစီအစဉ်

Peekaboo client များသည် ပုံမှန်အားဖြင့် အောက်ပါအစီအစဉ်အတိုင်း ဟို့စ်များကို စမ်းသပ်ပါသည်—

1. Peekaboo.app (UX ပြည့်စုံ)
2. Claude.app (တပ်ဆင်ထားပါက)
3. OpenClaw.app (ပါးလွှာသော broker)

ဘယ်ဟို့စ်ကို လက်ရှိအသုံးပြုနေသည်နှင့် မည်သည့် socket လမ်းကြောင်းကို အသုံးပြုနေသည်ကို ကြည့်ရန် `peekaboo bridge status --verbose` ကို အသုံးပြုပါ။ အောက်ပါအတိုင်း override လုပ်နိုင်ပါသည်—

```bash
export PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock
```

## လုံခြုံရေးနှင့် ခွင့်ပြုချက်များ

- Bridge သည် **ခေါ်ဆိုသူ၏ code signature များ** ကို အတည်ပြုစစ်ဆေးပြီး TeamID များ၏ allowlist ကို အကောင်အထည်ဖော်ထားပါသည် (Peekaboo ဟို့စ် TeamID + OpenClaw အက်ပ် TeamID)။
- တောင်းဆိုချက်များသည် ~10 စက္ကန့်အကြာတွင် အချိန်ကုန်ဆုံးပါသည်။
- လိုအပ်သော ခွင့်ပြုချက်များ မရှိပါက System Settings ကို ဖွင့်မခေါ်ဘဲ အမှားသတင်းစာကို ထင်ရှားစွာ ပြန်ပို့ပါသည်။

## Snapshot အပြုအမူ (အလိုအလျောက်လုပ်ဆောင်မှု)

Snapshot များကို မှတ်ဉာဏ်အတွင်း သိမ်းဆည်းထားပြီး အချိန်တိုအတွင်း အလိုအလျောက် သက်တမ်းကုန်ဆုံးပါသည်။ ပိုမိုကြာရှည်စွာ ထိန်းသိမ်းလိုပါက client မှ ပြန်လည် capture လုပ်ပါ။

## Troubleshooting

- `peekaboo` တွင် “bridge client is not authorized” ဟု ဖော်ပြပါက client ကို မှန်ကန်စွာ signed လုပ်ထားကြောင်း သေချာစစ်ဆေးပါ သို့မဟုတ် **debug** mode တွင်သာ `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` ဖြင့် ဟို့စ်ကို လည်ပတ်ပါ။
- ဟို့စ်များ မတွေ့ပါက ဟို့စ်အက်ပ်များထဲမှ တစ်ခုခု (Peekaboo.app သို့မဟုတ် OpenClaw.app) ကို ဖွင့်ပြီး ခွင့်ပြုချက်များ ပေးထားကြောင်း အတည်ပြုပါ။
