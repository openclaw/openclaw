---
summary: "`openclaw security` အတွက် CLI အညွှန်း (လုံခြုံရေးဆိုင်ရာ အမှားများကို စစ်ဆေးခြင်းနှင့် ပြုပြင်ခြင်း)"
read_when:
  - config/state အပေါ် လုံခြုံရေးကို အမြန် စစ်ဆေးလိုသောအခါ
  - ဘေးကင်းသော “fix” အကြံပြုချက်များ (chmod၊ မူလသတ်မှတ်ချက်များကို တင်းကျပ်စေခြင်း) ကို အသုံးချလိုသောအခါ
title: "security"
---

# `openclaw security`

လုံခြုံရေး ကိရိယာများ (စစ်ဆေးမှု + ရွေးချယ်နိုင်သော ပြုပြင်ချက်များ)။

ဆက်စပ်အကြောင်းအရာများ -

- လုံခြုံရေး လမ်းညွှန် - [Security](/gateway/security)

## Audit

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
```

Audit သည် DM ပေးပို့သူများ အများအပြားက main session ကို မျှဝေနေသည့်အခါ သတိပေးပြီး **secure DM mode** ကို အကြံပြုပါသည်: `session.dmScope="per-channel-peer"` (shared inbox များအတွက် multi-account channel များတွင် `per-account-channel-peer`)။
ထို့အပြင် sandbox မလုပ်ထားဘဲ web/browser tool များ ဖွင့်ထားသည့်အခြေအနေတွင် model သေးငယ်များ (`<=300B`) ကို အသုံးပြုပါက သတိပေးပါသည်။
