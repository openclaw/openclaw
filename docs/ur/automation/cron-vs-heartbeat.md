---
summary: "آٹومیشن کے لیے heartbeat اور cron جابز کے درمیان انتخاب کی رہنمائی"
read_when:
  - بار بار چلنے والے کاموں کی شیڈولنگ کا فیصلہ کرتے وقت
  - بیک گراؤنڈ مانیٹرنگ یا نوٹیفیکیشنز سیٹ اپ کرتے وقت
  - وقفہ وار جانچ کے لیے ٹوکن استعمال کو بہتر بناتے وقت
title: "Cron بمقابلہ Heartbeat"
---

# Cron بمقابلہ Heartbeat: ہر ایک کب استعمال کریں

ہارٹ بیٹس اور cron جابز دونوں آپ کو شیڈول پر ٹاسکس چلانے دیتی ہیں۔ یہ گائیڈ آپ کو اپنے استعمال کے کیس کے لیے درست میکانزم منتخب کرنے میں مدد دیتی ہے۔

## فوری فیصلہ جاتی رہنمائی

| استعمال کا کیس                            | سفارش کردہ                             | وجہ                                         |
| ----------------------------------------- | -------------------------------------- | ------------------------------------------- |
| ہر 30 منٹ میں ان باکس چیک کریں            | Heartbeat                              | دیگر چیکس کے ساتھ بیچنگ، سیاق سے آگاہ       |
| روزانہ 9 بجے ٹھیک رپورٹ بھیجیں            | Cron (isolated)     | عین وقت درکار                               |
| آنے والے ایونٹس کے لیے کیلنڈر مانیٹر کریں | Heartbeat                              | وقفہ وار آگاہی کے لیے قدرتی موزونیت         |
| ہفتہ وار گہرا تجزیہ چلائیں                | Cron (isolated)     | خودمختار کام، مختلف ماڈل استعمال ہو سکتا ہے |
| 20 منٹ میں یاد دہانی کروائیں              | Cron (main, `--at`) | ایک بارہ کام، عین وقت کے ساتھ               |
| بیک گراؤنڈ پروجیکٹ صحت چیک                | Heartbeat                              | موجودہ سائیکل پر انحصار کرتا ہے             |

## Heartbeat: وقفہ وار آگاہی

ہارٹ بیٹس **مین سیشن** میں باقاعدہ وقفے سے چلتی ہیں (بطورِ ڈیفالٹ: 30 منٹ)۔ انہیں ایجنٹ کے لیے چیزوں کی جانچ اور کسی بھی اہم بات کو سامنے لانے کے لیے ڈیزائن کیا گیا ہے۔

### Heartbeat کب استعمال کریں

- **متعدد وقفہ وار چیکس**: ان باکس، کیلنڈر، موسم، نوٹیفیکیشنز، اور پروجیکٹ اسٹیٹس کے لیے 5 الگ cron جابز کے بجائے ایک ہی heartbeat ان سب کو بیچ کر سکتا ہے۔
- **سیاق سے آگاہ فیصلے**: ایجنٹ کے پاس مکمل main-session سیاق ہوتا ہے، اس لیے وہ فوری بمقابلہ قابلِ انتظار امور پر بہتر فیصلے کر سکتا ہے۔
- **مکالماتی تسلسل**: Heartbeat رنز ایک ہی سیشن شیئر کرتے ہیں، لہٰذا ایجنٹ حالیہ گفتگو یاد رکھتا ہے اور قدرتی انداز میں فالو اپ کر سکتا ہے۔
- **کم اوورہیڈ مانیٹرنگ**: ایک heartbeat بہت سی چھوٹی پولنگ ٹاسکس کی جگہ لے لیتا ہے۔

### Heartbeat کے فوائد

