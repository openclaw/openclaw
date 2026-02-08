---
summary: "OpenClaw macOS معاون ایپ (مینو بار + گیٹ وے بروکر)"
read_when:
  - macOS ایپ کی خصوصیات نافذ کرتے وقت
  - macOS پر گیٹ وے لائف سائیکل یا نوڈ برِجنگ تبدیل کرتے وقت
title: "macOS ایپ"
x-i18n:
  source_path: platforms/macos.md
  source_hash: a5b1c02e5905e4cb
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:42Z
---

# OpenClaw macOS Companion (menu bar + gateway broker)

macOS ایپ OpenClaw کے لیے **مینو بار معاون** ہے۔ یہ اجازتوں کی ملکیت رکھتی ہے،
Gateway کو مقامی طور پر منظم/منسلک کرتی ہے (launchd یا دستی)، اور macOS کی
صلاحیتوں کو بطور نوڈ ایجنٹ کے سامنے ظاہر کرتی ہے۔

## What it does

- مینو بار میں مقامی نوٹیفیکیشنز اور اسٹیٹس دکھاتی ہے۔
- TCC پرامپس کی ملکیت رکھتی ہے (Notifications, Accessibility, Screen Recording, Microphone,
  Speech Recognition, Automation/AppleScript)۔
- Gateway کو چلاتی ہے یا اس سے جڑتی ہے (مقامی یا ریموٹ)۔
- صرف macOS کے اوزار ظاہر کرتی ہے (Canvas, Camera, Screen Recording, `system.run`)۔
- **remote** موڈ میں مقامی نوڈ ہوسٹ سروس شروع کرتی ہے (launchd)، اور **local** موڈ میں اسے روکتی ہے۔
- اختیاری طور پر UI آٹومیشن کے لیے **PeekabooBridge** ہوسٹ کرتی ہے۔
- درخواست پر npm/pnpm کے ذریعے عالمی CLI (`openclaw`) انسٹال کرتی ہے (Gateway رَن ٹائم کے لیے bun کی سفارش نہیں کی جاتی)۔

## Local vs remote mode

- **Local** (بطورِ طے شدہ): اگر کوئی چلتا ہوا مقامی Gateway موجود ہو تو ایپ اس سے منسلک ہو جاتی ہے؛
  بصورتِ دیگر `openclaw gateway install` کے ذریعے launchd سروس فعال کرتی ہے۔
- **Remote**: ایپ SSH/Tailscale کے ذریعے Gateway سے جڑتی ہے اور کبھی
  مقامی پراسیس شروع نہیں کرتی۔
  ایپ مقامی **node host service** شروع کرتی ہے تاکہ ریموٹ Gateway اس میک تک پہنچ سکے۔
  ایپ Gateway کو بطور چائلڈ پراسیس شروع نہیں کرتی۔

## Launchd control

ایپ فی-یوزر LaunchAgent کو منظم کرتی ہے جس کا لیبل `bot.molt.gateway` ہوتا ہے
(یا `bot.molt.<profile>` جب `--profile`/`OPENCLAW_PROFILE` استعمال ہوں؛ پرانا `com.openclaw.*` اب بھی unload کرتا ہے)۔

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

نامزد پروفائل چلانے پر لیبل کو `bot.molt.<profile>` سے بدل دیں۔

اگر LaunchAgent انسٹال نہیں ہے تو ایپ سے اسے فعال کریں یا
`openclaw gateway install` چلائیں۔

## Node capabilities (mac)

macOS ایپ خود کو ایک نوڈ کے طور پر پیش کرتی ہے۔ عام کمانڈز:

- Canvas: `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, `canvas.a2ui.*`
- Camera: `camera.snap`, `camera.clip`
- Screen: `screen.record`
- System: `system.run`, `system.notify`

نوڈ ایک `permissions` میپ رپورٹ کرتا ہے تاکہ ایجنٹس طے کر سکیں کہ کیا اجازت ہے۔

Node سروس + ایپ IPC:

- جب ہیڈلیس نوڈ ہوسٹ سروس چل رہی ہو (remote موڈ)، تو یہ Gateway WS سے بطور نوڈ جڑتی ہے۔
- `system.run` macOS ایپ میں (UI/TCC سیاق) مقامی Unix ساکٹ کے ذریعے چلتا ہے؛ پرامپس + آؤٹ پٹ ایپ ہی میں رہتے ہیں۔

Diagram (SCI):

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + TCC + system.run)
```

## Exec approvals (system.run)

`system.run` کو macOS ایپ میں **Exec approvals** (Settings → Exec approvals) کے ذریعے کنٹرول کیا جاتا ہے۔
سکیورٹی + پوچھ گچھ + اجازت فہرست مقامی طور پر میک پر یہاں محفوظ ہوتی ہیں:

```
~/.openclaw/exec-approvals.json
```

Example:

```json
{
  "version": 1,
  "defaults": {
    "security": "deny",
    "ask": "on-miss"
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [{ "pattern": "/opt/homebrew/bin/rg" }]
    }
  }
}
```

Notes:

- `allowlist` اندراجات resolved بائنری راستوں کے لیے glob پیٹرنز ہوتے ہیں۔
- پرامپٹ میں “Always Allow” منتخب کرنے سے وہ کمانڈ اجازت فہرست میں شامل ہو جاتی ہے۔
- `system.run` ماحولیاتی اوور رائیڈز فلٹر کی جاتی ہیں (`PATH`, `DYLD_*`, `LD_*`, `NODE_OPTIONS`, `PYTHON*`, `PERL*`, `RUBYOPT` کو خارج کیا جاتا ہے) اور پھر ایپ کے ماحول کے ساتھ ضم کی جاتی ہیں۔

