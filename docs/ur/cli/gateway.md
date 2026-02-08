---
summary: "OpenClaw Gateway CLI (`openclaw gateway`) — گیٹ ویز کو چلانا، کوئری کرنا، اور دریافت کرنا"
read_when:
  - CLI سے Gateway چلانا (ڈیولپمنٹ یا سرورز)
  - Gateway کی تصدیق، بائنڈ موڈز، اور کنیکٹیوٹی کی ڈیبگنگ
  - Bonjour کے ذریعے گیٹ ویز کی دریافت (LAN + tailnet)
title: "gateway"
x-i18n:
  source_path: cli/gateway.md
  source_hash: cbc1690e6be84073
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:12Z
---

# Gateway CLI

Gateway، OpenClaw کا WebSocket سرور ہے (چینلز، نوڈز، سیشنز، ہکس)۔

اس صفحے میں موجود ذیلی کمانڈز `openclaw gateway …` کے تحت آتی ہیں۔

متعلقہ دستاویزات:

- [/gateway/bonjour](/gateway/bonjour)
- [/gateway/discovery](/gateway/discovery)
- [/gateway/configuration](/gateway/configuration)

## Gateway چلائیں

ایک مقامی Gateway پراسیس چلائیں:

```bash
openclaw gateway
```

Foreground عرف:

```bash
openclaw gateway run
```

نوٹس:

- بطورِ طے شدہ، Gateway اس وقت تک شروع ہونے سے انکار کرتا ہے جب تک `gateway.mode=local` کو `~/.openclaw/openclaw.json` میں سیٹ نہ کیا جائے۔ عارضی/ڈیولپمنٹ رنز کے لیے `--allow-unconfigured` استعمال کریں۔
- تصدیق کے بغیر loopback سے آگے بائنڈ کرنا بلاک ہے (حفاظتی گارڈ ریل)۔
- `SIGUSR1` مجاز ہونے پر اِن-پروسیس ری اسٹارٹ کو متحرک کرتا ہے ( `commands.restart` فعال کریں یا gateway tool/config apply/update استعمال کریں)۔
- `SIGINT`/`SIGTERM` ہینڈلرز gateway پراسیس کو روک دیتے ہیں، مگر کسی بھی کسٹم ٹرمینل اسٹیٹ کو بحال نہیں کرتے۔ اگر آپ CLI کو TUI یا raw-mode اِن پٹ کے ساتھ لپیٹتے ہیں تو خروج سے پہلے ٹرمینل بحال کریں۔

### اختیارات

- `--port <port>`: WebSocket پورٹ (ڈیفالٹ کنفیگ/ماحول سے آتا ہے؛ عموماً `18789`)۔
- `--bind <loopback|lan|tailnet|auto|custom>`: listener بائنڈ موڈ۔
- `--auth <token|password>`: auth موڈ اووررائیڈ۔
- `--token <token>`: ٹوکن اووررائیڈ (پروسیس کے لیے `OPENCLAW_GATEWAY_TOKEN` بھی سیٹ کرتا ہے)۔
- `--password <password>`: پاس ورڈ اووررائیڈ (پروسیس کے لیے `OPENCLAW_GATEWAY_PASSWORD` بھی سیٹ کرتا ہے)۔
- `--tailscale <off|serve|funnel>`: Gateway کو Tailscale کے ذریعے ایکسپوز کریں۔
- `--tailscale-reset-on-exit`: شٹ ڈاؤن پر Tailscale serve/funnel کنفیگ ری سیٹ کریں۔
- `--allow-unconfigured`: کنفیگ میں `gateway.mode=local` کے بغیر gateway شروع کرنے کی اجازت دیں۔
- `--dev`: اگر موجود نہ ہو تو dev کنفیگ + ورک اسپیس بنائیں (BOOTSTRAP.md کو اسکیپ کرتا ہے)۔
- `--reset`: dev کنفیگ + اسناد + سیشنز + ورک اسپیس ری سیٹ کریں ( `--dev` درکار ہے)۔
- `--force`: شروع کرنے سے پہلے منتخب پورٹ پر کسی بھی موجود listener کو ختم کریں۔
- `--verbose`: تفصیلی لاگز۔
- `--claude-cli-logs`: کنسول میں صرف claude-cli لاگز دکھائیں (اور اس کا stdout/stderr فعال کریں)۔
- `--ws-log <auto|full|compact>`: websocket لاگ اسٹائل (ڈیفالٹ `auto`)۔
- `--compact`: `--ws-log compact` کے لیے عرف۔
- `--raw-stream`: خام ماڈل اسٹریم ایونٹس کو jsonl میں لاگ کریں۔
- `--raw-stream-path <path>`: خام اسٹریم jsonl پاتھ۔

## چلتے ہوئے Gateway کو کوئری کریں

تمام کوئری کمانڈز WebSocket RPC استعمال کرتی ہیں۔

آؤٹ پٹ موڈز:

- ڈیفالٹ: انسان کے لیے قابلِ مطالعہ (TTY میں رنگین)۔
- `--json`: مشین کے لیے قابلِ مطالعہ JSON (بغیر اسٹائلنگ/اسپنر)۔
- `--no-color` (یا `NO_COLOR=1`): انسانی لے آؤٹ برقرار رکھتے ہوئے ANSI غیر فعال کریں۔

مشترکہ اختیارات (جہاں معاون ہوں):

