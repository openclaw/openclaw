---
summary: "WebSocket گیٹ وے کی معماری، اجزاء، اور کلائنٹ فلو"
read_when:
  - گیٹ وے پروٹوکول، کلائنٹس، یا ٹرانسپورٹس پر کام کرتے وقت
title: "Gateway معماری"
x-i18n:
  source_path: concepts/architecture.md
  source_hash: 14079136faa267d7
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:14Z
---

# Gateway معماری

آخری تازہ کاری: 2026-01-22

## جائزہ

- ایک واحد طویل المدت **Gateway** تمام میسجنگ سرفیسز کا مالک ہوتا ہے (WhatsApp بذریعہ
  Baileys، Telegram بذریعہ grammY، Slack، Discord، Signal، iMessage، WebChat)۔
- کنٹرول‑پلین کلائنٹس (macOS ایپ، CLI، ویب UI، آٹومیشنز) ترتیب دیے گئے بائنڈ ہوسٹ پر
  **WebSocket** کے ذریعے Gateway سے جڑتے ہیں (بطورِ طے شدہ
  `127.0.0.1:18789`)۔
- **Nodes** (macOS/iOS/Android/headless) بھی **WebSocket** کے ذریعے جڑتے ہیں، لیکن
  واضح caps/commands کے ساتھ `role: node` کا اعلان کرتے ہیں۔
- ہر ہوسٹ پر ایک Gateway؛ WhatsApp سیشن کھولنے کی واحد جگہ یہی ہے۔
- ایک **canvas host** (بطورِ طے شدہ `18793`) ایجنٹ‑ایڈیٹ ایبل HTML اور A2UI فراہم کرتا ہے۔

## اجزاء اور فلو

### Gateway (ڈیمن)

- فراہم کنندگان کے کنکشن برقرار رکھتا ہے۔
- ایک ٹائپڈ WS API فراہم کرتا ہے (درخواستیں، جوابات، سرور‑پُش واقعات)۔
- آنے والے فریمز کو JSON Schema کے خلاف ویلیڈیٹ کرتا ہے۔
- `agent`، `chat`، `presence`، `health`، `heartbeat`، `cron` جیسے واقعات خارج کرتا ہے۔

### کلائنٹس (mac ایپ / CLI / ویب ایڈمن)

- ہر کلائنٹ کے لیے ایک WS کنکشن۔
- درخواستیں بھیجتے ہیں (`health`، `status`، `send`، `agent`، `system-presence`)۔
- واقعات کو سبسکرائب کرتے ہیں (`tick`، `agent`، `presence`، `shutdown`)۔

### Nodes (macOS / iOS / Android / headless)

- **اسی WS سرور** سے `role: node` کے ساتھ جڑتے ہیں۔
- `connect` میں ڈیوائس شناخت فراہم کرتے ہیں؛ pairing **ڈیوائس‑بنیاد** پر ہوتی ہے (کردار `node`) اور
  منظوری ڈیوائس pairing اسٹور میں محفوظ رہتی ہے۔
- `canvas.*`، `camera.*`، `screen.record`، `location.get` جیسی کمانڈز ایکسپوز کرتے ہیں۔

پروٹوکول کی تفصیلات:

- [Gateway پروٹوکول](/gateway/protocol)

### WebChat

- ایک جامد UI جو چیٹ ہسٹری اور بھیجنے کے لیے Gateway WS API استعمال کرتا ہے۔
- ریموٹ سیٹ اپس میں، دیگر کلائنٹس کی طرح اسی SSH/Tailscale سرنگ کے ذریعے کنیکٹ ہوتا ہے۔

## کنکشن لائف سائیکل (ایک کلائنٹ)

```
Client                    Gateway
  |                          |
  |---- req:connect -------->|
  |<------ res (ok) ---------|   (or res error + close)
  |   (payload=hello-ok carries snapshot: presence + health)
  |                          |
  |<------ event:presence ---|
  |<------ event:tick -------|
  |                          |
  |------- req:agent ------->|
  |<------ res:agent --------|   (ack: {runId,status:"accepted"})
  |<------ event:agent ------|   (streaming)
  |<------ res:agent --------|   (final: {runId,status,summary})
  |                          |
```

