---
summary: "سلैش کمانڈز: متن بمقابلہ نیٹو، کنفیگ، اور معاون کمانڈز"
read_when:
  - چیٹ کمانڈز کا استعمال یا کنفیگریشن کرتے وقت
  - کمانڈ روٹنگ یا اجازتوں کی خرابیوں کا ازالہ کرتے وقت
title: "سلैش کمانڈز"
---

# سلैش کمانڈز

کمانڈز کو Gateway کے ذریعے ہینڈل کیا جاتا ہے۔ زیادہ تر کمانڈز کو **standalone** پیغام کے طور پر بھیجنا ضروری ہے جو `/` سے شروع ہو۔
صرف ہوسٹ کے لیے bash چیٹ کمانڈ `!` استعمال کرتی ہے۔ <cmd>`(`/bash <cmd>\` بطور عرف)۔

دو باہم متعلقہ نظام ہیں:

- **کمانڈز**: علیحدہ `/...` پیغامات۔
- **دایرکٹیوز**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/exec`, `/model`, `/queue`۔
  - ماڈل کے دیکھنے سے پہلے دایرکٹیوز پیغام سے ہٹا دیے جاتے ہیں۔
  - عام چیٹ پیغامات میں (صرف دایرکٹیو نہ ہوں)، انہیں “ان لائن اشارے” سمجھا جاتا ہے اور یہ سیشن کی ترتیبات کو **محفوظ** نہیں کرتے۔
  - صرف دایرکٹیو والے پیغامات میں (پیغام میں صرف دایرکٹیوز ہوں)، یہ سیشن میں محفوظ ہو جاتے ہیں اور ایک توثیقی جواب دیتے ہیں۔
  - ہدایات (Directives) صرف **authorized senders** کے لیے لاگو ہوتی ہیں (چینل allowlists/پیئرنگ کے ساتھ `commands.useAccessGroups`)۔
    غیر مجاز بھیجنے والوں کو ہدایات سادہ متن کے طور پر نظر آتی ہیں۔

کچھ **inline shortcuts** بھی ہیں (صرف allowlisted/authorized senders کے لیے): `/help`, `/commands`, `/status`, `/whoami` (`/id`)۔
یہ فوراً چلتے ہیں، ماڈل کے پیغام دیکھنے سے پہلے ہٹا دیے جاتے ہیں، اور باقی متن معمول کے فلو سے گزرتا رہتا ہے۔

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
  - `false` اسٹارٹ اپ پر Discord/Telegram میں پہلے سے رجسٹرڈ کمانڈز کو صاف کر دیتا ہے۔ Slack کمانڈز Slack ایپ میں منظم کی جاتی ہیں اور خودکار طور پر حذف نہیں ہوتیں۔
- `commands.nativeSkills` (بطورِ طے شدہ `"auto"`) جہاں معاونت ہو وہاں **Skill** کمانڈز کو نیٹو طور پر رجسٹر کرتا ہے۔
  - Auto: Discord/Telegram کے لیے آن؛ Slack کے لیے آف (Slack میں ہر Skill کے لیے علیحدہ سلैش کمانڈ بنانا لازم ہے)۔
  - ہر فراہم کنندہ کے لیے اووررائیڈ کرنے کو `channels.discord.commands.nativeSkills`, `channels.telegram.commands.nativeSkills`, یا `channels.slack.commands.nativeSkills` سیٹ کریں (bool یا `"auto"`)۔
