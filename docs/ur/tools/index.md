---
summary: "OpenClaw کے لیے ایجنٹ ٹول سطح (براؤزر، کینوس، نوڈز، میسج، کرون) جو پرانے `openclaw-*` skills کی جگہ لیتی ہے"
read_when:
  - ایجنٹ ٹولز شامل یا ترمیم کرتے وقت
  - "`openclaw-*` skills کو ریٹائر یا تبدیل کرتے وقت"
title: "Tools"
---

# Tools (OpenClaw)

OpenClaw exposes **first-class agent tools** for browser, canvas, nodes, and cron.
These replace the old `openclaw-*` skills: the tools are typed, no shelling,
and the agent should rely on them directly.

## ٹولز کو غیر فعال کرنا

You can globally allow/deny tools via `tools.allow` / `tools.deny` in `openclaw.json`
(deny wins). This prevents disallowed tools from being sent to model providers.

```json5
{
  tools: { deny: ["browser"] },
}
```

نوٹس:

- میچنگ کیس سے غیر حساس ہے۔
- `*` وائلڈکارڈز سپورٹڈ ہیں (`"*"` کا مطلب تمام ٹولز ہے)۔
- اگر `tools.allow` صرف نامعلوم یا لوڈ نہ ہونے والے پلگ اِن ٹول ناموں کا حوالہ دے، تو OpenClaw وارننگ لاگ کرتا ہے اور اجازت فہرست کو نظرانداز کر دیتا ہے تاکہ بنیادی ٹولز دستیاب رہیں۔

## ٹول پروفائلز (بنیادی اجازت فہرست)

`tools.profile` sets a **base tool allowlist** before `tools.allow`/`tools.deny`.
Per-agent override: `agents.list[].tools.profile`.

پروفائلز:

- `minimal`: صرف `session_status`
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full`: کوئی پابندی نہیں (unset کے برابر)

مثال (بطورِ طے شدہ صرف میسجنگ، اور Slack + Discord ٹولز کی اجازت بھی):

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

مثال (کوڈنگ پروفائل، مگر ہر جگہ exec/process کی ممانعت):

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

مثال (عالمی کوڈنگ پروفائل، میسجنگ-اونلی سپورٹ ایجنٹ):

```json5
{
  tools: { profile: "coding" },
  agents: {
    list: [
      {
        id: "support",
        tools: { profile: "messaging", allow: ["slack"] },
      },
    ],
  },
}
```

## فراہم کنندہ کے لحاظ سے ٹول پالیسی

Use `tools.byProvider` to **further restrict** tools for specific providers
(or a single `provider/model`) without changing your global defaults.
Per-agent override: `agents.list[].tools.byProvider`.

This is applied **after** the base tool profile and **before** allow/deny lists,
so it can only narrow the tool set.
Provider keys accept either `provider` (e.g. `google-antigravity`) or
`provider/model` (e.g. `openai/gpt-5.2`).

مثال (عالمی کوڈنگ پروفائل برقرار رکھیں، مگر Google Antigravity کے لیے کم سے کم ٹولز):

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" },
    },
  },
}
```

مثال (غیر مستحکم اینڈپوائنٹ کے لیے فراہم کنندہ/ماڈل مخصوص اجازت فہرست):

```json5
{
  tools: {
    allow: ["group:fs", "group:runtime", "sessions_list"],
    byProvider: {
      "openai/gpt-5.2": { allow: ["group:fs", "sessions_list"] },
    },
  },
}
```

مثال (ایک فراہم کنندہ کے لیے ایجنٹ مخصوص اوور رائیڈ):

```json5
{
  agents: {
    list: [
      {
        id: "support",
        tools: {
          byProvider: {
            "google-antigravity": { allow: ["message", "sessions_list"] },
          },
        },
      },
    ],
  },
}
```

## ٹول گروپس (شارٹ ہینڈز)

ٹول پالیسیز (گلوبل، ایجنٹ، سینڈباکس) `group:*` اندراجات کی حمایت کرتی ہیں جو متعدد ٹولز میں پھیل جاتے ہیں.
Use these in `tools.allow` / `tools.deny`.

