---
summary: "Gateway HTTP အဆုံးမှတ်မှတစ်ဆင့် ကိရိယာတစ်ခုကို တိုက်ရိုက် ခေါ်ဆိုအသုံးပြုခြင်း"
read_when:
  - အေးဂျင့် လှည့်ပတ်မှုအပြည့်အစုံ မပြေးဆွဲဘဲ ကိရိယာများကို ခေါ်ဆိုလိုသည့်အခါ
  - ကိရိယာ မူဝါဒအကောင်အထည်ဖော်မှု လိုအပ်သော အလိုအလျောက်လုပ်ငန်းများ တည်ဆောက်သည့်အခါ
title: "Tools Invoke API"
---

# Tools Invoke (HTTP)

OpenClaw ၏ Gateway သည် tool တစ်ခုတည်းကို တိုက်ရိုက် ခေါ်ယူရန်အတွက် ရိုးရှင်းသော HTTP endpoint တစ်ခုကို ဖော်ပြထားပါသည်။ အမြဲတမ်း ဖွင့်ထားသော်လည်း Gateway auth နှင့် tool policy ဖြင့် ကန့်သတ်ထားပါသည်။

- `POST /tools/invoke`
- Gateway နှင့် တူညီသော ပေါက် (WS + HTTP multiplex): `http://<gateway-host>:<port>/tools/invoke`

ပုံမှန် အများဆုံး payload အရွယ်အစားမှာ 2 MB ဖြစ်သည်။

## Authentication

Gateway auth configuration ကို အသုံးပြုပါသည်။ Bearer token တစ်ခု ပို့ပါ:

- `Authorization: Bearer <token>`

မှတ်ချက်များ:

- `gateway.auth.mode="token"` ဖြစ်သောအခါ `gateway.auth.token` (သို့မဟုတ် `OPENCLAW_GATEWAY_TOKEN`) ကို အသုံးပြုပါ။
- `gateway.auth.mode="password"` ဖြစ်သောအခါ `gateway.auth.password` (သို့မဟုတ် `OPENCLAW_GATEWAY_PASSWORD`) ကို အသုံးပြုပါ။

## Request body

```json
{
  "tool": "sessions_list",
  "action": "json",
  "args": {},
  "sessionKey": "main",
  "dryRun": false
}
```

Fields:

- `tool` (string, လိုအပ်): ခေါ်ဆိုမည့် ကိရိယာအမည်။
- `action` (string, မလိုအပ်): ကိရိယာ schema မှ `action` ကို ထောက်ပံ့ပြီး args payload တွင် မပါရှိပါက args ထဲသို့ ချိတ်ဆက်သွားမည်။
- `args` (object, မလိုအပ်): ကိရိယာအလိုက် သီးသန့် arguments များ။
- `sessionKey` (string, optional): ပစ်မှတ် session key ဖြစ်သည်။ မထည့်ထားပါက သို့မဟုတ် `"main"` ဖြစ်ပါက Gateway သည် ပြင်ဆင်ထားသော main session key ကို အသုံးပြုပါမည် (`session.mainKey` နှင့် default agent ကို လေးစားလိုက်နာပြီး၊ global scope တွင် `global` ကို အသုံးပြုပါသည်)။
- `dryRun` (boolean, မလိုအပ်): အနာဂတ် အသုံးပြုရန် သိမ်းဆည်းထားခြင်းဖြစ်ပြီး လက်ရှိတွင် မသုံးပါ။

## Policy + routing behavior

ကိရိယာ ရရှိနိုင်မှုကို Gateway အေးဂျင့်များ အသုံးပြုသည့် မူဝါဒ ချိတ်ဆက်လမ်းကြောင်းတစ်လျှောက်တည်းဖြင့် စစ်ထုတ်သည်။

- `tools.profile` / `tools.byProvider.profile`
- `tools.allow` / `tools.byProvider.allow`
- `agents.<id>.tools.allow` / `agents.<id>.tools.byProvider.allow`
- အုပ်စု မူဝါဒများ (ဆက်ရှင် ကီးသည် အုပ်စု သို့မဟုတ် ချန်နယ်တစ်ခုသို့ ချိတ်ဆက်ထားပါက)
- subagent မူဝါဒ (subagent ဆက်ရှင် ကီးဖြင့် ခေါ်ဆိုသည့်အခါ)

ကိရိယာတစ်ခုကို မူဝါဒအရ ခွင့်မပြုပါက အဆုံးမှတ်သည် **404** ကို ပြန်လည်ပေးမည်။

အုပ်စု မူဝါဒများက အကြောင်းအရာကို မှန်ကန်စွာ ဖြေရှင်းနိုင်ရန် အောက်ပါတို့ကို မလိုအပ်ဘဲ သတ်မှတ်နိုင်သည်။

- `x-openclaw-message-channel: <channel>` (ဥပမာ: `slack`, `telegram`)
- `x-openclaw-account-id: <accountId>` (အကောင့်များ အများအပြား ရှိသည့်အခါ)

## Responses

- `200` → `{ ok: true, result }`
- `400` → `{ ok: false, error: { type, message } }` (မမှန်ကန်သော request သို့မဟုတ် ကိရိယာ အမှား)
- `401` → အထောက်အထား မရှိ
- `404` → ကိရိယာ မရရှိနိုင် (မတွေ့ရှိခြင်း သို့မဟုတ် allowlist တွင် မပါဝင်ခြင်း)
- `405` → ခွင့်မပြုသော method

## Example

```bash
curl -sS http://127.0.0.1:18789/tools/invoke \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": "sessions_list",
    "action": "json",
    "args": {}
  }'
```
