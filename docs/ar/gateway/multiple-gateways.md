---
summary: "تشغيل عدة Gateways من OpenClaw على مضيف واحد (العزل، المنافذ، والملفات التعريفية)"
read_when:
  - تشغيل أكثر من Gateway واحد على الجهاز نفسه
  - تحتاج إلى تهيئة/حالة/منافذ معزولة لكل Gateway
title: "Gateways متعددة"
---

# Gateways متعددة (المضيف نفسه)

يُفترض أن تستخدم معظم الإعدادات Gateway واحدًا لأن Gateway واحدًا يمكنه التعامل مع عدة اتصالات مراسلة وعدة وكلاء. إذا كنت بحاجة إلى عزل أقوى أو تكرار احتياطي (مثل «روبوت إنقاذ»)، فقم بتشغيل Gateways منفصلة مع ملفات تعريفية/منافذ معزولة.

## قائمة التحقق للعزل (مطلوب)

- `OPENCLAW_CONFIG_PATH` — ملف تهيئة لكل مثيل
- `OPENCLAW_STATE_DIR` — جلسات/اعتمادات/ذاكرات تخزين مؤقت لكل مثيل
- `agents.defaults.workspace` — جذر مساحة عمل لكل مثيل
- `gateway.port` (أو `--port`) — فريد لكل مثيل
- يجب ألا تتداخل المنافذ المُشتقة (المتصفح/اللوحة)

إذا كانت هذه مشتركة، فستواجه سباقات تهيئة وتعارضات منافذ.

## المُوصى به: الملفات التعريفية (`--profile`)

تقوم الملفات التعريفية تلقائيًا بتحديد نطاق `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` وإضافة لاحقة إلى أسماء الخدمات.

```bash
# main
openclaw --profile main setup
openclaw --profile main gateway --port 18789

# rescue
openclaw --profile rescue setup
openclaw --profile rescue gateway --port 19001
```

الخدمات لكل ملف تعريفي:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

## دليل روبوت الإنقاذ

شغّل Gateway ثانية على المضيف نفسه مع ما يلي خاص بها:

- ملف تعريفي/تهيئة
- الولاية العتيقة
- مساحة عمل
- منفذ أساسي (بالإضافة إلى المنافذ المُشتقة)

يحافظ هذا على عزل روبوت الإنقاذ عن الروبوت الرئيسي بحيث يمكنه التصحيح أو تطبيق تغييرات التهيئة إذا كان الروبوت الأساسي متوقفًا.

تباعد المنافذ: اترك ما لا يقل عن 20 منفذًا بين المنافذ الأساسية حتى لا تتصادم منافذ المتصفح/اللوحة/CDP المُشتقة.

### كيفية التثبيت (روبوت الإنقاذ)

```bash
# Main bot (existing or fresh, without --profile param)
# Runs on port 18789 + Chrome CDC/Canvas/... Ports
openclaw onboard
openclaw gateway install

# Rescue bot (isolated profile + ports)
openclaw --profile rescue onboard
# Notes:
# - workspace name will be postfixed with -rescue per default
# - Port should be at least 18789 + 20 Ports,
#   better choose completely different base port, like 19789,
# - rest of the onboarding is the same as normal

# To install the service (if not happened automatically during onboarding)
openclaw --profile rescue gateway install
```

## رسم خرائط الموانئ (مشتقة)

المنفذ الأساسي = `gateway.port` (أو `OPENCLAW_GATEWAY_PORT` / `--port`).

- منفذ خدمة التحكم بالمتصفح = الأساسي + 2 (حلقة محلية فقط)
- `canvasHost.port = base + 4`
- يتم التخصيص التلقائي لمنافذ CDP لملف تعريف المتصفح من `browser.controlPort + 9 .. + 108`

إذا قمت بتجاوز أيٍّ من هذه في التهيئة أو متغيرات البيئة، فيجب إبقاؤها فريدة لكل مثيل.

## ملاحظات المتصفح/CDP (خطأ شائع)

- **لا** تُثبّت `browser.cdpUrl` على القيم نفسها عبر عدة مثيلات.
- يحتاج كل مثيل إلى منفذ تحكم بالمتصفح خاص به ونطاق CDP خاص به (مُشتق من منفذ Gateway).
- إذا احتجت إلى منافذ CDP صريحة، فاضبط `browser.profiles.<name>.cdpPort` لكل مثيل.
- Chrome البعيد: استخدم `browser.profiles.<name>.cdpUrl` (لكل ملف تعريفي، لكل مثيل).

## مثال متغيرات البيئة اليدوي

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/main.json \
OPENCLAW_STATE_DIR=~/.openclaw-main \
openclaw gateway --port 18789

OPENCLAW_CONFIG_PATH=~/.openclaw/rescue.json \
OPENCLAW_STATE_DIR=~/.openclaw-rescue \
openclaw gateway --port 19001
```

## فحوصات سريعة

```bash
openclaw --profile main status
openclaw --profile rescue status
openclaw --profile rescue browser status
```
