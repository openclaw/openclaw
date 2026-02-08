---
summary: "အချက်အလက်ပြည့်စုံပြီး အရည်အသွေးမြင့် Issue နှင့် bug report များ တင်သွင်းခြင်း"
title: "Issue တင်သွင်းခြင်း"
x-i18n:
  source_path: help/submitting-an-issue.md
  source_hash: bcb33f05647e9f0d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:31Z
---

## Issue တင်သွင်းခြင်း

ရှင်းလင်းကျစ်လစ်သော Issue များသည် ပြဿနာခွဲခြမ်းစိတ်ဖြာခြင်းနှင့် ပြင်ဆင်ခြင်းကို လျင်မြန်စေပါသည်။ bug များ၊ regression များ သို့မဟုတ် feature မပြည့်စုံမှုများအတွက် အောက်ပါအချက်များကို ထည့်သွင်းပါ။

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

တိုတောင်းစွာရေးပါ။ အကျဉ်းချုပ်ရေးသားမှု > စာလုံးပေါင်းအပြည့်အစုံမှန်ကန်မှု။

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

_အများပြည်သူမြင်နိုင်သောနေရာတွင် secrets/exploit အသေးစိတ်များကို ရှောင်ကြဉ်ပါ။ အထိခိုက်မခံရသော Issue များအတွက် အသေးစိတ်ကို အနည်းဆုံးသာ ဖော်ပြပြီး private disclosure ကို တောင်းဆိုပါ။_

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

PR မတင်မီ Issue တင်ခြင်းသည် မဖြစ်မနေ မလိုအပ်ပါ။ ကျော်သွားပါက PR ထဲတွင် အသေးစိတ်ကို ထည့်သွင်းပါ။ PR ကို အာရုံစိုက်စွာထားပါ၊ Issue နံပါတ်ကို မှတ်သားပါ၊ test များ ထည့်ပါ သို့မဟုတ် မထည့်ရခြင်း၏ အကြောင်းရင်းကို ရှင်းပြပါ၊ အပြုအမူ ပြောင်းလဲမှုများ/အန္တရာယ်များကို မှတ်တမ်းတင်ပါ၊ အထောက်အထားအဖြစ် ဖယ်ရှားထားသော logs/screenshots များကို ထည့်သွင်းပါ၊ နှင့် တင်သွင်းမီ သင့်လျော်သော validation များကို run လုပ်ပါ။
