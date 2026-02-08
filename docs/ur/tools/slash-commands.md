---
summary: "سلैش کمانڈز: متن بمقابلہ نیٹو، کنفیگ، اور معاون کمانڈز"
read_when:
  - چیٹ کمانڈز کا استعمال یا کنفیگریشن کرتے وقت
  - کمانڈ روٹنگ یا اجازتوں کی خرابیوں کا ازالہ کرتے وقت
title: "سلैش کمانڈز"
x-i18n:
  source_path: tools/slash-commands.md
  source_hash: ca0deebf89518e8c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:14Z
---

# سلैش کمانڈز

کمانڈز Gateway کے ذریعے سنبھالی جاتی ہیں۔ زیادہ تر کمانڈز کو ایک **علیحدہ** پیغام کے طور پر بھیجنا لازم ہے جو `/` سے شروع ہو۔
صرف ہوسٹ کے لیے bash چیٹ کمانڈ `! <cmd>` استعمال کرتی ہے (جس کا عرف `/bash <cmd>` ہے)۔

دو باہم متعلقہ نظام ہیں:

- **کمانڈز**: علیحدہ `/...` پیغامات۔
- **دایرکٹیوز**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/exec`, `/model`, `/queue`۔
  - ماڈل کے دیکھنے سے پہلے دایرکٹیوز پیغام سے ہٹا دیے جاتے ہیں۔
  - عام چیٹ پیغامات میں (صرف دایرکٹیو نہ ہوں)، انہیں “ان لائن اشارے” سمجھا جاتا ہے اور یہ سیشن کی ترتیبات کو **محفوظ** نہیں کرتے۔
  - صرف دایرکٹیو والے پیغامات میں (پیغام میں صرف دایرکٹیوز ہوں)، یہ سیشن میں محفوظ ہو جاتے ہیں اور ایک توثیقی جواب دیتے ہیں۔
  - دایرکٹیوز صرف **مجاز ارسال کنندگان** کے لیے لاگو ہوتے ہیں (چینل اجازت فہرستیں/جوڑی بنانا نیز `commands.useAccessGroups`)۔
    غیر مجاز ارسال کنندگان کے لیے دایرکٹیوز سادہ متن کے طور پر برتاؤ کیے جاتے ہیں۔

کچھ **ان لائن شارٹ کٹس** بھی ہیں (صرف اجازت فہرست/مجاز ارسال کنندگان): `/help`, `/commands`, `/status`, `/whoami` (`/id`)۔
یہ فوراً چلتے ہیں، ماڈل کے دیکھنے سے پہلے ہٹا دیے جاتے ہیں، اور باقی متن معمول کے بہاؤ کے مطابق آگے بڑھتا ہے۔

## کنفیگ

```json5
{
  commands: {
    native: "auto",
    nativeSkills: "auto",
    text: true,
    bash: false,
    bashForegroundMs: 2000,
    config: false,
    debug: false,
    restart: false,
    useAccessGroups: true,
  },
}
```

- `commands.text` (بطورِ طے شدہ `true`) چیٹ پیغامات میں `/...` کی پارسنگ کو فعال کرتا ہے۔
  - ایسے پلیٹ فارمز پر جہاں نیٹو کمانڈز موجود نہیں (WhatsApp/WebChat/Signal/iMessage/Google Chat/MS Teams)، متن والی کمانڈز تب بھی کام کرتی ہیں چاہے آپ اسے `false` پر سیٹ کریں۔
- `commands.native` (بطورِ طے شدہ `"auto"`) نیٹو کمانڈز رجسٹر کرتا ہے۔
  - Auto: Discord/Telegram کے لیے آن؛ Slack کے لیے آف (جب تک آپ سلैش کمانڈز شامل نہ کریں)؛ جن فراہم کنندگان میں نیٹو سپورٹ نہیں، وہاں نظرانداز۔
  - ہر فراہم کنندہ کے لیے اووررائیڈ کرنے کو `channels.discord.commands.native`, `channels.telegram.commands.native`, یا `channels.slack.commands.native` سیٹ کریں (bool یا `"auto"`)۔
  - `false` اسٹارٹ اپ پر Discord/Telegram میں پہلے سے رجسٹرڈ کمانڈز صاف کرتا ہے۔ Slack کی کمانڈز Slack ایپ میں منظم ہوتی ہیں اور خودکار طور پر نہیں ہٹتیں۔
- `commands.nativeSkills` (بطورِ طے شدہ `"auto"`) جہاں معاونت ہو وہاں **Skill** کمانڈز کو نیٹو طور پر رجسٹر کرتا ہے۔
  - Auto: Discord/Telegram کے لیے آن؛ Slack کے لیے آف (Slack میں ہر Skill کے لیے علیحدہ سلैش کمانڈ بنانا لازم ہے)۔
  - ہر فراہم کنندہ کے لیے اووررائیڈ کرنے کو `channels.discord.commands.nativeSkills`, `channels.telegram.commands.nativeSkills`, یا `channels.slack.commands.nativeSkills` سیٹ کریں (bool یا `"auto"`)۔
- `commands.bash` (بطورِ طے شدہ `false`) `! <cmd>` کو ہوسٹ شیل کمانڈز چلانے کے لیے فعال کرتا ہے (`/bash <cmd>` عرف ہے؛ `tools.elevated` اجازت فہرستیں درکار)۔
- `commands.bashForegroundMs` (بطورِ طے شدہ `2000`) یہ کنٹرول کرتا ہے کہ bash پس منظر موڈ میں کب سوئچ کرے (`0` فوراً پس منظر میں بھیج دیتا ہے)۔
- `commands.config` (بطورِ طے شدہ `false`) `/config` کو فعال کرتا ہے (`openclaw.json` پڑھتا/لکھتا ہے)۔
- `commands.debug` (بطورِ طے شدہ `false`) `/debug` کو فعال کرتا ہے (صرف رن ٹائم اووررائیڈز)۔
- `commands.useAccessGroups` (بطورِ طے شدہ `true`) کمانڈز کے لیے اجازت فہرستیں/پالیسیاں نافذ کرتا ہے۔

## کمانڈ فہرست

متن + نیٹو (جب فعال ہوں):

- `/help`
- `/commands`
- `/skill <name> [input]` (نام کے ذریعے Skill چلائیں)
- `/status` (موجودہ اسٹیٹس دکھائیں؛ جہاں دستیاب ہو وہاں موجودہ ماڈل فراہم کنندہ کے لیے فراہم کنندہ استعمال/کوٹہ شامل)
- `/allowlist` (اجازت فہرست اندراجات کی فہرست/اضافہ/حذف)
- `/approve <id> allow-once|allow-always|deny` (exec منظوری پرامپٹس حل کریں)
- `/context [list|detail|json]` (“سیاق” کی وضاحت؛ `detail` فی فائل + فی ٹول + فی Skill + سسٹم پرامپٹ سائز دکھاتا ہے)
- `/whoami` (آپ کا sender id دکھائیں؛ عرف: `/id`)
- `/subagents list|stop|log|info|send` (موجودہ سیشن کے لیے ذیلی ایجنٹ رنز کا معائنہ، روکنا، لاگ، یا پیغام)
- `/config show|get|set|unset` (کنفیگ کو ڈسک پر محفوظ کریں، صرف مالک؛ `commands.config: true` درکار)
- `/debug show|set|unset|reset` (رن ٹائم اووررائیڈز، صرف مالک؛ `commands.debug: true` درکار)
- `/usage off|tokens|full|cost` (فی جواب استعمال فوٹر یا مقامی لاگت خلاصہ)
- `/tts off|always|inbound|tagged|status|provider|limit|summary|audio` (TTS کنٹرول؛ دیکھیں [/tts](/tts))
  - Discord: نیٹو کمانڈ `/voice` ہے (Discord `/tts` محفوظ رکھتا ہے)؛ متن `/tts` اب بھی کام کرتا ہے۔
- `/stop`
- `/restart`
- `/dock-telegram` (عرف: `/dock_telegram`) (جوابات Telegram پر منتقل کریں)
- `/dock-discord` (عرف: `/dock_discord`) (جوابات Discord پر منتقل کریں)
- `/dock-slack` (عرف: `/dock_slack`) (جوابات Slack پر منتقل کریں)
- `/activation mention|always` (صرف گروپس)
- `/send on|off|inherit` (صرف مالک)
- `/reset` یا `/new [model]` (اختیاری ماڈل اشارہ؛ باقی متن جوں کا توں آگے بھیجا جاتا ہے)
- `/think <off|minimal|low|medium|high|xhigh>` (ماڈل/فراہم کنندہ کے مطابق متحرک انتخاب؛ عرفات: `/thinking`, `/t`)
- `/verbose on|full|off` (عرف: `/v`)
- `/reasoning on|off|stream` (عرف: `/reason`; آن ہونے پر `Reasoning:` کے سابقے کے ساتھ علیحدہ پیغام بھیجتا ہے؛ `stream` = صرف Telegram ڈرافٹ)
- `/elevated on|off|ask|full` (عرف: `/elev`; `full` exec منظوریات چھوڑ دیتا ہے)
- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>` (موجودہ دکھانے کے لیے `/exec` بھیجیں)
- `/model <name>` (عرف: `/models`; یا `/<alias>` بذریعہ `agents.defaults.models.*.alias`)
- `/queue <mode>` (مزید اختیارات جیسے `debounce:2s cap:25 drop:summarize`; موجودہ ترتیبات دیکھنے کے لیے `/queue` بھیجیں)
- `/bash <command>` (صرف ہوسٹ؛ `! <command>` کا عرف؛ `commands.bash: true` + `tools.elevated` اجازت فہرستیں درکار)

