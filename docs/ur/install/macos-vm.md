---
summary: "جب آپ کو علیحدگی یا iMessage کی ضرورت ہو تو OpenClaw کو sandboxed macOS VM (لوکل یا ہوسٹڈ) میں چلائیں"
read_when:
  - آپ چاہتے ہیں کہ OpenClaw آپ کے مرکزی macOS ماحول سے الگ رہے
  - آپ sandbox میں iMessage انضمام (BlueBubbles) چاہتے ہیں
  - آپ ایک ایسا macOS ماحول چاہتے ہیں جسے ری سیٹ کیا جا سکے اور کلون کیا جا سکے
  - آپ لوکل بمقابلہ ہوسٹڈ macOS VM کے اختیارات کا موازنہ کرنا چاہتے ہیں
title: "macOS VMs"
---

# macOS VMs پر OpenClaw (Sandboxing)

## سفارش کردہ ڈیفالٹ (زیادہ تر صارفین)

- **Small Linux VPS** for an always-on Gateway and low cost. See [VPS hosting](/vps).
- **Dedicated hardware** (Mac mini or Linux box) if you want full control and a **residential IP** for browser automation. Many sites block data center IPs, so local browsing often works better.
- **Hybrid:** keep the Gateway on a cheap VPS, and connect your Mac as a **node** when you need browser/UI automation. See [Nodes](/nodes) and [Gateway remote](/gateway/remote).

macOS VM اس وقت استعمال کریں جب آپ کو خاص طور پر macOS تک محدود صلاحیتوں (iMessage/BlueBubbles) کی ضرورت ہو یا اپنے روزمرہ Mac سے سخت علیحدگی چاہتے ہوں۔

## macOS VM کے اختیارات

### آپ کے Apple Silicon Mac پر لوکل VM (Lume)

اپنے موجودہ Apple Silicon Mac پر [Lume](https://cua.ai/docs/lume) استعمال کرتے ہوئے sandboxed macOS VM میں OpenClaw چلائیں۔

اس سے آپ کو ملتا ہے:

- مکمل macOS ماحول علیحدگی کے ساتھ (آپ کا ہوسٹ صاف رہتا ہے)
- BlueBubbles کے ذریعے iMessage سپورٹ (Linux/Windows پر ناممکن)
- VM کلوننگ کے ذریعے فوری ری سیٹ
- اضافی ہارڈویئر یا کلاؤڈ لاگت نہیں

### ہوسٹڈ Mac فراہم کنندگان (کلاؤڈ)

اگر آپ کو کلاؤڈ میں macOS چاہیے، تو ہوسٹڈ Mac فراہم کنندگان بھی کام کرتے ہیں:

- [MacStadium](https://www.macstadium.com/) (ہوسٹڈ Macs)
- دیگر ہوسٹڈ Mac وینڈرز بھی کام کرتے ہیں؛ ان کی VM + SSH دستاویزات کی پیروی کریں

جیسے ہی آپ کو macOS VM تک SSH رسائی مل جائے، نیچے مرحلہ 6 سے آگے بڑھیں۔

---

## فوری راستہ (Lume، تجربہ کار صارفین)

1. Lume انسٹال کریں
2. `lume create openclaw --os macos --ipsw latest`
3. Setup Assistant مکمل کریں، Remote Login (SSH) فعال کریں
4. `lume run openclaw --no-display`
5. SSH کے ذریعے لاگ ان ہوں، OpenClaw انسٹال کریں، چینلز کنفیگر کریں
6. مکمل

---

## آپ کو کیا درکار ہے (Lume)

- Apple Silicon Mac (M1/M2/M3/M4)
- ہوسٹ پر macOS Sequoia یا اس کے بعد
- فی VM تقریباً 60 GB خالی ڈسک اسپیس
- تقریباً 20 منٹ

---

## 1. Lume انسٹال کریں

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/lume/scripts/install.sh)"
```

اگر `~/.local/bin` آپ کے PATH میں نہیں ہے:

```bash
echo 'export PATH="$PATH:$HOME/.local/bin"' >> ~/.zshrc && source ~/.zshrc
```

تصدیق کریں:

```bash
lume --version
```

دستاویزات: [Lume Installation](https://cua.ai/docs/lume/guide/getting-started/installation)

---

## 2. macOS VM بنائیں

```bash
lume create openclaw --os macos --ipsw latest
```

This downloads macOS and creates the VM. A VNC window opens automatically.

نوٹ: آپ کے کنکشن پر منحصر ہے، ڈاؤن لوڈ میں کچھ وقت لگ سکتا ہے۔

---

## 3. Setup Assistant مکمل کریں

VNC ونڈو میں:

1. زبان اور علاقہ منتخب کریں
2. Apple ID چھوڑ دیں (یا اگر بعد میں iMessage چاہتے ہیں تو سائن اِن کریں)
3. ایک یوزر اکاؤنٹ بنائیں (یوزرنیم اور پاس ورڈ یاد رکھیں)
4. تمام اختیاری فیچرز چھوڑ دیں

سیٹ اپ مکمل ہونے کے بعد، SSH فعال کریں:

1. System Settings → General → Sharing کھولیں
2. "Remote Login" فعال کریں

---

## 4. VM کا IP ایڈریس حاصل کریں

```bash
lume get openclaw
```

IP ایڈریس تلاش کریں (عام طور پر `192.168.64.x`)۔

---

## 5. VM میں SSH کریں

```bash
ssh youruser@192.168.64.X
```

`youruser` کو اس اکاؤنٹ سے بدلیں جو آپ نے بنایا ہے، اور IP کو اپنے VM کے IP سے بدلیں۔

---

## 6. OpenClaw انسٹال کریں

VM کے اندر:

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

آن بورڈنگ پرامپٹس کی پیروی کریں تاکہ اپنے ماڈل فراہم کنندہ (Anthropic، OpenAI، وغیرہ) سیٹ اپ کریں۔

---

## 7. چینلز کنفیگر کریں

کنفیگ فائل ایڈٹ کریں:

```bash
nano ~/.openclaw/openclaw.json
```

اپنے چینلز شامل کریں:

```json
{
  "channels": {
    "whatsapp": {
      "dmPolicy": "allowlist",
      "allowFrom": ["+15551234567"]
    },
    "telegram": {
      "botToken": "YOUR_BOT_TOKEN"
    }
  }
}
```

پھر WhatsApp میں لاگ ان کریں (QR اسکین کریں):

```bash
openclaw channels login
```

---

## 8. VM کو headless چلائیں

VM کو روکیں اور بغیر ڈسپلے کے دوبارہ شروع کریں:

```bash
lume stop openclaw
lume run openclaw --no-display
```

The VM runs in the background. OpenClaw's daemon keeps the gateway running.

اسٹیٹس چیک کرنے کے لیے:

```bash
ssh youruser@192.168.64.X "openclaw status"
```

---

## بونس: iMessage انضمام

This is the killer feature of running on macOS. Use [BlueBubbles](https://bluebubbles.app) to add iMessage to OpenClaw.

VM کے اندر:

1. bluebubbles.app سے BlueBubbles ڈاؤن لوڈ کریں
2. اپنے Apple ID سے سائن اِن کریں
3. Web API فعال کریں اور پاس ورڈ سیٹ کریں
4. BlueBubbles webhooks کو اپنے gateway کی طرف پوائنٹ کریں (مثال: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`)

