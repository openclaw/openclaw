---
summary: "كيفية عمل sandboxing في OpenClaw: الأوضاع، والنطاقات، والوصول إلى مساحة العمل، والصور"
title: Sandboxing
read_when: "عندما تحتاج إلى شرح مخصص لـ sandboxing أو ترغب في ضبط agents.defaults.sandbox."
status: active
---

# Sandboxing

يمكن لـ OpenClaw تشغيل **الأدوات داخل حاويات Docker** لتقليل نطاق التأثير.
هذا **اختياري** ويتم التحكم فيه عبر التهيئة (`agents.defaults.sandbox` أو
`agents.list[].sandbox`). إذا كان sandboxing معطّلًا، تعمل الأدوات على المضيف.
يبقى Gateway على المضيف؛ بينما يتم تنفيذ الأدوات داخل sandbox معزول
عند تمكينه.

هذا ليس حدًا أمنيًا مثاليًا، لكنه يحدّ بشكل ملموس من الوصول إلى نظام الملفات
والعمليات عندما يرتكب النموذج تصرّفًا غير ذكي.

## ما الذي يتم وضعه داخل sandbox

- تنفيذ الأدوات (`exec`، `read`، `write`، `edit`، `apply_patch`، `process`، إلخ).
- متصفح معزول اختياري (`agents.defaults.sandbox.browser`).
  - افتراضيًا، يبدأ متصفح sandbox تلقائيًا (لضمان إمكانية الوصول إلى CDP) عندما تحتاجه أداة المتصفح.
    تتم التهيئة عبر `agents.defaults.sandbox.browser.autoStart` و `agents.defaults.sandbox.browser.autoStartTimeoutMs`.
  - يتيح `agents.defaults.sandbox.browser.allowHostControl` للجلسات المعزولة استهداف متصفح المضيف صراحةً.
  - قوائم السماح الاختيارية تضبط `target: "custom"`: `allowedControlUrls`، `allowedControlHosts`، `allowedControlPorts`.

ليس صندوق رمل:

- عملية Gateway نفسها.
- أي أداة يُسمح لها صراحةً بالتشغيل على المضيف (مثل `tools.elevated`).
  - **التنفيذ بصلاحيات مرتفعة يعمل على المضيف ويتجاوز sandboxing.**
  - إذا كان sandboxing معطّلًا، فإن `tools.elevated` لا يغيّر التنفيذ (هو أصلًا على المضيف). راجع [Elevated Mode](/tools/elevated).

## أوضاع

يتحكم `agents.defaults.sandbox.mode` في **متى** يتم استخدام sandboxing:

- `"off"`: بدون sandboxing.
- `"non-main"`: عزل جلسات **غير الرئيسية** فقط (الافتراضي إذا أردت محادثات عادية على المضيف).
- `"all"`: كل جلسة تعمل داخل sandbox.
  ملاحظة: يعتمد `"non-main"` على `session.mainKey` (الافتراضي `"main"`) وليس على معرّف الوكيل.
  جلسات المجموعات/القنوات تستخدم مفاتيحها الخاصة، لذا تُعد غير رئيسية وسيتم عزلها.

## النطاق

يتحكم `agents.defaults.sandbox.scope` في **عدد الحاويات** التي يتم إنشاؤها:

- `"session"` (افتراضي): حاوية واحدة لكل جلسة.
- `"agent"`: حاوية واحدة لكل وكيل.
- `"shared"`: حاوية واحدة مشتركة بين جميع الجلسات المعزولة.

## الوصول إلى مساحة العمل

يتحكم `agents.defaults.sandbox.workspaceAccess` في **ما الذي يمكن لـ sandbox رؤيته**:

- `"none"` (افتراضي): ترى الأدوات مساحة عمل sandbox تحت `~/.openclaw/sandboxes`.
- `"ro"`: يركّب مساحة عمل الوكيل للقراءة فقط عند `/agent` (يعطّل `write`/`edit`/`apply_patch`).
- `"rw"`: يركّب مساحة عمل الوكيل للقراءة/الكتابة عند `/workspace`.

يتم نسخ الوسائط الواردة إلى مساحة عمل sandbox النشطة (`media/inbound/*`).
ملاحظة Skills: أداة `read` تكون جذورها داخل sandbox. مع `workspaceAccess: "none"`،
يعكس OpenClaw مهارات مؤهلة إلى مساحة عمل sandbox (`.../skills`) بحيث
يمكن قراءتها. ومع `"rw"`، تكون مهارات مساحة العمل قابلة للقراءة من
`/workspace/skills`.

## ربط مخصص (bind mounts)

يقوم `agents.defaults.sandbox.docker.binds` بتركيب أدلة إضافية من المضيف داخل الحاوية.
الصيغة: `host:container:mode` (مثلًا، `"/home/user/source:/source:rw"`).