دستیاب گروپس:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:web`: `web_search`, `web_fetch`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: تمام بلٹ اِن OpenClaw ٹولز (فراہم کنندہ پلگ اِنز شامل نہیں)

مثال (صرف فائل ٹولز + براؤزر کی اجازت):

```json5
{
  tools: {
    allow: ["group:fs", "browser"],
  },
}
```

## پلگ اِنز + ٹولز

Plugins can register **additional tools** (and CLI commands) beyond the core set.
انسٹال + کنفیگ کے لیے [Plugins](/tools/plugin) دیکھیں، اور یہ جاننے کے لیے [Skills](/tools/skills) دیکھیں کہ ٹول کے استعمال کی رہنمائی پرامپٹس میں کیسے شامل کی جاتی ہے۔ کچھ پلگ انز اپنے ٹولز کے ساتھ اپنی اسکلز بھی فراہم کرتے ہیں (مثال کے طور پر، وائس کال پلگ ان)۔

اختیاری پلگ اِن ٹولز:

- [Lobster](/tools/lobster): ریزیومیبل منظوریات کے ساتھ ٹائپڈ ورک فلو رن ٹائم (گیٹ وے ہوسٹ پر Lobster CLI درکار ہے)۔
- [LLM Task](/tools/llm-task): ساختہ ورک فلو آؤٹ پٹ کے لیے صرف-JSON LLM مرحلہ (اختیاری اسکیما ویلیڈیشن)۔

## ٹول فہرست

### `apply_patch`

ایک یا ایک سے زیادہ فائلوں پر اسٹرکچرڈ پیچز لاگو کریں۔ ملٹی ہنک ایڈیٹس کے لیے استعمال کریں۔
تجرباتی: `tools.exec.applyPatch.enabled` کے ذریعے فعال کریں (صرف OpenAI ماڈلز)۔

### `exec`

ورک اسپیس میں شیل کمانڈز چلائیں۔

بنیادی پیرامیٹرز:

- `command` (لازم)
- `yieldMs` (ٹائم آؤٹ کے بعد خودکار بیک گراؤنڈ، ڈیفالٹ 10000)
- `background` (فوری بیک گراؤنڈ)
- `timeout` (سیکنڈز؛ حد سے تجاوز پر پروسیس ختم، ڈیفالٹ 1800)
- `elevated` (bool؛ اگر ایلیویٹڈ موڈ فعال/اجازت یافتہ ہو تو ہوسٹ پر چلائیں؛ صرف اس وقت رویہ بدلتا ہے جب ایجنٹ sandboxed ہو)
- `host` (`sandbox | gateway | node`)
- `security` (`deny | allowlist | full`)
- `ask` (`off | on-miss | always`)
- `node` (`host=node` کے لیے نوڈ آئی ڈی/نام)
- حقیقی TTY درکار ہے؟ `pty: true` سیٹ کریں۔

نوٹس:

- بیک گراؤنڈ ہونے پر `sessionId` کے ساتھ `status: "running"` واپس کرتا ہے۔
- بیک گراؤنڈ سیشنز کو پول/لاگ/لکھنے/ختم/صاف کرنے کے لیے `process` استعمال کریں۔
- اگر `process` غیر مجاز ہو، تو `exec` ہم وقت چلتا ہے اور `yieldMs`/`background` کو نظرانداز کرتا ہے۔
- `elevated` کو `tools.elevated` کے علاوہ کسی `agents.list[].tools.elevated` اوور رائیڈ کے ذریعے گیٹ کیا جاتا ہے (دونوں کی اجازت لازم) اور یہ `host=gateway` + `security=full` کا عرف ہے۔
- `elevated` صرف اس وقت رویہ بدلتا ہے جب ایجنٹ sandboxed ہو (ورنہ no-op ہے)۔
- `host=node` macOS معاون ایپ یا ہیڈ لیس نوڈ ہوسٹ (`openclaw node run`) کو ہدف بنا سکتا ہے۔
- گیٹ وے/نوڈ منظوریات اور اجازت فہرستیں: [Exec approvals](/tools/exec-approvals)۔

### `process`

بیک گراؤنڈ exec سیشنز کا انتظام کریں۔

بنیادی ایکشنز:

- `list`, `poll`, `log`, `write`, `kill`, `clear`, `remove`

نوٹس:

- `poll` مکمل ہونے پر نیا آؤٹ پٹ اور ایگزٹ اسٹیٹس واپس کرتا ہے۔
- `log` لائن بیسڈ `offset`/`limit` کو سپورٹ کرتا ہے (`offset` چھوڑ دیں تو آخری N لائنیں ملتی ہیں)۔
- `process` ہر ایجنٹ کے دائرے میں ہے؛ دوسرے ایجنٹس کے سیشن نظر نہیں آتے۔

### `web_search`

Brave Search API استعمال کرتے ہوئے ویب تلاش کریں۔

بنیادی پیرامیٹرز:

- `query` (لازم)
- `count` (1–10؛ ڈیفالٹ `tools.web.search.maxResults` سے)

نوٹس:

- Brave API کلید درکار ہے (سفارش کردہ: `openclaw configure --section web`، یا `BRAVE_API_KEY` سیٹ کریں)۔
- `tools.web.search.enabled` کے ذریعے فعال کریں۔
- جوابات کیش کیے جاتے ہیں (ڈیفالٹ 15 منٹ)۔
- سیٹ اپ کے لیے [Web tools](/tools/web) دیکھیں۔

### `web_fetch`

URL سے قابلِ مطالعہ مواد حاصل کریں اور نکالیں (HTML → markdown/text)۔

بنیادی پیرامیٹرز:

- `url` (لازم)
- `extractMode` (`markdown` | `text`)
- `maxChars` (طویل صفحات کو تراشیں)

نوٹس:

- `tools.web.fetch.enabled` کے ذریعے فعال کریں۔
- `maxChars` کو `tools.web.fetch.maxCharsCap` (ڈیفالٹ 50000) سے محدود کیا جاتا ہے۔
- جوابات کیش کیے جاتے ہیں (ڈیفالٹ 15 منٹ)۔
- JS-ہیوی سائٹس کے لیے براؤزر ٹول کو ترجیح دیں۔
- سیٹ اپ کے لیے [Web tools](/tools/web) دیکھیں۔
- اختیاری اینٹی بوٹ فال بیک کے لیے [Firecrawl](/tools/firecrawl) دیکھیں۔

### `browser`

OpenClaw کے زیرِ انتظام مخصوص براؤزر کو کنٹرول کریں۔

بنیادی ایکشنز:

- `status`, `start`, `stop`, `tabs`, `open`, `focus`, `close`
- `snapshot` (aria/ai)
- `screenshot` (امیج بلاک + `MEDIA:<path>` واپس کرتا ہے)
- `act` (UI ایکشنز: click/type/press/hover/drag/select/fill/resize/wait/evaluate)
- `navigate`, `console`, `pdf`, `upload`, `dialog`

پروفائل مینجمنٹ:

- `profiles` — اسٹیٹس کے ساتھ تمام براؤزر پروفائلز کی فہرست
- `create-profile` — خودکار الاٹڈ پورٹ کے ساتھ نیا پروفائل بنائیں (یا `cdpUrl`)
- `delete-profile` — براؤزر بند کریں، یوزر ڈیٹا حذف کریں، کنفیگ سے ہٹائیں (صرف لوکل)
- `reset-profile` — پروفائل کے پورٹ پر یتیم پروسیس ختم کریں (صرف لوکل)

عام پیرامیٹرز:

- `profile` (اختیاری؛ ڈیفالٹ `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (اختیاری؛ مخصوص نوڈ آئی ڈی/نام منتخب کرتا ہے)
  نوٹس:
