---
summary: "दूरस्थ पहुँच के लिए exe.dev (VM + HTTPS प्रॉक्सी) पर OpenClaw Gateway चलाएँ"
read_when:
  - आपको Gateway के लिए एक सस्ता, हमेशा चालू रहने वाला Linux होस्ट चाहिए
  - आप अपना स्वयं का VPS चलाए बिना दूरस्थ Control UI एक्सेस चाहते हैं
title: "exe.dev"
x-i18n:
  source_path: install/exe-dev.md
  source_hash: 72ab798afd058a76
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:23Z
---

# exe.dev

लक्ष्य: exe.dev VM पर चल रहा OpenClaw Gateway, जो आपके लैपटॉप से निम्न माध्यम से पहुँचा जा सके: `https://<vm-name>.exe.xyz`

यह पृष्ठ exe.dev की डिफ़ॉल्ट **exeuntu** इमेज मानकर चलता है। यदि आपने कोई अलग डिस्ट्री चुनी है, तो पैकेजों को उसी अनुसार मैप करें।

## शुरुआती त्वरित मार्ग

1. [https://exe.new/openclaw](https://exe.new/openclaw)
2. आवश्यकता अनुसार अपनी auth key/token भरें
3. अपने VM के पास “Agent” पर क्लिक करें, और प्रतीक्षा करें...
4. ???
5. लाभ

## आपको क्या चाहिए

- exe.dev खाता
- [exe.dev](https://exe.dev) वर्चुअल मशीनों तक `ssh exe.dev` पहुँच (वैकल्पिक)

## Shelley के साथ स्वचालित इंस्टॉल

Shelley, [exe.dev](https://exe.dev) का एजेंट, हमारे
प्रॉम्प्ट के साथ OpenClaw को तुरंत इंस्टॉल कर सकता है। उपयोग किया गया प्रॉम्प्ट नीचे दिया गया है:

```
Set up OpenClaw (https://docs.openclaw.ai/install) on this VM. Use the non-interactive and accept-risk flags for openclaw onboarding. Add the supplied auth or token as needed. Configure nginx to forward from the default port 18789 to the root location on the default enabled site config, making sure to enable Websocket support. Pairing is done by "openclaw devices list" and "openclaw device approve <request id>". Make sure the dashboard shows that OpenClaw's health is OK. exe.dev handles forwarding from port 8000 to port 80/443 and HTTPS for us, so the final "reachable" should be <vm-name>.exe.xyz, without port specification.
```

## मैनुअल इंस्टॉलेशन

## 1) VM बनाएँ

अपने डिवाइस से:

```bash
ssh exe.dev new
```

फिर कनेक्ट करें:

```bash
ssh <vm-name>.exe.xyz
```

सुझाव: इस VM को **stateful** रखें। OpenClaw `~/.openclaw/` और `~/.openclaw/workspace/` के अंतर्गत स्थिति (state) संग्रहीत करता है।

## 2) पूर्वापेक्षाएँ इंस्टॉल करें (VM पर)

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

## 3) OpenClaw इंस्टॉल करें

OpenClaw इंस्टॉल स्क्रिप्ट चलाएँ:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## 4) OpenClaw को पोर्ट 8000 पर प्रॉक्सी करने के लिए nginx सेटअप करें

`/etc/nginx/sites-enabled/default` को निम्न के साथ संपादित करें:

```
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    listen 8000;
    listen [::]:8000;

    server_name _;

    location / {
        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;

        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Standard proxy headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeout settings for long-lived connections
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

## 5) OpenClaw तक पहुँचें और विशेषाधिकार प्रदान करें

`https://<vm-name>.exe.xyz/` तक पहुँचें (onboarding से Control UI आउटपुट देखें)। यदि यह auth के लिए पूछे, तो VM पर `gateway.auth.token` से टोकन पेस्ट करें (इसे `openclaw config get gateway.auth.token` से प्राप्त करें, या
`openclaw doctor --generate-gateway-token` के साथ नया जनरेट करें)। `openclaw devices list` और
`openclaw devices approve <requestId>` के साथ डिवाइसों को अनुमोदित करें। संदेह होने पर, अपने ब्राउज़र से Shelley का उपयोग करें!

## दूरस्थ पहुँच

दूरस्थ पहुँच [exe.dev](https://exe.dev) के प्रमाणीकरण द्वारा संभाली जाती है। डिफ़ॉल्ट रूप से,
पोर्ट 8000 से आने वाला HTTP ट्रैफ़िक ईमेल auth के साथ `https://<vm-name>.exe.xyz` पर फ़ॉरवर्ड किया जाता है।

## अपडेटिंग

```bash
npm i -g openclaw@latest
openclaw doctor
openclaw gateway restart
openclaw health
```

गाइड: [Updating](/install/updating)
