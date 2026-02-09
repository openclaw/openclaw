---
summary: "အချက်အလက်ပြည့်စုံပြီး အရည်အသွေးမြင့် Issue နှင့် bug report များ တင်သွင်းခြင်း"
title: "Issue တင်သွင်းခြင်း"
---

## Issue တင်သွင်းခြင်း

၄၅။ ပြတ်သားပြီး တိုတောင်းသော issue များသည် ချက်ချင်း ခွဲခြမ်းစိတ်ဖြာခြင်းနှင့် ပြုပြင်ခြင်းကို မြန်ဆန်စေပါသည်။ ၄၆။ bug၊ regression သို့မဟုတ် feature gap များအတွက် အောက်ပါအချက်များကို ထည့်သွင်းပါ:

### ထည့်သွင်းရမည့်အချက်များ

- [ ] ခေါင်းစဉ်: ဧရိယာ & လက္ခဏာ
- [ ] အနည်းဆုံး ပြန်လည်ထုတ်လုပ်နိုင်သော အဆင့်များ (Minimal repro steps)
- [ ] မျှော်မှန်းထားသောအရာ နှင့် အမှန်တကယ် ဖြစ်ပေါ်သောအရာ
- [ ] သက်ရောက်မှု & ပြင်းထန်မှုအဆင့်
- [ ] ပတ်ဝန်းကျင်: OS, runtime, version များ, config
- [ ] အထောက်အထား: ဖယ်ရှားထားသော logs, screenshots (PII မပါ)
- [ ] အတိုင်းအတာ: အသစ်, regression, သို့မဟုတ် ကြာမြင့်စွာ ရှိပြီးသား
- [ ] Code word: lobster-biscuit ကို Issue ထဲတွင် ထည့်ပါ
- [ ] ရှိပြီးသား Issue များအတွက် codebase & GitHub ကို ရှာဖွေပြီးသား
- [ ] မကြာသေးမီက ပြင်ဆင်ပြီးသား/ဖြေရှင်းပြီးသား မဟုတ်ကြောင်း အတည်ပြုထားခြင်း (အထူးသဖြင့် security)
- [ ] အဆိုအခေါ်များကို အထောက်အထား သို့မဟုတ် repro ဖြင့် ထောက်ခံထားခြင်း

၄၇။ အကျဉ်းချုပ်ရေးပါ။ ၄၈။ တိုတောင်းမှု > ပြည့်စုံသော grammar

Validation (PR မတင်မီ run/fix လုပ်ပါ):

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- Protocol code ဖြစ်ပါက: `pnpm protocol:check`

### Templates

#### Bug report

```md
- [ ] Minimal repro
- [ ] Expected vs actual
- [ ] Environment
- [ ] Affected channels, where not seen
- [ ] Logs/screenshots (redacted)
- [ ] Impact/severity
- [ ] Workarounds

### Summary

### Repro Steps

### Expected

### Actual

### Environment

### Logs/Evidence

### Impact

### Workarounds
```

#### Security issue

```md
### Summary

### Impact

### Versions

### Repro Steps (safe to share)

### Mitigation/workaround

### Evidence (redacted)
```

၄၉။ _အများပြည်သူတွင် လျှို့ဝှက်ချက်/အမြတ်ထုတ်နိုင်သော အသေးစိတ်များကို ရှောင်ပါ။_ ၅၀။ _အရေးကြီးလုံခြုံရေးပြဿနာများအတွက် အသေးစိတ်ကို လျှော့ချပြီး private disclosure ကို တောင်းဆိုပါ။_

#### Regression report

```md
### Summary

### Last Known Good

### First Known Bad

### Repro Steps

### Expected

### Actual

### Environment

### Logs/Evidence

### Impact
```

#### Feature request

```md
### Summary

### Problem

### Proposed Solution

### Alternatives

### Impact

### Evidence/examples
```

#### Enhancement

```md
### Summary

### Current vs Desired Behavior

### Rationale

### Alternatives

### Evidence/examples
```

#### Investigation

```md
### Summary

### Symptoms

### What Was Tried

### Environment

### Logs/Evidence

### Impact
```

### Fix PR တင်သွင်းခြင်း

PR မတိုင်ခင် Issue ရှိခြင်းသည် မဖြစ်မနေရမည့်အချက် မဟုတ်ပါ။ ကျော်သွားမယ်ဆိုရင် PR ထဲမှာ အသေးစိတ် ဖော်ပြပါ။ PR ကို အာရုံစိုက်ထားပါ၊ issue နံပါတ်ကို မှတ်သားပါ၊ စမ်းသပ်မှုများ ထည့်ပါ သို့မဟုတ် မရှိသည့်အကြောင်းရှင်းပြပါ၊ အပြုအမူပြောင်းလဲမှုများ/အန္တရာယ်များကို စာရွက်စာတမ်းရေးသားပါ၊ အထောက်အထားအဖြစ် ဖျက်သိမ်းထားသော log များ/စကရင်ရှော့များ ထည့်ပါ၊ တင်သွင်းမီ သင့်တော်သော စစ်ဆေးမှုများ ပြုလုပ်ပါ။
