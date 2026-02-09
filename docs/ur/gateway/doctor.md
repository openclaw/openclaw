---
summary: "Doctor کمانڈ: صحت کی جانچ، کنفیگ مائیگریشنز، اور مرمتی اقدامات"
read_when:
  - Doctor مائیگریشنز شامل یا تبدیل کرتے وقت
  - توڑنے والی کنفیگ تبدیلیاں متعارف کراتے وقت
title: "Doctor"
---

# Doctor

`openclaw doctor` is the repair + migration tool for OpenClaw. It fixes stale
config/state, checks health, and provides actionable repair steps.

## فوری آغاز

```bash
openclaw doctor
```

### ہیڈ لیس / آٹومیشن

```bash
openclaw doctor --yes
```

بغیر پوچھے طے شدہ اختیارات قبول کریں (جہاں قابلِ اطلاق ہو ری اسٹارٹ/سروس/sandbox مرمتی اقدامات سمیت)۔

```bash
openclaw doctor --repair
```

بغیر پوچھے سفارش کردہ مرمتیں لاگو کریں (جہاں محفوظ ہو وہاں مرمتیں + ری اسٹارٹس)۔

```bash
openclaw doctor --repair --force
```

جارحانہ مرمتیں بھی لاگو کریں (حسبِ ضرورت سپروائزر کنفیگز کو اووررائٹ کرتا ہے)۔

```bash
openclaw doctor --non-interactive
```

Run without prompts and only apply safe migrations (config normalization + on-disk state moves). Skips restart/service/sandbox actions that require human confirmation.
Legacy state migrations run automatically when detected.

```bash
openclaw doctor --deep
```

اضافی گیٹ وے انسٹالز کے لیے سسٹم سروسز اسکین کریں (launchd/systemd/schtasks)۔

اگر لکھنے سے پہلے تبدیلیوں کا جائزہ لینا چاہتے ہیں تو پہلے کنفیگ فائل کھولیں:

```bash
cat ~/.openclaw/openclaw.json
```

## یہ کیا کرتا ہے (خلاصہ)

- git انسٹالز کے لیے اختیاری پری فلائٹ اپ ڈیٹ (صرف انٹرایکٹو)۔
- UI پروٹوکول کی تازگی کی جانچ (جب پروٹوکول اسکیما نیا ہو تو Control UI دوبارہ بناتا ہے)۔
- صحت کی جانچ + ری اسٹارٹ پرامپٹ۔
- Skills اسٹیٹس خلاصہ (اہل/غائب/مسدود)۔
- لیگیسی قدروں کے لیے کنفیگ نارملائزیشن۔
- OpenCode Zen فراہم کنندہ اووررائڈ وارننگز (`models.providers.opencode`)۔
- لیگیسی آن-ڈسک اسٹیٹ مائیگریشن (sessions/agent dir/WhatsApp auth)۔
- اسٹیٹ سالمیت اور اجازتوں کی جانچ (sessions, transcripts, state dir)۔
- مقامی طور پر چلانے پر کنفیگ فائل اجازتوں کی جانچ (chmod 600)۔
- ماڈل auth صحت: OAuth ایکسپائری کی جانچ، ختم ہوتی ٹوکنز کو ریفریش کر سکتا ہے، اور auth-profile کول ڈاؤن/غیرفعال حالتوں کی رپورٹ۔
- اضافی ورک اسپیس ڈائریکٹری کی شناخت (`~/openclaw`)۔
- sandboxing فعال ہونے پر Sandbox امیج کی مرمت۔
- لیگیسی سروس مائیگریشن اور اضافی گیٹ وے کی شناخت۔
- Gateway رن ٹائم چیکس (سروس انسٹال مگر چل نہیں رہی؛ کیش شدہ launchd لیبل)۔
- چینل اسٹیٹس وارننگز (چلتے ہوئے گیٹ وے سے پروب کی گئی)۔
- سپروائزر کنفیگ آڈٹ (launchd/systemd/schtasks) اختیاری مرمت کے ساتھ۔
- Gateway رن ٹائم بہترین طریقہ کار کی جانچ (Node بمقابلہ Bun، ورژن-منیجر راستے)۔
- Gateway پورٹ تصادم کی تشخیص (ڈیفالٹ `18789`)۔
- کھلی DM پالیسیوں کے لیے سکیورٹی وارننگز۔
- جب کوئی `gateway.auth.token` سیٹ نہ ہو تو Gateway auth وارننگز (لوکل موڈ؛ ٹوکن جنریشن کی پیشکش)۔
- Linux پر systemd linger کی جانچ۔
- سورس انسٹال چیکس (pnpm ورک اسپیس عدم مطابقت، غائب UI اثاثے، غائب tsx بائنری)۔
- اپ ڈیٹ شدہ کنفیگ + ویزارڈ میٹاڈیٹا لکھتا ہے۔

