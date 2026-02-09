---
summary: "كتابة أدوات الوكيل في إضافة (المخططات، الأدوات الاختيارية، قوائم السماح)"
read_when:
  - تريد إضافة أداة وكيل جديدة في إضافة
  - تحتاج إلى جعل أداة ما اختيارية عبر قوائم السماح
title: "أدوات وكيل الإضافات"
---

# أدوات وكيل الإضافات

يمكن لإضافات OpenClaw تسجيل **أدوات وكيل** (دوال بمخطط JSON) تُعرَض على نموذج اللغة الكبير أثناء تشغيل الوكيل. يمكن أن تكون الأدوات **مطلوبة** (متاحة دائمًا) أو **اختيارية** (تتطلب الاشتراك).

تُهيَّأ أدوات الوكيل ضمن `tools` في التهيئة الرئيسية، أو لكل وكيل ضمن
`agents.list[].tools`. تتحكم سياسة قائمة السماح/قائمة المنع في الأدوات التي يمكن للوكيل
استدعاؤها.

## أداة أساسية

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

## أداة اختيارية (الاشتراك)

الأدوات الاختيارية **لا** تُفعَّل تلقائيًا أبدًا. يجب على المستخدمين إضافتها إلى قائمة
السماح الخاصة بالوكيل.

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

فعِّل الأدوات الاختيارية في `agents.list[].tools.allow` (أو العمومي `tools.allow`):

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

مقابض تهيئة أخرى تؤثر في توفر الأدوات:

- قوائم السماح التي تُسمّي أدوات الإضافات فقط تُعامَل كاشتراك في الإضافات؛ وتبقى الأدوات الأساسية مفعَّلة
  ما لم تُدرِج الأدوات الأساسية أو المجموعات أيضًا في قائمة السماح.
- `tools.profile` / `agents.list[].tools.profile` (قائمة السماح الأساسية)
- `tools.byProvider` / `agents.list[].tools.byProvider` (السماح/المنع الخاص بالمزوّد)
- `tools.sandbox.tools.*` (سياسة أدوات sandbox عند العمل داخل sandbox)

## القواعد + النصائح

- يجب **ألا** تتعارض أسماء الأدوات مع أسماء الأدوات الأساسية؛ تُتخطّى الأدوات المتعارضة.
- يجب ألا تتعارض معرّفات الإضافات المستخدمة في قوائم السماح مع أسماء الأدوات الأساسية.
- يُفضَّل `optional: true` للأدوات التي تُحدِث آثارًا جانبية أو تتطلب
  ملفات تنفيذية/اعتمادات إضافية.
