---
summary: "مصادقة النماذج: OAuth، مفاتيح API، وsetup-token"
read_when:
  - استكشاف أخطاء مصادقة النماذج أو انتهاء صلاحية OAuth
  - توثيق المصادقة أو تخزين بيانات الاعتماد
title: "المصادقة"
---

# المصادقة

يدعم OpenClaw كلاً من OAuth ومفاتيح API لموفّري النماذج. لحسابات Anthropic،
نوصي باستخدام **مفتاح API**. للوصول عبر اشتراك Claude،
استخدم الرمز طويل الأمد الذي تم إنشاؤه بواسطة `claude setup-token`.

راجع [/concepts/oauth](/concepts/oauth) للاطلاع على تدفّق OAuth الكامل وتخطيط التخزين.

## إعداد Anthropic الموصى به (مفتاح API)

إذا كنت تستخدم Anthropic مباشرةً، فاستعمل مفتاح API.

1. أنشئ مفتاح API في وحدة تحكم Anthropic.
2. ضعه على **مضيف Gateway** (الجهاز الذي يشغّل `openclaw gateway`).

```bash
export ANTHROPIC_API_KEY="..."
openclaw models status
```

3. إذا كان Gateway يعمل تحت systemd/launchd، ففضّل وضع المفتاح في
   `~/.openclaw/.env` كي يتمكن الـ daemon من قراءته:

```bash
cat >> ~/.openclaw/.env <<'EOF'
ANTHROPIC_API_KEY=...
EOF
```

بعد ذلك أعد تشغيل الـ daemon (أو أعد تشغيل عملية Gateway لديك) ثم أعد التحقق:

```bash
openclaw models status
openclaw doctor
```

إذا كنت تفضّل عدم إدارة متغيرات البيئة بنفسك، يمكن لمعالج التهيئة الأولية تخزين
مفاتيح API لاستخدام الـ daemon: `openclaw onboard`.

راجع [Help](/help) لمزيد من التفاصيل حول وراثة متغيرات البيئة (`env.shellEnv`،
`~/.openclaw/.env`، systemd/launchd).

## Anthropic: setup-token (مصادقة الاشتراك)

بالنسبة إلى Anthropic، المسار الموصى به هو **مفتاح API**. إذا كنت تستخدم اشتراك
Claude، فمسار setup-token مدعوم أيضًا. شغّله على **مضيف Gateway**:

```bash
claude setup-token
```

ثم الصقه في OpenClaw:

```bash
openclaw models auth setup-token --provider anthropic
```

إذا تم إنشاء الرمز على جهاز آخر، فالصقه يدويًا:

```bash
openclaw models auth paste-token --provider anthropic
```

إذا ظهرت لك رسالة خطأ من Anthropic مثل:

```
This credential is only authorized for use with Claude Code and cannot be used for other API requests.
```

…فاستخدم مفتاح API لـ Anthropic بدلًا من ذلك.

إدخال الرمز يدويًا (أي موفّر؛ يكتب `auth-profiles.json` + يحدّث التهيئة):

```bash
openclaw models auth paste-token --provider anthropic
openclaw models auth paste-token --provider openrouter
```

تحقّق ملائم للأتمتة (ينهي التنفيذ بـ `1` عند الانتهاء/الغياب، و`2` عند قرب الانتهاء):

```bash
openclaw models status --check
```

تم توثيق سكربتات التشغيل الاختيارية (systemd/Termux) هنا:
[/automation/auth-monitoring](/automation/auth-monitoring)

> يتطلّب `claude setup-token` طرفية TTY تفاعلية.

## التحقق من حالة مصادقة النموذج

```bash
openclaw models status
openclaw doctor
```

## التحكّم في بيانات الاعتماد المستخدمة

### لكل جلسة (أمر الدردشة)

استخدم `/model <alias-or-id>@<profileId>` لتثبيت بيانات اعتماد موفّر محددة للجلسة الحالية
(أمثلة على معرّفات الملفات التعريفية: `anthropic:default`، `anthropic:work`).

استخدم `/model` (أو `/model list`) لاختيار مختصر؛ واستخدم `/model status`
للعرض الكامل (المرشّحون + ملف المصادقة التالي، مع تفاصيل نقطة نهاية الموفّر عند التهيئة).

### لكل وكيل (تجاوز عبر CLI)

عيّن تجاوز ترتيب ملف تعريف المصادقة بشكل صريح لوكيل معيّن
(يُخزَّن في `auth-profiles.json` الخاص بذلك الوكيل):

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

استخدم `--agent <id>` لاستهداف وكيل محدّد؛ أو احذفه لاستخدام الوكيل الافتراضي المُهيّأ.

## استكشاف الأخطاء وإصلاحها

### «لم يتم العثور على بيانات اعتماد»

إذا كان ملف تعريف رمز Anthropic مفقودًا، شغّل `claude setup-token` على
**مضيف Gateway**، ثم أعد التحقق:

```bash
openclaw models status
```

### انتهت صلاحية الرمز المميز

شغّل `openclaw models status` لتأكيد أي ملف تعريف على وشك الانتهاء. إذا كان ملف التعريف
مفقودًا، فأعد تشغيل `claude setup-token` وألصق الرمز مرة أخرى.

## المتطلبات

- اشتراك Claude Max أو Pro (لـ `claude setup-token`)
- تثبيت Claude Code CLI (توفر أمر `claude`)
