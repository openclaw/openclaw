---
summary: "Elevated exec မုဒ်နှင့် /elevated ညွှန်ကြားချက်များ"
read_when:
  - Elevated မုဒ်၏ ပုံမှန်တန်ဖိုးများ၊ allowlist များ သို့မဟုတ် slash command အပြုအမူကို ပြင်ဆင်ချိန်
title: "Elevated Mode"
---

# Elevated Mode (/elevated directives)

## အလုပ်လုပ်ပုံ

- `/elevated on` သည် Gateway ဟို့စ်ပေါ်တွင် လည်ပတ်ပြီး exec အတည်ပြုချက်များကို ထိန်းသိမ်းထားသည် (`/elevated ask` နှင့် တူသည်)။
- `/elevated full` သည် Gateway ဟို့စ်ပေါ်တွင် လည်ပတ်ပြီး exec ကို အလိုအလျောက် အတည်ပြုသည် (exec အတည်ပြုချက်များကို ကျော်လွှားသည်)။
- `/elevated ask` သည် Gateway ဟို့စ်ပေါ်တွင် လည်ပတ်သော်လည်း exec အတည်ပြုချက်များကို ထိန်းသိမ်းထားသည် (`/elevated on` နှင့် တူသည်)။
- `on`/`ask` သည် `exec.security=full` ကို မဖြစ်မနေ အတင်းမခိုင်းစေပါ။ သတ်မှတ်ထားသော security/ask policy သည် ဆက်လက် အသက်ဝင်နေပါသည်။
- အေးဂျင့်သည် **sandboxed** ဖြစ်သောအခါသာ အပြုအမူ ပြောင်းလဲသည် (မဟုတ်ပါက exec သည် ဟို့စ်ပေါ်တွင် ရှိပြီးသား ဖြစ်သည်)။
- Directive ပုံစံများ: `/elevated on|off|ask|full`, `/elev on|off|ask|full`။
- `on|off|ask|full` များကိုသာ လက်ခံသည်။ အခြားအရာများသည် အကြံပြု hint ကို ပြန်ပေးပြီး state ကို မပြောင်းလဲပါ။

## ထိန်းချုပ်နိုင်သည့် အရာများ (နှင့် မထိန်းချုပ်နိုင်သည့် အရာများ)

- 14. **Availability gates**: `tools.elevated` သည် ကမ္ဘာလုံးဆိုင်ရာ အခြေခံအဆင့်ဖြစ်ပါသည်။ 15. `agents.list[].tools.elevated` သည် agent တစ်ခုချင်းစီအလိုက် elevated ကို ထပ်မံ ကန့်သတ်နိုင်ပါသည် (နှစ်ဖက်စလုံး ခွင့်ပြုရပါမည်)။
- **ဆက်ရှင်အလိုက် state**: `/elevated on|off|ask|full` သည် လက်ရှိ ဆက်ရှင် key အတွက် elevated အဆင့်ကို သတ်မှတ်သည်။
- **Inline directive**: စာသားအတွင်းရှိ `/elevated on|ask|full` သည် ထိုစာသားတစ်ခုတည်းအတွက်သာ သက်ရောက်သည်။
- 16. **Groups**: Group chat များတွင် elevated directives များကို agent ကို mention လုပ်ထားသောအခါတွင်သာ လိုက်နာဆောင်ရွက်ပါသည်။ 17. Mention လိုအပ်ချက်ကို ကျော်ဖြတ်သော command-only မက်ဆေ့ချ်များကို mention လုပ်ထားသည်ဟု သတ်မှတ်ပါသည်။
- **ဟို့စ်ပေါ်တွင် အကောင်အထည်ဖော်ခြင်း**: elevated သည် `exec` ကို Gateway ဟို့စ်ပေါ်သို့ အတင်း ချမှတ်သည်။ `full` သည် `security=full` ကိုလည်း သတ်မှတ်ပေးသည်။
- **အတည်ပြုချက်များ**: `full` သည် exec အတည်ပြုချက်များကို ကျော်လွှားသည်။ `on`/`ask` သည် allowlist/ask စည်းမျဉ်းများ လိုအပ်သည့်အခါ အတည်ပြုချက်များကို လိုက်နာသည်။
- **Unsandboxed အေးဂျင့်များ**: တည်နေရာအတွက် မည်သည့် အပြောင်းအလဲမှ မဖြစ်ပါ။ gating, logging နှင့် status များကိုသာ သက်ရောက်သည်။
- **Tool policy သည် ဆက်လက် အသက်ဝင်သည်**: `exec` ကို tool policy ဖြင့် ငြင်းပယ်ထားပါက elevated ကို မအသုံးပြုနိုင်ပါ။
- **`/exec` နှင့် ခွဲခြားထားသည်**: `/exec` သည် ခွင့်ပြုထားသော ပို့သူများအတွက် ဆက်ရှင်အလိုက် ပုံမှန်တန်ဖိုးများကို ပြင်ဆင်ပေးပြီး elevated ကို မလိုအပ်ပါ။

