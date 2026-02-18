---
summary: "macOS UI အလိုအလျောက်လုပ်ဆောင်မှုအတွက် PeekabooBridge ပေါင်းစည်းမှု"
read_when:
  - OpenClaw.app အတွင်း PeekabooBridge ကို ဟို့စ်တင်ခြင်း
  - Swift Package Manager ဖြင့် Peekaboo ကို ပေါင်းစည်းခြင်း
  - PeekabooBridge ပရိုတိုကော/လမ်းကြောင်းများ ပြောင်းလဲခြင်း
title: "Peekaboo Bridge"
---

# Peekaboo Bridge (macOS UI အလိုအလျောက်လုပ်ဆောင်မှု)

30. OpenClaw သည် **PeekabooBridge** ကို local၊ permission‑aware UI automation broker အဖြစ် host လုပ်နိုင်ပါသည်။ 31. ၎င်းကြောင့် `peekaboo` CLI သည် macOS app ၏ TCC permissions ကို ပြန်လည်အသုံးချပြီး UI automation ကို မောင်းနှင်နိုင်ပါသည်။

## ဒီအရာက ဘာလဲ (မဟုတ်တာက ဘာလဲ)

- **Host**: OpenClaw.app သည် PeekabooBridge ဟို့စ်အဖြစ် လုပ်ဆောင်နိုင်ပါသည်။
- **Client**: `peekaboo` CLI ကို အသုံးပြုပါ (သီးခြား `openclaw ui ...` မျက်နှာပြင် မလိုအပ်ပါ)။
- **UI**: မြင်ကွင်းအပေါ်ယံအလွှာများကို Peekaboo.app ထဲတွင်သာ ထားရှိပြီး OpenClaw သည် ပါးလွှာသော broker ဟို့စ်သာ ဖြစ်ပါသည်။

## Bridge ကို ဖွင့်ခြင်း

macOS အက်ပ်အတွင်း—

- Settings → **Enable Peekaboo Bridge**

32. Enable လုပ်ထားပါက OpenClaw သည် local UNIX socket server တစ်ခုကို စတင်ပါသည်။ 33. Disable လုပ်ထားပါက host ကို ရပ်တန့်ပြီး `peekaboo` သည် ရရှိနိုင်သော အခြား host များကို fallback အဖြစ် အသုံးပြုပါသည်။

## Client ရှာဖွေတွေ့ရှိမှု အစီအစဉ်

Peekaboo client များသည် ပုံမှန်အားဖြင့် အောက်ပါအစီအစဉ်အတိုင်း ဟို့စ်များကို စမ်းသပ်ပါသည်—

1. Peekaboo.app (UX ပြည့်စုံ)
2. Claude.app (တပ်ဆင်ထားပါက)
3. OpenClaw.app (ပါးလွှာသော broker)

34) မည်သည့် host သည် active ဖြစ်နေသည်နှင့် မည်သည့် socket path ကို အသုံးပြုနေသည်ကို ကြည့်ရန် `peekaboo bridge status --verbose` ကို အသုံးပြုပါ။ 35. အောက်ပါအတိုင်း override လုပ်နိုင်ပါသည်:

```bash
export PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock
```

## လုံခြုံရေးနှင့် ခွင့်ပြုချက်များ

- Bridge သည် **ခေါ်ဆိုသူ၏ code signature များ** ကို အတည်ပြုစစ်ဆေးပြီး TeamID များ၏ allowlist ကို အကောင်အထည်ဖော်ထားပါသည် (Peekaboo ဟို့စ် TeamID + OpenClaw အက်ပ် TeamID)။
- တောင်းဆိုချက်များသည် ~10 စက္ကန့်အကြာတွင် အချိန်ကုန်ဆုံးပါသည်။
- လိုအပ်သော ခွင့်ပြုချက်များ မရှိပါက System Settings ကို ဖွင့်မခေါ်ဘဲ အမှားသတင်းစာကို ထင်ရှားစွာ ပြန်ပို့ပါသည်။

## Snapshot အပြုအမူ (အလိုအလျောက်လုပ်ဆောင်မှု)

36. Snapshots များကို memory ထဲတွင် သိမ်းထားပြီး အချိန်တိုတောင်းအပြီး အလိုအလျောက် expire ဖြစ်ပါသည်။
37. ပိုကြာရှည်စွာ သိမ်းထားလိုပါက client မှ ပြန်လည် capture လုပ်ပါ။

## Troubleshooting

- `peekaboo` တွင် “bridge client is not authorized” ဟု ဖော်ပြပါက client ကို မှန်ကန်စွာ signed လုပ်ထားကြောင်း သေချာစစ်ဆေးပါ သို့မဟုတ် **debug** mode တွင်သာ `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` ဖြင့် ဟို့စ်ကို လည်ပတ်ပါ။
- ဟို့စ်များ မတွေ့ပါက ဟို့စ်အက်ပ်များထဲမှ တစ်ခုခု (Peekaboo.app သို့မဟုတ် OpenClaw.app) ကို ဖွင့်ပြီး ခွင့်ပြုချက်များ ပေးထားကြောင်း အတည်ပြုပါ။
