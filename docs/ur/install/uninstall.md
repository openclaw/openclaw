---
summary: "OpenClaw کو مکمل طور پر ان انسٹال کریں (CLI، سروس، اسٹیٹ، ورک اسپیس)"
read_when:
  - آپ کسی مشین سے OpenClaw کو ہٹانا چاہتے ہیں
  - ان انسٹال کے بعد بھی گیٹ وے سروس چل رہی ہے
title: "ان انسٹال"
---

# ان انسٹال

دو راستے:

- **آسان راستہ** اگر `openclaw` ابھی تک انسٹال ہے۔
- **دستی سروس ہٹانا** اگر CLI موجود نہیں مگر سروس اب بھی چل رہی ہے۔

## آسان راستہ (CLI ابھی انسٹال ہے)

سفارش کردہ: بلٹ اِن ان انسٹالر استعمال کریں:

```bash
openclaw uninstall
```

غیر تعاملی (خودکاری / npx):

```bash
openclaw uninstall --all --yes --non-interactive
npx -y openclaw uninstall --all --yes --non-interactive
```

دستی مراحل (وہی نتیجہ):

1. گیٹ وے سروس بند کریں:

```bash
openclaw gateway stop
```

2. گیٹ وے سروس کو ان انسٹال کریں (launchd/systemd/schtasks):

```bash
openclaw gateway uninstall
```

3. اسٹیٹ + کنفیگ حذف کریں:

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
```

اگر آپ نے `OPENCLAW_CONFIG_PATH` کو اسٹیٹ ڈائریکٹری سے باہر کسی حسبِ ضرورت مقام پر سیٹ کیا تھا تو وہ فائل بھی حذف کریں۔

4. اپنی ورک اسپیس حذف کریں (اختیاری، ایجنٹ فائلیں ہٹا دی جائیں گی):

```bash
rm -rf ~/.openclaw/workspace
```

5. CLI انسٹالیشن ہٹائیں (جو طریقہ آپ نے استعمال کیا تھا اسے منتخب کریں):

```bash
npm rm -g openclaw
pnpm remove -g openclaw
bun remove -g openclaw
```

6. اگر آپ نے macOS ایپ انسٹال کی تھی:

```bash
rm -rf /Applications/OpenClaw.app
```

نوٹس:

- اگر آپ نے پروفائلز (`--profile` / `OPENCLAW_PROFILE`) استعمال کیے تھے تو ہر اسٹیٹ ڈائریکٹری کے لیے مرحلہ 3 دہرائیں (ڈیفالٹس `~/.openclaw-<profile>` ہیں)۔
- ریموٹ موڈ میں، اسٹیٹ ڈائریکٹری **گیٹ وے ہوسٹ** پر ہوتی ہے، اس لیے مراحل 1-4 وہاں بھی چلائیں۔

## دستی سروس ہٹانا (CLI انسٹال نہیں)

یہ تب استعمال کریں جب گیٹ وے سروس چلتی رہے مگر `openclaw` موجود نہ ہو۔

### macOS (launchd)

ڈیفالٹ لیبل `bot.molt.gateway` ہے (یا `bot.molt.<profile>``; legacy `com.openclaw.\*\` may still exist):

```bash
launchctl bootout gui/$UID/bot.molt.gateway
rm -f ~/Library/LaunchAgents/bot.molt.gateway.plist
```

اگر آپ نے پروفائل استعمال کیا تھا تو لیبل اور plist نام کو `bot.molt.<profile>` سے بدل دیں`.  اگر موجود ہوں تو کسی بھی پرانے `com.openclaw.\*\` plists کو ہٹا دیں۔

### Linux (systemd user unit)

ڈیفالٹ یونٹ نام `openclaw-gateway.service` ہے (یا `openclaw-gateway-<profile>.service`):

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows (Scheduled Task)

ڈیفالٹ ٹاسک نام `OpenClaw Gateway` ہے (یا `OpenClaw Gateway (<profile>)`)۔
ٹاسک اسکرپٹ آپ کی اسٹیٹ ڈائریکٹری کے اندر موجود ہوتا ہے۔

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd"
```

اگر آپ نے کوئی پروفائل استعمال کیا تھا تو متعلقہ ٹاسک نام اور `~\.openclaw-<profile>\gateway.cmd` حذف کریں۔

## عام انسٹال بمقابلہ سورس چیک آؤٹ

### عام انسٹال (install.sh / npm / pnpm / bun)

اگر آپ نے `https://openclaw.ai/install.sh` یا `install.ps1` استعمال کیا، تو CLI کو `npm install -g openclaw@latest` کے ذریعے انسٹال کیا گیا تھا۔
`npm rm -g openclaw` کے ذریعے اسے ہٹا دیں (یا اگر اسی طرح انسٹال کیا ہو تو `pnpm remove -g` / `bun remove -g`)۔

### سورس چیک آؤٹ (git clone)

اگر آپ ریپو چیک آؤٹ سے چلاتے ہیں (`git clone` + `openclaw ...` / `bun run openclaw ...`):

1. ریپو حذف کرنے سے **پہلے** گیٹ وے سروس کو ان انسٹال کریں (اوپر دیا گیا آسان راستہ یا دستی سروس ہٹانا استعمال کریں)۔
2. ریپو ڈائریکٹری حذف کریں۔
3. اوپر دکھائے گئے مطابق اسٹیٹ + ورک اسپیس حذف کریں۔
