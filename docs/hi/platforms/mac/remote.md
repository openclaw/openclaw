---
summary: "SSH के माध्यम से दूरस्थ OpenClaw Gateway को नियंत्रित करने के लिए macOS ऐप प्रवाह"
read_when:
  - दूरस्थ mac नियंत्रण सेटअप या डिबग करते समय
title: "दूरस्थ नियंत्रण"
x-i18n:
  source_path: platforms/mac/remote.md
  source_hash: 61b43707250d5515
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:37Z
---

# Remote OpenClaw (macOS ⇄ दूरस्थ होस्ट)

यह प्रवाह macOS ऐप को किसी अन्य होस्ट (डेस्कटॉप/सर्वर) पर चल रहे OpenClaw Gateway के लिए पूर्ण दूरस्थ नियंत्रण के रूप में कार्य करने देता है। यह ऐप की **Remote over SSH** (remote run) सुविधा है। सभी सुविधाएँ—स्वास्थ्य जाँच, Voice Wake फ़ॉरवर्डिंग, और Web Chat—_Settings → General_ में एक ही दूरस्थ SSH विन्यास का पुन: उपयोग करती हैं।

## Modes

- **Local (this Mac)**: सब कुछ लैपटॉप पर चलता है। कोई SSH शामिल नहीं।
- **Remote over SSH (default)**: OpenClaw कमांड दूरस्थ होस्ट पर निष्पादित होते हैं। mac ऐप `-o BatchMode` के साथ आपकी चुनी हुई पहचान/कुंजी और एक local port-forward के साथ SSH कनेक्शन खोलता है।
- **Remote direct (ws/wss)**: कोई SSH टनल नहीं। mac ऐप सीधे Gateway URL से कनेक्ट करता है (उदाहरण के लिए, Tailscale Serve या सार्वजनिक HTTPS रिवर्स प्रॉक्सी के माध्यम से)।

## Remote transports

Remote मोड दो ट्रांसपोर्ट का समर्थन करता है:

- **SSH tunnel** (default): Gateway पोर्ट को localhost पर फ़ॉरवर्ड करने के लिए `ssh -N -L ...` का उपयोग करता है। टनल loopback होने के कारण Gateway नोड का IP `127.0.0.1` के रूप में देखेगा।
- **Direct (ws/wss)**: सीधे Gateway URL से कनेक्ट करता है। Gateway वास्तविक क्लाइंट IP देखता है।

## Prereqs on the remote host

1. Node + pnpm इंस्टॉल करें और OpenClaw CLI (`pnpm install && pnpm build && pnpm link --global`) को बिल्ड/इंस्टॉल करें।
2. सुनिश्चित करें कि `openclaw` non-interactive shells के लिए PATH पर है (आवश्यक होने पर `/usr/local/bin` या `/opt/homebrew/bin` में symlink करें)।
3. कुंजी प्रमाणीकरण के साथ SSH खोलें। ऑफ-LAN स्थिर पहुँच के लिए हम **Tailscale** IPs की सिफारिश करते हैं।

## macOS app setup

1. _Settings → General_ खोलें।
2. **OpenClaw runs** के अंतर्गत **Remote over SSH** चुनें और सेट करें:
   - **Transport**: **SSH tunnel** या **Direct (ws/wss)**।
   - **SSH target**: `user@host` (वैकल्पिक `:port`)।
     - यदि Gateway उसी LAN पर है और Bonjour का विज्ञापन करता है, तो इस फ़ील्ड को स्वतः भरने के लिए खोजी गई सूची से उसे चुनें।
   - **Gateway URL** (केवल Direct): `wss://gateway.example.ts.net` (या local/LAN के लिए `ws://...`)।
   - **Identity file** (advanced): आपकी कुंजी का पथ।
   - **Project root** (advanced): कमांड्स के लिए उपयोग किया जाने वाला दूरस्थ checkout पथ।
   - **CLI path** (advanced): वैकल्पिक रूप से चलाने योग्य `openclaw` entrypoint/binary का पथ (विज्ञापित होने पर स्वतः भरा जाता है)।
