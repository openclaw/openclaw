---
summary: "OAuth في OpenClaw: تبادل الرموز، التخزين، وأنماط تعدد الحسابات"
read_when:
  - تريد فهم OAuth في OpenClaw من البداية إلى النهاية
  - واجهت مشكلات إبطال الرموز أو تسجيل الخروج
  - تريد تدفقات setup-token أو مصادقة OAuth
  - تريد استخدام حسابات متعددة أو توجيه الملفات الشخصية
title: "OAuth"
---

# OAuth

يدعم OpenClaw «مصادقة الاشتراك» عبر OAuth للموفّرين الذين يقدّمونها (ولا سيما **OpenAI Codex (ChatGPT OAuth)**). لاشتراكات Anthropic، استخدم تدفّق **setup-token**. تشرح هذه الصفحة:

- كيف يعمل **تبادل الرموز** في OAuth (PKCE)
- أين يتم **تخزين** الرموز (ولماذا)
- كيفية التعامل مع **حسابات متعددة** (الملفات الشخصية + التجاوزات لكل جلسة)

يدعم OpenClaw أيضًا **إضافات الموفّر** التي تأتي بتدفّقات OAuth أو مفاتيح API خاصة بها. شغّلها عبر:

```bash
openclaw models auth login --provider <id>
```

## بنك الرمز المميز (لماذا يوجد)

غالبًا ما تقوم موفّرات OAuth بإصدار **رمز تحديث جديد** أثناء تدفّقات تسجيل الدخول/التحديث. بعض الموفّرين (أو عملاء OAuth) قد يُبطلون رموز التحديث الأقدم عند إصدار رمز جديد للمستخدم/التطبيق نفسه.

الأعراض العملية:

- تسجّل الدخول عبر OpenClaw _وأيضًا_ عبر Claude Code / Codex CLI → في وقت لاحق يتم «تسجيل الخروج» عشوائيًا من أحدهما

لتقليل ذلك، يتعامل OpenClaw مع `auth-profiles.json` بوصفه **مصرفًا للرموز**:

- يقرأ وقت التشغيل بيانات الاعتماد من **مكان واحد**
- يمكننا الاحتفاظ بملفات شخصية متعددة وتوجيهها بشكل حتمي

## التخزين (أين تعيش الرموز)

تُخزَّن الأسرار **لكل وكيل**:

- ملفات المصادقة (OAuth + مفاتيح API): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- ذاكرة التخزين المؤقت لوقت التشغيل (تُدار تلقائيًا؛ لا تُعدّلها): `~/.openclaw/agents/<agentId>/agent/auth.json`

ملف قديم للاستيراد فقط (ما يزال مدعومًا، لكنه ليس المخزن الرئيسي):

- `~/.openclaw/credentials/oauth.json` (يُستورد إلى `auth-profiles.json` عند أول استخدام)

كل ما سبق يحترم أيضًا `$OPENCLAW_STATE_DIR` (تجاوز دليل الحالة). المرجع الكامل: [/gateway/configuration](/gateway/configuration#auth-storage-oauth--api-keys)

## Anthropic setup-token (مصادقة الاشتراك)

شغّل `claude setup-token` على أي جهاز، ثم الصقه في OpenClaw:

```bash
openclaw models auth setup-token --provider anthropic
```

إذا أنشأت الرمز في مكان آخر، الصقه يدويًا:

```bash
openclaw models auth paste-token --provider anthropic
```

تحقّق:

```bash
openclaw models status
```

## تبادل OAuth (كيف يعمل تسجيل الدخول)

تُنفَّذ تدفّقات تسجيل الدخول التفاعلية في OpenClaw ضمن `@mariozechner/pi-ai` ومتصلة بالمعالجات/الأوامر.

### Anthropic (Claude Pro/Max) setup-token

شكل التدفّق:

1. شغّل `claude setup-token`
2. الصق الرمز في OpenClaw
3. خزّنه كملف مصادقة بالرمز (من دون تحديث)

مسار المعالج هو `openclaw onboard` → خيار المصادقة `setup-token` (Anthropic).

### OpenAI Codex (ChatGPT OAuth)

شكل التدفّق (PKCE):

1. توليد مُحقِّق/تحدّي PKCE + `state` عشوائي
2. فتح `https://auth.openai.com/oauth/authorize?...`
3. محاولة التقاط الاستدعاء الراجع على `http://127.0.0.1:1455/auth/callback`
4. إذا تعذّر ربط الاستدعاء الراجع (أو كنت بعيدًا/من دون واجهة)، الصق عنوان URL/الرمز المُعاد توجيهه
5. التبادل عند `https://auth.openai.com/oauth/token`
6. استخراج `accountId` من رمز الوصول وتخزين `{ access, refresh, expires, accountId }`

مسار المعالج هو `openclaw onboard` → خيار المصادقة `openai-codex`.

## التحديث + الانتهاء

تخزّن الملفات الشخصية طابعًا زمنيًا لـ `expires`.

أثناء التشغيل:

- إذا كان `expires` في المستقبل → استخدم رمز الوصول المخزّن
- إذا انتهت الصلاحية → حدّث (تحت قفل ملف) واستبدل بيانات الاعتماد المخزّنة

تدفّق التحديث تلقائي؛ عادةً لا تحتاج إلى إدارة الرموز يدويًا.

## حسابات متعددة (ملفات شخصية) + التوجيه

نمطـان:

### 1. المفضّل: وكلاء منفصلون

إذا أردت ألا يتفاعل «الشخصي» و«العمل» إطلاقًا، استخدم وكلاء معزولين (جلسات + بيانات اعتماد + مساحة عمل منفصلة):

```bash
openclaw agents add work
openclaw agents add personal
```

ثم هيّئ المصادقة لكل وكيل (المعالج) ووجّه الدردشات إلى الوكيل المناسب.

### 2. متقدّم: ملفات شخصية متعددة داخل وكيل واحد

يدعم `auth-profiles.json` معرّفات ملفات شخصية متعددة للموفّر نفسه.

اختر أي ملف شخصي يُستخدم:

- عالميًا عبر ترتيب التهيئة (`auth.order`)
- لكل جلسة عبر `/model ...@<profileId>`

مثال (تجاوز الجلسة):

- `/model Opus@anthropic:work`

كيفية معرفة معرّفات الملفات الشخصية الموجودة:

- `openclaw channels list --json` (يعرض `auth[]`)

مستندات ذات صلة:

- [/concepts/model-failover](/concepts/model-failover) (قواعد التناوب + فترات التهدئة)
- [/tools/slash-commands](/tools/slash-commands) (سطح الأوامر)