## تفصیلی رویہ اور جواز

### 0. اختیاری اپ ڈیٹ (git انسٹالز)

اگر یہ git چیک آؤٹ ہے اور doctor انٹرایکٹو طور پر چل رہا ہے تو
doctor چلانے سے پہلے اپ ڈیٹ (fetch/rebase/build) کی پیشکش کرتا ہے۔

### 1. کنفیگ نارملائزیشن

اگر کنفیگ میں لیگیسی ویلیو شیپس ہوں (مثال کے طور پر `messages.ackReaction`
بغیر چینل-خصوصی اووررائڈ کے)، تو doctor انہیں موجودہ
اسکیما میں نارملائز کرتا ہے۔

### 2. لیگیسی کنفیگ کی مائیگریشنز

جب کنفیگ میں منسوخ شدہ کیز ہوں، تو دیگر کمانڈز چلنے سے انکار کرتی ہیں اور
آپ سے `openclaw doctor` چلانے کو کہتی ہیں۔

Doctor یہ کرے گا:

- وضاحت کرے گا کہ کون سی لیگیسی کیز ملی ہیں۔
- لاگو کی گئی مائیگریشن دکھائے گا۔
- اپ ڈیٹ شدہ اسکیما کے ساتھ `~/.openclaw/openclaw.json` دوبارہ لکھے گا۔

Gateway بھی اسٹارٹ اپ پر خودکار طور پر doctor مائیگریشنز چلاتا ہے جب وہ
لیگیسی کنفیگ فارمیٹ شناخت کرے، تاکہ پرانی کنفیگز بغیر دستی مداخلت کے درست ہو جائیں۔

موجودہ مائیگریشنز:

- `routing.allowFrom` → `channels.whatsapp.allowFrom`
- `routing.groupChat.requireMention` → `channels.whatsapp/telegram/imessage.groups."*".requireMention`
- `routing.groupChat.historyLimit` → `messages.groupChat.historyLimit`
- `routing.groupChat.mentionPatterns` → `messages.groupChat.mentionPatterns`
- `routing.queue` → `messages.queue`
- `routing.bindings` → ٹاپ-لیول `bindings`
- `routing.agents`/`routing.defaultAgentId` → `agents.list` + `agents.list[].default`
- `routing.agentToAgent` → `tools.agentToAgent`
- `routing.transcribeAudio` → `tools.media.audio.models`
- `bindings[].match.accountID` → `bindings[].match.accountId`
- `identity` → `agents.list[].identity`
- `agent.*` → `agents.defaults` + `tools.*` (tools/elevated/exec/sandbox/subagents)
- `agent.model`/`allowedModels`/`modelAliases`/`modelFallbacks`/`imageModelFallbacks`
  → `agents.defaults.models` + `agents.defaults.model.primary/fallbacks` + `agents.defaults.imageModel.primary/fallbacks`

### 2b) OpenCode Zen فراہم کنندہ اووررائڈز

If you’ve added `models.providers.opencode` (or `opencode-zen`) manually, it
overrides the built-in OpenCode Zen catalog from `@mariozechner/pi-ai`. That can
force every model onto a single API or zero out costs. Doctor warns so you can
remove the override and restore per-model API routing + costs.