3. **Test remote** पर क्लिक करें। सफलता दर्शाती है कि दूरस्थ `openclaw status --json` सही ढंग से चल रहा है। विफलताएँ आमतौर पर PATH/CLI समस्याएँ होती हैं; exit 127 का अर्थ है कि CLI दूरस्थ रूप से नहीं मिल रहा।
4. स्वास्थ्य जाँच और Web Chat अब इस SSH टनल के माध्यम से स्वतः चलेंगे।

## Web Chat

- **SSH tunnel**: Web Chat फ़ॉरवर्ड किए गए WebSocket कंट्रोल पोर्ट (default 18789) के माध्यम से Gateway से कनेक्ट करता है।
- **Direct (ws/wss)**: Web Chat सीधे कॉन्फ़िगर किए गए Gateway URL से कनेक्ट करता है।
- अब कोई अलग WebChat HTTP सर्वर नहीं है।

## Permissions

- दूरस्थ होस्ट को स्थानीय के समान TCC अनुमतियाँ चाहिए (Automation, Accessibility, Screen Recording, Microphone, Speech Recognition, Notifications)। उन्हें एक बार प्रदान करने के लिए उस मशीन पर onboarding चलाएँ।
- नोड्स अपनी अनुमति स्थिति `node.list` / `node.describe` के माध्यम से विज्ञापित करते हैं ताकि एजेंट जान सकें कि क्या उपलब्ध है।

## Security notes

- दूरस्थ होस्ट पर loopback binds को प्राथमिकता दें और SSH या Tailscale के माध्यम से कनेक्ट करें।
- यदि आप Gateway को non-loopback इंटरफ़ेस से bind करते हैं, तो token/password प्रमाणीकरण आवश्यक करें।
- [Security](/gateway/security) और [Tailscale](/gateway/tailscale) देखें।

## WhatsApp login flow (remote)

- `openclaw channels login --verbose` **दूरस्थ होस्ट पर** चलाएँ। अपने फ़ोन पर WhatsApp से QR स्कैन करें।
- यदि प्रमाणीकरण समाप्त हो जाए तो उसी होस्ट पर लॉगिन पुनः चलाएँ। स्वास्थ्य जाँच लिंक समस्याएँ दिखाएगी।

## Troubleshooting

- **exit 127 / not found**: `openclaw` non-login shells के लिए PATH पर नहीं है। इसे `/etc/paths`, आपके shell rc में जोड़ें, या `/usr/local/bin`/`/opt/homebrew/bin` में symlink करें।
- **Health probe failed**: SSH पहुँच, PATH, और यह कि Baileys लॉग इन है (`openclaw status --json`)—इनकी जाँच करें।
- **Web Chat stuck**: पुष्टि करें कि Gateway दूरस्थ होस्ट पर चल रहा है और फ़ॉरवर्ड किया गया पोर्ट Gateway WS पोर्ट से मेल खाता है; UI को स्वस्थ WS कनेक्शन चाहिए।
- **Node IP shows 127.0.0.1**: SSH टनल के साथ यह अपेक्षित है। यदि आप चाहते हैं कि Gateway वास्तविक क्लाइंट IP देखे, तो **Transport** को **Direct (ws/wss)** पर स्विच करें।
- **Voice Wake**: remote मोड में ट्रिगर वाक्यांश स्वतः फ़ॉरवर्ड हो जाते हैं; अलग फ़ॉरवर्डर की आवश्यकता नहीं।

## Notification sounds

स्क्रिप्ट्स से प्रति नोटिफ़िकेशन ध्वनियाँ `openclaw` और `node.invoke` के साथ चुनें, उदाहरण के लिए:

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

अब ऐप में कोई वैश्विक “default sound” टॉगल नहीं है; कॉलर प्रत्येक अनुरोध के लिए एक ध्वनि (या कोई नहीं) चुनते हैं।
