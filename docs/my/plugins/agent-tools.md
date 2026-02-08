---
summary: "ပလဂင်တစ်ခုအတွင်း အေးဂျင့်ကိရိယာများကို ရေးသားခြင်း (schemas၊ optional tools၊ allowlists)"
read_when:
  - ပလဂင်တစ်ခုအတွင်း အေးဂျင့်ကိရိယာအသစ် ထည့်သွင်းလိုသောအခါ
  - ကိရိယာတစ်ခုကို allowlists ဖြင့် opt‑in ဖြစ်အောင် ပြုလုပ်ရန် လိုအပ်သောအခါ
title: "ပလဂင် အေးဂျင့်ကိရိယာများ"
x-i18n:
  source_path: plugins/agent-tools.md
  source_hash: 4479462e9d8b17b6
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:44Z
---

# ပလဂင် အေးဂျင့်ကိရိယာများ

OpenClaw ပလဂင်များသည် အေးဂျင့်လုပ်ဆောင်ချိန်အတွင်း LLM သို့ ထုတ်ဖော်ပေးသည့် **အေးဂျင့်ကိရိယာများ** (JSON‑schema functions) ကို မှတ်ပုံတင်နိုင်သည်။ ကိရိယာများကို **required** (အမြဲရရှိနိုင်) သို့မဟုတ် **optional** (opt‑in) အဖြစ် သတ်မှတ်နိုင်သည်။

အေးဂျင့်ကိရိယာများကို အဓိက config အောက်ရှိ `tools` တွင် သို့မဟုတ် အေးဂျင့်တစ်ခုချင်းစီအလိုက် `agents.list[].tools` အောက်တွင် ဖွဲ့စည်းပြင်ဆင်နိုင်သည်။ allowlist/denylist မူဝါဒသည် အေးဂျင့်က ခေါ်ယူနိုင်သော ကိရိယာများကို ထိန်းချုပ်သည်။

## အခြေခံ ကိရိယာ

```ts
import { Type } from "@sinclair/typebox";

export default function (api) {
  api.registerTool({
    name: "my_tool",
    description: "Do a thing",
    parameters: Type.Object({
      input: Type.String(),
    }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: params.input }] };
    },
  });
}
```

## Optional ကိရိယာ (opt‑in)

Optional ကိရိယာများကို အလိုအလျောက် **ဘယ်တော့မှ** မဖွင့်ပေးပါ။ အသုံးပြုသူများသည် အေးဂျင့် allowlist ထဲသို့ ထည့်သွင်းရပါမည်။

```ts
export default function (api) {
  api.registerTool(
    {
      name: "workflow_tool",
      description: "Run a local workflow",
      parameters: {
        type: "object",
        properties: {
          pipeline: { type: "string" },
        },
        required: ["pipeline"],
      },
      async execute(_id, params) {
        return { content: [{ type: "text", text: params.pipeline }] };
      },
    },
    { optional: true },
  );
}
```

`agents.list[].tools.allow` (သို့မဟုတ် အထွေထွေ `tools.allow`) တွင် optional ကိရိယာများကို ဖွင့်ပါ—

```json5
{
  agents: {
    list: [
      {
        id: "main",
        tools: {
          allow: [
            "workflow_tool", // specific tool name
            "workflow", // plugin id (enables all tools from that plugin)
            "group:plugins", // all plugin tools
          ],
        },
      },
    ],
  },
}
```

ကိရိယာရရှိနိုင်မှုကို သက်ရောက်စေသော အခြား config ခလုတ်များ—

- ပလဂင်ကိရိယာများကိုသာ အမည်ဖော်ပြထားသော allowlists များကို ပလဂင် opt‑ins အဖြစ် သတ်မှတ်သည်; allowlist ထဲတွင် core ကိရိယာများ သို့မဟုတ် အုပ်စုများကိုလည်း မပါဝင်စေသရွေ့ core ကိရိယာများသည် ဆက်လက် ဖွင့်ထားမည်ဖြစ်သည်။
- `tools.profile` / `agents.list[].tools.profile` (အခြေခံ allowlist)
- `tools.byProvider` / `agents.list[].tools.byProvider` (provider အလိုက် allow/deny)
- `tools.sandbox.tools.*` (sandboxed ဖြစ်သောအခါ sandbox ကိရိယာ မူဝါဒ)

## စည်းကမ်းများ + အကြံပြုချက်များ

- ကိရိယာအမည်များသည် core ကိရိယာအမည်များနှင့် **မတူညီရ** ပါ; မတူညီမှုမရှိပါက ထိခိုက်နေသော ကိရိယာများကို ကျော်လွှားထားမည်ဖြစ်သည်။
- allowlists တွင် အသုံးပြုသော ပလဂင် id များသည် core ကိရိယာအမည်များနှင့် မတူညီရပါ။
- ဘေးထွက်သက်ရောက်မှုများ ဖြစ်ပေါ်စေသည့် သို့မဟုတ် အပို binaries/credentials လိုအပ်သည့် ကိရိယာများအတွက် `optional: true` ကို ဦးစားပေး အသုံးပြုပါ။
