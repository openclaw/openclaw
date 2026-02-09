---
summary: "जब आपको आइसोलेशन या iMessage की आवश्यकता हो, तब sandboxed macOS VM (लोकल या होस्टेड) में OpenClaw चलाएँ"
read_when:
  - आप OpenClaw को अपने मुख्य macOS वातावरण से अलग रखना चाहते हैं
  - आप sandbox में iMessage एकीकरण (BlueBubbles) चाहते हैं
  - आप एक रीसेट‑योग्य macOS वातावरण चाहते हैं जिसे क्लोन किया जा सके
  - आप लोकल बनाम होस्टेड macOS VM विकल्पों की तुलना करना चाहते हैं
title: "macOS VM"
---

# macOS VM पर OpenClaw (Sandboxing)

## अनुशंसित डिफ़ॉल्ट (अधिकांश उपयोगकर्ताओं के लिए)

- हमेशा चालू Gateway और कम लागत के लिए **छोटा Linux VPS**। [VPS hosting](/vps) देखें।
- यदि आप पूर्ण नियंत्रण और ब्राउज़र ऑटोमेशन के लिए **residential IP** चाहते हैं, तो **Dedicated hardware** (Mac mini या Linux बॉक्स)। कई साइटें डेटा सेंटर IPs को ब्लॉक कर देती हैं, इसलिए लोकल ब्राउज़िंग अक्सर बेहतर काम करती है।
- **Hybrid:** Gateway को सस्ते VPS पर रखें, और जब ब्राउज़र/UI ऑटोमेशन की ज़रूरत हो तो अपने Mac को **node** के रूप में कनेक्ट करें। [Nodes](/nodes) और [Gateway remote](/gateway/remote) देखें।

जब आपको विशेष रूप से macOS‑केवल क्षमताएँ (iMessage/BlueBubbles) चाहिए हों या अपने दैनिक Mac से कड़ा आइसोलेशन चाहिए हो, तब macOS VM का उपयोग करें।

## macOS VM विकल्प

### आपके Apple Silicon Mac पर लोकल VM (Lume)

अपने मौजूदा Apple Silicon Mac पर [Lume](https://cua.ai/docs/lume) का उपयोग करके sandboxed macOS VM में OpenClaw चलाएँ।

यह आपको देता है:

- आइसोलेशन में पूर्ण macOS वातावरण (होस्ट साफ रहता है)
- BlueBubbles के माध्यम से iMessage समर्थन (Linux/Windows पर संभव नहीं)
- VM क्लोन करके त्वरित रीसेट
- अतिरिक्त हार्डवेयर या क्लाउड लागत नहीं

### होस्टेड Mac प्रदाता (क्लाउड)

यदि आप क्लाउड में macOS चाहते हैं, तो होस्टेड Mac प्रदाता भी काम करते हैं:

- [MacStadium](https://www.macstadium.com/) (होस्टेड Macs)
- अन्य होस्टेड Mac विक्रेता भी काम करते हैं; उनके VM + SSH दस्तावेज़ों का पालन करें

जब आपके पास macOS VM के लिए SSH एक्सेस हो जाए, तो नीचे दिए गए चरण 6 से आगे बढ़ें।

---

## त्वरित मार्ग (Lume, अनुभवी उपयोगकर्ता)

1. Lume इंस्टॉल करें
2. `lume create openclaw --os macos --ipsw latest`
3. Setup Assistant पूरा करें, Remote Login (SSH) सक्षम करें
4. `lume run openclaw --no-display`
5. SSH से कनेक्ट करें, OpenClaw इंस्टॉल करें, चैनल कॉन्फ़िगर करें
6. हो गया

---

## आवश्यकताएँ (Lume)

- Apple Silicon Mac (M1/M2/M3/M4)
- होस्ट पर macOS Sequoia या बाद का संस्करण
- प्रति VM ~60 GB खाली डिस्क स्पेस
- ~20 मिनट

---

## 1. Lume इंस्टॉल करें

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/lume/scripts/install.sh)"
```

यदि `~/.local/bin` आपके PATH में नहीं है:

```bash
echo 'export PATH="$PATH:$HOME/.local/bin"' >> ~/.zshrc && source ~/.zshrc
```

सत्यापित करें:

```bash
lume --version
```

डॉक्स: [Lume Installation](https://cua.ai/docs/lume/guide/getting-started/installation)

---

## 2. macOS VM बनाएँ

```bash
lume create openclaw --os macos --ipsw latest
```

यह macOS डाउनलोड करता है और VM बनाता है। एक VNC विंडो अपने आप खुल जाती है।

टिप्पणी: आपके कनेक्शन पर निर्भर करते हुए डाउनलोड में समय लग सकता है।

---

## 3. Setup Assistant पूरा करें

VNC विंडो में:

1. भाषा और क्षेत्र चुनें
2. Apple ID छोड़ें (या यदि बाद में iMessage चाहते हैं तो साइन इन करें)
3. एक उपयोगकर्ता खाता बनाएँ (यूज़रनेम और पासवर्ड याद रखें)
4. सभी वैकल्पिक सुविधाएँ छोड़ें

सेटअप पूरा होने के बाद, SSH सक्षम करें:

1. System Settings → General → Sharing खोलें
2. "Remote Login" सक्षम करें

---

## 4. VM का IP पता प्राप्त करें

```bash
lume get openclaw
```

IP पता देखें (आमतौर पर `192.168.64.x`)।

---

## 5. VM में SSH करें

```bash
ssh youruser@192.168.64.X
```

`youruser` को उस खाते से बदलें जो आपने बनाया है, और IP को अपने VM के IP से बदलें।

---

## 6. OpenClaw इंस्टॉल करें

VM के अंदर:

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

अपने मॉडल प्रदाता (Anthropic, OpenAI, आदि) को सेट करने के लिए ऑनबोर्डिंग प्रॉम्प्ट्स का पालन करें।

---

## 7. चैनल कॉन्फ़िगर करें

कॉन्फ़िग फ़ाइल संपादित करें:

```bash
nano ~/.openclaw/openclaw.json
```

अपने चैनल जोड़ें:

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

फिर WhatsApp में लॉगिन करें (QR स्कैन करें):

```bash
openclaw channels login
```

---

## 8. VM को हेडलेस चलाएँ

VM रोकें और डिस्प्ले के बिना पुनः प्रारंभ करें:

```bash
lume stop openclaw
lume run openclaw --no-display
```

VM बैकग्राउंड में चलता है। OpenClaw का डेमन गेटवे को चालू रखता है।

स्थिति जाँचने के लिए:

```bash
ssh youruser@192.168.64.X "openclaw status"
```

---

## बोनस: iMessage एकीकरण

macOS पर चलाने की यह सबसे बड़ी खासियत है। OpenClaw में iMessage जोड़ने के लिए [BlueBubbles](https://bluebubbles.app) का उपयोग करें।

VM के अंदर:

1. bluebubbles.app से BlueBubbles डाउनलोड करें
2. अपने Apple ID से साइन इन करें
3. Web API सक्षम करें और एक पासवर्ड सेट करें
4. BlueBubbles वेबहुक्स को अपने Gateway की ओर इंगित करें (उदाहरण: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`)