## Deep links

ایپ مقامی کارروائیوں کے لیے `openclaw://` URL اسکیم رجسٹر کرتی ہے۔

### `openclaw://agent`

Gateway کی `agent` درخواست کو متحرک کرتا ہے۔

```bash
open 'openclaw://agent?message=Hello%20from%20deep%20link'
```

Query parameters:

- `message` (لازم)
- `sessionKey` (اختیاری)
- `thinking` (اختیاری)
- `deliver` / `to` / `channel` (اختیاری)
- `timeoutSeconds` (اختیاری)
- `key` (اختیاری unattended موڈ کلید)

Safety:

- `key` کے بغیر، ایپ تصدیق کے لیے پرامپٹ دکھاتی ہے۔
- درست `key` کے ساتھ، رَن unattended ہوتا ہے (ذاتی آٹومیشنز کے لیے مقصود)۔

## Onboarding flow (typical)

1. **OpenClaw.app** انسٹال کریں اور لانچ کریں۔
2. اجازتوں کی چیک لسٹ مکمل کریں (TCC پرامپس)۔
3. یقینی بنائیں کہ **Local** موڈ فعال ہے اور Gateway چل رہا ہے۔
4. اگر ٹرمینل رسائی چاہتے ہیں تو CLI انسٹال کریں۔

## Build & dev workflow (native)

- `cd apps/macos && swift build`
- `swift run OpenClaw` (یا Xcode)
- ایپ پیکیج کریں: `scripts/package-mac-app.sh`

## Debug gateway connectivity (macOS CLI)

ڈیبگ CLI استعمال کریں تاکہ وہی Gateway WebSocket ہینڈ شیک اور ڈسکوری
منطق آزمائی جا سکے جو macOS ایپ استعمال کرتی ہے، ایپ لانچ کیے بغیر۔

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

Connect options:

- `--url <ws://host:port>`: کنفیگ اوور رائیڈ کریں
- `--mode <local|remote>`: کنفیگ سے ریزولو کریں (بطورِ طے شدہ: کنفیگ یا مقامی)
- `--probe`: تازہ ہیلتھ پروب کو مجبور کریں
- `--timeout <ms>`: درخواست ٹائم آؤٹ (بطورِ طے شدہ: `15000`)
- `--json`: فرق نکالنے کے لیے اسٹرکچرڈ آؤٹ پٹ

Discovery options:

- `--include-local`: وہ گیٹ ویز بھی شامل کریں جو “local” کے طور پر فلٹر ہو جاتے
- `--timeout <ms>`: مجموعی ڈسکوری ونڈو (بطورِ طے شدہ: `2000`)
- `--json`: فرق نکالنے کے لیے اسٹرکچرڈ آؤٹ پٹ

Tip: `openclaw gateway discover --json` کے خلاف موازنہ کریں تاکہ دیکھا جا سکے کہ
macOS ایپ کی ڈسکوری پائپ لائن (NWBrowser + tailnet DNS‑SD fallback) نوڈ CLI کی
`dns-sd` پر مبنی ڈسکوری سے کیسے مختلف ہے۔

## Remote connection plumbing (SSH tunnels)

جب macOS ایپ **Remote** موڈ میں چلتی ہے، تو یہ ایک SSH سرنگ کھولتی ہے تاکہ مقامی UI
اجزاء ریموٹ Gateway سے ایسے بات کر سکیں جیسے وہ localhost پر ہو۔

### Control tunnel (Gateway WebSocket port)

- **Purpose:** ہیلتھ چیکس، اسٹیٹس، Web Chat، کنفیگ، اور دیگر کنٹرول‑پلین کالز۔
- **Local port:** Gateway پورٹ (بطورِ طے شدہ `18789`)، ہمیشہ مستحکم۔
- **Remote port:** ریموٹ ہوسٹ پر وہی Gateway پورٹ۔
- **Behavior:** کوئی رینڈم مقامی پورٹ نہیں؛ ایپ موجودہ صحت مند سرنگ کو دوبارہ استعمال کرتی ہے
  یا ضرورت پڑنے پر اسے دوبارہ شروع کرتی ہے۔
- **SSH shape:** `ssh -N -L <local>:127.0.0.1:<remote>` بمع BatchMode +
  ExitOnForwardFailure + keepalive اختیارات۔
- **IP reporting:** SSH سرنگ loopback استعمال کرتی ہے، اس لیے گیٹ وے نوڈ
  IP کو `127.0.0.1` کے طور پر دیکھے گا۔ اگر آپ چاہتے ہیں کہ اصل کلائنٹ
  IP ظاہر ہو تو **Direct (ws/wss)** ٹرانسپورٹ استعمال کریں (دیکھیں [macOS remote access](/platforms/mac/remote))۔

سیٹ اپ کے مراحل کے لیے دیکھیں [macOS remote access](/platforms/mac/remote)۔ پروٹوکول کی
تفصیلات کے لیے دیکھیں [Gateway protocol](/gateway/protocol)۔

## Related docs

- [Gateway runbook](/gateway)
- [Gateway (macOS)](/platforms/mac/bundled-gateway)
- [macOS permissions](/platforms/mac/permissions)
- [Canvas](/platforms/mac/canvas)
