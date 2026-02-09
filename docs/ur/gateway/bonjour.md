---
summary: "Bonjour/mDNS ڈسکوری + ڈیبگنگ (Gateway بیکنز، کلائنٹس، اور عام ناکامی کے انداز)"
read_when:
  - macOS/iOS پر Bonjour ڈسکوری کے مسائل کی ڈیبگنگ
  - mDNS سروس ٹائپس، TXT ریکارڈز، یا ڈسکوری UX میں تبدیلی
title: "Bonjour ڈسکوری"
---

# Bonjour / mDNS ڈسکوری

OpenClaw ایک **صرف‑LAN سہولت** کے طور پر Bonjour (mDNS / DNS‑SD) استعمال کرتا ہے تاکہ ایک فعال Gateway (WebSocket endpoint) دریافت کیا جا سکے۔ یہ best‑effort ہے اور SSH یا Tailnet‑based connectivity کی **جگہ نہیں لیتا**۔

## Tailscale پر Wide‑area Bonjour (Unicast DNS‑SD)

اگر node اور gateway مختلف نیٹ ورکس پر ہوں تو multicast mDNS اس حد (boundary) کو عبور نہیں کرے گا۔ آپ **unicast DNS‑SD** ("Wide‑Area Bonjour") پر Tailscale کے ذریعے سوئچ کر کے وہی discovery UX برقرار رکھ سکتے ہیں۔

اعلیٰ سطحی مراحل:

1. گیٹ وے ہوسٹ پر ایک DNS سرور چلائیں (Tailnet کے ذریعے قابلِ رسائی)۔
2. ایک مخصوص زون کے تحت `_openclaw-gw._tcp` کے لیے DNS‑SD ریکارڈز شائع کریں
   (مثال: `openclaw.internal.`)۔
3. Tailscale **split DNS** کنفیگر کریں تاکہ آپ کا منتخب ڈومین کلائنٹس
   (بشمول iOS) کے لیے اسی DNS سرور کے ذریعے resolve ہو۔

OpenClaw کسی بھی discovery domain کو سپورٹ کرتا ہے؛ `openclaw.internal.` محض ایک مثال ہے۔
iOS/Android nodes `local.` اور آپ کے کنفیگر کیے گئے wide‑area domain دونوں کو براؤز کرتے ہیں۔

### Gateway کنفیگ (سفارش کردہ)

```json5
{
  gateway: { bind: "tailnet" }, // tailnet-only (recommended)
  discovery: { wideArea: { enabled: true } }, // enables wide-area DNS-SD publishing
}
```

### ایک مرتبہ DNS سرور سیٹ اپ (گیٹ وے ہوسٹ)

```bash
openclaw dns setup --apply
```

یہ CoreDNS انسٹال کرتا ہے اور اسے اس طرح کنفیگر کرتا ہے کہ:

- پورٹ 53 پر صرف گیٹ وے کی Tailscale انٹرفیسز پر listen کرے
- آپ کے منتخب ڈومین (مثال: `openclaw.internal.`) کو `~/.openclaw/dns/<domain>.db` سے serve کرے

tailnet‑سے منسلک مشین پر تصدیق کریں:

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### Tailscale DNS سیٹنگز

Tailscale ایڈمن کنسول میں:

- گیٹ وے کے tailnet IP کی طرف اشارہ کرنے والا ایک nameserver شامل کریں (UDP/TCP 53)۔
- split DNS شامل کریں تاکہ آپ کا ڈسکوری ڈومین اسی nameserver کو استعمال کرے۔

جب کلائنٹس tailnet DNS قبول کر لیں، تو iOS نوڈز ملٹی کاسٹ کے بغیر
آپ کے ڈسکوری ڈومین میں `_openclaw-gw._tcp` براؤز کر سکتے ہیں۔

### Gateway listener سکیورٹی (سفارش کردہ)

The Gateway WS port (default `18789`) binds to loopback by default. LAN/tailnet رسائی کے لیے، واضح طور پر bind کریں اور auth کو فعال رکھیں۔

صرف tailnet سیٹ اپس کے لیے:

- `~/.openclaw/openclaw.json` میں `gateway.bind: "tailnet"` سیٹ کریں۔
- Gateway کو ری اسٹارٹ کریں (یا macOS مینو بار ایپ ری اسٹارٹ کریں)۔

## کیا اشتہار دیا جاتا ہے

صرف Gateway، `_openclaw-gw._tcp` کا اشتہار دیتا ہے۔

## سروس ٹائپس

- `_openclaw-gw._tcp` — گیٹ وے ٹرانسپورٹ بیکن (macOS/iOS/Android نوڈز کے ذریعے استعمال ہوتا ہے)۔

## TXT کیز (غیر خفیہ اشارے)

Gateway، UI فلو کو سہل بنانے کے لیے چھوٹے غیر خفیہ اشارے اشتہار دیتا ہے:

- `role=gateway`
- `displayName=<friendly name>`
- `lanHost=<hostname>.local`
- `gatewayPort=<port>` (Gateway WS + HTTP)
- `gatewayTls=1` (صرف جب TLS فعال ہو)
- `gatewayTlsSha256=<sha256>` (صرف جب TLS فعال ہو اور فنگرپرنٹ دستیاب ہو)
- `canvasPort=<port>` (صرف جب canvas ہوسٹ فعال ہو؛ ڈیفالٹ `18793`)
- `sshPort=<port>` (جب override نہ ہو تو بطورِ طے شدہ 22)
- `transport=gateway`
- `cliPath=<path>` (اختیاری؛ runnable `openclaw` انٹری پوائنٹ کا مطلق راستہ)
- `tailnetDns=<magicdns>` (جب Tailnet دستیاب ہو تو اختیاری اشارہ)

## macOS پر ڈیبگنگ

کارآمد بلٹ‑ان اوزار:

- انسٹینسز براؤز کریں:

  ```bash
  dns-sd -B _openclaw-gw._tcp local.
  ```

- ایک انسٹینس resolve کریں ( `<instance>` کو بدلیں):

  ```bash
  dns-sd -L "<instance>" _openclaw-gw._tcp local.
  ```

اگر براؤزنگ کام کرتی ہے مگر resolving ناکام ہو جائے، تو عموماً یہ LAN پالیسی یا
mDNS resolver مسئلہ ہوتا ہے۔

## Gateway لاگز میں ڈیبگنگ

Gateway ایک rolling log فائل لکھتا ہے (startup پر پرنٹ ہوتی ہے بطور `gateway log file: ...`)۔ `bonjour:` والی لائنیں دیکھیں، خاص طور پر:

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`

## iOS نوڈ پر ڈیبگنگ

iOS نوڈ، `NWBrowser` استعمال کر کے `_openclaw-gw._tcp` دریافت کرتا ہے۔

لاگز حاصل کرنے کے لیے:

- Settings → Gateway → Advanced → **Discovery Debug Logs**
- Settings → Gateway → Advanced → **Discovery Logs** → reproduce → **Copy**

لاگ میں براؤزر اسٹیٹ ٹرانزیشنز اور رزلٹ‑سیٹ تبدیلیاں شامل ہوتی ہیں۔

## عام ناکامی کے انداز

- **Bonjour نیٹ ورکس عبور نہیں کرتا**: Tailnet یا SSH استعمال کریں۔
- **ملٹی کاسٹ بلاک**: کچھ Wi‑Fi نیٹ ورکس mDNS کو غیر فعال کر دیتے ہیں۔
- **Sleep / انٹرفیس churn**: macOS عارضی طور پر mDNS نتائج گرا سکتا ہے؛ دوبارہ کوشش کریں۔
- **Browse کام کرتا ہے مگر resolve ناکام**: مشین کے نام سادہ رکھیں (emojis یا punctuation سے گریز کریں)، پھر Gateway ری اسٹارٹ کریں۔ سروس instance کا نام host name سے اخذ ہوتا ہے، اس لیے حد سے زیادہ پیچیدہ نام کچھ resolvers کو کنفیوز کر سکتے ہیں۔

## Escaped انسٹینس نام (`\032`)

Bonjour/DNS‑SD اکثر سروس انسٹینس ناموں میں بائٹس کو اعشاری `\DDD`
سیکوئنسز کے طور پر escape کرتا ہے (مثلاً اسپیس `\032` بن جاتی ہے)۔

- یہ پروٹوکول کی سطح پر معمول کی بات ہے۔
- UIs کو ڈسپلے کے لیے decode کرنا چاہیے (iOS `BonjourEscapes.decode` استعمال کرتا ہے)۔

## غیر فعال کرنا / کنفیگریشن

- `OPENCLAW_DISABLE_BONJOUR=1` اشتہار بندی کو غیر فعال کرتا ہے (legacy: `OPENCLAW_DISABLE_BONJOUR`)۔
- `~/.openclaw/openclaw.json` میں `gateway.bind` Gateway bind موڈ کنٹرول کرتا ہے۔
- `OPENCLAW_SSH_PORT` TXT میں اشتہار دیے گئے SSH پورٹ کو override کرتا ہے (legacy: `OPENCLAW_SSH_PORT`)۔
- `OPENCLAW_TAILNET_DNS` TXT میں MagicDNS کا اشارہ شائع کرتا ہے (legacy: `OPENCLAW_TAILNET_DNS`)۔
- `OPENCLAW_CLI_PATH` اشتہار دیے گئے CLI راستے کو override کرتا ہے (legacy: `OPENCLAW_CLI_PATH`)۔

## متعلقہ دستاویزات

- ڈسکوری پالیسی اور ٹرانسپورٹ کا انتخاب: [Discovery](/gateway/discovery)
- نوڈ pairing + منظوریات: [Gateway pairing](/gateway/pairing)
