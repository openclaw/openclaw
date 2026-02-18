---
summary: "ပလဂင်တစ်ခုအတွင်း အေးဂျင့်ကိရိယာများကို ရေးသားခြင်း (schemas၊ optional tools၊ allowlists)"
read_when:
  - ပလဂင်တစ်ခုအတွင်း အေးဂျင့်ကိရိယာအသစ် ထည့်သွင်းလိုသောအခါ
  - ကိရိယာတစ်ခုကို allowlists ဖြင့် opt‑in ဖြစ်အောင် ပြုလုပ်ရန် လိုအပ်သောအခါ
title: "ပလဂင် အေးဂျင့်ကိရိယာများ"
---

# ပလဂင် အေးဂျင့်ကိရိယာများ

OpenClaw plugins များသည် agent runs အတွင်း LLM သို့ ထုတ်ဖော်ပြသသော **agent tools** (JSON‑schema functions) များကို register လုပ်နိုင်ပါသည်။ Tools များကို **required** (အမြဲတမ်း အသုံးပြုနိုင်သည်) သို့မဟုတ် **optional** (opt‑in) အဖြစ် သတ်မှတ်နိုင်ပါသည်။

Agent tools များကို main config အောက်ရှိ `tools` တွင် သို့မဟုတ် agent တစ်ခုချင်းစီအတွက် `agents.list[].tools` အောက်တွင် သတ်မှတ်နိုင်ပါသည်။ allowlist/denylist policy သည် agent မှ ခေါ်နိုင်သော tools များကို ထိန်းချုပ်ပါသည်။

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

Optional tools များကို **အလိုအလျောက်** enable မလုပ်ပါ။ အသုံးပြုသူများသည် agent allowlist ထဲသို့ ကိုယ်တိုင် ထည့်သွင်းရပါမည်။

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
