---
summary: "apply_patch ကိရိယာဖြင့် ဖိုင်များစွာကို တစ်ပြိုင်နက် ပတ်ချ်များ အသုံးပြုခြင်း"
read_when:
  - ဖိုင်များစွာအနှံ့ ဖွဲ့စည်းတည်ဆောက်ထားသော ပြင်ဆင်မှုများ လိုအပ်သည့်အခါ
  - ပတ်ချ်အခြေခံ ပြင်ဆင်မှုများကို မှတ်တမ်းတင်ရန် သို့မဟုတ် အမှားရှာရန် လိုသည့်အခါ
title: "apply_patch ကိရိယာ"
---

# apply_patch ကိရိယာ

Apply file changes using a structured patch format. ဖိုင်အများအပြား သို့မဟုတ် hunk အများအပြား ပါဝင်သော ပြင်ဆင်မှုများအတွက်၊ `edit` တစ်ခါတည်း သုံးခြင်းသည် မခိုင်မာနိုင်သောကြောင့် ဤနည်းလမ်းသည် သင့်တော်ပါသည်။

ဤကိရိယာသည် ဖိုင်လုပ်ဆောင်ချက် တစ်ခု သို့မဟုတ် အများအပြားကို ထုပ်ပိုးထားသော `input` စာကြောင်း တစ်ခုကို လက်ခံပါသည်—

```
*** Begin Patch
*** Add File: path/to/file.txt
+line 1
+line 2
*** Update File: src/app.ts
@@
-old line
+new line
*** Delete File: obsolete.txt
*** End Patch
```

## Parameters

- `input` (လိုအပ်): `*** Begin Patch` နှင့် `*** End Patch` ပါဝင်သော ပတ်ချ်အကြောင်းအရာ အပြည့်အစုံ။

## Notes

- လမ်းကြောင်းများကို workspace root နှင့် ဆက်စပ်၍ ဖြေရှင်းပါသည်။
- ဖိုင်အမည်ပြောင်းရန် `*** Update File:` hunk အတွင်း `*** Move to:` ကို အသုံးပြုပါ။
- လိုအပ်ပါက EOF သာ ထည့်သွင်းခြင်းကို အမှတ်အသားပြုရန် `*** End of File` ကို အသုံးပြုပါ။
- စမ်းသပ်အဆင့်ဖြစ်ပြီး ပုံမှန်အားဖြင့် ပိတ်ထားပါသည်။ `tools.exec.applyPatch.enabled` ဖြင့် ဖွင့်နိုင်ပါသည်။
- OpenAI အတွက်သာ အသုံးပြုနိုင်ပါသည် (OpenAI Codex အပါအဝင်)။ လိုအပ်ပါက မော်ဒယ်အလိုက် `tools.exec.applyPatch.allowModels` ဖြင့် ထိန်းချုပ်နိုင်ပါသည်။
- Config သည် `tools.exec` အောက်တွင်သာ ရှိပါသည်။

## Example

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```