## ဆုံးဖြတ်မှု အစဉ်အလာ

1. မက်ဆေ့ချ်အပေါ်ရှိ Inline directive (ထိုမက်ဆေ့ချ်တစ်ခုတည်းအတွက်သာ သက်ရောက်သည်)။
2. ဆက်ရှင် override (directive-only မက်ဆေ့ချ် ပို့ခြင်းဖြင့် သတ်မှတ်သည်)။
3. ကမ္ဘာလုံးဆိုင်ရာ ပုံမှန်တန်ဖိုး (config ထဲရှိ `agents.defaults.elevatedDefault`)။

## ဆက်ရှင် ပုံမှန်တန်ဖိုး သတ်မှတ်ခြင်း

- directive တစ်ခုတည်းသာ ပါသော မက်ဆေ့ချ်ကို ပို့ပါ (whitespace ခွင့်ပြုသည်)၊ ဥပမာ `/elevated full`။
- အတည်ပြု ပြန်ကြားချက်ကို ပို့ပေးသည် (`Elevated mode set to full...` / `Elevated mode disabled.`)။
- elevated ဝင်ရောက်ခွင့်ကို ပိတ်ထားပါက သို့မဟုတ် ပို့သူသည် ခွင့်ပြုထားသော allowlist တွင် မပါဝင်ပါက၊ directive သည် လုပ်ဆောင်နိုင်သော အမှားပြန်ကြားချက်ကို ပြန်ပေးပြီး ဆက်ရှင် state ကို မပြောင်းလဲပါ။
- လက်ရှိ elevated အဆင့်ကို ကြည့်ရန် `/elevated` (သို့မဟုတ် `/elevated:`) ကို အကြောင်းအရာ မပါဘဲ ပို့ပါ။

## အသုံးပြုနိုင်မှု + allowlists

- Feature gate: `tools.elevated.enabled` (code က ပံ့ပိုးထားသော်လည်း config ဖြင့် ပုံမှန်အားဖြင့် ပိတ်ထားနိုင်သည်)။
- ပို့သူ allowlist: `tools.elevated.allowFrom` နှင့် provider အလိုက် allowlists များ (ဥပမာ `discord`, `whatsapp`)။
- အေးဂျင့်အလိုက် gate: `agents.list[].tools.elevated.enabled` (ရွေးချယ်နိုင်သည်; ထပ်မံ ကန့်သတ်နိုင်ခြင်းသာ ရှိသည်)။
- အေးဂျင့်အလိုက် allowlist: `agents.list[].tools.elevated.allowFrom` (ရွေးချယ်နိုင်သည်; သတ်မှတ်ထားပါက ပို့သူသည် ကမ္ဘာလုံးဆိုင်ရာ + အေးဂျင့်အလိုက် allowlists နှစ်ခုစလုံးနှင့် ကိုက်ညီရပါသည်)။
- 18. Discord fallback: `tools.elevated.allowFrom.discord` ကို မထည့်ထားပါက `channels.discord.dm.allowFrom` စာရင်းကို fallback အဖြစ် အသုံးပြုပါသည်။ 19. Override လုပ်ရန် `tools.elevated.allowFrom.discord` ကို ( `[]` ပါဝင်သော်လည်း ) သတ်မှတ်ပါ။ 20. Agent တစ်ခုချင်းစီအလိုက် allowlist များသည် fallback ကို **မ** အသုံးပြုပါ။
- ဂိတ်အားလုံး ဖြတ်ကျော်ရပါသည်။ မဟုတ်ပါက elevated ကို မရရှိနိုင်ဟု ဆက်ဆံပါသည်။

## Logging + status

- Elevated exec ခေါ်ယူမှုများကို info level ဖြင့် မှတ်တမ်းတင်ထားသည်။
- ဆက်ရှင် status တွင် elevated မုဒ် ပါဝင်သည် (ဥပမာ `elevated=ask`, `elevated=full`)။
