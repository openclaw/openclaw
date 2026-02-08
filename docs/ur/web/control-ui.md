---
summary: "Gateway کے لیے براؤزر پر مبنی کنٹرول UI (چیٹ، نوڈز، کنفیگ)"
read_when:
  - آپ براؤزر سے Gateway کو چلانا چاہتے ہیں
  - آپ SSH سرنگوں کے بغیر Tailnet رسائی چاہتے ہیں
title: "کنٹرول UI"
x-i18n:
  source_path: web/control-ui.md
  source_hash: baaaf73820f0e703
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:07Z
---

# کنٹرول UI (براؤزر)

کنٹرول UI ایک چھوٹی **Vite + Lit** سنگل پیج ایپ ہے جو Gateway کے ذریعے فراہم کی جاتی ہے:

- ڈیفالٹ: `http://<host>:18789/`
- اختیاری پری فکس: `gateway.controlUi.basePath` سیٹ کریں (مثلاً `/openclaw`)

یہ اسی پورٹ پر **Gateway WebSocket** سے **براہِ راست** بات کرتا ہے۔

## فوری کھولیں (لوکل)

اگر Gateway اسی کمپیوٹر پر چل رہا ہو تو کھولیں:

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (یا [http://localhost:18789/](http://localhost:18789/))

اگر صفحہ لوڈ نہ ہو تو پہلے Gateway شروع کریں: `openclaw gateway`۔

تصدیق WebSocket ہینڈ شیک کے دوران فراہم کی جاتی ہے بذریعہ:

- `connect.params.auth.token`
- `connect.params.auth.password`
  ڈیش بورڈ کی سیٹنگز پینل آپ کو ٹوکن محفوظ کرنے دیتا ہے؛ پاس ورڈز محفوظ نہیں کیے جاتے۔
  آن بورڈنگ وزارڈ بطورِ طے شدہ ایک گیٹ وے ٹوکن بناتا ہے، لہٰذا پہلی کنکشن پر اسے یہاں پیسٹ کریں۔

## ڈیوائس جوڑی بنانا (پہلا کنکشن)

جب آپ کسی نئے براؤزر یا ڈیوائس سے کنٹرول UI سے جڑتے ہیں تو Gateway
ایک **یک وقتی جوڑی منظوری** درکار کرتا ہے — چاہے آپ اسی Tailnet پر ہوں
`gateway.auth.allowTailscale: true` کے ساتھ۔ یہ غیر مجاز رسائی روکنے کے لیے ایک حفاظتی اقدام ہے۔

**آپ کیا دیکھیں گے:** "disconnected (1008): pairing required"

**ڈیوائس منظور کرنے کے لیے:**

```bash
# List pending requests
openclaw devices list

# Approve by request ID
openclaw devices approve <requestId>
```

منظوری کے بعد، ڈیوائس یاد رکھی جاتی ہے اور دوبارہ منظوری درکار نہیں ہوگی جب تک
آپ اسے `openclaw devices revoke --device <id> --role <role>` کے ساتھ منسوخ نہ کریں۔ ٹوکن روٹیشن اور منسوخی کے لیے
[Devices CLI](/cli/devices) دیکھیں۔

**نوٹس:**

- لوکل کنکشنز (`127.0.0.1`) خودکار طور پر منظور ہو جاتے ہیں۔
- ریموٹ کنکشنز (LAN، Tailnet وغیرہ) کے لیے واضح منظوری درکار ہوتی ہے۔
- ہر براؤزر پروفائل ایک منفرد ڈیوائس ID بناتا ہے، اس لیے براؤزر تبدیل کرنے یا
  براؤزر ڈیٹا صاف کرنے پر دوبارہ جوڑی بنانا لازم ہوگا۔

## یہ آج کیا کر سکتا ہے

- Gateway WS کے ذریعے ماڈل سے چیٹ (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`)
- چیٹ میں ٹول کالز کی اسٹریمنگ + لائیو ٹول آؤٹ پٹ کارڈز (ایجنٹ ایونٹس)
- چینلز: WhatsApp/Telegram/Discord/Slack + پلگ اِن چینلز (Mattermost وغیرہ) کی حالت + QR لاگ اِن + فی چینل کنفیگ (`channels.status`, `web.login.*`, `config.patch`)
- انسٹینسز: موجودگی فہرست + ریفریش (`system-presence`)
- سیشنز: فہرست + فی سیشن تھنکنگ/وربوز اوور رائیڈز (`sessions.list`, `sessions.patch`)
- کرون جابز: فہرست/شامل کریں/چلائیں/فعال کریں/غیرفعال کریں + رن ہسٹری (`cron.*`)
- Skills: اسٹیٹس، فعال/غیرفعال، انسٹال، API کلید اپ ڈیٹس (`skills.*`)
- نوڈز: فہرست + کیپس (`node.list`)
- Exec approvals: گیٹ وے یا نوڈ اجازت فہرستیں ترمیم کریں + `exec host=gateway/node` کے لیے پالیسی سے پوچھیں (`exec.approvals.*`)
- کنفیگ: دیکھیں/ترمیم کریں `~/.openclaw/openclaw.json` (`config.get`, `config.set`)
- کنفیگ: لاگو کریں + ویلیڈیشن کے ساتھ ری اسٹارٹ (`config.apply`) اور آخری فعال سیشن کو جگائیں
- کنفیگ لکھائی میں ہم زمانی ترمیمات کو اوور رائٹ ہونے سے بچانے کے لیے بیس-ہیش گارڈ شامل ہے
- کنفیگ اسکیما + فارم رینڈرنگ (`config.schema`، بشمول پلگ اِن + چینل اسکیماز)؛ را JSON ایڈیٹر دستیاب رہتا ہے
- ڈیبگ: اسٹیٹس/ہیلتھ/ماڈلز اسنیپ شاٹس + ایونٹ لاگ + دستی RPC کالز (`status`, `health`, `models.list`)
- لاگز: گیٹ وے فائل لاگز کا لائیو ٹیل فلٹر/ایکسپورٹ کے ساتھ (`logs.tail`)
- اپ ڈیٹ: پیکیج/گِٹ اپ ڈیٹ چلائیں + ری اسٹارٹ (`update.run`) ری اسٹارٹ رپورٹ کے ساتھ

کرون جابز پینل نوٹس:

- علیحدہ جابز کے لیے، ڈیلیوری بطورِ طے شدہ اعلانِ خلاصہ ہوتی ہے۔ اگر آپ صرف اندرونی رنز چاہتے ہیں تو none پر سوئچ کر سکتے ہیں۔
- جب announce منتخب ہو تو چینل/ٹارگٹ فیلڈز ظاہر ہوتے ہیں۔

## چیٹ رویّہ

- `chat.send` **نان بلاکنگ** ہے: یہ فوراً `{ runId, status: "started" }` کے ساتھ اَیک کرتا ہے اور جواب `chat` ایونٹس کے ذریعے اسٹریمنگ ہوتا ہے۔
- اسی `idempotencyKey` کے ساتھ دوبارہ بھیجنے پر، چلتے وقت `{ status: "in_flight" }` اور تکمیل کے بعد `{ status: "ok" }` واپس آتا ہے۔
- `chat.inject` سیشن ٹرانسکرپٹ میں اسسٹنٹ نوٹ شامل کرتا ہے اور صرف UI اپ ڈیٹس کے لیے `chat` ایونٹ نشر کرتا ہے (کوئی ایجنٹ رن نہیں، کوئی چینل ڈیلیوری نہیں)۔
- روکیں:
  - **Stop** پر کلک کریں (کال کرتا ہے `chat.abort`)
  - `/stop` ٹائپ کریں (یا `stop|esc|abort|wait|exit|interrupt`) آؤٹ آف بینڈ منسوخی کے لیے
  - `chat.abort` `{ sessionKey }` کی حمایت کرتا ہے (بغیر `runId`) تاکہ اس سیشن کے تمام فعال رنز منسوخ ہو جائیں

## Tailnet رسائی (سفارش کردہ)

### مربوط Tailscale Serve (ترجیحی)

Gateway کو لوپ بیک پر رکھیں اور Tailscale Serve کو HTTPS کے ساتھ پروکسی کرنے دیں:

```bash
openclaw gateway --tailscale serve
```

کھولیں:

- `https://<magicdns>/` (یا آپ کا کنفیگر کیا گیا `gateway.controlUi.basePath`)

بطورِ طے شدہ، Serve درخواستیں Tailscale شناختی ہیڈرز کے ذریعے تصدیق کر سکتی ہیں
(`tailscale-user-login`) جب `gateway.auth.allowTailscale` `true` ہو۔ OpenClaw
شناخت کی تصدیق `x-forwarded-for` ایڈریس کو `tailscale whois` کے ساتھ حل کر کے
اور اسے ہیڈر سے میچ کر کے کرتا ہے، اور صرف اسی وقت قبول کرتا ہے جب
درخواست لوپ بیک پر Tailscale کے `x-forwarded-*` ہیڈرز کے ساتھ آئے۔ سیٹ کریں
`gateway.auth.allowTailscale: false` (یا زبردستی `gateway.auth.mode: "password"`)
اگر آپ Serve ٹریفک کے لیے بھی ٹوکن/پاس ورڈ لازم کرنا چاہتے ہیں۔

### Tailnet پر بائنڈ + ٹوکن

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

پھر کھولیں:

- `http://<tailscale-ip>:18789/` (یا آپ کا کنفیگر کیا گیا `gateway.controlUi.basePath`)

ٹوکن UI سیٹنگز میں پیسٹ کریں (بطور `connect.params.auth.token` بھیجا جاتا ہے)۔

## غیر محفوظ HTTP

اگر آپ ڈیش بورڈ کو سادہ HTTP پر کھولیں (`http://<lan-ip>` یا `http://<tailscale-ip>`)،
تو براؤزر **غیر محفوظ کانٹیکسٹ** میں چلتا ہے اور WebCrypto کو بلاک کرتا ہے۔ بطورِ طے شدہ،
OpenClaw ڈیوائس شناخت کے بغیر کنٹرول UI کنکشنز کو **بلاک** کرتا ہے۔

**سفارش کردہ حل:** HTTPS استعمال کریں (Tailscale Serve) یا UI کو لوکلی کھولیں:

- `https://<magicdns>/` (Serve)
- `http://127.0.0.1:18789/` (گیٹ وے ہوسٹ پر)

**ڈاؤن گریڈ مثال (HTTP پر صرف ٹوکن):**

```json5
{
  gateway: {
    controlUi: { allowInsecureAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

یہ کنٹرول UI کے لیے ڈیوائس شناخت + جوڑی بنانا غیر فعال کر دیتا ہے (حتیٰ کہ HTTPS پر بھی)۔ صرف اسی صورت استعمال کریں جب آپ نیٹ ورک پر بھروسا کرتے ہوں۔

HTTPS سیٹ اپ رہنمائی کے لیے [Tailscale](/gateway/tailscale) دیکھیں۔

## UI کی بلڈنگ

Gateway جامد فائلیں `dist/control-ui` سے فراہم کرتا ہے۔ انہیں یوں بلڈ کریں:

```bash
pnpm ui:build # auto-installs UI deps on first run
```

اختیاری مطلق بیس (جب آپ فکسڈ اثاثہ URLs چاہتے ہوں):

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

لوکل ڈیولپمنٹ کے لیے (الگ ڈیو سرور):

```bash
pnpm ui:dev # auto-installs UI deps on first run
```

پھر UI کو اپنے Gateway WS URL کی طرف پوائنٹ کریں (مثلاً `ws://127.0.0.1:18789`)۔

## ڈیبگنگ/ٹیسٹنگ: ڈیو سرور + ریموٹ Gateway

کنٹرول UI جامد فائلیں ہیں؛ WebSocket ٹارگٹ قابلِ کنفیگ ہے اور HTTP اوریجن سے مختلف ہو سکتا ہے۔ یہ اس وقت مفید ہے جب آپ لوکل Vite ڈیو سرور چاہتے ہوں مگر Gateway کہیں اور چل رہا ہو۔

1. UI ڈیو سرور شروع کریں: `pnpm ui:dev`
2. اس طرح کا URL کھولیں:

```text
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789
```

اختیاری یک وقتی تصدیق (اگر درکار ہو):

```text
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789&token=<gateway-token>
```

نوٹس:

- `gatewayUrl` لوڈ کے بعد localStorage میں محفوظ ہوتا ہے اور URL سے ہٹا دیا جاتا ہے۔
- `token` localStorage میں محفوظ ہوتا ہے؛ `password` صرف میموری میں رکھا جاتا ہے۔
- جب `gatewayUrl` سیٹ ہو، UI کنفیگ یا ماحول کی اسناد پر فال بیک نہیں کرتا۔
  `token` (یا `password`) واضح طور پر فراہم کریں۔ واضح اسناد کی کمی ایک غلطی ہے۔
- جب Gateway TLS کے پیچھے ہو (Tailscale Serve، HTTPS پراکسی وغیرہ) تو `wss://` استعمال کریں۔
- `gatewayUrl` صرف ٹاپ لیول ونڈو میں قبول کیا جاتا ہے (ایمبیڈڈ نہیں) تاکہ کلک جیکنگ روکی جا سکے۔
- کراس اوریجن ڈیو سیٹ اپس کے لیے (مثلاً `pnpm ui:dev` سے ریموٹ Gateway)، UI
  اوریجن کو `gateway.controlUi.allowedOrigins` میں شامل کریں۔

مثال:

```json5
{
  gateway: {
    controlUi: {
      allowedOrigins: ["http://localhost:5173"],
    },
  },
}
```

ریموٹ رسائی سیٹ اپ کی تفصیلات: [Remote access](/gateway/remote)۔