- `browser.enabled=true` درکار ہے (ڈیفالٹ `true`؛ غیر فعال کرنے کے لیے `false` سیٹ کریں)۔
- تمام ایکشنز ملٹی انسٹینس سپورٹ کے لیے اختیاری `profile` پیرامیٹر قبول کرتے ہیں۔
- جب `profile` چھوڑ دیا جائے، تو `browser.defaultProfile` استعمال ہوتا ہے (ڈیفالٹ "chrome")۔
- پروفائل نام: صرف لوئر کیس حروف/اعداد + ہائفنز (زیادہ سے زیادہ 64 کریکٹرز)۔
- پورٹ رینج: 18800-18899 (تقریباً 100 پروفائلز زیادہ سے زیادہ)۔
- ریموٹ پروفائلز صرف attach-only ہیں (start/stop/reset نہیں)۔
- اگر براؤزر صلاحیت والا نوڈ منسلک ہو، تو ٹول خودکار طور پر اس کی طرف روٹ کر سکتا ہے (جب تک آپ `target` پِن نہ کریں)۔
- Playwright انسٹال ہونے پر `snapshot` بطورِ طے شدہ `ai` ہوتا ہے؛ ایکسیسبلٹی ٹری کے لیے `aria` استعمال کریں۔
- `snapshot` رول-اسنیپ شاٹ آپشنز (`interactive`, `compact`, `depth`, `selector`) کو بھی سپورٹ کرتا ہے جو `e12` جیسے refs واپس کرتے ہیں۔
- `act` کو `snapshot` سے `ref` درکار ہے (AI اسنیپ شاٹس سے عددی `12`، یا رول اسنیپ شاٹس سے `e12`)؛ نادر CSS سیلیکٹر ضروریات کے لیے `evaluate` استعمال کریں۔
- بطورِ طے شدہ `act` → `wait` سے گریز کریں؛ صرف غیر معمولی صورتوں میں استعمال کریں (جب انتظار کے لیے قابلِ اعتماد UI اسٹیٹ نہ ہو)۔
- `upload` آرم کرنے کے بعد خودکار کلک کے لیے اختیاری طور پر `ref` پاس کر سکتا ہے۔
- `upload`، `inputRef` (aria ref) یا `element` (CSS selector) کو بھی سپورٹ کرتا ہے تاکہ `<input type="file">` براہِ راست سیٹ کیا جا سکے۔