### 3. لیگیسی اسٹیٹ مائیگریشنز (ڈسک لے آؤٹ)

Doctor پرانے آن-ڈسک لے آؤٹس کو موجودہ ساخت میں مائیگریٹ کر سکتا ہے:

- Sessions اسٹور + transcripts:
  - `~/.openclaw/sessions/` سے `~/.openclaw/agents/<agentId>/sessions/` تک
- Agent dir:
  - `~/.openclaw/agent/` سے `~/.openclaw/agents/<agentId>/agent/` تک
- WhatsApp auth اسٹیٹ (Baileys):
  - لیگیسی `~/.openclaw/credentials/*.json` سے (سوائے `oauth.json`)
  - `~/.openclaw/credentials/whatsapp/<accountId>/...` تک (ڈیفالٹ اکاؤنٹ آئی ڈی: `default`)

These migrations are best-effort and idempotent; doctor will emit warnings when
it leaves any legacy folders behind as backups. The Gateway/CLI also auto-migrates
the legacy sessions + agent dir on startup so history/auth/models land in the
per-agent path without a manual doctor run. WhatsApp auth is intentionally only
migrated via `openclaw doctor`.

### 4. اسٹیٹ سالمیت کی جانچ (سیشن پرسسٹنس، روٹنگ، اور حفاظت)

The state directory is the operational brainstem. اگر یہ غائب ہو جائے تو آپ سیشنز، اسناد، لاگز، اور کنفیگ کھو دیتے ہیں (جب تک کہیں اور بیک اپ موجود نہ ہوں)۔

Doctor یہ چیکس کرتا ہے:

- **اسٹیٹ ڈائریکٹری غائب**: تباہ کن اسٹیٹ نقصان کے بارے میں خبردار کرتا ہے، ڈائریکٹری دوبارہ بنانے کا پرامپٹ دیتا ہے،
  اور یاد دہانی کراتا ہے کہ وہ غائب ڈیٹا بازیافت نہیں کر سکتا۔
- **اسٹیٹ ڈائریکٹری اجازتیں**: لکھنے کی اہلیت کی تصدیق کرتا ہے؛ اجازتیں درست کرنے کی پیشکش کرتا ہے
  (اور جب مالک/گروپ عدم مطابقت ہو تو `chown` ہنٹ دیتا ہے)۔
- **سیشن ڈائریکٹریز غائب**: `sessions/` اور سیشن اسٹور ڈائریکٹری
  ہسٹری برقرار رکھنے اور `ENOENT` کریشز سے بچنے کے لیے ضروری ہیں۔
- **ٹرانسکرپٹ عدم مطابقت**: جب حالیہ سیشن اندراجات کی ٹرانسکرپٹ فائلیں غائب ہوں تو خبردار کرتا ہے۔
- **مرکزی سیشن “1-line JSONL”**: نشان دہی کرتا ہے جب مرکزی ٹرانسکرپٹ میں صرف ایک لائن ہو (ہسٹری جمع نہیں ہو رہی)۔
- **متعدد اسٹیٹ ڈائریکٹریز**: خبردار کرتا ہے جب مختلف ہوم ڈائریکٹریز میں متعدد `~/.openclaw` فولڈرز ہوں
  یا جب `OPENCLAW_STATE_DIR` کہیں اور اشارہ کرے (ہسٹری انسٹالز کے درمیان تقسیم ہو سکتی ہے)۔
- **ریموٹ موڈ یاد دہانی**: اگر `gateway.mode=remote` ہو تو doctor یاد دہانی کراتا ہے کہ
  اسے ریموٹ ہوسٹ پر چلائیں (اسٹیٹ وہیں رہتی ہے)۔
- **کنفیگ فائل اجازتیں**: خبردار کرتا ہے اگر `~/.openclaw/openclaw.json`
  گروپ/دنیا کے لیے قابلِ مطالعہ ہو اور `600` تک سخت کرنے کی پیشکش کرتا ہے۔

