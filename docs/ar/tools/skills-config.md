---
summary: "مخطط تهيئة Skills وأمثلة"
read_when:
  - إضافة أو تعديل تهيئة Skills
  - ضبط قائمة السماح المضمّنة أو سلوك التثبيت
title: "تهيئة Skills"
---

# تهيئة Skills

توجد جميع التهيئات المتعلقة بـ Skills ضمن `skills` في `~/.openclaw/openclaw.json`.

```json5
{
  skills: {
    allowBundled: ["gemini", "peekaboo"],
    load: {
      extraDirs: ["~/Projects/agent-scripts/skills", "~/Projects/oss/some-skill-pack/skills"],
      watch: true,
      watchDebounceMs: 250,
    },
    install: {
      preferBrew: true,
      nodeManager: "npm", // npm | pnpm | yarn | bun (Gateway runtime still Node; bun not recommended)
    },
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

## الحقول

- `allowBundled`: قائمة سماح اختيارية للـ Skills **المضمّنة** فقط. عند تعيينها، تكون
  Skills المضمّنة الموجودة في القائمة فقط مؤهلة (ولا تتأثر Skills المُدارة/الخاصة بمساحة العمل).
- `load.extraDirs`: أدلة Skills إضافية للمسح (أدنى أولوية).
- `load.watch`: مراقبة مجلدات Skills وتحديث لقطة Skills (الافتراضي: true).
- `load.watchDebounceMs`: إزالة الارتداد لأحداث مراقب Skills بالمللي ثانية (الافتراضي: 250).
- `install.preferBrew`: تفضيل مثبّتات brew عند توفرها (الافتراضي: true).
- `install.nodeManager`: تفضيل مثبّت Node (`npm` | `pnpm` | `yarn` | `bun`، الافتراضي: npm).
  يؤثر هذا على **تثبيت Skills** فقط؛ يجب أن يظل وقت تشغيل Gateway هو Node
  (لا يُنصح باستخدام Bun مع WhatsApp/Telegram).
- `entries.<skillKey>`: تجاوزات لكل Skill.

الحقول الخاصة بكل Skill:

- `enabled`: عيّن `false` لتعطيل Skill حتى لو كانت مضمّنة/مثبّتة.
- `env`: متغيرات البيئة التي تُحقن أثناء تشغيل الوكيل (فقط إذا لم تكن مضبوطة بالفعل).
- `apiKey`: خيار تسهيلي اختياري للـ Skills التي تعلن عن متغير بيئة أساسي.

## ملاحظات

- المفاتيح تحت `entries` تُطابق اسم Skill افتراضيًا. إذا عرّفت Skill
  `metadata.openclaw.skillKey`، فاستخدم ذلك المفتاح بدلًا منه.
- تُلتقط التغييرات على Skills في دورة الوكيل التالية عندما تكون المراقبة مفعّلة.

### Skills داخل sandbox + متغيرات البيئة

عندما تكون الجلسة **sandboxed**، تعمل عمليات Skills داخل Docker. لا يرث sandbox
متغيرات `process.env` من المضيف.

استخدم أحد الخيارين:

- `agents.defaults.sandbox.docker.env` (أو `agents.list[].sandbox.docker.env` لكل وكيل)
- تضمين متغيرات البيئة داخل صورة sandbox مخصّصة لديك

تُطبَّق `env` و`skills.entries.<skill>.env/apiKey` العامة على عمليات **المضيف** فقط.
