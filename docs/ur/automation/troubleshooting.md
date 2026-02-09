---
summary: "کرون اور ہارٹ بیٹ کی شیڈولنگ اور ترسیل کے مسائل کا ازالہ کریں"
read_when:
  - کرون نہیں چلا
  - کرون چلا لیکن کوئی پیغام ترسیل نہیں ہوا
  - ہارٹ بیٹ خاموش یا اسکیپ ہوا محسوس ہو رہا ہے
title: "Automation کی خرابیوں کا ازالہ"
---

# Automation کی خرابیوں کا ازالہ

اس صفحے کو شیڈیولر اور ترسیل سے متعلق مسائل کے لیے استعمال کریں (`cron` + `heartbeat`)۔

## Command ladder

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

پھر آٹومیشن چیکس چلائیں:

```bash
openclaw cron status
openclaw cron list
openclaw system heartbeat last
```

## Cron فائر نہیں ہو رہا

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw logs --follow
```

اچھی آؤٹ پٹ کچھ یوں دکھائی دیتی ہے:

- `cron status` فعال ہونے اور مستقبل کے `nextWakeAtMs` کی رپورٹ کرتا ہے۔
- جاب فعال ہے اور اس کے پاس درست شیڈول/ٹائم زون ہے۔
- `cron runs` میں `ok` یا واضح اسکیپ وجہ دکھائی دیتی ہے۔

عام علامات:

- `cron: scheduler disabled; jobs will not run automatically` → کنفیگ/env میں کرون غیرفعال ہے۔
- `cron: timer tick failed` → شیڈیولر ٹک کریش ہوا؛ قریبی اسٹیک/لاگ سیاق کا معائنہ کریں۔
- رن آؤٹ پٹ میں `reason: not-due` → دستی رن `--force` کے بغیر کال ہوا اور جاب ابھی واجب الادا نہیں تھا۔

## Cron فائر ہوا لیکن ترسیل نہیں ہوئی

```bash
openclaw cron runs --id <jobId> --limit 20
openclaw cron list
openclaw channels status --probe
openclaw logs --follow
```

اچھی آؤٹ پٹ کچھ یوں دکھائی دیتی ہے:

- رن اسٹیٹس `ok` ہے۔
- الگ تھلگ جابز کے لیے ترسیلی موڈ/ہدف سیٹ ہیں۔
- چینل پروب ہدف چینل کے کنیکٹ ہونے کی رپورٹ کرتا ہے۔

عام علامات:

- رن کامیاب ہوا لیکن ترسیلی موڈ `none` ہے → کسی بیرونی پیغام کی توقع نہیں ہوتی۔
- ترسیلی ہدف غائب/غلط (`channel`/`to`) → رن اندرونی طور پر کامیاب ہو سکتا ہے مگر آؤٹ باؤنڈ اسکیپ ہو جاتا ہے۔
- چینل تصدیقی غلطیاں (`unauthorized`, `missing_scope`, `Forbidden`) → چینل کی اسناد/اجازتوں کی وجہ سے ترسیل بلاک ہو جاتی ہے۔

## Heartbeat دبایا گیا یا اسکیپ ہوا

```bash
openclaw system heartbeat last
openclaw logs --follow
openclaw config get agents.defaults.heartbeat
openclaw channels status --probe
```

اچھی آؤٹ پٹ کچھ یوں دکھائی دیتی ہے:

- ہارٹ بیٹ غیر صفر وقفے کے ساتھ فعال ہے۔
- آخری ہارٹ بیٹ نتیجہ `ran` ہے (یا اسکیپ کی وجہ سمجھ میں آتی ہے)۔

عام علامات:

- `heartbeat skipped` کے ساتھ `reason=quiet-hours` → `activeHours` سے باہر۔
- `requests-in-flight` → مین لین مصروف؛ ہارٹ بیٹ مؤخر کر دیا گیا۔
- `empty-heartbeat-file` → `HEARTBEAT.md` موجود ہے مگر اس میں قابلِ عمل مواد نہیں۔
- `alerts-disabled` → ویژیبلیٹی سیٹنگز آؤٹ باؤنڈ ہارٹ بیٹ پیغامات کو دبا دیتی ہیں۔

## Timezone اور activeHours کے مسائل

```bash
openclaw config get agents.defaults.heartbeat.activeHours
openclaw config get agents.defaults.heartbeat.activeHours.timezone
openclaw config get agents.defaults.userTimezone || echo "agents.defaults.userTimezone not set"
openclaw cron list
openclaw logs --follow
```

فوری اصول:

- `Config path not found: agents.defaults.userTimezone` کا مطلب ہے کہ کلید غیر سیٹ ہے؛ ہارٹ بیٹ ہوسٹ ٹائم زون پر واپس چلا جاتا ہے (یا اگر سیٹ ہو تو `activeHours.timezone`)۔
- `--tz` کے بغیر کرون گیٹ وے ہوسٹ ٹائم زون استعمال کرتا ہے۔
- ہارٹ بیٹ `activeHours` کنفیگرڈ ٹائم زون ریزولوشن (`user`, `local`, یا واضح IANA tz) استعمال کرتا ہے۔
- بغیر ٹائم زون کے ISO ٹائم اسٹیمپس کرون `at` شیڈولز کے لیے UTC سمجھے جاتے ہیں۔

عام علامات:

- ہوسٹ ٹائم زون میں تبدیلی کے بعد جابز غلط وال کلاک وقت پر چلتے ہیں۔
- دن کے وقت ہارٹ بیٹ ہمیشہ اسکیپ ہو جاتا ہے کیونکہ `activeHours.timezone` غلط ہے۔

متعلقہ:

- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)
- [/automation/cron-vs-heartbeat](/automation/cron-vs-heartbeat)
- [/concepts/timezone](/concepts/timezone)