### 5. ماڈل auth صحت (OAuth ایکسپائری)

Doctor auth اسٹور میں OAuth پروفائلز کا معائنہ کرتا ہے، جب ٹوکن ختم ہونے والے یا ختم شدہ ہوں تو خبردار کرتا ہے، اور محفوظ ہونے پر انہیں ریفریش بھی کر سکتا ہے۔ اگر Anthropic Claude Code پروفائل پرانا ہو تو یہ `claude setup-token` چلانے (یا setup-token پیسٹ کرنے) کی تجویز دیتا ہے۔
ریفریش پرامپٹس صرف انٹرایکٹو (TTY) موڈ میں چلنے پر ظاہر ہوتے ہیں؛ `--non-interactive` ریفریش کی کوششیں چھوڑ دیتا ہے۔

Doctor ان auth پروفائلز کی بھی رپورٹ کرتا ہے جو عارضی طور پر ناقابلِ استعمال ہوں، مثلاً:

- مختصر کول ڈاؤنز (ریٹ لمٹس/ٹائم آؤٹس/auth ناکامیاں)
- طویل غیرفعالیاں (بلنگ/کریڈٹ ناکامیاں)

### 6. Hooks ماڈل کی توثیق

اگر `hooks.gmail.model` سیٹ ہو تو doctor ماڈل حوالہ کو
کیٹلاگ اور اجازت فہرست کے خلاف توثیق کرتا ہے اور جب وہ ریزولو نہ ہو یا ممنوع ہو تو خبردار کرتا ہے۔

### 7. Sandbox امیج کی مرمت

جب sandboxing فعال ہو تو doctor Docker امیجز کی جانچ کرتا ہے اور
اگر موجودہ امیج غائب ہو تو بنانے یا لیگیسی ناموں پر سوئچ کرنے کی پیشکش کرتا ہے۔

### 8. Gateway سروس مائیگریشنز اور صفائی کے اشارے

Doctor لیگیسی گیٹ وے سروسز (launchd/systemd/schtasks) کا پتا لگاتا ہے اور انہیں ہٹانے اور موجودہ گیٹ وے پورٹ کے ساتھ OpenClaw سروس انسٹال کرنے کی پیشکش کرتا ہے۔ یہ اضافی گیٹ وے جیسی سروسز کے لیے بھی اسکین کر سکتا ہے اور صفائی کے اشارے پرنٹ کرتا ہے۔
پروفائل نام والی OpenClaw گیٹ وے سروسز کو فرسٹ کلاس سمجھا جاتا ہے اور انہیں "extra" کے طور پر فلیگ نہیں کیا جاتا۔

### 9. سکیورٹی وارننگز

Doctor وارننگز جاری کرتا ہے جب کوئی فراہم کنندہ اجازت فہرست کے بغیر DMs کے لیے کھلا ہو، یا
جب کوئی پالیسی خطرناک انداز میں کنفیگر کی گئی ہو۔

### 10. systemd linger (Linux)

اگر systemd یوزر سروس کے طور پر چل رہا ہو تو doctor یہ یقینی بناتا ہے کہ lingering فعال ہو تاکہ
لاگ آؤٹ کے بعد بھی گیٹ وے چلتا رہے۔

### 11. Skills اسٹیٹس

Doctor موجودہ ورک اسپیس کے لیے اہل/غائب/مسدود Skills کا ایک مختصر خلاصہ پرنٹ کرتا ہے۔

### 12. Gateway auth چیکس (لوکل ٹوکن)

جب لوکل گیٹ وے پر `gateway.auth` موجود نہ ہو تو Doctor خبردار کرتا ہے اور ٹوکن بنانے کی پیشکش کرتا ہے۔ آٹومیشن میں زبردستی ٹوکن بنانے کے لیے `openclaw doctor --generate-gateway-token` استعمال کریں۔

### 13. Gateway صحت کی جانچ + ری اسٹارٹ

