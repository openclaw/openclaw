---
summary: "نوڈز: جوڑی بنانا، صلاحیتیں، اجازتیں، اور کینوس/کیمرہ/اسکرین/سسٹم کے لیے CLI مددگار"
read_when:
  - گیٹ وے کے ساتھ iOS/Android نوڈز کو جوڑی بنانا
  - ایجنٹ سیاق کے لیے نوڈ کینوس/کیمرہ کا استعمال
  - نئے نوڈ کمانڈز یا CLI مددگار شامل کرنا
title: "نوڈز"
x-i18n:
  source_path: nodes/index.md
  source_hash: ba259b5c384b9329
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:45Z
---

# نوڈز

ایک **نوڈ** ایک معاون ڈیوائس (macOS/iOS/Android/headless) ہوتا ہے جو Gateway **WebSocket** (وہی پورٹ جو آپریٹرز کے لیے ہے) سے `role: "node"` کے ساتھ جڑتا ہے اور `node.invoke` کے ذریعے ایک کمانڈ سرفیس (مثلاً `canvas.*`، `camera.*`، `system.*`) فراہم کرتا ہے۔ پروٹوکول کی تفصیلات: [Gateway protocol](/gateway/protocol)۔

لیگیسی ٹرانسپورٹ: [Bridge protocol](/gateway/bridge-protocol) (TCP JSONL؛ متروک/موجودہ نوڈز کے لیے ہٹا دیا گیا)۔

macOS **node mode** میں بھی چل سکتا ہے: مینو بار ایپ Gateway کے WS سرور سے جڑتی ہے اور اپنے مقامی کینوس/کیمرہ کمانڈز کو بطور نوڈ فراہم کرتی ہے (لہٰذا `openclaw nodes …` اس میک کے خلاف کام کرتا ہے)۔

نوٹس:

- نوڈز **پیریفرلز** ہیں، گیٹ وے نہیں۔ یہ گیٹ وے سروس نہیں چلاتے۔
- Telegram/WhatsApp وغیرہ کے پیغامات **gateway** پر آتے ہیں، نوڈز پر نہیں۔
- خرابیوں کے ازالے کی رہنمائی: [/nodes/troubleshooting](/nodes/troubleshooting)

## Pairing + status

**WS نوڈز ڈیوائس pairing استعمال کرتے ہیں۔** نوڈز `connect` کے دوران ڈیوائس شناخت پیش کرتے ہیں؛ Gateway `role: node` کے لیے ڈیوائس pairing کی درخواست بناتا ہے۔ ڈیوائسز کے CLI (یا UI) کے ذریعے منظوری دیں۔

فوری CLI:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
```

نوٹس:

- `nodes status` کسی نوڈ کو **paired** نشان زد کرتا ہے جب اس کے ڈیوائس pairing رول میں `node` شامل ہو۔
- `node.pair.*` (CLI: `openclaw nodes pending/approve/reject`) ایک علیحدہ gateway-ملکیتی نوڈ pairing اسٹور ہے؛ یہ WS `connect` ہینڈشیک کو **روکتا نہیں**۔

## Remote node host (system.run)

جب آپ کا Gateway ایک مشین پر چل رہا ہو اور آپ چاہتے ہوں کہ کمانڈز دوسری مشین پر چلیں تو **node host** استعمال کریں۔ ماڈل بدستور **gateway** سے بات کرتا ہے؛ جب `host=node` منتخب ہو تو gateway `exec` کالز کو **node host** کی طرف فارورڈ کرتا ہے۔

### کیا کہاں چلتا ہے

- **Gateway host**: پیغامات وصول کرتا ہے، ماڈل چلاتا ہے، ٹول کالز روٹ کرتا ہے۔
- **Node host**: نوڈ مشین پر `system.run`/`system.which` اجرا کرتا ہے۔
- **Approvals**: node host پر `~/.openclaw/exec-approvals.json` کے ذریعے نافذ ہوتی ہیں۔

### Start a node host (foreground)

نوڈ مشین پر:

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

### Remote gateway via SSH tunnel (loopback bind)

اگر Gateway loopback (`gateway.bind=loopback`، مقامی موڈ میں بطورِ طے شدہ) پر bind ہو، تو ریموٹ node hosts براہِ راست کنیکٹ نہیں ہو سکتے۔ ایک SSH ٹنل بنائیں اور node host کو ٹنل کے لوکل اینڈ کی طرف پوائنٹ کریں۔

مثال (node host -> gateway host):

```bash
# Terminal A (keep running): forward local 18790 -> gateway 127.0.0.1:18789
ssh -N -L 18790:127.0.0.1:18789 user@gateway-host

