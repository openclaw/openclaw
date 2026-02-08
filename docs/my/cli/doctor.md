---
summary: "Gateway နှင့် ချန်နယ်များအတွက် ကျန်းမာရေးစစ်ဆေးမှုများ + လမ်းညွှန်ပြုပြင်မှုများ ပါဝင်သော `openclaw doctor` အတွက် CLI ကိုးကားချက်"
read_when:
  - ချိတ်ဆက်မှု/အတည်ပြုခြင်း ပြဿနာများရှိပြီး လမ်းညွှန်ပြုပြင်မှုများလိုချင်သောအခါ
  - အပ်ဒိတ်လုပ်ပြီးနောက် စနစ်မှန်ကန်မှုကို စစ်ဆေးချင်သောအခါ
title: "ဒေါက်တာ"
x-i18n:
  source_path: cli/doctor.md
  source_hash: 92310aa3f3d111e9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:03Z
---

# `openclaw doctor`

Gateway နှင့် ချန်နယ်များအတွက် ကျန်းမာရေးစစ်ဆေးမှုများ + အမြန်ပြုပြင်မှုများ။

ဆက်စပ်အကြောင်းအရာများ—

- ပြဿနာဖြေရှင်းခြင်း: [Troubleshooting](/gateway/troubleshooting)
- လုံခြုံရေး စစ်ဆေးမှု: [Security](/gateway/security)

## Examples

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
```

မှတ်ချက်များ—

- stdin သည် TTY ဖြစ်ပြီး `--non-interactive` ကို သတ်မှတ်မထားသောအခါမှသာ အပြန်အလှန် မေးမြန်းမှုများ (ဥပမာ keychain/OAuth ပြုပြင်မှုများ) ကို လုပ်ဆောင်ပါသည်။ Headless အလုပ်လုပ်ခြင်းများ (cron, Telegram, တာမီနယ်မရှိခြင်း) တွင် မေးမြန်းမှုများကို ကျော်သွားပါလိမ့်မည်။
- `--fix` (`--repair` အတွက် alias) သည် `~/.openclaw/openclaw.json.bak` သို့ backup တစ်ခုရေးသားပြီး မသိရှိသော config ကီးများကို ဖယ်ရှားကာ ဖယ်ရှားမှုတစ်ခုချင်းစီကို စာရင်းပြုစုပါသည်။

## macOS: `launchctl` env overrides

ယခင်က `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...` (သို့မဟုတ် `...PASSWORD`) ကို လုပ်ဆောင်ခဲ့ပါက ထိုတန်ဖိုးသည် သင့် config ဖိုင်ကို override လုပ်ပြီး “unauthorized” အမှားများကို ဆက်လက်ဖြစ်ပေါ်စေနိုင်ပါသည်။

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```