صرف متن:

- `/compact [instructions]` (دیکھیں [/concepts/compaction](/concepts/compaction))
- `! <command>` (صرف ہوسٹ؛ ایک وقت میں ایک؛ طویل المدت جابز کے لیے `!poll` + `!stop` استعمال کریں)
- `!poll` (آؤٹ پٹ/اسٹیٹس چیک کریں؛ اختیاری `sessionId` قبول کرتا ہے؛ `/bash poll` بھی کام کرتا ہے)
- `!stop` (چلتی ہوئی bash جاب روکیں؛ اختیاری `sessionId` قبول کرتا ہے؛ `/bash stop` بھی کام کرتا ہے)

نوٹس:

- کمانڈز کمانڈ اور دلائل کے درمیان اختیاری `:` قبول کرتی ہیں (مثلاً `/think: high`, `/send: on`, `/help:`)۔
- `/new <model>` ماڈل عرف، `provider/model`, یا فراہم کنندہ کا نام (فزی میچ) قبول کرتا ہے؛ اگر میچ نہ ہو تو متن کو پیغام کے جسم کے طور پر سمجھا جاتا ہے۔
- فراہم کنندہ کے مکمل استعمال کی تفصیل کے لیے `openclaw status --usage` استعمال کریں۔
- `/allowlist add|remove` کے لیے `commands.config=true` درکار ہے اور یہ چینل `configWrites` کی پاسداری کرتا ہے۔
- `/usage` فی جواب استعمال فوٹر کو کنٹرول کرتا ہے؛ `/usage cost` OpenClaw سیشن لاگز سے مقامی لاگت کا خلاصہ پرنٹ کرتا ہے۔
- `/restart` بطورِ طے شدہ غیرفعال ہے؛ اسے فعال کرنے کے لیے `commands.restart: true` سیٹ کریں۔
- `/verbose` ڈیبگنگ اور اضافی مرئیت کے لیے ہے؛ معمول کے استعمال میں اسے **بند** رکھیں۔
- `/reasoning` (اور `/verbose`) گروپ سیٹنگز میں خطرناک ہیں: یہ داخلی استدلال یا ٹول آؤٹ پٹ ظاہر کر سکتے ہیں جسے آپ ظاہر نہیں کرنا چاہتے تھے۔ خصوصاً گروپ چیٹس میں انہیں بند رکھنا بہتر ہے۔
- **فاسٹ پاتھ:** اجازت فہرست والے ارسال کنندگان کے کمانڈ-صرف پیغامات فوراً نمٹائے جاتے ہیں (قطار + ماڈل بائی پاس)۔
- **گروپ مینشن گیٹنگ:** اجازت فہرست والے ارسال کنندگان کے کمانڈ-صرف پیغامات مینشن تقاضوں کو بائی پاس کرتے ہیں۔
- **ان لائن شارٹ کٹس (صرف اجازت فہرست والے ارسال کنندگان):** کچھ کمانڈز عام پیغام میں ضم ہو کر بھی کام کرتی ہیں اور باقی متن ماڈل کے دیکھنے سے پہلے ہٹا دی جاتی ہیں۔
  - مثال: `hey /status` اسٹیٹس کا جواب ٹرگر کرتا ہے، اور باقی متن معمول کے بہاؤ کے مطابق جاری رہتا ہے۔