# Terminal B: export the gateway token and connect through the tunnel
export OPENCLAW_GATEWAY_TOKEN="<gateway-token>"
openclaw node run --host 127.0.0.1 --port 18790 --display-name "Build Node"
```

نوٹس:

- ٹوکن gateway کنفیگ سے `gateway.auth.token` ہے (gateway host پر `~/.openclaw/openclaw.json`)۔
- `openclaw node run` تصدیق کے لیے `OPENCLAW_GATEWAY_TOKEN` پڑھتا ہے۔

### Start a node host (service)

```bash
openclaw node install --host <gateway-host> --port 18789 --display-name "Build Node"
openclaw node restart
```

### Pair + name

gateway host پر:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes list
```

نام رکھنے کے اختیارات:

- `openclaw node run` / `openclaw node install` پر `--display-name` (نوڈ پر `~/.openclaw/node.json` میں محفوظ ہوتا ہے)۔
- `openclaw nodes rename --node <id|name|ip> --name "Build Node"` (gateway اووررائیڈ)۔

### Allowlist the commands

Exec approvals **ہر node host کے لیے** ہوتی ہیں۔ gateway سے allowlist اندراجات شامل کریں:

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

منظوریاں node host پر `~/.openclaw/exec-approvals.json` میں محفوظ ہوتی ہیں۔

### Point exec at the node

ڈیفالٹس کنفیگر کریں (gateway کنفیگ):

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.security allowlist
openclaw config set tools.exec.node "<id-or-name>"
```

یا فی سیشن:

```
/exec host=node security=allowlist node=<id-or-name>
```

ایک بار سیٹ ہو جانے کے بعد، `host=node` کے ساتھ کوئی بھی `exec` کال node host پر چلتی ہے (نوڈ allowlist/approvals کے تابع)۔

متعلقہ:

- [Node host CLI](/cli/node)
- [Exec tool](/tools/exec)
- [Exec approvals](/tools/exec-approvals)

## Invoking commands

کم سطحی (raw RPC):

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

عام “ایجنٹ کو MEDIA اٹیچمنٹ دینا” ورک فلو کے لیے اعلیٰ سطحی مددگار موجود ہیں۔

## Screenshots (canvas snapshots)

اگر نوڈ Canvas (WebView) دکھا رہا ہو تو `canvas.snapshot`، `{ format, base64 }` واپس کرتا ہے۔

CLI مددگار (عارضی فائل میں لکھتا ہے اور `MEDIA:<path>` پرنٹ کرتا ہے):

```bash
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format png
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9
```

### Canvas controls

```bash
openclaw nodes canvas present --node <idOrNameOrIp> --target https://example.com
openclaw nodes canvas hide --node <idOrNameOrIp>
openclaw nodes canvas navigate https://example.com --node <idOrNameOrIp>
openclaw nodes canvas eval --node <idOrNameOrIp> --js "document.title"
```

نوٹس:

- `canvas present` URLs یا لوکل فائل پاتھس (`--target`) قبول کرتا ہے، ساتھ اختیاری `--x/--y/--width/--height` برائے پوزیشننگ۔
- `canvas eval` inline JS (`--js`) یا ایک positional arg قبول کرتا ہے۔

### A2UI (Canvas)

```bash
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
openclaw nodes canvas a2ui reset --node <idOrNameOrIp>
```

نوٹس:

- صرف A2UI v0.8 JSONL سپورٹڈ ہے (v0.9/createSurface مسترد کیا جاتا ہے)۔

## Photos + videos (node camera)

تصاویر (`jpg`):

```bash
openclaw nodes camera list --node <idOrNameOrIp>
openclaw nodes camera snap --node <idOrNameOrIp>            # default: both facings (2 MEDIA lines)
openclaw nodes camera snap --node <idOrNameOrIp> --facing front
```

ویڈیو کلپس (`mp4`):

```bash
openclaw nodes camera clip --node <idOrNameOrIp> --duration 10s
openclaw nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