اپنی OpenClaw کنفیگ میں شامل کریں:

```json
{
  "channels": {
    "bluebubbles": {
      "serverUrl": "http://localhost:1234",
      "password": "your-api-password",
      "webhookPath": "/bluebubbles-webhook"
    }
  }
}
```

gateway کو ری اسٹارٹ کریں۔ Now your agent can send and receive iMessages.

مکمل سیٹ اپ کی تفصیلات: [BlueBubbles channel](/channels/bluebubbles)

---

## گولڈن امیج محفوظ کریں

مزید حسبِ منشا کرنے سے پہلے، اپنی صاف حالت کا اسنیپ شاٹ لیں:

```bash
lume stop openclaw
lume clone openclaw openclaw-golden
```

کسی بھی وقت ری سیٹ کریں:

```bash
lume stop openclaw && lume delete openclaw
lume clone openclaw-golden openclaw
lume run openclaw --no-display
```

---

## 24/7 چلانا

VM کو چلتا رکھنے کے لیے:

- اپنے Mac کو پلگ اِن رکھیں
- System Settings → Energy Saver میں سلیپ غیر فعال کریں
- ضرورت ہو تو `caffeinate` استعمال کریں

For true always-on, consider a dedicated Mac mini or a small VPS. See [VPS hosting](/vps).

---

## خرابیوں کا ازالہ

| مسئلہ                         | حل                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| VM میں SSH نہیں ہو رہا        | تصدیق کریں کہ VM کی System Settings میں "Remote Login" فعال ہے                                               |
| VM IP نظر نہیں آ رہا          | VM کے مکمل بوٹ ہونے کا انتظار کریں، پھر `lume get openclaw` دوبارہ چلائیں                                    |
| Lume کمانڈ نہیں مل رہی        | `~/.local/bin` کو اپنے PATH میں شامل کریں                                                                    |
| WhatsApp QR اسکین نہیں ہو رہا | یقینی بنائیں کہ `openclaw channels login` چلاتے وقت آپ VM میں لاگ اِن ہیں (ہوسٹ میں نہیں) |

---

## متعلقہ دستاویزات

- [VPS hosting](/vps)
- [Nodes](/nodes)
- [Gateway remote](/gateway/remote)
- [BlueBubbles channel](/channels/bluebubbles)
- [Lume Quickstart](https://cua.ai/docs/lume/guide/getting-started/quickstart)
- [Lume CLI Reference](https://cua.ai/docs/lume/reference/cli-reference)
- [Unattended VM Setup](https://cua.ai/docs/lume/guide/fundamentals/unattended-setup) (ایڈوانسڈ)
- [Docker Sandboxing](/install/docker) (متبادل علیحدگی کا طریقہ)
