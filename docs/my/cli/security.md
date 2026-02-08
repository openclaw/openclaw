---
summary: "`openclaw security` အတွက် CLI အညွှန်း (လုံခြုံရေးဆိုင်ရာ အမှားများကို စစ်ဆေးခြင်းနှင့် ပြုပြင်ခြင်း)"
read_when:
  - config/state အပေါ် လုံခြုံရေးကို အမြန် စစ်ဆေးလိုသောအခါ
  - ဘေးကင်းသော “fix” အကြံပြုချက်များ (chmod၊ မူလသတ်မှတ်ချက်များကို တင်းကျပ်စေခြင်း) ကို အသုံးချလိုသောအခါ
title: "security"
x-i18n:
  source_path: cli/security.md
  source_hash: 96542b4784e53933
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:03Z
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

Audit သည် DM ပို့သူများ အများအပြားက အဓိက ဆက်ရှင်ကို မျှဝေနေသောအခါ သတိပေးပြီး မျှဝေထားသော inbox များအတွက် **secure DM mode** ကို အသုံးပြုရန် အကြံပြုသည် — `session.dmScope="per-channel-peer"` (သို့မဟုတ် multi-account ချန်နယ်များအတွက် `per-account-channel-peer`)။
ထို့အပြင် sandboxing မပါဘဲ web/browser ကိရိယာများကို ဖွင့်ထားသောအခြေအနေတွင် အသုံးပြုနေသော သေးငယ်သော မော်ဒယ်များ (`<=300B`) ကိုလည်း သတိပေးသည်။