- **متعدد چیکس کی بیچنگ**: ایک ایجنٹ ٹرن میں ان باکس، کیلنڈر، اور نوٹیفیکیشنز اکٹھے ریویو ہو جاتے ہیں۔
- **API کالز میں کمی**: ایک heartbeat پانچ الگ cron جابز سے سستا ہوتا ہے۔
- **سیاق سے آگاہ**: ایجنٹ جانتا ہے کہ آپ کس پر کام کر رہے ہیں اور اسی حساب سے ترجیح دیتا ہے۔
- **سمارٹ دباؤ**: اگر کسی توجہ کی ضرورت نہ ہو تو ایجنٹ `HEARTBEAT_OK` جواب دیتا ہے اور کوئی پیغام ڈیلیور نہیں ہوتا۔
- **قدرتی ٹائمنگ**: کیو لوڈ کے مطابق معمولی ڈرفٹ ہو سکتا ہے، جو زیادہ تر مانیٹرنگ کے لیے قابلِ قبول ہے۔

### Heartbeat کی مثال: HEARTBEAT.md چیک لسٹ

```md
# Heartbeat checklist

- Check email for urgent messages
- Review calendar for events in next 2 hours
- If a background task finished, summarize results
- If idle for 8+ hours, send a brief check-in
```

ایجنٹ ہر heartbeat پر اسے پڑھتا ہے اور تمام آئٹمز کو ایک ہی ٹرن میں نمٹاتا ہے۔

### Heartbeat کی کنفیگریشن

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // interval
        target: "last", // where to deliver alerts
        activeHours: { start: "08:00", end: "22:00" }, // optional
      },
    },
  },
}
```

مکمل کنفیگریشن کے لیے [Heartbeat](/gateway/heartbeat) دیکھیں۔

## Cron: عین شیڈولنگ

Cron جابز **عین اوقات** پر چلتی ہیں اور isolated سیشنز میں چل سکتی ہیں، بغیر main context کو متاثر کیے۔

### Cron کب استعمال کریں

- **عین وقت درکار ہو**: "ہر پیر صبح 9:00 بجے بھیجیں" (نہ کہ "تقریباً 9 کے آس پاس")۔
- **خودمختار کام**: ایسے کام جنہیں مکالماتی سیاق کی ضرورت نہیں۔
- **مختلف ماڈل/سوچ**: بھاری تجزیہ جس کے لیے زیادہ طاقتور ماڈل موزوں ہو۔
- **ایک بارہ یاد دہانیاں**: "20 منٹ میں یاد دلائیں" `--at` کے ساتھ۔
- **شور دار/کثرت والے کام**: ایسے کام جو main session کی ہسٹری کو بھر دیں۔
- **بیرونی ٹرگرز**: ایسے کام جو ایجنٹ کی دیگر سرگرمیوں سے آزاد چلنے چاہئیں۔

### Cron کے فوائد

- **عین وقت**: ٹائم زون سپورٹ کے ساتھ 5-فیلڈ cron ایکسپریشنز۔
- **سیشن آئسولیشن**: `cron:<jobId>` میں چلتا ہے، main ہسٹری کو آلودہ کیے بغیر۔
- **ماڈل اووررائیڈز**: ہر جاب کے لیے سستا یا زیادہ طاقتور ماڈل منتخب کریں۔
- **ڈیلیوری کنٹرول**: isolated جابز بطورِ طے شدہ `announce` (خلاصہ) پر ہوتی ہیں؛ ضرورت ہو تو `none` منتخب کریں۔
- **فوری ڈیلیوری**: Announce موڈ heartbeat کا انتظار کیے بغیر براہِ راست پوسٹ کرتا ہے۔
- **ایجنٹ سیاق کی ضرورت نہیں**: main session غیر فعال یا کمپیکٹڈ ہو تب بھی چلتا ہے۔
- **ایک بارہ سپورٹ**: عین مستقبل کے ٹائم اسٹیمپس کے لیے `--at`۔

### Cron کی مثال: روزانہ صبح کی بریفنگ

```bash
openclaw cron add \
  --name "Morning briefing" \
  --cron "0 7 * * *" \
  --tz "America/New_York" \
  --session isolated \
  --message "Generate today's briefing: weather, calendar, top emails, news summary." \
  --model opus \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

یہ نیویارک وقت کے مطابق ٹھیک 7:00 AM پر چلتا ہے، معیار کے لیے Opus استعمال کرتا ہے، اور خلاصہ براہِ راست WhatsApp پر اعلان کرتا ہے۔

