---
summary: "SSH کے ذریعے ریموٹ OpenClaw Gateway کو کنٹرول کرنے کے لیے macOS ایپ کا فلو"
read_when:
  - ریموٹ میک کنٹرول سیٹ اپ یا ڈیبگ کرتے وقت
title: "ریمote کنٹرول"
---

# ریموٹ OpenClaw (macOS ⇄ ریموٹ ہوسٹ)

یہ فلو macOS ایپ کو کسی دوسرے ہوسٹ (ڈیسک ٹاپ/سرور) پر چلنے والے OpenClaw گیٹ وے کے لیے مکمل ریموٹ کنٹرول کے طور پر کام کرنے دیتا ہے۔ یہ ایپ کی **Remote over SSH** (ریموٹ رن) فیچر ہے۔ تمام فیچرز—ہیلتھ چیکس، Voice Wake فارورڈنگ، اور Web Chat—_Settings → General_ میں موجود ایک ہی ریموٹ SSH کنفیگریشن کو دوبارہ استعمال کرتے ہیں۔

## Modes

- **Local (this Mac)**: سب کچھ لیپ ٹاپ پر چلتا ہے۔ کوئی SSH شامل نہیں۔
- **Remote over SSH (default)**: OpenClaw کمانڈز ریموٹ ہوسٹ پر چلائی جاتی ہیں۔ mac ایپ `-o BatchMode` کے ساتھ، آپ کی منتخب کردہ شناخت/کی، اور ایک لوکل پورٹ‑فارورڈ کے ساتھ SSH کنکشن کھولتی ہے۔
- **Remote direct (ws/wss)**: کوئی SSH ٹنل نہیں۔ میک ایپ گیٹ وے URL سے براہِ راست جڑتی ہے (مثال کے طور پر Tailscale Serve یا کسی عوامی HTTPS ریورس پراکسی کے ذریعے)۔

## Remote transports

ریموٹ موڈ دو ٹرانسپورٹس کی حمایت کرتا ہے:

- **SSH tunnel** (default): گیٹ وے پورٹ کو localhost پر فارورڈ کرنے کے لیے `ssh -N -L ...` استعمال کرتا ہے۔ ٹنل لوپ بیک ہونے کی وجہ سے گیٹ وے کو نوڈ کا IP `127.0.0.1` نظر آئے گا۔
- **Direct (ws/wss)**: گیٹ وے URL سے سیدھا کنیکٹ ہوتا ہے۔ گیٹ وے کو اصل کلائنٹ IP نظر آتا ہے۔

## Prereqs on the remote host

1. Node + pnpm انسٹال کریں اور OpenClaw CLI (`pnpm install && pnpm build && pnpm link --global`) کو build/انسٹال کریں۔
2. یقینی بنائیں کہ `openclaw` نان-انٹرایکٹو شیلز کے لیے PATH میں ہے (ضرورت ہو تو `/usr/local/bin` یا `/opt/homebrew/bin` میں symlink کریں)۔
3. کی آتھنٹیکیشن کے ساتھ SSH کھولیں۔ ہم آف-LAN مستحکم رسائی کے لیے **Tailscale** IPs کی سفارش کرتے ہیں۔

## macOS app setup

1. _Settings → General_ کھولیں۔
2. **OpenClaw runs** کے تحت **Remote over SSH** منتخب کریں اور یہ سیٹ کریں:
   - **Transport**: **SSH tunnel** یا **Direct (ws/wss)**۔
   - **SSH target**: `user@host` (اختیاری `:port`)۔
     - اگر gateway اسی LAN پر ہے اور Bonjour کے ذریعے اعلان کر رہا ہے، تو خودکار طور پر اس فیلڈ کو بھرنے کے لیے دریافت شدہ فہرست سے منتخب کریں۔
   - **Gateway URL** (صرف Direct): `wss://gateway.example.ts.net` (یا لوکل/LAN کے لیے `ws://...`)۔
   - **Identity file** (advanced): آپ کی کلید کا راستہ۔
   - **Project root** (advanced): کمانڈز کے لیے استعمال ہونے والا ریموٹ checkout راستہ۔
   - **CLI path** (advanced): قابلِ عمل `openclaw` entrypoint/binary کا اختیاری راستہ (جب مشتہر ہو تو خودکار طور پر بھر جاتا ہے)۔