## وائر پروٹوکول (خلاصہ)

- ٹرانسپورٹ: WebSocket، JSON پے لوڈز کے ساتھ ٹیکسٹ فریمز۔
- پہلا فریم **لازم** ہے کہ `connect` ہو۔
- ہینڈ شیک کے بعد:
  - درخواستیں: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - واقعات: `{type:"event", event, payload, seq?, stateVersion?}`
- اگر `OPENCLAW_GATEWAY_TOKEN` (یا `--token`) سیٹ ہو، تو `connect.params.auth.token`
  لازماً میچ کرنا چاہیے، ورنہ ساکٹ بند کر دی جاتی ہے۔
- ضمنی اثر رکھنے والے میتھڈز (`send`، `agent`) کے لیے idempotency keys درکار ہیں تاکہ
  محفوظ انداز میں ری ٹرائی کیا جا سکے؛ سرور ایک قلیل المدت dedupe کیش رکھتا ہے۔
- Nodes کو `role: "node"` کے ساتھ ساتھ caps/commands/permissions کو `connect` میں شامل کرنا لازم ہے۔

## Pairing + مقامی اعتماد

- تمام WS کلائنٹس (آپریٹرز + nodes) `connect` پر **ڈیوائس شناخت** شامل کرتے ہیں۔
- نئی ڈیوائس IDs کے لیے pairing منظوری درکار ہوتی ہے؛ Gateway آئندہ کنکشنز کے لیے **ڈیوائس ٹوکن** جاری کرتا ہے۔
- **مقامی** کنکشنز (loopback یا گیٹ وے ہوسٹ کے اپنے tailnet ایڈریس) کو
  خودکار منظوری دی جا سکتی ہے تاکہ اسی ہوسٹ پر UX ہموار رہے۔
- **غیر مقامی** کنکشنز کو `connect.challenge` nonce پر دستخط کرنا ہوتے ہیں اور
  واضح منظوری درکار ہوتی ہے۔
- Gateway تصدیق (`gateway.auth.*`) **تمام** کنکشنز پر لاگو رہتی ہے، مقامی ہوں یا
  ریموٹ۔

تفصیلات: [Gateway پروٹوکول](/gateway/protocol)، [Pairing](/channels/pairing)،
[Security](/gateway/security)۔

## پروٹوکول ٹائپنگ اور کوڈ جنریشن

- TypeBox اسکیماز پروٹوکول کی تعریف کرتے ہیں۔
- JSON Schema ان اسکیماز سے جنریٹ کیا جاتا ہے۔
- Swift ماڈلز JSON Schema سے جنریٹ کیے جاتے ہیں۔

## ریموٹ رسائی

- ترجیحی: Tailscale یا VPN۔
- متبادل: SSH سرنگ

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- سرنگ کے ذریعے بھی وہی ہینڈ شیک + auth ٹوکن لاگو ہوتا ہے۔
- ریموٹ سیٹ اپس میں WS کے لیے TLS + اختیاری pinning فعال کی جا سکتی ہے۔

## آپریشنز اسنیپ شاٹ

- آغاز: `openclaw gateway` (foreground، لاگز stdout پر)۔
- صحت: `health` بذریعہ WS (جو `hello-ok` میں بھی شامل ہے)۔
- نگرانی: خودکار ری اسٹارٹ کے لیے launchd/systemd۔

## مستقل اصول

- ہر ہوسٹ پر بالکل ایک Gateway ایک واحد Baileys سیشن کنٹرول کرتا ہے۔
- ہینڈ شیک لازمی ہے؛ کوئی بھی non‑JSON یا non‑connect پہلا فریم سخت بندش کا باعث بنتا ہے۔
- واقعات دوبارہ نہیں بھیجے جاتے؛ خلا کی صورت میں کلائنٹس کو ریفریش کرنا ہوگا۔
