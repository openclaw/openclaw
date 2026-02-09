---
summary: "Linux ပေါ်တွင် OpenClaw browser control အတွက် Chrome/Brave/Edge/Chromium CDP စတင်မှု ပြဿနာများကို ဖြေရှင်းခြင်း"
read_when: "Linux ပေါ်တွင် browser control မအောင်မြင်သောအခါ၊ အထူးသဖြင့် snap Chromium အသုံးပြုနေသည့်အခါ"
title: "Browser ပြဿနာဖြေရှင်းခြင်း"
---

# Browser ပြဿနာဖြေရှင်းခြင်း (Linux)

## ပြဿနာ: "Failed to start Chrome CDP on port 18800"

OpenClaw ၏ browser control server သည် Chrome/Brave/Edge/Chromium ကို စတင်ရန် ကြိုးစားရာတွင် အောက်ပါ error ဖြင့် မအောင်မြင်ပါသည် —

```
{"error":"Error: Failed to start Chrome CDP on port 18800 for profile \"openclaw\"."}
```

### အကြောင်းရင်း (Root Cause)

Ubuntu (နှင့် Linux distro များစွာ) တွင် ပုံမှန် Chromium installation သည် **snap package** ဖြစ်ပါသည်။ Snap ၏ AppArmor confinement သည် OpenClaw က browser process ကို spawn လုပ်ပြီး monitor လုပ်သည့် နည်းလမ်းကို အနှောင့်အယှက်ဖြစ်စေပါသည်။

`apt install chromium` အမိန့်သည် snap သို့ redirect လုပ်ပေးသည့် stub package ကို ထည့်သွင်းပေးပါသည် —

```
Note, selecting 'chromium-browser' instead of 'chromium'
chromium-browser is already the newest version (2:1snap1-0ubuntu2).
```

၎င်းသည် အမှန်တကယ် browser မဟုတ်ဘဲ wrapper တစ်ခုသာ ဖြစ်ပါသည်။

### ဖြေရှင်းနည်း 1: Google Chrome ကို ထည့်သွင်းခြင်း (အကြံပြု)

Snap ဖြင့် sandbox မလုပ်ထားသော တရားဝင် Google Chrome `.deb` package ကို ထည့်သွင်းပါ —

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt --fix-broken install -y  # if there are dependency errors
```

ထို့နောက် OpenClaw config (`~/.openclaw/openclaw.json`) ကို အပ်ဒိတ်လုပ်ပါ —

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

### ဖြေရှင်းနည်း 2: Snap Chromium ကို Attach-Only Mode ဖြင့် အသုံးပြုခြင်း

Snap Chromium ကို မဖြစ်မနေ အသုံးပြုရပါက၊ OpenClaw ကို ကိုယ်တိုင် စတင်ထားသော browser သို့ attach လုပ်ရန် ဖွဲ့စည်းပြင်ဆင်ပါ —

1. Config ကို အပ်ဒိတ်လုပ်ပါ —

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

2. Chromium ကို ကိုယ်တိုင် စတင်ပါ —

```bash
chromium-browser --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=18800 \
  --user-data-dir=$HOME/.openclaw/browser/openclaw/user-data \
  about:blank &
```

3. Chrome ကို auto-start လုပ်ရန် systemd user service တစ်ခုကို (ရွေးချယ်စရာအနေဖြင့်) ဖန်တီးနိုင်ပါသည် —

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

Enable လုပ်ရန် — `systemctl --user enable --now openclaw-browser.service`

### Browser အလုပ်လုပ်ကြောင်း စစ်ဆေးခြင်း

အခြေအနေ စစ်ဆေးရန် —

```bash
curl -s http://127.0.0.1:18791/ | jq '{running, pid, chosenBrowser}'
```

Browsing ကို စမ်းသပ်ရန် —

```bash
curl -s -X POST http://127.0.0.1:18791/start
curl -s http://127.0.0.1:18791/tabs
```

### Config ကိုးကားချက်

| Option                   | ဖော်ပြချက်                                                                                   | Default                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `browser.enabled`        | Browser control ကို ဖွင့်ရန်                                                                 | `true`                                                                                  |
| `browser.executablePath` | Chromium အခြေခံ browser binary (Chrome/Brave/Edge/Chromium) ၏ လမ်းကြောင်း | auto-detected (Chromium အခြေခံ ဖြစ်ပါက ပုံမှန် browser ကို ဦးစားပေး) |
| `browser.headless`       | GUI မပါဘဲ လည်ပတ်ရန်                                                                          | `false`                                                                                 |
| `browser.noSandbox`      | `--no-sandbox` flag ကို ထည့်ရန် (Linux setup အချို့တွင် လိုအပ်)           | `false`                                                                                 |
| `browser.attachOnly`     | Browser ကို မစတင်ဘဲ ရှိပြီးသားကိုသာ attach လုပ်ရန်                                           | `false`                                                                                 |
| `browser.cdpPort`        | Chrome DevTools Protocol port                                                                | `18800`                                                                                 |

### ပြဿနာ: "Chrome extension relay is running, but no tab is connected"

သင်သည် `chrome` profile (extension relay) ကို အသုံးပြုနေပါသည်။ ၎င်းသည် OpenClaw browser extension ကို live tab တစ်ခုနှင့် ချိတ်ဆက်ထားရမည်ဟု မျှော်လင့်ပါသည်။

ဖြေရှင်းရန် နည်းလမ်းများ —

1. **Managed browser ကို အသုံးပြုပါ:** `openclaw browser start --browser-profile openclaw`
   (သို့မဟုတ် `browser.defaultProfile: "openclaw"` ကို သတ်မှတ်ပါ)။
2. **Extension relay ကို အသုံးပြုပါ:** extension ကို ထည့်သွင်းပြီး tab တစ်ခုကို ဖွင့်ကာ
   OpenClaw extension icon ကို နှိပ်၍ attach လုပ်ပါ။

မှတ်ချက်များ —

- `chrome` profile သည် ဖြစ်နိုင်ပါက သင်၏ **system default Chromium browser** ကို အသုံးပြုပါသည်။
- Local `openclaw` profiles များသည် `cdpPort`/`cdpUrl` ကို အလိုအလျောက် သတ်မှတ်ပေးပါသည်။ remote CDP အတွက်သာ ၎င်းတို့ကို ကိုယ်တိုင် သတ်မှတ်ပါ။