3. **Test remote** پر کلک کریں۔ کامیابی اس بات کی نشاندہی کرتی ہے کہ ریموٹ `openclaw status --json` درست طریقے سے چل رہا ہے۔ ناکامیوں کا عموماً مطلب PATH/CLI کے مسائل ہوتے ہیں؛ exit 127 کا مطلب ہے کہ CLI ریموٹ پر نہیں مل رہی۔
4. ہیلتھ چیکس اور Web Chat اب خودکار طور پر اسی SSH ٹنل کے ذریعے چلیں گے۔

## Web Chat

- **SSH tunnel**: Web Chat فارورڈ کیے گئے WebSocket کنٹرول پورٹ (بطورِ طے شدہ 18789) کے ذریعے gateway سے کنیکٹ ہوتا ہے۔
- **Direct (ws/wss)**: Web Chat براہِ راست کنفیگر کردہ gateway URL سے کنیکٹ ہوتا ہے۔
- اب کوئی علیحدہ WebChat HTTP سرور موجود نہیں ہے۔

## Permissions

- ریموٹ ہوسٹ کو لوکل کی طرح وہی TCC منظوریوں کی ضرورت ہوتی ہے (Automation, Accessibility, Screen Recording, Microphone, Speech Recognition, Notifications)۔ ان منظوریوں کو ایک بار دینے کے لیے اسی مشین پر onboarding چلائیں۔
- نوڈز اپنی اجازتوں کی حالت `node.list` / `node.describe` کے ذریعے مشتہر کرتے ہیں تاکہ ایجنٹس جان سکیں کہ کیا دستیاب ہے۔

## Security notes

- ریموٹ ہوسٹ پر loopback binds کو ترجیح دیں اور SSH یا Tailscale کے ذریعے کنیکٹ کریں۔
- اگر آپ Gateway کو کسی non-loopback انٹرفیس پر bind کرتے ہیں، تو ٹوکن/پاس ورڈ تصدیق لازمی بنائیں۔
- [Security](/gateway/security) اور [Tailscale](/gateway/tailscale) دیکھیں۔

## WhatsApp login flow (remote)

- **ریموٹ ہوسٹ پر** `openclaw channels login --verbose` چلائیں۔ Scan the QR with WhatsApp on your phone.
- اگر آتھنٹیکیشن ختم ہو جائے تو اسی ہوسٹ پر دوبارہ لاگ اِن چلائیں۔ ہیلتھ چیک لنک کے مسائل ظاہر کرے گا۔

## Troubleshooting

- **exit 127 / not found**: نان-لاگ اِن شیلز کے لیے `openclaw` PATH میں نہیں ہے۔ اسے `/etc/paths`، اپنی شیل rc میں شامل کریں، یا `/usr/local/bin`/`/opt/homebrew/bin` میں symlink کریں۔
- **Health probe failed**: SSH رسائی، PATH، اور یہ کہ Baileys لاگ اِن ہے (`openclaw status --json`) چیک کریں۔
- **Web Chat stuck**: تصدیق کریں کہ gateway ریموٹ ہوسٹ پر چل رہا ہے اور فارورڈ کیا گیا پورٹ gateway WS پورٹ سے میل کھاتا ہے؛ UI کو صحت مند WS کنکشن درکار ہے۔
- **Node IP shows 127.0.0.1**: SSH ٹنل کے ساتھ یہ متوقع ہے۔ اگر آپ چاہتے ہیں کہ گیٹ وے اصل کلائنٹ IP دیکھے تو **Transport** کو **Direct (ws/wss)** پر سوئچ کریں۔
- **Voice Wake**: ریموٹ موڈ میں trigger phrases خودکار طور پر فارورڈ ہوتے ہیں؛ کسی علیحدہ فارورڈر کی ضرورت نہیں۔

## Notification sounds

اسکرپٹس کے ذریعے ہر نوٹیفکیشن کے لیے آوازیں منتخب کریں، `openclaw` اور `node.invoke` کے ساتھ، مثلاً:

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

اب ایپ میں کوئی عالمی “default sound” ٹوگل موجود نہیں؛ کالرز ہر درخواست کے لیے آواز (یا کوئی نہیں) منتخب کرتے ہیں۔
