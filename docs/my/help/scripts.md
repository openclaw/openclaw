---
summary: "Repository အတွင်းရှိ scripts များ၏ ရည်ရွယ်ချက်၊ အကျုံးဝင်မှုနှင့် လုံခြုံရေးဆိုင်ရာ မှတ်ချက်များ"
read_when:
  - Repo မှ scripts များကို အလုပ်လုပ်စေမည့်အခါ
  - ./scripts အောက်တွင် scripts များ ထည့်သွင်းခြင်း သို့မဟုတ် ပြောင်းလဲခြင်း ပြုလုပ်သောအခါ
title: "Scripts"
---

# Scripts

၃၅။ `scripts/` directory တွင် local workflows နှင့် ops tasks အတွက် အထောက်အကူ script များ ပါဝင်ပါသည်။
၃၆။ Task တစ်ခုသည် script နှင့် တိုက်ရိုက် ဆက်စပ်နေပါက ဤအရာများကို သုံးပါ၊ မဟုတ်ပါက CLI ကို ဦးစားပေးပါ။

## Conventions

- Scripts များသည် docs သို့မဟုတ် release checklist များတွင် ကိုးကားထားခြင်း မရှိပါက **မဖြစ်မနေ မလိုအပ်ပါ**။
- ရှိပြီးသား ဖြစ်ပါက CLI မျက်နှာပြင်များကို ဦးစားပေး အသုံးပြုပါ (ဥပမာ– auth monitoring သည် `openclaw models status --check` ကို အသုံးပြုသည်)။
- Scripts များကို ဟို့စ်အလိုက် ကွဲပြားနိုင်သည်ဟု ယူဆပါ။ စက်အသစ်တစ်လုံးတွင် လုပ်ဆောင်မည်မတိုင်မီ ဖတ်ရှုပါ။

## Auth monitoring scripts

Auth monitoring scripts များကို ဤနေရာတွင် မှတ်တမ်းတင်ထားသည်—
[/automation/auth-monitoring](/automation/auth-monitoring)

## Scripts ထည့်သွင်းသောအခါ

- Scripts များကို အာရုံစိုက်ပြီး ရေးသားကာ မှတ်တမ်းတင်ပါ။
- သက်ဆိုင်ရာ doc တွင် ချုပ်ချုပ်လေး ထည့်သွင်းရေးသားပါ (မရှိပါက အသစ်ဖန်တီးပါ)။
