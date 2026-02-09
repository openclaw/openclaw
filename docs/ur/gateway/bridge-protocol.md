---
summary: "برج پروٹوکول (لیگیسی نوڈز): TCP JSONL، pairing، اسکوپڈ RPC"
read_when:
  - نوڈ کلائنٹس (iOS/Android/macOS نوڈ موڈ) بناتے یا ڈیبگ کرتے وقت
  - pairing یا برج کی تصدیق کی ناکامیوں کی تفتیش کے دوران
  - گیٹ وے کے ذریعے ظاہر کیے گئے نوڈ سرفیس کا آڈٹ کرتے وقت
title: "برج پروٹوکول"
---

# برج پروٹوکول (لیگیسی نوڈ ٹرانسپورٹ)

Bridge پروٹوکول ایک **legacy** node transport ہے (TCP JSONL)۔ نئے node clients کو اس کے بجائے unified Gateway WebSocket پروٹوکول استعمال کرنا چاہیے۔

اگر آپ آپریٹر یا نوڈ کلائنٹ بنا رہے ہیں تو
[Gateway پروٹوکول](/gateway/protocol) استعمال کریں۔

**نوٹ:** موجودہ OpenClaw builds اب TCP bridge listener کے ساتھ شپ نہیں ہوتے؛ یہ دستاویز تاریخی حوالہ کے طور پر رکھی گئی ہے۔
Legacy `bridge.*` کنفگ keys اب کنفگ schema کا حصہ نہیں ہیں۔

## کیوں ہمارے پاس دونوں ہیں

- **سکیورٹی باؤنڈری**: برج مکمل گیٹ وے API سرفیس کے بجائے ایک محدود اجازت فہرست ظاہر کرتا ہے۔
- **Pairing + نوڈ شناخت**: نوڈ کی شمولیت گیٹ وے کے زیرِ انتظام ہوتی ہے اور ہر نوڈ کے ٹوکن سے منسلک ہوتی ہے۔
- **ڈسکوری UX**: نوڈز LAN پر Bonjour کے ذریعے گیٹ ویز دریافت کر سکتے ہیں، یا براہِ راست tailnet پر کنیکٹ ہو سکتے ہیں۔
- **Loopback WS**: مکمل WS کنٹرول پلین مقامی رہتا ہے جب تک SSH کے ذریعے ٹنل نہ کیا جائے۔

## ٹرانسپورٹ

- TCP، فی لائن ایک JSON آبجیکٹ (JSONL)۔
- اختیاری TLS (جب `bridge.tls.enabled` true ہو)۔
- لیگیسی ڈیفالٹ لسٹنر پورٹ `18790` تھا (موجودہ بلڈز TCP برج شروع نہیں کرتے)۔

جب TLS فعال ہو، تو ڈسکوری TXT ریکارڈز میں `bridgeTls=1` کے ساتھ
`bridgeTlsSha256` شامل ہوتے ہیں تاکہ نوڈز سرٹیفکیٹ کو پن کر سکیں۔

## ہینڈشیک + pairing

1. کلائنٹ نوڈ میٹاڈیٹا + ٹوکن (اگر پہلے سے paired ہو) کے ساتھ `hello` بھیجتا ہے۔
2. اگر paired نہ ہو، تو گیٹ وے `error` (`NOT_PAIRED`/`UNAUTHORIZED`) کے ساتھ جواب دیتا ہے۔
3. کلائنٹ `pair-request` بھیجتا ہے۔
4. گیٹ وے منظوری کا انتظار کرتا ہے، پھر `pair-ok` اور `hello-ok` بھیجتا ہے۔

`hello-ok` `serverName` واپس کرتا ہے اور اس میں `canvasHostUrl` شامل ہو سکتا ہے۔

## فریمز

کلائنٹ → گیٹ وے:

- `req` / `res`: اسکوپڈ گیٹ وے RPC (چیٹ، سیشنز، کنفیگ، ہیلتھ، voicewake، skills.bins)
- `event`: نوڈ سگنلز (وائس ٹرانسکرپٹ، ایجنٹ درخواست، چیٹ سبسکرائب، exec لائف سائیکل)

گیٹ وے → کلائنٹ:

- `invoke` / `invoke-res`: نوڈ کمانڈز (`canvas.*`, `camera.*`, `screen.record`,
  `location.get`, `sms.send`)
- `event`: سبسکرائب کیے گئے سیشنز کے لیے چیٹ اپڈیٹس
- `ping` / `pong`: کیپ الائیو

لیگیسی اجازت فہرست کے نفاذ `src/gateway/server-bridge.ts` میں موجود تھے (ہٹا دیے گئے)۔

## Exec لائف سائیکل ایونٹس

Nodes can emit `exec.finished` or `exec.denied` events to surface system.run activity.
These are mapped to system events in the gateway. (Legacy nodes may still emit `exec.started`.)

پے لوڈ فیلڈز (جب تک نوٹ نہ ہو، سب اختیاری ہیں):

- `sessionKey` (لازم): سسٹم ایونٹ وصول کرنے کے لیے ایجنٹ سیشن۔
- `runId`: گروپنگ کے لیے منفرد exec id۔
- `command`: خام یا فارمیٹ شدہ کمانڈ اسٹرنگ۔
- `exitCode`, `timedOut`, `success`, `output`: تکمیل کی تفصیلات (صرف finished)۔
- `reason`: انکار کی وجہ (صرف denied)۔

## Tailnet کا استعمال

- برج کو tailnet IP پر بائنڈ کریں: `bridge.bind: "tailnet"` میں
  `~/.openclaw/openclaw.json`۔
- کلائنٹس MagicDNS نام یا tailnet IP کے ذریعے کنیکٹ کرتے ہیں۔
- Bonjour **نیٹ ورکس عبور نہیں کرتا**؛ ضرورت پڑنے پر دستی ہوسٹ/پورٹ یا وسیع رقبہ DNS‑SD استعمال کریں۔

## ورژننگ

Bridge فی الحال **implicit v1** ہے (کوئی min/max negotiation نہیں)۔ Backward‑compat متوقع ہے؛ کسی بھی breaking change سے پہلے bridge پروٹوکول ورژن فیلڈ شامل کریں۔
