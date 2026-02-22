---
summary: "macOS အတွက် Skills ဆက်တင် UI နှင့် Gateway（ဂိတ်ဝေး）အခြေပြု အခြေအနေ"
read_when:
  - macOS Skills ဆက်တင် UI ကို အပ်ဒိတ်လုပ်နေစဉ်
  - Skills ကို ကန့်သတ်ခြင်း သို့မဟုတ် ထည့်သွင်းတပ်ဆင်မှု အပြုအမူများကို ပြောင်းလဲနေစဉ်
title: "Skills"
---

# Skills (macOS)

macOS အက်ပ်သည် Gateway（ဂိတ်ဝေး）မှတစ်ဆင့် OpenClaw Skills များကို ပြသပေးပြီး Skills များကို ဒေသခံအနေဖြင့် မဖတ်ရှုပါ။

## Data source

- `skills.status` (Gateway（ဂိတ်ဝေး）) သည် Skills အားလုံးနှင့်အတူ အရည်အချင်းသင့်တော်မှုနှင့် မပြည့်စုံသေးသော လိုအပ်ချက်များကို ပြန်ပေးသည်  
  (bundled skills များအတွက် allowlist ကန့်သတ်ချက်များပါဝင်သည်)။
- လိုအပ်ချက်များကို `SKILL.md` တစ်ခုချင်းစီအတွင်းရှိ `metadata.openclaw.requires` မှ ဆင်းသက်တွက်ချက်သည်။

## Install actions

- `metadata.openclaw.install` သည် install ရွေးချယ်စရာများ (brew/node/go/uv) ကို သတ်မှတ်ပေးသည်။
- အက်ပ်သည် Gateway ဟို့စ် ပေါ်တွင် installer များကို လည်ပတ်စေရန် `skills.install` ကို ခေါ်ဆိုသည်။
- Gateway（ဂိတ်ဝေး） သည် ရွေးချယ်စရာများ အများအပြား ရှိပါက ဦးစားပေး installer တစ်ခုသာ ပြသသည်  
  (ရရှိနိုင်ပါက brew ကို ဦးစားပေးပြီး၊ မရှိပါက `skills.install` မှ node manager ကို အသုံးပြုကာ၊ ပုံမှန်အနေဖြင့် npm ကို သုံးသည်)။

## Env/API keys

- App သည် keys များကို `~/.openclaw/openclaw.json` အောက်ရှိ `skills.entries.<skillKey>` တွင် သိမ်းဆည်းထားသည်။`.`
- `skills.update` သည် `enabled`, `apiKey`, နှင့် `env` ကို patch လုပ်သည်။

## Remote mode

- Install နှင့် config အပ်ဒိတ်များကို ဒေသခံ Mac မဟုတ်ဘဲ Gateway ဟို့စ် ပေါ်တွင် ဆောင်ရွက်သည်။
