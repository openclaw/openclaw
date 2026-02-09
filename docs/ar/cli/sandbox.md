---
title: رملد CLI
summary: "إدارة حاويات sandbox وفحص سياسة sandbox الفعلية"
read_when: "عندما تكون تدير حاويات sandbox أو تقوم بتصحيح سلوك sandbox/سياسة الأدوات."
status: active
---

# رملد CLI

إدارة حاويات sandbox المعتمدة على Docker لتنفيذ الوكلاء بشكل معزول.

## نظرة عامة

يمكن لـ OpenClaw تشغيل الوكلاء داخل حاويات Docker معزولة لأغراض الأمان. تساعدك أوامر `sandbox` على إدارة هذه الحاويات، خصوصًا بعد التحديثات أو تغييرات التهيئة.

## الأوامر

### `openclaw sandbox explain`

فحص وضع/نطاق/وصول مساحة العمل الفعلي لـ sandbox، وسياسة أدوات sandbox، والبوابات ذات الامتيازات المرتفعة (مع مسارات مفاتيح التهيئة للإصلاح).

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

### `openclaw sandbox list`

سرد جميع حاويات sandbox مع حالتها وتهيئتها.

```bash
openclaw sandbox list
openclaw sandbox list --browser  # List only browser containers
openclaw sandbox list --json     # JSON output
```

**يتضمن الإخراج:**

- اسم الحاوية والحالة (قيد التشغيل/متوقفة)
- صورة Docker وما إذا كانت تطابق التهيئة
- العمر (الوقت منذ الإنشاء)
- وقت الخمول (الوقت منذ آخر استخدام)
- الجلسة/الوكيل المرتبط

### `openclaw sandbox recreate`

إزالة حاويات sandbox لفرض إعادة إنشائها باستخدام الصور/التهيئة المُحدَّثة.

```bash
openclaw sandbox recreate --all                # Recreate all containers
openclaw sandbox recreate --session main       # Specific session
openclaw sandbox recreate --agent mybot        # Specific agent
openclaw sandbox recreate --browser            # Only browser containers
openclaw sandbox recreate --all --force        # Skip confirmation
```

**الخيارات:**

- `--all`: إعادة إنشاء جميع حاويات sandbox
- `--session <key>`: إعادة إنشاء الحاوية لجلسة محددة
- `--agent <id>`: إعادة إنشاء الحاويات لوكيل محدد
- `--browser`: إعادة إنشاء حاويات المتصفح فقط
- `--force`: تخطي مطالبة التأكيد

**مهم:** تُعاد إنشاء الحاويات تلقائيًا عند استخدام الوكيل في المرة التالية.

## حالات الاستخدام

### بعد تحديث صور Docker

```bash
# Pull new image
docker pull openclaw-sandbox:latest
docker tag openclaw-sandbox:latest openclaw-sandbox:bookworm-slim

# Update config to use new image
# Edit config: agents.defaults.sandbox.docker.image (or agents.list[].sandbox.docker.image)

# Recreate containers
openclaw sandbox recreate --all
```

### بعد تغيير تهيئة sandbox

```bash
# Edit config: agents.defaults.sandbox.* (or agents.list[].sandbox.*)

# Recreate to apply new config
openclaw sandbox recreate --all
```

### بعد تغيير setupCommand

```bash
openclaw sandbox recreate --all
# or just one agent:
openclaw sandbox recreate --agent family
```

### لوكيل محدد فقط

```bash
# Update only one agent's containers
openclaw sandbox recreate --agent alfred
```

## لماذا نحتاج إلى ذلك؟

**المشكلة:** عند تحديث صور Docker الخاصة بـ sandbox أو التهيئة:

- تستمر الحاويات الحالية في العمل بإعدادات قديمة
- لا يتم تنظيف الحاويات إلا بعد 24 ساعة من عدم النشاط
- يستمر الوكلاء المستخدمون بانتظام في تشغيل حاويات قديمة إلى أجل غير مسمى

**الحل:** استخدم `openclaw sandbox recreate` لفرض إزالة الحاويات القديمة. ستُعاد إنشاؤها تلقائيًا بالإعدادات الحالية عند الحاجة التالية.

نصيحة: يُفضَّل `openclaw sandbox recreate` على `docker rm` اليدوي. فهو يستخدم تسمية الحاويات الخاصة بـ Gateway (البوابة) ويتجنب عدم التطابق عند تغيّر مفاتيح النطاق/الجلسة.

## التهيئة

توجد إعدادات sandbox في `~/.openclaw/openclaw.json` ضمن `agents.defaults.sandbox` (وتوضع التجاوزات لكل وكيل في `agents.list[].sandbox`):

```jsonc
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all", // off, non-main, all
        "scope": "agent", // session, agent, shared
        "docker": {
          "image": "openclaw-sandbox:bookworm-slim",
          "containerPrefix": "openclaw-sbx-",
          // ... more Docker options
        },
        "prune": {
          "idleHours": 24, // Auto-prune after 24h idle
          "maxAgeDays": 7, // Auto-prune after 7 days
        },
      },
    },
  },
}
```

## انظر أيضًا

- [توثيق Sandbox](/gateway/sandboxing)
- [تهيئة الوكيل](/concepts/agent-workspace)
- [أمر Doctor](/gateway/doctor) - التحقق من إعداد sandbox
