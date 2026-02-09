---
summary: "مرجع CLI لأمر `openclaw browser` (الملفات الشخصية، علامات التبويب، الإجراءات، ترحيل الامتداد)"
read_when:
  - تستخدم `openclaw browser` وتريد أمثلة على المهام الشائعة
  - تريد التحكم في متصفح يعمل على جهاز آخر عبر مضيف عُقدة
  - تريد استخدام ترحيل امتداد Chrome (الإرفاق/الفصل عبر زر شريط الأدوات)
title: "browser"
---

# `openclaw browser`

إدارة خادم التحكم بالمتصفح في OpenClaw وتشغيل إجراءات المتصفح (علامات التبويب، اللقطات، لقطات الشاشة، التنقّل، النقرات، الكتابة).

ذو صلة:

- أداة المتصفح + واجهة برمجة التطبيقات: [Browser tool](/tools/browser)
- ترحيل امتداد Chrome: [Chrome extension](/tools/chrome-extension)

## Common flags

- `--url <gatewayWsUrl>`: عنوان URL لـ WebSocket الخاص بـ Gateway (الإعداد الافتراضي من التهيئة).
- `--token <token>`: رمز Gateway (إذا كان مطلوبًا).
- `--timeout <ms>`: مهلة الطلب (بالمللي ثانية).
- `--browser-profile <name>`: اختيار ملف تعريف المتصفح (الافتراضي من التهيئة).
- `--json`: مخرجات قابلة للقراءة آليًا (حيثما يكون مدعومًا).

## Quick start (local)

```bash
openclaw browser --browser-profile chrome tabs
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

## Profiles

الملفات الشخصية هي تهيئات مسماة لتوجيه المتصفح. عمليًا:

- `openclaw`: تشغيل/الإرفاق بمثيل Chrome مُدار من OpenClaw ومخصّص (دليل بيانات مستخدم معزول).
- `chrome`: التحكم في علامات تبويب Chrome الحالية لديك عبر ترحيل امتداد Chrome.

```bash
openclaw browser profiles
openclaw browser create-profile --name work --color "#FF5A36"
openclaw browser delete-profile --name work
```

استخدام ملف تعريف محدد:

```bash
openclaw browser --browser-profile work tabs
```

## Tabs

```bash
openclaw browser tabs
openclaw browser open https://docs.openclaw.ai
openclaw browser focus <targetId>
openclaw browser close <targetId>
```

## Snapshot / screenshot / actions

لقطة (Snapshot):

```bash
openclaw browser snapshot
```

لقطة شاشة (Screenshot):

```bash
openclaw browser screenshot
```

تصفح/نقر / نوع (تلقائية واجهة المستخدم القائمة على الرفع):

```bash
openclaw browser navigate https://example.com
openclaw browser click <ref>
openclaw browser type <ref> "hello"
```

## Chrome extension relay (attach via toolbar button)

يتيح هذا الوضع للوكيل التحكم في علامة تبويب Chrome موجودة تقوم بإرفاقها يدويًا (لا يتم الإرفاق تلقائيًا).

ثبّت الامتداد غير المعبّأ إلى مسار ثابت:

```bash
openclaw browser extension install
openclaw browser extension path
```

ثم Chrome → `chrome://extensions` → تفعيل «Developer mode» → «Load unpacked» → اختيار المجلد المطبوع.

الدليل الكامل: [Chrome extension](/tools/chrome-extension)

## Remote browser control (node host proxy)

إذا كان Gateway يعمل على جهاز مختلف عن المتصفح، فشغّل **مضيف عُقدة** على الجهاز الذي يحتوي على Chrome/Brave/Edge/Chromium. سيقوم Gateway بتمرير إجراءات المتصفح إلى تلك العُقدة (ولا يلزم وجود خادم تحكم بالمتصفح منفصل).

استخدم `gateway.nodes.browser.mode` للتحكم في التوجيه التلقائي و `gateway.nodes.browser.node` لتثبيت عُقدة محددة إذا كان هناك عدة عُقد متصلة.

الأمان + الإعداد عن بُعد: [Browser tool](/tools/browser)، [Remote access](/gateway/remote)، [Tailscale](/gateway/tailscale)، [Security](/gateway/security)
