---
summary: "OpenClaw को पूरी तरह अनइंस्टॉल करें (CLI, सेवा, स्टेट, वर्कस्पेस)"
read_when:
  - आप किसी मशीन से OpenClaw हटाना चाहते हैं
  - अनइंस्टॉल के बाद भी Gateway सेवा चल रही है
title: "अनइंस्टॉल"
---

# अनइंस्टॉल

दो तरीके:

- **आसान तरीका** यदि `openclaw` अभी भी इंस्टॉल है।
- **मैनुअल सेवा हटाना** यदि CLI हट चुकी है लेकिन सेवा अभी भी चल रही है।

## आसान तरीका (CLI अभी भी इंस्टॉल है)

अनुशंसित: बिल्ट-इन अनइंस्टॉलर का उपयोग करें:

```bash
openclaw uninstall
```

नॉन-इंटरएक्टिव (ऑटोमेशन / npx):

```bash
openclaw uninstall --all --yes --non-interactive
npx -y openclaw uninstall --all --yes --non-interactive
```

मैनुअल चरण (उसी परिणाम के साथ):

1. Gateway सेवा रोकें:

```bash
openclaw gateway stop
```

2. Gateway सेवा अनइंस्टॉल करें (launchd/systemd/schtasks):

```bash
openclaw gateway uninstall
```

3. स्टेट + कॉन्फ़िग हटाएँ:

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
```

यदि आपने `OPENCLAW_CONFIG_PATH` को स्टेट डायरेक्टरी के बाहर किसी कस्टम लोकेशन पर सेट किया है, तो उस फ़ाइल को भी हटाएँ।

4. अपना वर्कस्पेस हटाएँ (वैकल्पिक, एजेंट फ़ाइलें हटाता है):

```bash
rm -rf ~/.openclaw/workspace
```

5. CLI इंस्टॉलेशन हटाएँ (जिसका आपने उपयोग किया था उसे चुनें):

```bash
npm rm -g openclaw
pnpm remove -g openclaw
bun remove -g openclaw
```

6. यदि आपने macOS ऐप इंस्टॉल किया था:

```bash
rm -rf /Applications/OpenClaw.app
```

नोट्स:

- यदि आपने प्रोफ़ाइल्स का उपयोग किया था (`--profile` / `OPENCLAW_PROFILE`), तो प्रत्येक स्टेट डायरेक्टरी के लिए चरण 3 दोहराएँ (डिफ़ॉल्ट `~/.openclaw-<profile>` हैं)।
- रिमोट मोड में, स्टेट डायरेक्टरी **Gateway होस्ट** पर होती है, इसलिए वहाँ भी चरण 1–4 चलाएँ।

## मैनुअल सेवा हटाना (CLI इंस्टॉल नहीं है)

यदि Gateway सेवा चलती रहती है लेकिन `openclaw` मौजूद नहीं है, तो इसका उपयोग करें।

### macOS (launchd)

डिफ़ॉल्ट लेबल `bot.molt.gateway` है (या `bot.molt.<profile>`; legacy `com.openclaw.*` अभी भी मौजूद हो सकता है):

```bash
launchctl bootout gui/$UID/bot.molt.gateway
rm -f ~/Library/LaunchAgents/bot.molt.gateway.plist
```

यदि आपने कोई प्रोफ़ाइल उपयोग की है, तो लेबल और plist नाम को `bot.molt.<profile>` से बदलें। यदि मौजूद हों, तो किसी भी legacy `com.openclaw.*` plist को हटा दें।

### Linux (systemd user unit)

डिफ़ॉल्ट यूनिट नाम `openclaw-gateway.service` है (या `openclaw-gateway-<profile>.service`):

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows (Scheduled Task)

डिफ़ॉल्ट टास्क नाम `OpenClaw Gateway` है (या `OpenClaw Gateway (<profile>)`)।
टास्क स्क्रिप्ट आपकी state dir के अंतर्गत रहती है।

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd"
```

यदि आपने कोई प्रोफ़ाइल उपयोग की है, तो संबंधित टास्क नाम और `~\.openclaw-<profile>\gateway.cmd` हटाएँ।

## सामान्य इंस्टॉल बनाम सोर्स चेकआउट

### सामान्य इंस्टॉल (install.sh / npm / pnpm / bun)

यदि आपने `https://openclaw.ai/install.sh` या `install.ps1` का उपयोग किया है, तो CLI को `npm install -g openclaw@latest` के साथ इंस्टॉल किया गया था।
`npm rm -g openclaw` से इसे हटाएँ (या यदि आपने उस तरह से इंस्टॉल किया है तो `pnpm remove -g` / `bun remove -g`)।

### सोर्स चेकआउट (git clone)

यदि आप किसी रिपॉज़िटरी चेकआउट से चलाते हैं (`git clone` + `openclaw ...` / `bun run openclaw ...`):

1. रिपॉज़िटरी हटाने से **पहले** Gateway सेवा अनइंस्टॉल करें (ऊपर दिया गया आसान तरीका या मैनुअल सेवा हटाना उपयोग करें)।
2. रिपॉज़िटरी डायरेक्टरी हटाएँ।
3. ऊपर बताए अनुसार स्टेट + वर्कस्पेस हटाएँ।
