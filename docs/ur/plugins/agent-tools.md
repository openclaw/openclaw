---
summary: "ایک پلگ اِن میں ایجنٹ ٹولز لکھیں (اسکیماز، اختیاری ٹولز، اجازت فہرستیں)"
read_when:
  - آپ کسی پلگ اِن میں نیا ایجنٹ ٹول شامل کرنا چاہتے ہیں
  - آپ کو کسی ٹول کو اجازت فہرستوں کے ذریعے اختیاری (opt‑in) بنانا ہے
title: "پلگ اِن ایجنٹ ٹولز"
---

# پلگ اِن ایجنٹ ٹولز

OpenClaw plugins can register **agent tools** (JSON‑schema functions) that are exposed
to the LLM during agent runs. Tools can be **required** (always available) or
**optional** (opt‑in).

Agent tools are configured under `tools` in the main config, or per‑agent under
`agents.list[].tools`. The allowlist/denylist policy controls which tools the agent
can call.

## بنیادی ٹول

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

## اختیاری ٹول (opt‑in)

Optional tools are **never** auto‑enabled. Users must add them to an agent
allowlist.

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

`agents.list[].tools.allow` میں اختیاری ٹولز فعال کریں (یا عالمی `tools.allow`):

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

ٹول کی دستیابی کو متاثر کرنے والی دیگر کنفیگ سیٹنگز:

- وہ اجازت فہرستیں جن میں صرف پلگ اِن ٹولز کے نام ہوں، پلگ اِن opt‑ins سمجھی جاتی ہیں؛ بنیادی ٹولز
  تب تک فعال رہتے ہیں جب تک آپ اجازت فہرست میں بنیادی ٹولز یا گروپس بھی شامل نہ کریں۔
- `tools.profile` / `agents.list[].tools.profile` (بنیادی اجازت فہرست)
- `tools.byProvider` / `agents.list[].tools.byProvider` (فراہم کنندہ مخصوص اجازت/انکار)
- `tools.sandbox.tools.*` (sandbox میں ہونے پر sandbox ٹول پالیسی)

## قواعد + نکات

- ٹول کے نام بنیادی ٹول ناموں سے **متصادم نہیں** ہونے چاہئیں؛ متصادم ٹولز کو نظرانداز کر دیا جاتا ہے۔
- اجازت فہرستوں میں استعمال ہونے والی پلگ اِن آئی ڈیز بنیادی ٹول ناموں سے متصادم نہیں ہونی چاہئیں۔
- اُن ٹولز کے لیے `optional: true` کو ترجیح دیں جو ضمنی اثرات پیدا کریں یا اضافی
  بائنریز/اسناد درکار ہوں۔