نوٹس:

- `canvas.*` اور `camera.*` کے لیے نوڈ کا **foregrounded** ہونا ضروری ہے (background کالز `NODE_BACKGROUND_UNAVAILABLE` واپس کرتی ہیں)۔
- کلپ کی مدت محدود کی جاتی ہے (فی الحال `<= 60s`) تاکہ بہت بڑے base64 پےلوڈز سے بچا جا سکے۔
- Android ممکن ہونے پر `CAMERA`/`RECORD_AUDIO` اجازتوں کے لیے پرامپٹ کرے گا؛ مسترد اجازتیں `*_PERMISSION_REQUIRED` کے ساتھ ناکام ہوں گی۔

## Screen recordings (nodes)

نوڈز `screen.record` (mp4) فراہم کرتے ہیں۔ مثال:

```bash
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

نوٹس:

- `screen.record` کے لیے نوڈ ایپ کا foregrounded ہونا ضروری ہے۔
- Android ریکارڈنگ سے پہلے سسٹم اسکرین-کیپچر پرامپٹ دکھائے گا۔
- اسکرین ریکارڈنگز `<= 60s` تک محدود کی جاتی ہیں۔
- `--no-audio` مائیکروفون کیپچر غیر فعال کرتا ہے (iOS/Android پر سپورٹڈ؛ macOS سسٹم کیپچر آڈیو استعمال کرتا ہے)۔
- متعدد اسکرینز دستیاب ہوں تو `--screen <index>` کے ذریعے ڈسپلے منتخب کریں۔

## Location (nodes)

جب سیٹنگز میں Location فعال ہو تو نوڈز `location.get` فراہم کرتے ہیں۔

CLI مددگار:

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

نوٹس:

- Location **بطورِ طے شدہ بند** ہے۔
- “Always” کے لیے سسٹم اجازت درکار ہے؛ background fetch بہترین کوشش (best‑effort) ہے۔
- رسپانس میں lat/lon، accuracy (میٹرز)، اور timestamp شامل ہوتے ہیں۔

## SMS (Android nodes)

Android نوڈز `sms.send` فراہم کر سکتے ہیں جب صارف **SMS** اجازت دے اور ڈیوائس ٹیلی فونی کو سپورٹ کرے۔

کم سطحی invoke:

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from OpenClaw"}'
```

نوٹس:

- صلاحیت مشتہر ہونے سے پہلے Android ڈیوائس پر اجازت پرامپٹ قبول کرنا ضروری ہے۔
- بغیر ٹیلی فونی کے Wi‑Fi‑only ڈیوائسز `sms.send` مشتہر نہیں کریں گی۔

## System commands (node host / mac node)

macOS نوڈ `system.run`، `system.notify`، اور `system.execApprovals.get/set` فراہم کرتا ہے۔
headless node host `system.run`، `system.which`، اور `system.execApprovals.get/set` فراہم کرتا ہے۔

مثالیں:

```bash
openclaw nodes run --node <idOrNameOrIp> -- echo "Hello from mac node"
openclaw nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
```

نوٹس:

- `system.run` پےلوڈ میں stdout/stderr/exit code واپس کرتا ہے۔
- `system.notify` macOS ایپ میں نوٹیفکیشن اجازت کی حالت کا احترام کرتا ہے۔
- `system.run` `--cwd`، `--env KEY=VAL`، `--command-timeout`، اور `--needs-screen-recording` کو سپورٹ کرتا ہے۔
- `system.notify` `--priority <passive|active|timeSensitive>` اور `--delivery <system|overlay|auto>` کو سپورٹ کرتا ہے۔
- macOS نوڈز `PATH` اووررائیڈز چھوڑ دیتے ہیں؛ headless node hosts صرف `PATH` قبول کرتے ہیں جب وہ node host PATH کو prepend کرے۔
- macOS node mode میں، `system.run` macOS ایپ میں exec approvals (Settings → Exec approvals) کے تحت gated ہے۔
  Ask/allowlist/full headless node host کی طرح ہی برتاؤ کرتے ہیں؛ مسترد پرامپٹس `SYSTEM_RUN_DENIED` واپس کرتے ہیں۔
- headless node host پر، `system.run` exec approvals (`~/.openclaw/exec-approvals.json`) کے تحت gated ہے۔

## Exec node binding

جب متعدد نوڈز دستیاب ہوں، آپ exec کو کسی مخصوص نوڈ سے bind کر سکتے ہیں۔
یہ `exec host=node` کے لیے ڈیفالٹ نوڈ سیٹ کرتا ہے (اور فی ایجنٹ اووررائیڈ ہو سکتا ہے)۔

گلوبل ڈیفالٹ:

```bash
openclaw config set tools.exec.node "node-id-or-name"
```

فی ایجنٹ اووررائیڈ:

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

کسی بھی نوڈ کی اجازت دینے کے لیے unset کریں:

```bash
openclaw config unset tools.exec.node
openclaw config unset agents.list[0].tools.exec.node
```

## Permissions map

نوڈز `node.list` / `node.describe` میں ایک `permissions` میپ شامل کر سکتے ہیں، جو اجازت کے نام (مثلاً `screenRecording`، `accessibility`) کے مطابق keyed ہوتا ہے اور boolean اقدار (`true` = granted) رکھتا ہے۔

## Headless node host (cross-platform)

OpenClaw ایک **headless node host** (بغیر UI) چلا سکتا ہے جو Gateway
WebSocket سے جڑتا ہے اور `system.run` / `system.which` فراہم کرتا ہے۔ یہ Linux/Windows پر
یا سرور کے ساتھ کم سے کم نوڈ چلانے کے لیے مفید ہے۔

اسے شروع کریں:

```bash
openclaw node run --host <gateway-host> --port 18789
```

نوٹس:

- Pairing اب بھی درکار ہے (Gateway نوڈ منظوری کا پرامپٹ دکھائے گا)۔
- node host اپنا node id، token، display name، اور gateway کنیکشن معلومات `~/.openclaw/node.json` میں محفوظ کرتا ہے۔
- Exec approvals مقامی طور پر `~/.openclaw/exec-approvals.json` کے ذریعے نافذ ہوتی ہیں
  (دیکھیں [Exec approvals](/tools/exec-approvals))۔
- macOS پر، headless node host قابلِ رسائی ہونے پر companion app exec host کو ترجیح دیتا ہے اور
  ایپ دستیاب نہ ہو تو لوکل اجرا پر واپس آ جاتا ہے۔ ایپ کو لازمی کرنے کے لیے `OPENCLAW_NODE_EXEC_HOST=app` سیٹ کریں،
  یا fallback غیر فعال کرنے کے لیے `OPENCLAW_NODE_EXEC_FALLBACK=0`۔
- جب Gateway WS TLS استعمال کرے تو `--tls` / `--tls-fingerprint` شامل کریں۔

## Mac node mode

- macOS مینو بار ایپ Gateway WS سرور سے بطور نوڈ جڑتی ہے (لہٰذا `openclaw nodes …` اس میک کے خلاف کام کرتا ہے)۔
- ریموٹ موڈ میں، ایپ Gateway پورٹ کے لیے SSH ٹنل کھولتی ہے اور `localhost` سے جڑتی ہے۔