- فی الحال: `/help`, `/commands`, `/status`, `/whoami` (`/id`)۔
- غیر مجاز کمانڈ-صرف پیغامات خاموشی سے نظرانداز کر دیے جاتے ہیں، اور ان لائن `/...` ٹوکنز کو سادہ متن سمجھا جاتا ہے۔
- **Skill کمانڈز:** `user-invocable` Skills سلैش کمانڈز کے طور پر دستیاب ہوتی ہیں۔ ناموں کو `a-z0-9_` میں صاف کیا جاتا ہے (زیادہ سے زیادہ 32 حروف)؛ ٹکراؤ کی صورت میں عددی لاحقے لگتے ہیں (مثلاً `_2`)۔
  - `/skill <name> [input]` نام کے ذریعے Skill چلاتا ہے (اس وقت مفید جب نیٹو کمانڈ حدود فی Skill کمانڈ بنانے سے روکیں)۔
  - بطورِ طے شدہ، Skill کمانڈز ماڈل کو عام درخواست کے طور پر فارورڈ کی جاتی ہیں۔
  - Skills اختیاری طور پر `command-dispatch: tool` کا اعلان کر سکتی ہیں تاکہ کمانڈ براہِ راست کسی ٹول کی طرف روٹ ہو (متعین، بغیر ماڈل)۔
  - مثال: `/prose` (OpenProse پلگ ان) — دیکھیں [OpenProse](/prose)۔
