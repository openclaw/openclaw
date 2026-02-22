---
summary: "ပလဂ်အင် မန်နီဖက်စ်နှင့် JSON schema လိုအပ်ချက်များ (တင်းကျပ်သော config စစ်ဆေးခြင်း)"
read_when:
  - သင် OpenClaw ပလဂ်အင် တစ်ခုကို တည်ဆောက်နေချိန်
  - ပလဂ်အင် config schema ကို ပို့ဆောင်ရန် သို့မဟုတ် ပလဂ်အင် စစ်ဆေးမှု အမှားများကို အမှန်တကယ် ခွဲခြမ်းစိတ်ဖြာရန် လိုအပ်သည့်အခါ
title: "Plugin Manifest"
---

# Plugin manifest (openclaw.plugin.json)

Plugin တစ်ခုချင်းစီတွင် **plugin root** အတွင်း `openclaw.plugin.json` ဖိုင်တစ်ခု **မဖြစ်မနေ** ပါဝင်ရပါမည်။
OpenClaw သည် plugin code ကို **မ run ဘဲ** configuration ကို validate လုပ်ရန် ဤ manifest ကို အသုံးပြုပါသည်။ မရှိသော သို့မဟုတ် မမှန်ကန်သော manifests များကို plugin errors အဖြစ် သတ်မှတ်ပြီး config validation ကို ပိတ်ဆို့ပါသည်။

ပလဂ်အင် စနစ်အပြည့်အစုံ လမ်းညွှန်ကို ကြည့်ရန်: [Plugins](/tools/plugin)

## Required fields

```json
{
  "id": "voice-call",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

လိုအပ်သော ကီးများ:

- `id` (string): ပလဂ်အင်၏ canonical id။
- `configSchema` (object): ပလဂ်အင် config အတွက် JSON Schema (inline)။

ရွေးချယ်နိုင်သော ကီးများ:

- `kind` (string): ပလဂ်အင် အမျိုးအစား (ဥပမာ: `"memory"`)။
- `channels` (array): ဤပလဂ်အင်မှ မှတ်ပုံတင်ထားသော channel id များ (ဥပမာ: `["matrix"]`)။
- `providers` (array): ဤပလဂ်အင်မှ မှတ်ပုံတင်ထားသော provider id များ။
- `skills` (array): တင်သွင်းမည့် skill လမ်းကြောင်းများ (plugin root ကို အခြေခံ၍ relative)။
- `name` (string): ပလဂ်အင်အတွက် ပြသမည့် အမည်။
- `description` (string): ပလဂ်အင်၏ အကျဉ်းချုပ် ဖော်ပြချက်။
- `uiHints` (object): UI ပြသရန်အတွက် config field အညွှန်းများ / placeholder များ / sensitive flag များ။
- `version` (string): ပလဂ်အင် ဗားရှင်း (အချက်အလက်ဆိုင်ရာ)။

## JSON Schema requirements

- **ပလဂ်အင်တိုင်းသည် JSON Schema တစ်ခုကို မဖြစ်မနေ ထည့်သွင်းရပါသည်**၊ config ကို မလက်ခံသော်လည်း ဖြစ်ပါသည်။
- ဗလာ schema ကိုလည်း လက်ခံပါသည် (ဥပမာ: `{ "type": "object", "additionalProperties": false }`)။
- Schema များကို runtime မဟုတ်ဘဲ config ဖတ်/ရေးချိန်တွင်သာ စစ်ဆေးပါသည်။

## Validation behavior

- မသိရှိသော `channels.*` ကီးများကို **အမှားများ** အဖြစ် သတ်မှတ်ပါသည်၊ သို့သော်
  channel id ကို ပလဂ်အင် manifest မှ ကြေညာထားပါက ချန်လှပ်ထားနိုင်ပါသည်။
- `plugins.entries.<id>``, `plugins.allow`, `plugins.deny`, နှင့် `plugins.slots.\*\` တို့သည် **discoverable** plugin ids များကို reference လုပ်ရပါမည်။ မသိသော ids များကို **errors** အဖြစ် သတ်မှတ်ပါသည်။
- ပလဂ်အင်ကို ထည့်သွင်းထားပြီးသား ဖြစ်သော်လည်း မန်နီဖက်စ် သို့မဟုတ် schema ပျက်စီးနေခြင်း သို့မဟုတ် ပျောက်ဆုံးနေပါက
  စစ်ဆေးမှု မအောင်မြင်ဘဲ Doctor တွင် ပလဂ်အင် အမှားအဖြစ် အစီရင်ခံပါသည်။
- ပလဂ်အင် config ရှိနေသော်လည်း ပလဂ်အင်ကို **ပိတ်ထားပါက**၊ config ကို ထိန်းသိမ်းထားပြီး
  Doctor နှင့် logs တွင် **သတိပေးချက်** ကို ပြသပါသည်။

## Notes

- မန်နီဖက်စ်သည် **ပလဂ်အင်အားလုံးအတွက် မဖြစ်မနေ လိုအပ်ပါသည်**၊ local filesystem မှ တင်သွင်းခြင်းများပါဝင်သည်။
- Runtime သည် ပလဂ်အင် မော်ဂျူးကို သီးခြားစီ တင်သွင်းလုပ်ဆောင်နေဆဲဖြစ်ပြီး၊ မန်နီဖက်စ်ကို
  ရှာဖွေတွေ့ရှိမှုနှင့် စစ်ဆေးခြင်းအတွက်သာ အသုံးပြုပါသည်။
- သင့်ပလဂ်အင်သည် native modules များကို မူတည်နေပါက၊ build လုပ်ငန်းစဉ်များနှင့်
  package-manager allowlist လိုအပ်ချက်များကို မှတ်တမ်းတင်ဖော်ပြပါ (ဥပမာ: pnpm `allow-build-scripts`
  - `pnpm rebuild <package>`)။