### Cron کی مثال: ایک بارہ یاد دہانی

```bash
openclaw cron add \
  --name "Meeting reminder" \
  --at "20m" \
  --session main \
  --system-event "Reminder: standup meeting starts in 10 minutes." \
  --wake now \
  --delete-after-run
```

مکمل CLI حوالہ کے لیے [Cron jobs](/automation/cron-jobs) دیکھیں۔

## فیصلہ جاتی فلوچارٹ

```
Does the task need to run at an EXACT time?
  YES -> Use cron
  NO  -> Continue...

Does the task need isolation from main session?
  YES -> Use cron (isolated)
  NO  -> Continue...

Can this task be batched with other periodic checks?
  YES -> Use heartbeat (add to HEARTBEAT.md)
  NO  -> Use cron

Is this a one-shot reminder?
  YES -> Use cron with --at
  NO  -> Continue...

Does it need a different model or thinking level?
  YES -> Use cron (isolated) with --model/--thinking
  NO  -> Use heartbeat
```

## دونوں کو یکجا کرنا

سب سے مؤثر سیٹ اپ **دونوں** استعمال کرتا ہے:

1. **Heartbeat** ہر 30 منٹ میں ایک بیچڈ ٹرن میں معمول کی مانیٹرنگ (ان باکس، کیلنڈر، نوٹیفیکیشنز) سنبھالتا ہے۔
2. **Cron** عین شیڈولز (روزانہ رپورٹس، ہفتہ وار ریویوز) اور ایک بارہ یاد دہانیاں سنبھالتا ہے۔

### مثال: مؤثر آٹومیشن سیٹ اپ

**HEARTBEAT.md** (ہر 30 منٹ میں چیک):

```md
# Heartbeat checklist

- Scan inbox for urgent emails
- Check calendar for events in next 2h
- Review any pending tasks
- Light check-in if quiet for 8+ hours
```

**Cron jobs** (عین ٹائمنگ):

```bash
# Daily morning briefing at 7am
openclaw cron add --name "Morning brief" --cron "0 7 * * *" --session isolated --message "..." --announce

# Weekly project review on Mondays at 9am
openclaw cron add --name "Weekly review" --cron "0 9 * * 1" --session isolated --message "..." --model opus

# One-shot reminder
openclaw cron add --name "Call back" --at "2h" --session main --system-event "Call back the client" --wake now
```

## Lobster: منظوریوں کے ساتھ متعین ورک فلو

Lobster **ملٹی اسٹیپ ٹول پائپ لائنز** کے لیے ورک فلو رن ٹائم ہے جنہیں متعین عمل درآمد اور واضح منظوریوں کی ضرورت ہوتی ہے۔
جب کام ایک واحد ایجنٹ ٹرن سے زیادہ ہو، اور آپ انسانی چیک پوائنٹس کے ساتھ قابلِ بحالی ورک فلو چاہتے ہوں، تو اسے استعمال کریں۔

### Lobster کب موزوں ہے

- **کئی مرحلہ وار آٹومیشن**: آپ کو ٹول کالز کی ایک مقررہ پائپ لائن درکار ہو، نہ کہ ایک وقتی پرامپٹ۔
- **منظوری کے گیٹس**: سائیڈ ایفیکٹس منظوری تک رکیں، پھر دوبارہ شروع ہوں۔
- **قابلِ دوبارہ آغاز رنز**: پہلے مراحل دوبارہ چلائے بغیر رکے ہوئے ورک فلو کو جاری رکھیں۔

### Heartbeat اور Cron کے ساتھ جوڑ

- **Heartbeat/Cron** یہ طے کرتے ہیں کہ رن _کب_ ہوگا۔
- **Lobster** یہ متعین کرتا ہے کہ رن شروع ہونے پر _کون سے مراحل_ ہوں گے۔

For scheduled workflows, use cron or heartbeat to trigger an agent turn that calls Lobster.
ایڈہاک ورک فلو کے لیے، Lobster کو براہِ راست کال کریں۔

### آپریشنل نوٹس (کوڈ سے)