- `commands.bash` (ڈیفالٹ `false`) `!` کو فعال کرتا ہے۔ <cmd>` کے ذریعے ہوسٹ شیل کمانڈز چلانے کے لیے (`/bash <cmd>`بطور عرف؛`tools.elevated\` allowlists درکار ہیں)۔
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
- `/bash <command>` (صرف ہوسٹ؛ `!` کا عرف)۔ <command>`؛ `commands.bash: true`+`tools.elevated\` allowlists درکار ہیں)

صرف متن:

- `/compact [instructions]` (دیکھیں [/concepts/compaction](/concepts/compaction))
- `!` <command>`(صرف ہوسٹ؛ ایک وقت میں ایک؛ طویل چلنے والے کاموں کے لیے`!poll`+`!stop\` استعمال کریں)
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
- `/reasoning` (اور `/verbose`) گروپ سیٹنگز میں خطرناک ہیں: یہ اندرونی reasoning یا ٹول آؤٹ پٹ ظاہر کر سکتے ہیں جسے آپ ظاہر نہیں کرنا چاہتے تھے۔ خصوصاً گروپ چیٹس میں، انہیں بند ہی رکھنا بہتر ہے۔
- **فاسٹ پاتھ:** اجازت فہرست والے ارسال کنندگان کے کمانڈ-صرف پیغامات فوراً نمٹائے جاتے ہیں (قطار + ماڈل بائی پاس)۔
- **گروپ مینشن گیٹنگ:** اجازت فہرست والے ارسال کنندگان کے کمانڈ-صرف پیغامات مینشن تقاضوں کو بائی پاس کرتے ہیں۔
- **ان لائن شارٹ کٹس (صرف اجازت فہرست والے ارسال کنندگان):** کچھ کمانڈز عام پیغام میں ضم ہو کر بھی کام کرتی ہیں اور باقی متن ماڈل کے دیکھنے سے پہلے ہٹا دی جاتی ہیں۔
  - مثال: `hey /status` اسٹیٹس کا جواب ٹرگر کرتا ہے، اور باقی متن معمول کے بہاؤ کے مطابق جاری رہتا ہے۔
- فی الحال: `/help`, `/commands`, `/status`, `/whoami` (`/id`)۔
- غیر مجاز کمانڈ-صرف پیغامات خاموشی سے نظرانداز کر دیے جاتے ہیں، اور ان لائن `/...` ٹوکنز کو سادہ متن سمجھا جاتا ہے۔
- **Skill commands:** `user-invocable` اسکلز کو سلیش کمانڈز کے طور پر ظاہر کیا جاتا ہے۔ Names are sanitized to `a-z0-9_` (max 32 chars); collisions get numeric suffixes (e.g. `_2`).
  - `/skill <name> [input]` نام کے ذریعے Skill چلاتا ہے (اس وقت مفید جب نیٹو کمانڈ حدود فی Skill کمانڈ بنانے سے روکیں)۔
  - بطورِ طے شدہ، Skill کمانڈز ماڈل کو عام درخواست کے طور پر فارورڈ کی جاتی ہیں۔
  - Skills اختیاری طور پر `command-dispatch: tool` کا اعلان کر سکتی ہیں تاکہ کمانڈ براہِ راست کسی ٹول کی طرف روٹ ہو (متعین، بغیر ماڈل)۔
  - مثال: `/prose` (OpenProse پلگ ان) — دیکھیں [OpenProse](/prose)۔
- **Native command arguments:** Discord ڈائنامک آپشنز کے لیے آٹو کمپلیٹ استعمال کرتا ہے (اور جب آپ مطلوبہ آرگومنٹس چھوڑ دیں تو بٹن مینیو)۔ Telegram اور Slack اس وقت بٹن مینیو دکھاتے ہیں جب کوئی کمانڈ انتخاب (choices) کو سپورٹ کرے اور آپ آرگومنٹ چھوڑ دیں۔

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

`/debug` آپ کو **runtime-only** کنفیگ اووررائیڈز سیٹ کرنے دیتا ہے (میموری میں، ڈسک پر نہیں)۔ صرف مالک کے لیے۔ بطورِ ڈیفالٹ غیر فعال؛ `commands.debug: true` کے ساتھ فعال کریں۔

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

`/config` آپ کی آن-ڈسک کنفیگ (`openclaw.json`) میں لکھتا ہے۔ صرف مالک کے لیے۔ بطورِ ڈیفالٹ غیر فعال؛ `commands.config: true` کے ساتھ فعال کریں۔

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
- **Slack:** `channels.slack.slashCommand` اب بھی ایک واحد `/openclaw` طرز کی کمانڈ کے لیے سپورٹڈ ہے۔ اگر آپ `commands.native` فعال کرتے ہیں، تو آپ کو ہر built-in کمانڈ کے لیے ایک Slack سلیش کمانڈ بنانی ہوگی (وہی نام جیسے `/help`)۔ Slack کے لیے کمانڈ آرگومنٹ مینیو ephemeral Block Kit بٹنوں کے طور پر فراہم کیے جاتے ہیں۔