- **نیٹو کمانڈ دلائل:** Discord متحرک اختیارات کے لیے آٹو کمپلیٹ استعمال کرتا ہے (اور جب لازم دلائل چھوڑ دیے جائیں تو بٹن مینو)۔ Telegram اور Slack اس وقت بٹن مینو دکھاتے ہیں جب کمانڈ انتخاب کی معاونت کرے اور آپ دلیل چھوڑ دیں۔

## استعمالی سرفیسز (کہاں کیا دکھتا ہے)

- **فراہم کنندہ استعمال/کوٹہ** (مثال: “Claude 80% left”) موجودہ ماڈل فراہم کنندہ کے لیے `/status` میں ظاہر ہوتا ہے جب استعمال ٹریکنگ فعال ہو۔
- **فی جواب ٹوکنز/لاگت** کو `/usage off|tokens|full` کنٹرول کرتا ہے (عام جوابات کے ساتھ منسلک)۔
- `/model status` **ماڈلز/تصدیق/اینڈ پوائنٹس** کے بارے میں ہے، استعمال کے بارے میں نہیں۔

## ماڈل انتخاب (`/model`)

`/model` ایک دایرکٹیو کے طور پر نافذ کیا گیا ہے۔

مثالیں:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model opus@anthropic:default
/model status
```

نوٹس:

- `/model` اور `/model list` ایک مختصر، نمبر شدہ پکر دکھاتے ہیں (ماڈل فیملی + دستیاب فراہم کنندگان)۔
- `/model <#>` اسی پکر سے انتخاب کرتا ہے (اور جہاں ممکن ہو موجودہ فراہم کنندہ کو ترجیح دیتا ہے)۔
- `/model status` تفصیلی منظر دکھاتا ہے، جس میں کنفیگرڈ فراہم کنندہ اینڈ پوائنٹ (`baseUrl`) اور API موڈ (`api`) شامل ہیں جب دستیاب ہوں۔

