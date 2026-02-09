---
summary: "onboarding wizard နှင့် config schema အတွက် RPC protocol မှတ်စုများ"
read_when: "onboarding wizard အဆင့်များ သို့မဟုတ် config schema endpoints များကို ပြောင်းလဲသည့်အခါ"
title: "Onboarding နှင့် Config Protocol"
---

# Onboarding + Config Protocol

ရည်ရွယ်ချက်: CLI၊ macOS အက်ပ်နှင့် Web UI တို့အကြား မျှဝေအသုံးပြုသော onboarding နှင့် config မျက်နှာပြင်များ။

## Components

- Wizard engine (မျှဝေထားသော ဆက်ရှင် + prompts + onboarding အခြေအနေ)။
- CLI onboarding သည် UI client များနှင့် တူညီသော wizard flow ကို အသုံးပြုသည်။
- Gateway RPC သည် wizard + config schema endpoints များကို ပံ့ပိုးပေးသည်။
- macOS onboarding သည် wizard step model ကို အသုံးပြုသည်။
- Web UI သည် JSON Schema + UI hints မှ config ဖောင်များကို render လုပ်သည်။

## Gateway RPC

- `wizard.start` params: `{ mode?: "local"|"remote", workspace?: string }`
- `wizard.next` params: `{ sessionId, answer?: { stepId, value?` } }\`
- `wizard.cancel` params: `{ sessionId }`
- `wizard.status` params: `{ sessionId }`
- `config.schema` params: `{}`

Responses (shape)

- Wizard: `{ sessionId, done, step?, status?, error?` မကြာသေးမီ gateway logs များတွင် မမှန်ကန်သော parameters များ ( `sessionTarget`, `wakeMode`, `payload` မပါရှိခြင်း နှင့် `schedule` မမှန်ကန်ခြင်း) ကြောင့် `cron.add` မအောင်မြင်မှုများကို ထပ်ခါတလဲလဲ ပြထားပါသည်။
- Config schema: `{ schema, uiHints, version, generatedAt }`

## UI Hints

- `uiHints` ကို path အလိုက် keyed လုပ်ထားသည်; ရွေးချယ်နိုင်သော metadata (label/help/group/order/advanced/sensitive/placeholder) ပါဝင်နိုင်သည်။
- Sensitive fields များကို password input အဖြစ် render လုပ်သည်; redaction layer မပါဝင်ပါ။
- မပံ့ပိုးထားသော schema node များသည် raw JSON editor သို့ ပြန်လည် fallback လုပ်သည်။

## Notes

- ဤစာတမ်းသည် onboarding/config အတွက် protocol refactor များကို ခြေရာခံရန် တစ်ခုတည်းသော နေရာဖြစ်သည်။