يتم **دمج** الروابط العامة وروابط كل وكيل (ولا يتم استبدالها). ضمن `scope: "shared"`، يتم تجاهل روابط كل وكيل.

مثال (مصدر للقراءة فقط + مقبس Docker):

```json5
{
  agents: {
    defaults: {
      sandbox: {
        docker: {
          binds: ["/home/user/source:/source:ro", "/var/run/docker.sock:/var/run/docker.sock"],
        },
      },
    },
    list: [
      {
        id: "build",
        sandbox: {
          docker: {
            binds: ["/mnt/cache:/cache:rw"],
          },
        },
      },
    ],
  },
}
```

ملاحظات أمنية:

- تتجاوز الروابط نظام ملفات sandbox: فهي تكشف مسارات المضيف وفق الوضع الذي تحدده (`:ro` أو `:rw`).
- ينبغي أن تكون التركيبات الحساسة (مثل `docker.sock`، والأسرار، ومفاتيح SSH) `:ro` ما لم تكن مطلوبة على الإطلاق.
- اجمع ذلك مع `workspaceAccess: "ro"` إذا كنت تحتاج فقط إلى وصول للقراءة إلى مساحة العمل؛ تبقى أوضاع الروابط مستقلة.
- راجع [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) لمعرفة كيفية تفاعل الروابط مع سياسة الأدوات والتنفيذ بصلاحيات مرتفعة.

## الصور + الإعداد

الصورة الافتراضية: `openclaw-sandbox:bookworm-slim`

قم ببنائها مرة واحدة:

```bash
scripts/sandbox-setup.sh
```

ملاحظة: لا تتضمن الصورة الافتراضية **Node**. إذا احتاجت مهارة إلى Node (أو
بيئات تشغيل أخرى)، فإما أن تبني صورة مخصصة أو تثبّت عبر
`sandbox.docker.setupCommand` (يتطلب خروج شبكة + جذر قابل للكتابة +
مستخدم root).

صورة متصفح sandbox:

```bash
scripts/sandbox-browser-setup.sh
```

افتراضيًا، تعمل حاويات sandbox **بدون شبكة**.
يمكن تجاوز ذلك عبر `agents.defaults.sandbox.docker.network`.

تثبيتات Docker والـ Gateway المُحَوْسَب موجودة هنا:
[Docker](/install/docker)

## setupCommand (إعداد الحاوية لمرة واحدة)

يشغّل `setupCommand` **مرة واحدة** بعد إنشاء حاوية sandbox (وليس في كل تشغيل).
يُنفَّذ داخل الحاوية عبر `sh -lc`.

المسارات:

- عام: `agents.defaults.sandbox.docker.setupCommand`
- لكل وكيل: `agents.list[].sandbox.docker.setupCommand`

مزالق شائعة:

- القيمة الافتراضية لـ `docker.network` هي `"none"` (بدون خروج)، لذا ستفشل تثبيتات الحزم.
- يمنع `readOnlyRoot: true` الكتابة؛ عيّن `readOnlyRoot: false` أو ابنِ صورة مخصصة.
- يجب أن يكون `user` هو root لتثبيت الحزم (احذف `user` أو عيّن `user: "0:0"`).
- تنفيذ sandbox لا يرث `process.env` من المضيف. استخدم
  `agents.defaults.sandbox.docker.env` (أو صورة مخصصة) لمفاتيح واجهات برمجة التطبيقات الخاصة بالمهارات.

## سياسة الأدوات + مخارج الهروب

تُطبَّق سياسات السماح/المنع للأدوات قبل قواعد sandbox. إذا كانت أداة ممنوعة
عالميًا أو لكل وكيل، فلن يعيدها sandboxing.

`tools.elevated` هو مخرج هروب صريح يشغّل `exec` على المضيف.
تُطبَّق توجيهات `/exec` فقط للمرسلين المخوّلين وتستمر لكل جلسة؛ لتعطيل
`exec` بشكل صارم، استخدم منع سياسة الأدوات (راجع [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)).

التنقيح:

- استخدم `openclaw sandbox explain` لفحص وضع sandbox الفعّال، وسياسة الأدوات، ومفاتيح تهيئة الإصلاح.
- راجع [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) لنموذج التفكير «لماذا تم الحظر؟».
  احرص على إبقائه مقفلًا.

## تجاوزات متعددة الوكلاء

يمكن لكل وكيل تجاوز sandbox + الأدوات:
`agents.list[].sandbox` و `agents.list[].tools` (بالإضافة إلى `agents.list[].tools.sandbox.tools` لسياسة أدوات sandbox).
راجع [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) لمعرفة الأولوية.

## مثال تمكين حدّي

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
      },
    },
  },
}
```

## مستندات ذات صلة

- [Sandbox Configuration](/gateway/configuration#agentsdefaults-sandbox)
- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)
- [Security](/gateway/security)