अपने OpenClaw कॉन्फ़िग में जोड़ें:

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

Gateway को पुनः आरंभ करें। अब आपका agent iMessages भेज और प्राप्त कर सकता है।

पूर्ण सेटअप विवरण: [BlueBubbles channel](/channels/bluebubbles)

---

## गोल्डन इमेज सहेजें

आगे कस्टमाइज़ करने से पहले, अपनी साफ स्थिति का स्नैपशॉट लें:

```bash
lume stop openclaw
lume clone openclaw openclaw-golden
```

कभी भी रीसेट करें:

```bash
lume stop openclaw && lume delete openclaw
lume clone openclaw-golden openclaw
lume run openclaw --no-display
```

---

## 24/7 चलाना

VM को चालू रखने के लिए:

- अपने Mac को प्लग‑इन रखें
- System Settings → Energy Saver में स्लीप अक्षम करें
- आवश्यकता होने पर `caffeinate` का उपयोग करें

वास्तव में हमेशा-चालू के लिए, एक समर्पित Mac mini या छोटा VPS विचार करें। [VPS होस्टिंग](/vps) देखें।

---

## समस्या‑निवारण

| समस्या                 | समाधान                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| VM में SSH नहीं हो रहा | VM के System Settings में "Remote Login" सक्षम है, जाँचें                                                      |
| VM IP नहीं दिख रहा     | VM के पूरी तरह बूट होने की प्रतीक्षा करें, फिर `lume get openclaw` दोबारा चलाएँ                                |
| Lume कमांड नहीं मिला   | `~/.local/bin` को अपने PATH में जोड़ें                                                                         |
| WhatsApp QR स्कैन नहीं | `openclaw channels login` चलाते समय सुनिश्चित करें कि आप VM में लॉग‑इन हैं (होस्ट में नहीं) |

---

## संबंधित दस्तावेज़

- [VPS hosting](/vps)
- [Nodes](/nodes)
- [Gateway remote](/gateway/remote)
- [BlueBubbles channel](/channels/bluebubbles)
- [Lume Quickstart](https://cua.ai/docs/lume/guide/getting-started/quickstart)
- [Lume CLI Reference](https://cua.ai/docs/lume/reference/cli-reference)
- [Unattended VM Setup](https://cua.ai/docs/lume/guide/fundamentals/unattended-setup) (उन्नत)
- [Docker Sandboxing](/install/docker) (वैकल्पिक आइसोलेशन दृष्टिकोण)
