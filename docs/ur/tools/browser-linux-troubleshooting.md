---
summary: "لینکس پر OpenClaw براؤزر کنٹرول کے لیے Chrome/Brave/Edge/Chromium CDP کے آغاز کے مسائل حل کریں"
read_when: "لینکس پر براؤزر کنٹرول ناکام ہو، خصوصاً snap Chromium کے ساتھ"
title: "براؤزر کی خرابیوں کا ازالہ"
---

# براؤزر کی خرابیوں کا ازالہ (Linux)

## مسئلہ: "Failed to start Chrome CDP on port 18800"

OpenClaw کا براؤزر کنٹرول سرور درج ذیل خرابی کے ساتھ Chrome/Brave/Edge/Chromium لانچ کرنے میں ناکام رہتا ہے:

```
{"error":"Error: Failed to start Chrome CDP on port 18800 for profile \"openclaw\"."}
```

### بنیادی وجہ

On Ubuntu (and many Linux distros), the default Chromium installation is a **snap package**. Snap's AppArmor confinement interferes with how OpenClaw spawns and monitors the browser process.

`apt install chromium` کمانڈ ایک اسٹب پیکج انسٹال کرتی ہے جو snap کی طرف ری ڈائریکٹ کرتی ہے:

```
Note, selecting 'chromium-browser' instead of 'chromium'
chromium-browser is already the newest version (2:1snap1-0ubuntu2).
```

یہ کوئی حقیقی براؤزر نہیں — یہ محض ایک ریپر ہے۔

### حل 1: Google Chrome انسٹال کریں (سفارش کردہ)

آفیشل Google Chrome `.deb` پیکج انسٹال کریں، جو snap کے ذریعے sandboxed نہیں ہوتا:

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt --fix-broken install -y  # if there are dependency errors
```

پھر اپنی OpenClaw کنفیگ اپ ڈیٹ کریں (`~/.openclaw/openclaw.json`):

```json
{
  "browser": {
    "enabled": true,
    "executablePath": "/usr/bin/google-chrome-stable",
    "headless": true,
    "noSandbox": true
  }
}
```

### حل 2: Attach-Only موڈ کے ساتھ Snap Chromium استعمال کریں

اگر آپ کو لازماً snap Chromium استعمال کرنا ہو، تو OpenClaw کو دستی طور پر شروع کیے گئے براؤزر سے منسلک ہونے کے لیے کنفیگر کریں:

1. کنفیگ اپ ڈیٹ کریں:

```json
{
  "browser": {
    "enabled": true,
    "attachOnly": true,
    "headless": true,
    "noSandbox": true
  }
}
```

2. Chromium دستی طور پر شروع کریں:

```bash
chromium-browser --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=18800 \
  --user-data-dir=$HOME/.openclaw/browser/openclaw/user-data \
  about:blank &
```

3. اختیاری طور پر Chrome کو خودکار طور پر شروع کرنے کے لیے systemd یوزر سروس بنائیں:

```ini
# ~/.config/systemd/user/openclaw-browser.service
[Unit]
Description=OpenClaw Browser (Chrome CDP)
After=network.target

[Service]
ExecStart=/snap/bin/chromium --headless --no-sandbox --disable-gpu --remote-debugging-port=18800 --user-data-dir=%h/.openclaw/browser/openclaw/user-data about:blank
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

فعال کریں: `systemctl --user enable --now openclaw-browser.service`

### براؤزر کے کام کرنے کی تصدیق

اسٹیٹس چیک کریں:

```bash
curl -s http://127.0.0.1:18791/ | jq '{running, pid, chosenBrowser}'
```

براؤزنگ ٹیسٹ کریں:

```bash
curl -s -X POST http://127.0.0.1:18791/start
curl -s http://127.0.0.1:18791/tabs
```

### کنفیگ حوالہ

| Option                   | Description                                                                             | Default                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `browser.enabled`        | براؤزر کنٹرول فعال کریں                                                                 | `true`                                                                                    |
| `browser.executablePath` | Chromium پر مبنی براؤزر بائنری کا راستہ (Chrome/Brave/Edge/Chromium) | خودکار طور پر معلوم (جب Chromium پر مبنی ہو تو ڈیفالٹ براؤزر کو ترجیح) |
| `browser.headless`       | GUI کے بغیر چلائیں                                                                      | `false`                                                                                   |
| `browser.noSandbox`      | `--no-sandbox` فلیگ شامل کریں (کچھ لینکس سیٹ اپس کے لیے درکار)       | `false`                                                                                   |
| `browser.attachOnly`     | براؤزر لانچ نہ کریں، صرف موجودہ سے منسلک ہوں                                            | `false`                                                                                   |
| `browser.cdpPort`        | Chrome DevTools Protocol پورٹ                                                           | `18800`                                                                                   |

### مسئلہ: "Chrome extension relay is running, but no tab is connected"

You’re using the `chrome` profile (extension relay). It expects the OpenClaw
browser extension to be attached to a live tab.

حل کے اختیارات:

1. **منظم براؤزر استعمال کریں:** `openclaw browser start --browser-profile openclaw`
   (یا `browser.defaultProfile: "openclaw"` سیٹ کریں)۔
2. **ایکسٹینشن ریلے استعمال کریں:** ایکسٹینشن انسٹال کریں، ایک ٹیب کھولیں، اور
   OpenClaw ایکسٹینشن آئیکن پر کلک کر کے اسے منسلک کریں۔

نوٹس:

- `chrome` پروفائل ممکن ہو تو آپ کے **سسٹم کے ڈیفالٹ Chromium براؤزر** کو استعمال کرتا ہے۔
- مقامی `openclaw` پروفائلز خودکار طور پر `cdpPort`/`cdpUrl` مختص کرتے ہیں؛ ریموٹ CDP کے لیے ہی انہیں سیٹ کریں۔
