---
title: Sandbox مقابل سياسة الأدوات مقابل Elevated
summary: "لماذا يتم حظر أداة ما: وقت تشغيل sandbox، وسياسة السماح/المنع للأدوات، وبوابات تنفيذ Elevated"
read_when: "عندما تصطدم بـ «سجن sandbox» أو ترى رفضًا لأداة/‏Elevated وتريد مفتاح التهيئة الدقيق الذي يجب تغييره."
status: active
---

# Sandbox مقابل سياسة الأدوات مقابل Elevated

يمتلك OpenClaw ثلاثة عناصر تحكّم مترابطة (لكنها مختلفة):

1. **Sandbox** (`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`) يحدّد **أين تعمل الأدوات** (Docker مقابل المضيف).
2. **سياسة الأدوات** (`tools.*`, `tools.sandbox.tools.*`, `agents.list[].tools.*`) تحدّد **أي الأدوات متاحة/مسموح بها**.
3. **Elevated** (`tools.elevated.*`, `agents.list[].tools.elevated.*`) هو **مخرج تنفيذ فقط** للتشغيل على المضيف عندما تكون داخل sandbox.

## تصحيح سريع

استخدم أداة الفحص لمعرفة ما يفعله OpenClaw _فعليًا_:

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

ستطبع:

- وضع/نطاق sandbox الفعّال وإتاحة مساحة العمل
- ما إذا كانت الجلسة مُسَندبَكَة حاليًا (الرئيسية مقابل غير الرئيسية)
- السماح/المنع الفعّال لأدوات sandbox (وهل جاء من الوكيل/العالمي/الافتراضي)
- بوابات elevated ومسارات مفاتيح الإصلاح

## Sandbox: أين تعمل الأدوات

يتم التحكّم في sandboxing عبر `agents.defaults.sandbox.mode`:

- `"off"`: كل شيء يعمل على المضيف.
- `"non-main"`: تُسَندبَك فقط الجلسات غير الرئيسية (مفاجأة شائعة للمجموعات/القنوات).
- `"all"`: كل شيء داخل sandbox.

انظر [Sandboxing](/gateway/sandboxing) للمصفوفة الكاملة (النطاق، ربط مساحات العمل، الصور).

### Bind mounts (فحص أمني سريع)

- `docker.binds` «يخترق» نظام ملفات sandbox: كل ما تربطه يصبح مرئيًا داخل الحاوية مع الوضع الذي تحدّده (`:ro` أو `:rw`).
- الافتراضي قراءة-كتابة إذا حذفت الوضع؛ يُفضَّل `:ro` للمصدر/الأسرار.
- `scope: "shared"` يتجاهل الروابط الخاصة بكل وكيل (تُطبَّق الروابط العالمية فقط).
- ربط `/var/run/docker.sock` يسلّم فعليًا التحكم بالمضيف إلى sandbox؛ افعل ذلك عن قصد فقط.
- إتاحة مساحة العمل (`workspaceAccess: "ro"`/`"rw"`) مستقلة عن أوضاع الربط.

## سياسة الأدوات: أي الأدوات موجودة/قابلة للاستدعاء

توجد طبقتان مهمتان:

- **ملف تعريف الأداة**: `tools.profile` و `agents.list[].tools.profile` (قائمة السماح الأساسية)
- **ملف تعريف أدوات الموفّر**: `tools.byProvider[provider].profile` و `agents.list[].tools.byProvider[provider].profile`
- **سياسة الأدوات العالمية/لكل وكيل**: `tools.allow`/`tools.deny` و `agents.list[].tools.allow`/`agents.list[].tools.deny`
- **سياسة أدوات الموفّر**: `tools.byProvider[provider].allow/deny` و `agents.list[].tools.byProvider[provider].allow/deny`
- **سياسة أدوات sandbox** (تُطبَّق فقط عند التسنيد): `tools.sandbox.tools.allow`/`tools.sandbox.tools.deny` و `agents.list[].tools.sandbox.tools.*`

قواعد عامة:

- `deny` يفوز دائمًا.
- إذا كان `allow` غير فارغ، فكل ما عداه يُعد محظورًا.
- سياسة الأدوات هي نقطة الإيقاف الصارمة: لا يمكن لـ `/exec` تجاوز أداة `exec` الممنوعة.
- `/exec` يغيّر فقط افتراضات الجلسة للمرسلين المخوّلين؛ ولا يمنح وصولًا للأدوات.
  مفاتيح أدوات الموفّر تقبل إمّا `provider` (مثل `google-antigravity`) أو `provider/model` (مثل `openai/gpt-5.2`).

### مجموعات الأدوات (اختصارات)

تدعم سياسات الأدوات (العالمية، الوكيل، sandbox) إدخالات `group:*` التي تتوسّع إلى عدة أدوات:

```json5
{
  tools: {
    sandbox: {
      tools: {
        allow: ["group:runtime", "group:fs", "group:sessions", "group:memory"],
      },
    },
  },
}
```

المجموعات المتاحة:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: جميع أدوات OpenClaw المضمّنة (يستثني إضافات الموفّرين)

## Elevated: تنفيذ فقط «التشغيل على المضيف»

لا يمنح Elevated أدوات إضافية؛ بل يؤثّر فقط على `exec`.

- إذا كنت داخل sandbox، فإن `/elevated on` (أو `exec` مع `elevated: true`) يعمل على المضيف (وقد تظل الموافقات مطلوبة).
- استخدم `/elevated full` لتجاوز موافقات التنفيذ للجلسة.
- إذا كنت تعمل مباشرة بالفعل، فـ Elevated عمليًا بلا أثر (ولا يزال مُقيّدًا).
- Elevated **غير** محصور بنطاق Skill ولا **يتجاوز** السماح/المنع للأدوات.
- `/exec` منفصل عن Elevated. يضبط فقط افتراضات التنفيذ لكل جلسة للمرسلين المخوّلين.

البوابات:

- التمكين: `tools.elevated.enabled` (واختياريًا `agents.list[].tools.elevated.enabled`)
- قوائم سماح المرسلين: `tools.elevated.allowFrom.<provider>` (واختياريًا `agents.list[].tools.elevated.allowFrom.<provider>`)

انظر [Elevated Mode](/tools/elevated).

## إصلاحات شائعة لـ «سجن sandbox»

### «تم حظر الأداة X بواسطة سياسة أدوات sandbox»

مفاتيح الإصلاح (اختر واحدًا):

- تعطيل sandbox: `agents.defaults.sandbox.mode=off` (أو لكل وكيل `agents.list[].sandbox.mode=off`)
- السماح بالأداة داخل sandbox:
  - إزالتها من `tools.sandbox.tools.deny` (أو لكل وكيل `agents.list[].tools.sandbox.tools.deny`)
  - أو إضافتها إلى `tools.sandbox.tools.allow` (أو السماح لكل وكيل)

### «ظننت أن هذه جلسة رئيسية، لماذا هي داخل sandbox؟»

في وضع `"non-main"`، مفاتيح المجموعات/القنوات ليست رئيسية. استخدم مفتاح الجلسة الرئيسية (المعروض بواسطة `sandbox explain`) أو بدّل الوضع إلى `"off"`.
