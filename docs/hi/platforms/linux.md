---
summary: "Linux समर्थन + सहचर ऐप की स्थिति"
read_when:
  - Linux सहचर ऐप की स्थिति खोज रहे हों
  - प्लेटफ़ॉर्म कवरेज या योगदान की योजना बना रहे हों
title: "Linux ऐप"
x-i18n:
  source_path: platforms/linux.md
  source_hash: 93b8250cd1267004
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:26Z
---

# Linux ऐप

Gateway Linux पर पूर्ण रूप से समर्थित है। **Node अनुशंसित रनटाइम है**।
Gateway के लिए Bun की अनुशंसा नहीं की जाती (WhatsApp/Telegram बग्स)।

नेटिव Linux सहचर ऐप्स योजनाबद्ध हैं। यदि आप एक बनाने में सहायता करना चाहते हैं तो योगदान का स्वागत है।

## शुरुआती त्वरित मार्ग (VPS)

1. Node 22+ इंस्टॉल करें
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. अपने लैपटॉप से: `ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. `http://127.0.0.1:18789/` खोलें और अपना टोकन पेस्ट करें

चरण-दर-चरण VPS मार्गदर्शिका: [exe.dev](/install/exe-dev)

## इंस्टॉल

- [आरंभ करें](/start/getting-started)
- [इंस्टॉल और अपडेट्स](/install/updating)
- वैकल्पिक प्रवाह: [Bun (प्रायोगिक)](/install/bun), [Nix](/install/nix), [Docker](/install/docker)

## Gateway

- [Gateway रनबुक](/gateway)
- [विन्यास](/gateway/configuration)

## Gateway सेवा इंस्टॉल (CLI)

इनमें से किसी एक का उपयोग करें:

```
openclaw onboard --install-daemon
```

या:

```
openclaw gateway install
```

या:

```
openclaw configure
```

प्रॉम्प्ट आने पर **Gateway सेवा** चुनें।

मरम्मत/माइग्रेट:

```
openclaw doctor
```

## सिस्टम नियंत्रण (systemd उपयोगकर्ता यूनिट)

OpenClaw डिफ़ॉल्ट रूप से एक systemd **उपयोगकर्ता** सेवा इंस्टॉल करता है। साझा या हमेशा-चालू सर्वरों के लिए **सिस्टम** सेवा का उपयोग करें। पूर्ण यूनिट उदाहरण और मार्गदर्शन [Gateway रनबुक](/gateway) में उपलब्ध हैं।

न्यूनतम सेटअप:

`~/.config/systemd/user/openclaw-gateway[-<profile>].service` बनाएँ:

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

इसे सक्षम करें:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```
