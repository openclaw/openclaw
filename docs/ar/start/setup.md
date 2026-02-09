---
summary: "إعدادات متقدمة وسير عمل التطوير لـ OpenClaw"
read_when:
  - إعداد جهاز جديد
  - تريد «الأحدث والأفضل» دون كسر إعدادك الشخصي
title: "الإعداد"
---

# الإعداد

<Note>
إذا كنت تُجري الإعداد للمرة الأولى، فابدأ بـ [بدء الاستخدام](/start/getting-started).
للاطّلاع على تفاصيل المعالج، راجع [معالج الإعداد الأولي](/start/wizard).
</Note>

آخر تحديث: 2026-01-01

## TL;DR

- **التخصيص خارج المستودع:** `~/.openclaw/workspace` (مساحة العمل) + `~/.openclaw/openclaw.json` (التهيئة).
- **سير عمل مستقر:** ثبّت تطبيق macOS؛ ودعه يشغّل Gateway (البوابة) المضمّن.
- **سير عمل على الحافة:** شغّل Gateway (البوابة) بنفسك عبر `pnpm gateway:watch`، ثم دع تطبيق macOS يتصل في وضع Local.

## المتطلبات المسبقة (من المصدر)

- Node `>=22`
- `pnpm`
- Docker (اختياري؛ فقط للإعداد المُحَوْسَب/اختبارات e2e — انظر [Docker](/install/docker))

## استراتيجية التخصيص (حتى لا تؤذيك التحديثات)

إذا كنت تريد «مخصّصًا 100% لي» _و_ تحديثات سهلة، فاحتفظ بتخصيصك في:

- **التهيئة:** `~/.openclaw/openclaw.json` (JSON/JSON5-ish)
- **مساحة العمل:** `~/.openclaw/workspace` (Skills، مطالبات، ذكريات؛ اجعلها مستودع git خاصًا)

Bootstrap مرة:

```bash
openclaw setup
```

من داخل هذا المستودع، استخدم مدخل CLI المحلي:

```bash
openclaw setup
```

إذا لم يكن لديك تثبيت عام بعد، فشغّله عبر `pnpm openclaw setup`.

## تشغيل البوابة من هذا المستودع

بعد `pnpm build`، يمكنك تشغيل CLI المُعبّأ مباشرةً:

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## سير العمل المستقر (تطبيق macOS أولًا)

1. ثبّت وشغّل **OpenClaw.app** (شريط القوائم).
2. أكمل قائمة التهيئة/الأذونات (مطالبات TCC).
3. تأكد من أن Gateway (البوابة) في وضع **Local** ويعمل (يديره التطبيق).
4. اربط القنوات (مثال: WhatsApp):

```bash
openclaw channels login
```

5. التحقق من المتعة:

```bash
openclaw health
```

إذا لم يكن الإعداد الأولي متاحًا في نسختك:

- شغّل `openclaw setup`، ثم `openclaw channels login`، ثم ابدأ Gateway (البوابة) يدويًا (`openclaw gateway`).

## سير العمل على الحافة (Gateway في الطرفية)

الهدف: العمل على Gateway المكتوب بـ TypeScript، الحصول على إعادة تحميل فورية، والإبقاء على واجهة تطبيق macOS متصلة.

### 0. (اختياري) تشغيل تطبيق macOS من المصدر أيضًا

إذا أردت أيضًا تشغيل تطبيق macOS على أحدث نسخة:

```bash
./scripts/restart-mac.sh
```

### 1. بدء Gateway التطويري

```bash
pnpm install
pnpm gateway:watch
```

يشغّل `gateway:watch` البوابة في وضع المراقبة ويعيد التحميل عند تغييرات TypeScript.

### 2. توجيه تطبيق macOS إلى Gateway (البوابة) التي تعمل لديك

في **OpenClaw.app**:

- وضع الاتصال: **Local**
  سيتصل التطبيق بالبوابة العاملة على المنفذ المُهيّأ.

### 3. التحقق

- يجب أن تعرض حالة Gateway داخل التطبيق **«Using existing gateway …»**
- أو عبر CLI:

```bash
openclaw health
```

### المسدسات الشائعة

- **منفذ خاطئ:** افتراضي WS لـ Gateway هو `ws://127.0.0.1:18789`؛ احرص على أن يكون التطبيق وCLI على المنفذ نفسه.
- **أين تُحفظ الحالة:**
  - بيانات الاعتماد: `~/.openclaw/credentials/`
  - الجلسات: `~/.openclaw/agents/<agentId>/sessions/`
  - السجلات: `/tmp/openclaw/`

## خريطة تخزين بيانات الاعتماد

استخدمها عند تصحيح أخطاء المصادقة أو تحديد ما يجب نسخه احتياطيًا:

- **WhatsApp**: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **رمز بوت Telegram**: التهيئة/متغيرات البيئة أو `channels.telegram.tokenFile`
- **رمز Discord bot**: تهيئة/متغيرات البيئة (ملف الرمز غير مدعوم بعد)
- **رموز Slack**: التهيئة/متغيرات البيئة (`channels.slack.*`)
- **قوائم السماح بالاقتران**: `~/.openclaw/credentials/<channel>-allowFrom.json`
- **ملفات تعريف مصادقة النماذج**: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **استيراد OAuth القديم**: `~/.openclaw/credentials/oauth.json`
  مزيد من التفاصيل: [الأمان](/gateway/security#credential-storage-map).

## التحديث (من دون تخريب إعدادك)

- احتفظ بـ `~/.openclaw/workspace` و `~/.openclaw/` باعتبارهما «أشيائك»؛ لا تضع مطالبات/تهيئة شخصية داخل مستودع `openclaw`.
- تحديث المصدر: `git pull` + `pnpm install` (عند تغيّر lockfile) + واصل استخدام `pnpm gateway:watch`.

## Linux (خدمة systemd للمستخدم)

تستخدم عمليات تثبيت Linux خدمة systemd **للمستخدم**. افتراضيًا، يوقف systemd خدمات المستخدم
عند تسجيل الخروج/الخمول، ما يوقف Gateway (البوابة). يحاول الإعداد الأولي تمكين
lingering لك (قد يطلب sudo). إذا كان لا يزال متوقفًا، شغّل:

```bash
sudo loginctl enable-linger $USER
```

لخوادم تعمل دائمًا أو متعددة المستخدمين، فكّر في خدمة **نظام** بدلًا من خدمة
المستخدم (لا حاجة إلى lingering). راجع [دليل تشغيل Gateway](/gateway) لملاحظات systemd.

## مستندات ذات صلة

- [دليل تشغيل Gateway](/gateway) (الأعلام، الإشراف، المنافذ)
- [تهيئة Gateway](/gateway/configuration) (مخطط التهيئة + أمثلة)
- [Discord](/channels/discord) و [Telegram](/channels/telegram) (وسوم الرد + إعدادات replyToMode)
- [إعداد مساعد OpenClaw](/start/openclaw)
- [تطبيق macOS](/platforms/macos) (دورة حياة البوابة)
