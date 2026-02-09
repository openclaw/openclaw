---
summary: "OpenClaw macOS ऐप पर काम करने वाले डेवलपर्स के लिए सेटअप गाइड"
read_when:
  - macOS डेवलपमेंट परिवेश सेटअप करते समय
title: "macOS डेवलपर सेटअप"
---

# macOS डेवलपर सेटअप

यह गाइड स्रोत से OpenClaw macOS एप्लिकेशन को बिल्ड और चलाने के लिए आवश्यक चरणों को कवर करती है।

## पूर्वापेक्षाएँ

ऐप को बिल्ड करने से पहले, सुनिश्चित करें कि आपके पास निम्नलिखित इंस्टॉल हैं:

1. **Xcode 26.2+**: Swift डेवलपमेंट के लिए आवश्यक।
2. **Node.js 22+ & pnpm**: Gateway, CLI, और पैकेजिंग स्क्रिप्ट्स के लिए आवश्यक।

## 1) Install Dependencies

प्रोजेक्ट-व्यापी डिपेंडेंसीज़ इंस्टॉल करें:

```bash
pnpm install
```

## 2. Build and Package the App

macOS ऐप को बिल्ड करने और उसे `dist/OpenClaw.app` में पैकेज करने के लिए, चलाएँ:

```bash
./scripts/package-mac-app.sh
```

यदि आपके पास Apple Developer ID सर्टिफिकेट नहीं है, तो स्क्रिप्ट अपने आप **ad-hoc signing** (`-`) का उपयोग करेगी।

डेव रन मोड्स, साइनिंग फ़्लैग्स, और Team ID समस्या-निवारण के लिए, macOS ऐप README देखें:
[https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md](https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md)

> **Note**: Ad-hoc signed apps may trigger security prompts. If the app crashes immediately with "Abort trap 6", see the [Troubleshooting](#troubleshooting) section.

## 3. CLI इंस्टॉल करें

macOS ऐप बैकग्राउंड कार्यों को प्रबंधित करने के लिए एक वैश्विक `openclaw` CLI इंस्टॉल की अपेक्षा करता है।

**इसे इंस्टॉल करने के लिए (अनुशंसित):**

1. OpenClaw ऐप खोलें।
2. **General** सेटिंग्स टैब पर जाएँ।
3. **"Install CLI"** पर क्लिक करें।

वैकल्पिक रूप से, इसे मैन्युअल रूप से इंस्टॉल करें:

```bash
npm install -g openclaw@<version>
```

## समस्या-निवारण

### बिल्ड विफल: टूलचेन या SDK असंगति

macOS ऐप बिल्ड को नवीनतम macOS SDK और Swift 6.2 टूलचेन की अपेक्षा होती है।

**सिस्टम डिपेंडेंसीज़ (आवश्यक):**

- **Software Update में उपलब्ध नवीनतम macOS संस्करण** (Xcode 26.2 SDKs द्वारा आवश्यक)
- **Xcode 26.2** (Swift 6.2 टूलचेन)

**जाँच:**

```bash
xcodebuild -version
xcrun swift --version
```

यदि संस्करण मेल नहीं खाते, तो macOS/Xcode अपडेट करें और बिल्ड दोबारा चलाएँ।

### अनुमति देने पर ऐप क्रैश होना

यदि **Speech Recognition** या **Microphone** एक्सेस की अनुमति देने पर ऐप क्रैश हो जाता है, तो यह दूषित TCC कैश या सिग्नेचर असंगति के कारण हो सकता है।

**समाधान:**

1. TCC अनुमतियाँ रीसेट करें:

   ```bash
   tccutil reset All bot.molt.mac.debug
   ```

2. यदि इससे समस्या हल न हो, तो macOS से "clean slate" मजबूर करने के लिए [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) में `BUNDLE_ID` को अस्थायी रूप से बदलें।

### 1) गेटवे "Starting..." पर अनिश्चितकाल तक अटका रहता है

2. यदि गेटवे की स्थिति "Starting..." पर ही बनी रहती है, तो जांचें कि क्या कोई ज़ॉम्बी प्रोसेस पोर्ट को होल्ड कर रहा है:

```bash
openclaw gateway status
openclaw gateway stop

# If you’re not using a LaunchAgent (dev mode / manual runs), find the listener:
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

3. यदि कोई मैनुअल रन पोर्ट को होल्ड कर रहा है, तो उस प्रोसेस को रोकें (Ctrl+C)। 4. अंतिम उपाय के रूप में, ऊपर पाए गए PID को kill करें।
