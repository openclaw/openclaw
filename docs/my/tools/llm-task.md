---
summary: "လုပ်ငန်းစဉ်များအတွက် JSON-only LLM တာဝန်များ (ရွေးချယ်နိုင်သော plugin tool)"
read_when:
  - လုပ်ငန်းစဉ်များအတွင်း JSON-only LLM အဆင့်တစ်ခု လိုအပ်သောအခါ
  - အလိုအလျောက်လုပ်ဆောင်မှုအတွက် schema ဖြင့် စစ်ဆေးထားသော LLM အထွက် လိုအပ်သောအခါ
title: "LLM Task"
---

# LLM Task

`llm-task` သည် **ရွေးချယ်နိုင်သော plugin tool** တစ်ခုဖြစ်ပြီး JSON-only LLM တာဝန်တစ်ခုကို လုပ်ဆောင်ကာ
ဖွဲ့စည်းထားသော အထွက်ကို ပြန်ပေးသည် (လိုအပ်ပါက JSON Schema ဖြင့် စစ်ဆေးနိုင်သည်)။

ဤအရာသည် Lobster ကဲ့သို့သော workflow engine များအတွက် အထူးသင့်တော်ပါသည်။ workflow တစ်ခုချင်းစီအတွက်
အထူး OpenClaw code မရေးဘဲ LLM အဆင့်တစ်ခုတည်းကို ထည့်သွင်းနိုင်ပါသည်။

## Plugin ကို ဖွင့်အသုံးပြုရန်

1. Plugin ကို ဖွင့်ပါ:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  }
}
```

2. Tool ကို allowlist ထဲ ထည့်ပါ (`optional: true` ဖြင့် မှတ်ပုံတင်ထားပါသည်):

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "allow": ["llm-task"] }
      }
    ]
  }
}
```

## Config (ရွေးချယ်နိုင်)

```json
{
  "plugins": {
    "entries": {
      "llm-task": {
        "enabled": true,
        "config": {
          "defaultProvider": "openai-codex",
          "defaultModel": "gpt-5.2",
          "defaultAuthProfileId": "main",
          "allowedModels": ["openai-codex/gpt-5.3-codex"],
          "maxTokens": 800,
          "timeoutMs": 30000
        }
      }
    }
  }
}
```

`allowedModels` သည် `provider/model` string များ၏ allowlist ဖြစ်သည်။ သတ်မှတ်ထားပါက စာရင်းအပြင်ရှိသော request မည်သည့်တစ်ခုမဆို ငြင်းပယ်ခံရမည် ဖြစ်သည်။

## Tool parameters

- `prompt` (string, မဖြစ်မနေလိုအပ်)
- `input` (any, ရွေးချယ်နိုင်)
- `schema` (object, ရွေးချယ်နိုင်သော JSON Schema)
- `provider` (string, ရွေးချယ်နိုင်)
- `model` (string, ရွေးချယ်နိုင်)
- `authProfileId` (string, ရွေးချယ်နိုင်)
- `temperature` (number, ရွေးချယ်နိုင်)
- `maxTokens` (number, ရွေးချယ်နိုင်)
- `timeoutMs` (number, ရွေးချယ်နိုင်)

## Output

`details.json` ကို ပြန်ပေးပြီး ပါဝင်သော JSON ကို parse လုပ်ထားပါသည် (ပေးထားပါက
`schema` ဖြင့် စစ်ဆေးပါသည်)။

## ဥပမာ: Lobster workflow အဆင့်

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "input": {
    "subject": "Hello",
    "body": "Can you help?"
  },
  "schema": {
    "type": "object",
    "properties": {
      "intent": { "type": "string" },
      "draft": { "type": "string" }
    },
    "required": ["intent", "draft"],
    "additionalProperties": false
  }
}'
```

## လုံခြုံရေး မှတ်ချက်များ

- Tool သည် **JSON-only** ဖြစ်ပြီး မော်ဒယ်အား JSON သာ ထုတ်ရန် ညွှန်ကြားထားပါသည် (code fences မရှိ၊ မှတ်ချက်များ မရှိ)။
- ဤ run အတွက် မော်ဒယ်ထံ မည်သည့် tool မဆို ဖွင့်ပေးထားခြင်း မရှိပါ။
- `schema` ဖြင့် စစ်ဆေးမထားပါက အထွက်ကို ယုံကြည်စိတ်ချရမှု မရှိသည့်အရာအဖြစ် ကိုင်တွယ်ပါ။
- side-effect ဖြစ်စေသော အဆင့်များ (send, post, exec) မလုပ်မီ အတည်ပြုချက်များ ထည့်သွင်းထားပါ။