### `canvas`

نوڈ کینوس (present, eval, snapshot, A2UI) کو چلائیں۔

بنیادی ایکشنز:

- `present`, `hide`, `navigate`, `eval`
- `snapshot` (امیج بلاک + `MEDIA:<path>` واپس کرتا ہے)
- `a2ui_push`, `a2ui_reset`

نوٹس:

- اندرونی طور پر گیٹ وے `node.invoke` استعمال کرتا ہے۔
- اگر کوئی `node` فراہم نہ کیا جائے، تو ٹول ڈیفالٹ منتخب کرتا ہے (ایک واحد منسلک نوڈ یا لوکل میک نوڈ)۔
- A2UI صرف v0.8 ہے (کوئی `createSurface` نہیں)؛ CLI لائن ایررز کے ساتھ v0.9 JSONL کو مسترد کرتا ہے۔
- فوری اسموک: `openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"`۔

### `nodes`

جوڑے بنے نوڈز دریافت کریں اور ہدف بنائیں؛ نوٹیفکیشنز بھیجیں؛ کیمرا/اسکرین کیپچر کریں۔

بنیادی ایکشنز:

- `status`, `describe`
- `pending`, `approve`, `reject` (جوڑی بنانا)
- `notify` (macOS `system.notify`)
- `run` (macOS `system.run`)
- `camera_snap`, `camera_clip`, `screen_record`
- `location_get`

نوٹس:

- کیمرا/اسکرین کمانڈز کے لیے نوڈ ایپ کا foreground میں ہونا ضروری ہے۔
- تصاویر امیج بلاکس + `MEDIA:<path>` واپس کرتی ہیں۔
- ویڈیوز `FILE:<path>` (mp4) واپس کرتی ہیں۔
- لوکیشن JSON پے لوڈ واپس کرتی ہے (lat/lon/accuracy/timestamp)۔
- `run` پیرامیٹرز: `command` argv array؛ اختیاری `cwd`, `env` (`KEY=VAL`), `commandTimeoutMs`, `invokeTimeoutMs`, `needsScreenRecording`۔

مثال (`run`):

```json
{
  "action": "run",
  "node": "office-mac",
  "command": ["echo", "Hello"],
  "env": ["FOO=bar"],
  "commandTimeoutMs": 12000,
  "invokeTimeoutMs": 45000,
  "needsScreenRecording": false
}
```

### `image`

کنفیگر شدہ امیج ماڈل کے ساتھ تصویر کا تجزیہ کریں۔

بنیادی پیرامیٹرز:

- `image` (لازم راستہ یا URL)
- `prompt` (اختیاری؛ ڈیفالٹ "Describe the image.")
- `model` (اختیاری اوور رائیڈ)
- `maxBytesMb` (اختیاری سائز حد)

نوٹس:

- صرف اس وقت دستیاب ہے جب `agents.defaults.imageModel` کنفیگر ہو (پرائمری یا فال بیکس)، یا جب آپ کے ڈیفالٹ ماڈل + کنفیگر شدہ auth سے ایک ضمنی امیج ماڈل اخذ کیا جا سکے (best-effort pairing)۔
- امیج ماڈل کو براہِ راست استعمال کرتا ہے (مرکزی چیٹ ماڈل سے آزاد)۔

### `message`

Discord/Google Chat/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams میں پیغامات اور چینل ایکشنز بھیجیں۔

بنیادی ایکشنز:

- `send` (متن + اختیاری میڈیا؛ MS Teams میں Adaptive Cards کے لیے `card` بھی سپورٹڈ ہے)
- `poll` (WhatsApp/Discord/MS Teams پولز)
- `react` / `reactions` / `read` / `edit` / `delete`
- `pin` / `unpin` / `list-pins`
- `permissions`
- `thread-create` / `thread-list` / `thread-reply`
- `search`
- `sticker`
- `member-info` / `role-info`
- `emoji-list` / `emoji-upload` / `sticker-upload`
- `role-add` / `role-remove`
- `channel-info` / `channel-list`
- `voice-status`
- `event-list` / `event-create`
- `timeout` / `kick` / `ban`

نوٹس:

- `send` WhatsApp کو Gateway کے ذریعے روٹ کرتا ہے؛ دیگر چینلز براہِ راست جاتے ہیں۔
- `poll` WhatsApp اور MS Teams کے لیے Gateway استعمال کرتا ہے؛ Discord پولز براہِ راست جاتے ہیں۔
- جب میسج ٹول کال کسی فعال چیٹ سیشن سے بندھی ہو، تو بھیجنے کی کارروائیاں اسی سیشن کے ہدف تک محدود رہتی ہیں تاکہ سیاقی لیکس سے بچا جا سکے۔

### `cron`

Gateway کے کرون جابز اور ویک اپس کا انتظام کریں۔

بنیادی ایکشنز:

- `status`, `list`
- `add`, `update`, `remove`, `run`, `runs`
- `wake` (سسٹم ایونٹ قطار میں ڈالیں + اختیاری فوری ہارٹ بیٹ)

نوٹس:

- `add` ایک مکمل کرون جاب آبجیکٹ کی توقع کرتا ہے (وہی اسکیما جو `cron.add` RPC میں ہے)۔
- `update`، `{ jobId, patch }` استعمال کرتا ہے (`id` مطابقت کے لیے قبول ہے)۔

### `gateway`

چلتے ہوئے Gateway پروسیس کو دوبارہ شروع کریں یا اپ ڈیٹس لاگو کریں (ان-پلیس)۔

بنیادی ایکشنز:

- `restart` (اجازت دیتا ہے + ان-پروسیس ری اسٹارٹ کے لیے `SIGUSR1` بھیجتا ہے؛ `openclaw gateway` ان-پلیس ری اسٹارٹ)
- `config.get` / `config.schema`
- `config.apply` (ویلیڈیٹ + کنفیگ لکھیں + ری اسٹارٹ + ویک)
- `config.patch` (جزوی اپ ڈیٹ مرج + ری اسٹارٹ + ویک)
- `update.run` (اپ ڈیٹ چلائیں + ری اسٹارٹ + ویک)

نوٹس:

- جاری جواب میں خلل سے بچنے کے لیے `delayMs` (ڈیفالٹ 2000) استعمال کریں۔
- `restart` بطورِ طے شدہ غیر فعال ہے؛ `commands.restart: true` کے ساتھ فعال کریں۔

### `sessions_list` / `sessions_history` / `sessions_send` / `sessions_spawn` / `session_status`

سیشنز کی فہرست بنائیں، ٹرانسکرپٹ ہسٹری دیکھیں، یا کسی اور سیشن کو بھیجیں۔

بنیادی پیرامیٹرز:

- `sessions_list`: `kinds?`, `limit?`, `activeMinutes?`, `messageLimit?` (0 = کوئی نہیں)
- `sessions_history`: `sessionKey` (یا `sessionId`), `limit?`, `includeTools?`
- `sessions_send`: `sessionKey` (یا `sessionId`), `message`, `timeoutSeconds?` (0 = فائر اینڈ فورگیٹ)
- `sessions_spawn`: `task`, `label?`, `agentId?`, `model?`, `runTimeoutSeconds?`, `cleanup?`
- `session_status`: `sessionKey?` (ڈیفالٹ موجودہ؛ `sessionId` قبول کرتا ہے)، `model?` (`default` اوور رائیڈ صاف کرتا ہے)

نوٹس:

- `main` براہِ راست چیٹ کی معیاری کلید ہے؛ عالمی/نامعلوم پوشیدہ ہوتے ہیں۔
- `messageLimit > 0` ہر سیشن کے آخری N پیغامات حاصل کرتا ہے (ٹول پیغامات فلٹر ہوتے ہیں)۔
- جب `timeoutSeconds > 0` ہو تو `sessions_send` حتمی تکمیل کا انتظار کرتا ہے۔
- ترسیل/اعلان تکمیل کے بعد ہوتا ہے اور best-effort ہے؛ `status: "ok"` اس بات کی تصدیق کرتا ہے کہ ایجنٹ رن ختم ہوا، نہ کہ اعلان پہنچا۔
- `sessions_spawn` سب-ایجنٹ رن شروع کرتا ہے اور درخواست کنندہ چیٹ میں اعلان کا جواب پوسٹ کرتا ہے۔
- `sessions_spawn` نان بلاکنگ ہے اور فوراً `status: "accepted"` واپس کرتا ہے۔
- `sessions_send` جواب-واپس پنگ-پونگ چلاتا ہے (روکنے کے لیے `REPLY_SKIP` کا جواب دیں؛ زیادہ سے زیادہ ٹرنز `session.agentToAgent.maxPingPongTurns` کے ذریعے، 0–5)۔
- پنگ-پونگ کے بعد، ہدف ایجنٹ **اعلان مرحلہ** چلاتا ہے؛ اعلان دبانے کے لیے `ANNOUNCE_SKIP` کا جواب دیں۔

### `agents_list`

ان ایجنٹ آئی ڈیز کی فہرست بنائیں جنہیں موجودہ سیشن `sessions_spawn` کے ساتھ ہدف بنا سکتا ہے۔

نوٹس:

- نتیجہ ہر ایجنٹ کی اجازت فہرستوں (`agents.list[].subagents.allowAgents`) تک محدود ہے۔
- جب `["*"]` کنفیگر ہو، تو ٹول تمام کنفیگر شدہ ایجنٹس شامل کرتا ہے اور `allowAny: true` کو نشان زد کرتا ہے۔

## پیرامیٹرز (عام)

Gateway بیکڈ ٹولز (`canvas`, `nodes`, `cron`):

- `gatewayUrl` (ڈیفالٹ `ws://127.0.0.1:18789`)
- `gatewayToken` (اگر auth فعال ہو)
- `timeoutMs`

نوٹ: جب `gatewayUrl` سیٹ ہو، تو `gatewayToken` کو واضح طور پر شامل کریں۔ ٹولز اوور رائیڈز کے لیے کنفیگ یا انوائرمنٹ کریڈینشلز وراثت میں نہیں لیتے، اور واضح کریڈینشلز کا نہ ہونا ایک ایرر ہے۔

براؤزر ٹول:

- `profile` (اختیاری؛ ڈیفالٹ `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (اختیاری؛ مخصوص نوڈ آئی ڈی/نام پِن کریں)

## سفارش کردہ ایجنٹ فلوؤز

براؤزر آٹومیشن:

1. `browser` → `status` / `start`
2. `snapshot` (ai یا aria)
3. `act` (click/type/press)
4. بصری تصدیق درکار ہو تو `screenshot`

کینوس رینڈر:

1. `canvas` → `present`
2. `a2ui_push` (اختیاری)
3. `snapshot`

نوڈ ہدف بندی:

1. `nodes` → `status`
2. منتخب نوڈ پر `describe`
3. `notify` / `run` / `camera_snap` / `screen_record`

## حفاظت

- براہِ راست `system.run` سے گریز کریں؛ صرف واضح صارف رضامندی کے ساتھ `nodes` → `run` استعمال کریں۔
- کیمرا/اسکرین کیپچر کے لیے صارف کی رضامندی کا احترام کریں۔
- میڈیا کمانڈز چلانے سے پہلے اجازتیں یقینی بنانے کے لیے `status/describe` استعمال کریں۔

## ٹولز ایجنٹ کو کیسے پیش کیے جاتے ہیں

ٹولز دو متوازی چینلز میں ظاہر کیے جاتے ہیں:

1. **سسٹم پرامپٹ متن**: انسان کے لیے قابلِ مطالعہ فہرست + رہنمائی۔
2. **ٹول اسکیما**: ماڈل API کو بھیجی جانے والی ساختہ فنکشن تعریفیں۔

اس کا مطلب ہے کہ ایجنٹ دونوں چیزیں دیکھتا ہے: “کون سے ٹولز موجود ہیں” اور “انہیں کیسے کال کرنا ہے۔” اگر کوئی ٹول سسٹم پرامپٹ یا اسکیما میں ظاہر نہیں ہوتا، تو ماڈل اسے کال نہیں کر سکتا۔