- Lobster ٹول موڈ میں **local subprocess** کے طور پر (`lobster` CLI) چلتا ہے اور **JSON envelope** واپس کرتا ہے۔
- اگر ٹول `needs_approval` واپس کرے تو آپ `resumeToken` اور `approve` فلیگ کے ساتھ دوبارہ شروع کرتے ہیں۔
- یہ ٹول ایک **اختیاری پلگ اِن** ہے؛ `tools.alsoAllow: ["lobster"]` کے ذریعے اضافی طور پر فعال کریں (سفارش کردہ)۔
- اگر آپ `lobsterPath` پاس کریں تو یہ **absolute path** ہونا لازم ہے۔

مکمل استعمال اور مثالوں کے لیے [Lobster](/tools/lobster) دیکھیں۔

## Main Session بمقابلہ Isolated Session

Heartbeat اور cron دونوں main session کے ساتھ تعامل کر سکتے ہیں، مگر مختلف انداز میں:

|         | Heartbeat                          | Cron (main)                  | Cron (isolated)               |
| ------- | ---------------------------------- | ----------------------------------------------- | ------------------------------------------------ |
| Session | Main                               | Main (system event کے ذریعے) | `cron:<jobId>`                                   |
| History | مشترک                              | مشترک                                           | ہر رن میں نئی                                    |
| Context | مکمل                               | مکمل                                            | کوئی نہیں (صاف آغاز)          |
| Model   | Main session ماڈل                  | Main session ماڈل                               | اووررائیڈ ہو سکتا ہے                             |
| Output  | اگر `HEARTBEAT_OK` نہ ہو تو ڈیلیور | Heartbeat پرامپٹ + ایونٹ                        | Announce خلاصہ (بطورِ طے شدہ) |

### Main session cron کب استعمال کریں

جب آپ `--session main` کے ساتھ `--system-event` استعمال کرنا چاہیں تو:

- یاد دہانی/ایونٹ main session سیاق میں ظاہر ہو
- ایجنٹ اگلے heartbeat میں مکمل سیاق کے ساتھ اسے سنبھالے
- کوئی الگ isolated رن نہ ہو

```bash
openclaw cron add \
  --name "Check project" \
  --every "4h" \
  --session main \
  --system-event "Time for a project health check" \
  --wake now
```

### Isolated cron کب استعمال کریں

جب آپ `--session isolated` استعمال کرنا چاہیں تو:

- سابقہ سیاق کے بغیر صاف آغاز
- مختلف ماڈل یا سوچ کی ترتیبات
- خلاصے براہِ راست کسی چینل پر اعلان ہوں
- ایسی ہسٹری جو main session کو بھاری نہ کرے

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 0" \
  --session isolated \
  --message "Weekly codebase analysis..." \
  --model opus \
  --thinking high \
  --announce
```

## لاگت کے پہلو

| طریقہ کار                          | لاگت پروفائل                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| Heartbeat                          | ہر N منٹ میں ایک ٹرن؛ HEARTBEAT.md کے سائز کے ساتھ بڑھتا ہے       |
| Cron (main)     | اگلے heartbeat میں ایونٹ شامل کرتا ہے (کوئی isolated ٹرن نہیں) |
| Cron (isolated) | ہر جاب پر مکمل ایجنٹ ٹرن؛ سستا ماڈل استعمال ہو سکتا ہے                            |

**مشورے**:

- ٹوکن اوورہیڈ کم رکھنے کے لیے `HEARTBEAT.md` کو چھوٹا رکھیں۔
- متعدد cron جابز کے بجائے مشابہ چیکس کو heartbeat میں بیچ کریں۔
- اگر صرف اندرونی پروسیسنگ چاہیے تو heartbeat پر `target: "none"` استعمال کریں۔
- معمول کے کاموں کے لیے isolated cron کو سستے ماڈل کے ساتھ استعمال کریں۔

## متعلقہ

- [Heartbeat](/gateway/heartbeat) - مکمل heartbeat کنفیگریشن
- [Cron jobs](/automation/cron-jobs) - مکمل cron CLI اور API حوالہ
- [System](/cli/system) - سسٹم ایونٹس + heartbeat کنٹرولز