## ڈیبگ اووررائیڈز

`/debug` آپ کو **صرف رن ٹائم** کنفیگ اووررائیڈز (میموری، ڈسک نہیں) سیٹ کرنے دیتا ہے۔ صرف مالک۔ بطورِ طے شدہ غیرفعال؛ `commands.debug: true` کے ساتھ فعال کریں۔

مثالیں:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

نوٹس:

- اووررائیڈز فوراً نئی کنفیگ ریڈز پر لاگو ہوتے ہیں، لیکن `openclaw.json` میں **نہیں** لکھتے۔
- تمام اووررائیڈز صاف کرنے اور آن-ڈسک کنفیگ پر واپس آنے کے لیے `/debug reset` استعمال کریں۔

## کنفیگ اپڈیٹس

`/config` آپ کی آن-ڈسک کنفیگ (`openclaw.json`) میں لکھتا ہے۔ صرف مالک۔ بطورِ طے شدہ غیرفعال؛ `commands.config: true` کے ساتھ فعال کریں۔

مثالیں:

```
/config show
/config show messages.responsePrefix
/config get messages.responsePrefix
/config set messages.responsePrefix="[openclaw]"
/config unset messages.responsePrefix
```

نوٹس:

- لکھنے سے پہلے کنفیگ کی توثیق کی جاتی ہے؛ غلط تبدیلیاں مسترد کر دی جاتی ہیں۔
- `/config` اپڈیٹس ری اسٹارٹس کے بعد بھی برقرار رہتی ہیں۔

## سرفیس نوٹس

- **متنی کمانڈز** معمول کے چیٹ سیشن میں چلتی ہیں (DMs `main` شیئر کرتے ہیں، گروپس کا اپنا سیشن ہوتا ہے)۔
- **نیٹو کمانڈز** علیحدہ سیشن استعمال کرتی ہیں:
  - Discord: `agent:<agentId>:discord:slash:<userId>`
  - Slack: `agent:<agentId>:slack:slash:<userId>` (`channels.slack.slashCommand.sessionPrefix` کے ذریعے سابقہ قابلِ کنفیگ)
  - Telegram: `telegram:slash:<userId>` (`CommandTargetSessionKey` کے ذریعے چیٹ سیشن کو ہدف بناتا ہے)
- **`/stop`** فعال چیٹ سیشن کو ہدف بناتا ہے تاکہ موجودہ رن کو منسوخ کیا جا سکے۔
- **Slack:** `channels.slack.slashCommand` اب بھی ایک واحد `/openclaw` طرز کی کمانڈ کے لیے معاون ہے۔ اگر آپ `commands.native` فعال کریں تو آپ کو ہر بلٹ اِن کمانڈ کے لیے ایک Slack سلैش کمانڈ بنانا ہوگی (وہی نام جو `/help` میں ہیں)۔ Slack کے لیے کمانڈ دلیل مینو عارضی Block Kit بٹنز کے طور پر فراہم کیے جاتے ہیں۔
