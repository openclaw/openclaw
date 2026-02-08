---
summary: "အချက်အလက်တိကျပြီး အရေးပါသော PR ကို ဘယ်လို တင်သွင်းရမလဲ"
title: "PR တင်သွင်းခြင်း"
x-i18n:
  source_path: help/submitting-a-pr.md
  source_hash: 277b0f51b948d1a9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:33Z
---

ကောင်းမွန်သော PR များကို ပြန်လည်သုံးသပ်ရန် လွယ်ကူသည် — ပြန်လည်သုံးသပ်သူများအနေဖြင့် ရည်ရွယ်ချက်ကို လျင်မြန်စွာ နားလည်နိုင်ရမည်၊ အပြုအမူကို စစ်ဆေးနိုင်ရမည်၊ ပြောင်းလဲမှုများကို လုံခြုံစွာ ထည့်သွင်းနိုင်ရမည်။ ဤလမ်းညွှန်သည် လူသားနှင့် LLM ပြန်လည်သုံးသပ်မှုအတွက် တိုတိုတုတ်တုတ်၊ အချက်အလက်တိကျသော တင်သွင်းမှုများကို ဖော်ပြထားသည်။

## ကောင်းမွန်သော PR တစ်ခု ဖြစ်စေသည့် အချက်များ

- [ ] ပြဿနာကို ရှင်းပြပါ၊ အရေးပါမှုကို ရှင်းပြပါ၊ ပြောင်းလဲမှုကို ရှင်းပြပါ။
- [ ] ပြောင်းလဲမှုများကို အဓိကအချက်ပေါ် အာရုံစိုက်ထားပါ။ ကျယ်ပြန့်သော refactor များကို ရှောင်ကြဉ်ပါ။
- [ ] အသုံးပြုသူမြင်နိုင်သော / config / default ပြောင်းလဲမှုများကို အကျဉ်းချုပ်ရေးပါ။
- [ ] စမ်းသပ်မှုအကျုံးဝင်မှု၊ ကျော်သွားသောအရာများနှင့် အကြောင်းရင်းများကို စာရင်းပြုစုပါ။
- [ ] သက်သေထောက်ခံချက်များ ထည့်ပါ — log များ၊ screenshot များ၊ သို့မဟုတ် မှတ်တမ်းတင်ထားသော ဗီဒီယိုများ (UI/UX)။
- [ ] Code word: ဤလမ်းညွှန်ကို ဖတ်ပြီးပါက PR ဖော်ပြချက်တွင် “lobster-biscuit” ကို ထည့်ပါ။
- [ ] PR ဖန်တီးမီ သက်ဆိုင်ရာ `pnpm` အမိန့်များကို chạy/run လုပ်ပြီး အမှားများကို ပြင်ဆင်ပါ။
- [ ] ဆက်စပ်သော လုပ်ဆောင်ချက်များ / issue များ / ပြင်ဆင်ချက်များအတွက် codebase နှင့် GitHub ကို ရှာဖွေပါ။
- [ ] အဆိုပြုချက်များကို သက်သေ သို့မဟုတ် လေ့လာတွေ့ရှိချက်များအပေါ် အခြေခံပါ။
- [ ] ခေါင်းစဉ်ကောင်း: ကြိယာ + အတိုင်းအတာ + ရလဒ် (ဥပမာ၊ `Docs: add PR and issue templates`)။

တိုတောင်းစွာ ရေးပါ; ပြန်လည်သုံးသပ်မှု တိုတောင်းခြင်းသည် စာလုံးပေါင်းမှန်ကန်မှုထက် ပိုအရေးကြီးသည်။ မသက်ဆိုင်သော အပိုင်းများကို ချန်လှပ်ပါ။

### အခြေခံ အတည်ပြု စစ်ဆေးမှု အမိန့်များ (သင့်ပြောင်းလဲမှုအတွက် အမှားများကို chạy/run လုပ်ပြီး ပြင်ဆင်ပါ)

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- Protocol ပြောင်းလဲမှုများ: `pnpm protocol:check`

## အဆင့်လိုက် ဖော်ပြခြင်း (Progressive disclosure)

- အပေါ်ဆုံး: အကျဉ်းချုပ် / ရည်ရွယ်ချက်
- နောက်တစ်ဆင့်: ပြောင်းလဲမှုများ / အန္တရာယ်များ
- နောက်တစ်ဆင့်: စမ်းသပ်မှု / အတည်ပြုခြင်း
- နောက်ဆုံး: အကောင်အထည်ဖော်ပုံ / သက်သေထောက်ခံချက်များ