- `--url <url>`: Gateway WebSocket URL۔
- `--token <token>`: Gateway ٹوکن۔
- `--password <password>`: Gateway پاس ورڈ۔
- `--timeout <ms>`: ٹائم آؤٹ/بجٹ (ہر کمانڈ کے مطابق مختلف)۔
- `--expect-final`: “final” جواب کا انتظار کریں (ایجنٹ کالز)۔

نوٹ: جب آپ `--url` سیٹ کرتے ہیں تو CLI کنفیگ یا ماحول کی اسناد پر واپس نہیں جاتا۔
`--token` یا `--password` واضح طور پر پاس کریں۔ واضح اسناد کی عدم موجودگی ایک خرابی ہے۔

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

### `gateway status`

`gateway status` Gateway سروس (launchd/systemd/schtasks) کے ساتھ ایک اختیاری RPC پروب دکھاتا ہے۔

```bash
openclaw gateway status
openclaw gateway status --json
```

اختیارات:

- `--url <url>`: پروب URL اووررائیڈ کریں۔
- `--token <token>`: پروب کے لیے ٹوکن auth۔
- `--password <password>`: پروب کے لیے پاس ورڈ auth۔
- `--timeout <ms>`: پروب ٹائم آؤٹ (ڈیفالٹ `10000`)۔
- `--no-probe`: RPC پروب اسکیپ کریں (صرف سروس ویو)۔
- `--deep`: سسٹم لیول سروسز بھی اسکین کریں۔

### `gateway probe`

`gateway probe` “سب کچھ ڈیبگ کریں” کمانڈ ہے۔ یہ ہمیشہ پروب کرتا ہے:

- آپ کے کنفیگر کردہ ریموٹ gateway کو (اگر سیٹ ہو)، اور
- localhost (loopback) کو **حتیٰ کہ جب ریموٹ کنفیگر ہو**۔

اگر متعدد گیٹ ویز قابلِ رسائی ہوں تو یہ سب کو پرنٹ کرتا ہے۔ الگ تھلگ پروفائلز/پورٹس (مثلاً rescue bot) استعمال کرنے پر متعدد گیٹ ویز معاون ہیں، مگر زیادہ تر انسٹالیشنز اب بھی ایک ہی gateway چلاتی ہیں۔

```bash
openclaw gateway probe
openclaw gateway probe --json
```

#### SSH کے ذریعے ریموٹ (Mac ایپ برابری)

macOS ایپ کا “Remote over SSH” موڈ ایک مقامی پورٹ-فارورڈ استعمال کرتا ہے تاکہ ریموٹ gateway (جو شاید صرف loopback پر باؤنڈ ہو) `ws://127.0.0.1:<port>` پر قابلِ رسائی بن جائے۔

CLI متبادل:

```bash
openclaw gateway probe --ssh user@gateway-host
```

اختیارات:

- `--ssh <target>`: `user@host` یا `user@host:port` (پورٹ ڈیفالٹ `22`)۔
- `--ssh-identity <path>`: شناختی فائل۔
- `--ssh-auto`: دریافت شدہ پہلے گیٹ وے ہوسٹ کو SSH ہدف کے طور پر منتخب کریں (صرف LAN/WAB)۔

کنفیگ (اختیاری، بطور ڈیفالٹ استعمال ہوتی ہے):

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

لو لیول RPC ہیلپر۔

```bash
openclaw gateway call status
openclaw gateway call logs.tail --params '{"sinceMs": 60000}'
```

## Gateway سروس کا انتظام کریں

```bash
openclaw gateway install
openclaw gateway start
openclaw gateway stop
openclaw gateway restart
openclaw gateway uninstall
```

نوٹس:

- `gateway install` `--port`, `--runtime`, `--token`, `--force`, `--json` کو سپورٹ کرتا ہے۔
- لائف سائیکل کمانڈز اسکرپٹنگ کے لیے `--json` قبول کرتی ہیں۔

## گیٹ ویز دریافت کریں (Bonjour)

`gateway discover` Gateway بیکنز (`_openclaw-gw._tcp`) کے لیے اسکین کرتا ہے۔

- ملٹی کاسٹ DNS-SD: `local.`
- یونیکاسٹ DNS-SD (Wide-Area Bonjour): ایک ڈومین منتخب کریں (مثال: `openclaw.internal.`) اور split DNS + DNS سرور سیٹ اپ کریں؛ دیکھیں [/gateway/bonjour](/gateway/bonjour)

صرف وہ گیٹ ویز جن میں Bonjour discovery فعال ہو (ڈیفالٹ) بیکن مشتہر کرتے ہیں۔

Wide-Area discovery ریکارڈز میں (TXT) شامل ہیں:

- `role` (gateway رول ہنٹ)
- `transport` (ٹرانسپورٹ ہنٹ، مثلاً `gateway`)
- `gatewayPort` (WebSocket پورٹ، عموماً `18789`)
- `sshPort` (SSH پورٹ؛ اگر موجود نہ ہو تو ڈیفالٹ `22`)
- `tailnetDns` (MagicDNS ہوسٹ نیم، جب دستیاب ہو)
- `gatewayTls` / `gatewayTlsSha256` (TLS فعال + سرٹیفکیٹ فنگرپرنٹ)
- `cliPath` (ریموٹ انسٹالز کے لیے اختیاری ہنٹ)

### `gateway discover`

```bash
openclaw gateway discover
```

اختیارات:

- `--timeout <ms>`: فی کمانڈ ٹائم آؤٹ (browse/resolve)؛ ڈیفالٹ `2000`۔
- `--json`: مشین کے لیے قابلِ مطالعہ آؤٹ پٹ (اسٹائلنگ/اسپنر بھی غیر فعال کرتا ہے)۔

مثالیں:

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```
