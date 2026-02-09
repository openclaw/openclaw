---
summary: "OpenClaw लॉगिंग: रोलिंग डायग्नोस्टिक्स फ़ाइल लॉग + यूनिफ़ाइड लॉग गोपनीयता फ़्लैग"
read_when:
  - macOS लॉग कैप्चर करते समय या निजी डेटा लॉगिंग की जाँच करते समय
  - वॉइस वेक/सत्र लाइफ़साइकिल समस्याओं का डिबग करते समय
title: "macOS लॉगिंग"
---

# लॉगिंग (macOS)

## रोलिंग डायग्नोस्टिक्स फ़ाइल लॉग (Debug pane)

OpenClaw macOS ऐप लॉग्स को swift-log (डिफ़ॉल्ट रूप से यूनिफ़ाइड लॉगिंग) के माध्यम से रूट करता है और आवश्यकता होने पर टिकाऊ कैप्चर के लिए डिस्क पर एक स्थानीय, रोटेटिंग फ़ाइल लॉग लिख सकता है।

- Verbosity: **Debug pane → Logs → App logging → Verbosity**
- सक्षम करें: **Debug pane → Logs → App logging → “Write rolling diagnostics log (JSONL)”**
- 14. लोकेशन: `~/Library/Logs/OpenClaw/diagnostics.jsonl` (अपने‑आप रोटेट होता है; पुराने फ़ाइलों के साथ `.1`, `.2`, … जोड़ा जाता है)
- साफ़ करें: **Debug pane → Logs → App logging → “Clear”**

टिप्पणियाँ:

- 15. यह **डिफ़ॉल्ट रूप से बंद** है। 16. केवल सक्रिय रूप से डिबग करते समय ही सक्षम करें।
- फ़ाइल को संवेदनशील मानें; समीक्षा के बिना साझा न करें।

## macOS पर यूनिफ़ाइड लॉगिंग का निजी डेटा

17. यूनिफ़ाइड लॉगिंग अधिकांश पेलोड्स को रेडैक्ट कर देती है, जब तक कोई सबसिस्टम `privacy -off` में ऑप्ट‑इन न करे। 18. पीटर की macOS पर [logging privacy shenanigans](https://steipete.me/posts/2025/logging-privacy-shenanigans) (2025) वाली लिखावट के अनुसार, यह `/Library/Preferences/Logging/Subsystems/` में सबसिस्टम नाम से की गई plist द्वारा नियंत्रित होता है। 19. केवल नई लॉग एंट्रियाँ ही फ़्लैग को अपनाती हैं, इसलिए किसी समस्या को दोहराने से पहले इसे सक्षम करें।

## OpenClaw के लिए सक्षम करें (`bot.molt`)

- पहले plist को एक अस्थायी फ़ाइल में लिखें, फिर उसे root के रूप में एटॉमिक तरीके से इंस्टॉल करें:

```bash
cat <<'EOF' >/tmp/bot.molt.plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>DEFAULT-OPTIONS</key>
    <dict>
        <key>Enable-Private-Data</key>
        <true/>
    </dict>
</dict>
</plist>
EOF
sudo install -m 644 -o root -g wheel /tmp/bot.molt.plist /Library/Preferences/Logging/Subsystems/bot.molt.plist
```

- रीबूट की आवश्यकता नहीं है; logd फ़ाइल को जल्दी पहचान लेता है, लेकिन केवल नई लॉग लाइन्स में ही निजी पेलोड शामिल होंगे।
- मौजूदा हेल्पर के साथ अधिक समृद्ध आउटपुट देखें, उदाहरण के लिए `./scripts/clawlog.sh --category WebChat --last 5m`।

## डिबगिंग के बाद अक्षम करें

- ओवरराइड हटाएँ: `sudo rm /Library/Preferences/Logging/Subsystems/bot.molt.plist`।
- वैकल्पिक रूप से, ओवरराइड को तुरंत हटाने के लिए logd को बाध्य करने हेतु `sudo log config --reload` चलाएँ।
- याद रखें कि इस सतह में फ़ोन नंबर और संदेश बॉडी शामिल हो सकती हैं; अतिरिक्त विवरण की सक्रिय आवश्यकता होने पर ही plist को स्थान पर रखें।