## အများဆုံးတွေ့ရသော PR အမျိုးအစားများ: အသေးစိတ်

- [ ] Fix: ပြန်လည်ဖြစ်ပွားနိုင်မှု (repro)၊ အမြစ်ကြောင်းအရင်း (root cause)၊ အတည်ပြုခြင်းကို ထည့်ပါ။
- [ ] Feature: အသုံးပြုမှုကိစ္စများ၊ အပြုအမူ၊ demo များ / screenshot များ (UI) ကို ထည့်ပါ။
- [ ] Refactor: “အပြုအမူ မပြောင်းလဲပါ” ဟု ဖော်ပြပြီး ရွှေ့ပြောင်းထားသည့် / ရိုးရှင်းစေထားသည့် အရာများကို စာရင်းပြုစုပါ။
- [ ] Chore: အကြောင်းရင်းကို ဖော်ပြပါ (ဥပမာ၊ build အချိန်၊ CI၊ dependency များ)။
- [ ] Docs: ပြောင်းလဲမှုမတိုင်မီ/နောက်ပိုင်း အခြေအနေ၊ update ပြုလုပ်ထားသော စာမျက်နှာလင့်ခ်၊ `pnpm format` ကို chạy/run လုပ်ပါ။
- [ ] Test: ဘယ်လို အားနည်းချက်ကို ဖြည့်ဆည်းထားသည်၊ regression များကို ဘယ်လို ကာကွယ်ထားသည်။
- [ ] Perf: မတိုင်မီ/နောက်ပိုင်း metric များနှင့် တိုင်းတာနည်းကို ထည့်ပါ။
- [ ] UX/UI: Screenshot / ဗီဒီယိုများ၊ accessibility အပေါ် သက်ရောက်မှုကို မှတ်သားပါ။
- [ ] Infra/Build: ပတ်ဝန်းကျင်များ / အတည်ပြုခြင်း။
- [ ] Security: အန္တရာယ် အကျဉ်းချုပ်၊ repro၊ အတည်ပြုခြင်း၊ အထူးလျှို့ဝှက်ဒေတာ မပါဝင်စေရန်။ သက်သေရှိသော အဆိုပြုချက်များသာ အသုံးပြုပါ။

## စစ်ဆေးရန် စာရင်း (Checklist)

- [ ] ပြဿနာ / ရည်ရွယ်ချက် ရှင်းလင်းမှု
- [ ] အတိုင်းအတာ အာရုံစိုက်မှု
- [ ] အပြုအမူ ပြောင်းလဲမှုများ စာရင်းပြုစုထားခြင်း
- [ ] စမ်းသပ်မှုများနှင့် ရလဒ်များ စာရင်းပြုစုထားခြင်း
- [ ] လက်တွေ့ စမ်းသပ် အဆင့်များ (လိုအပ်သည့်အခါ)
- [ ] လျှို့ဝှက်ချက် / ကိုယ်ရေးကိုယ်တာ ဒေတာ မပါဝင်ခြင်း
- [ ] သက်သေ အခြေခံထားခြင်း

## အထွေထွေ PR Template

```md
#### Summary

#### Behavior Changes

#### Codebase and GitHub Search

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort (self-reported):
- Agent notes (optional, cite evidence):
```

## PR အမျိုးအစား Template များ (သင့်အမျိုးအစားဖြင့် အစားထိုးပါ)

### Fix

```md
#### Summary

#### Repro Steps

#### Root Cause

#### Behavior Changes

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Feature

```md
#### Summary

#### Use Cases

#### Behavior Changes

#### Existing Functionality Check

- [ ] I searched the codebase for existing functionality.
      Searches performed (1-3 bullets):
  -
  -

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Refactor

```md
#### Summary

#### Scope

#### No Behavior Change Statement

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Chore/Maintenance

```md
#### Summary

#### Why This Matters

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Docs

```md
#### Summary

#### Pages Updated

#### Before/After

#### Formatting

pnpm format

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Test

```md
#### Summary

#### Gap Covered

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Perf

```md
#### Summary

#### Baseline

#### After

#### Measurement Method

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### UX/UI

```md
#### Summary

#### Screenshots or Video

#### Accessibility Impact

#### Tests

#### Manual Testing

### Prerequisites

-

### Steps

1.
2. **Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Infra/Build

```md
#### Summary

#### Environments Affected

#### Validation Steps

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Security

```md
#### Summary

#### Risk Summary

#### Repro Steps

#### Mitigation or Fix

#### Verification

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```