Doctor صحت کی جانچ چلاتا ہے اور جب گیٹ وے غیر صحت مند لگے تو
ری اسٹارٹ کی پیشکش کرتا ہے۔

### 14. چینل اسٹیٹس وارننگز

اگر گیٹ وے صحت مند ہو تو doctor چینل اسٹیٹس پروب چلاتا ہے اور
تجویز کردہ حل کے ساتھ وارننگز رپورٹ کرتا ہے۔

### 15. سپروائزر کنفیگ آڈٹ + مرمت

Doctor انسٹال شدہ سپروائزر کنفیگ (launchd/systemd/schtasks) میں غائب یا پرانی ڈیفالٹس (مثلاً systemd network-online dependencies اور restart delay) کی جانچ کرتا ہے۔ جب عدم مطابقت ملتی ہے تو یہ اپڈیٹ کی سفارش کرتا ہے اور سروس فائل/ٹاسک کو موجودہ ڈیفالٹس کے مطابق دوبارہ لکھ سکتا ہے۔

نوٹس:

- `openclaw doctor` سپروائزر کنفیگ دوبارہ لکھنے سے پہلے پرامپٹ کرتا ہے۔
- `openclaw doctor --yes` ڈیفالٹ مرمتی پرامپٹس قبول کرتا ہے۔
- `openclaw doctor --repair` بغیر پرامپٹس کے سفارش کردہ اصلاحات لاگو کرتا ہے۔
- `openclaw doctor --repair --force` حسبِ ضرورت سپروائزر کنفیگز کو اووررائٹ کرتا ہے۔
- آپ ہمیشہ `openclaw gateway install --force` کے ذریعے مکمل ری رائٹ مجبور کر سکتے ہیں۔

### 16. Gateway رن ٹائم + پورٹ تشخیص

Doctor سروس کے رَن ٹائم (PID، آخری ایگزٹ اسٹیٹس) کا معائنہ کرتا ہے اور خبردار کرتا ہے جب سروس انسٹال ہو مگر حقیقت میں چل نہ رہی ہو۔ یہ گیٹ وے پورٹ (ڈیفالٹ `18789`) پر پورٹ تصادم کی بھی جانچ کرتا ہے اور ممکنہ وجوہات (گیٹ وے پہلے سے چل رہا ہو، SSH ٹنل) رپورٹ کرتا ہے۔

### 17. Gateway رن ٹائم بہترین طریقہ کار

جب گیٹ وے سروس Bun پر یا ورژن مینیجڈ Node پاتھ (`nvm`, `fnm`, `volta`, `asdf` وغیرہ) پر چل رہی ہو تو Doctor خبردار کرتا ہے۔ WhatsApp + Telegram چینلز کو Node درکار ہوتا ہے، اور ورژن مینیجر کے پاتھ اپ گریڈ کے بعد ٹوٹ سکتے ہیں کیونکہ سروس آپ کا شیل init لوڈ نہیں کرتی۔ جب دستیاب ہو تو Doctor سسٹم Node انسٹال (Homebrew/apt/choco) پر منتقل کرنے کی پیشکش کرتا ہے۔

### 18. کنفیگ لکھائی + ویزارڈ میٹاڈیٹا

Doctor کسی بھی کنفیگ تبدیلی کو محفوظ کرتا ہے اور
doctor رن کو ریکارڈ کرنے کے لیے ویزارڈ میٹاڈیٹا اسٹیمپ کرتا ہے۔

### 19. ورک اسپیس ٹپس (بیک اپ + میموری سسٹم)

Doctor غیر موجود ہونے پر ورک اسپیس میموری سسٹم کی تجویز دیتا ہے اور
اگر ورک اسپیس پہلے سے git کے تحت نہ ہو تو بیک اپ ٹِپ پرنٹ کرتا ہے۔

ورک اسپیس اسٹرکچر اور git بیک اپ (سفارش کردہ نجی GitHub یا GitLab) کے لیے مکمل رہنمائی کے لیے
یہ دیکھیں [/concepts/agent-workspace](/concepts/agent-workspace)۔
