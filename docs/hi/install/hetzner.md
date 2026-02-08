---
summary: "स्थायी स्थिति और अंतर्निहित बाइनरीज़ के साथ सस्ते Hetzner VPS (Docker) पर OpenClaw Gateway को 24/7 चलाएँ"
read_when:
  - आप OpenClaw को क्लाउड VPS पर 24/7 चलाना चाहते हैं (अपने लैपटॉप पर नहीं)
  - आप अपने स्वयं के VPS पर प्रोडक्शन-ग्रेड, हमेशा चालू Gateway चाहते हैं
  - आप persistence, बाइनरीज़ और रीस्टार्ट व्यवहार पर पूर्ण नियंत्रण चाहते हैं
  - आप Hetzner या समान प्रदाता पर Docker में OpenClaw चला रहे हैं
title: "Hetzner"
x-i18n:
  source_path: install/hetzner.md
  source_hash: 84d9f24f1a803aa1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:28Z
---

# Hetzner पर OpenClaw (Docker, प्रोडक्शन VPS गाइड)

## लक्ष्य

Docker का उपयोग करके Hetzner VPS पर एक स्थायी OpenClaw Gateway चलाना, जिसमें durable state, अंतर्निहित बाइनरीज़ और सुरक्षित रीस्टार्ट व्यवहार हो।

यदि आप “लगभग $5 में OpenClaw 24/7” चाहते हैं, तो यह सबसे सरल और विश्वसनीय सेटअप है।  
Hetzner की कीमतें बदलती रहती हैं; सबसे छोटा Debian/Ubuntu VPS चुनें और यदि OOMs हों तो स्केल अप करें।

## हम क्या कर रहे हैं (सरल शब्दों में)?

- एक छोटा Linux सर्वर किराए पर लेना (Hetzner VPS)
- Docker इंस्टॉल करना (आइसोलेटेड ऐप रनटाइम)
- Docker में OpenClaw Gateway शुरू करना
- होस्ट पर `~/.openclaw` + `~/.openclaw/workspace` को स्थायी रखना (रीस्टार्ट/रीबिल्ड के बाद भी)
- SSH टनल के माध्यम से अपने लैपटॉप से Control UI तक पहुँच बनाना

Gateway तक निम्न तरीकों से पहुँचा जा सकता है:

- आपके लैपटॉप से SSH पोर्ट फ़ॉरवर्डिंग
- यदि आप फ़ायरवॉलिंग और टोकन स्वयं प्रबंधित करते हैं तो सीधे पोर्ट एक्सपोज़र

यह गाइड Hetzner पर Ubuntu या Debian मानकर चलती है।  
यदि आप किसी अन्य Linux VPS पर हैं, तो पैकेजों को उसी अनुसार मैप करें।  
सामान्य Docker फ्लो के लिए, [Docker](/install/docker) देखें।

---

## त्वरित मार्ग (अनुभवी ऑपरेटर)

1. Hetzner VPS प्रोविजन करें
2. Docker इंस्टॉल करें
3. OpenClaw रिपॉज़िटरी क्लोन करें
4. स्थायी होस्ट डायरेक्टरी बनाएँ
5. `.env` और `docker-compose.yml` को विन्यस्त करें
6. आवश्यक बाइनरीज़ को इमेज में बेक करें
7. `docker compose up -d`
8. persistence और Gateway एक्सेस सत्यापित करें

---

## आपको क्या चाहिए

- root एक्सेस के साथ Hetzner VPS
- अपने लैपटॉप से SSH एक्सेस
- SSH + कॉपी/पेस्ट में बुनियादी सहजता
- ~20 मिनट
- Docker और Docker Compose
- मॉडल प्रमाणीकरण क्रेडेंशियल्स
- वैकल्पिक प्रदाता क्रेडेंशियल्स
  - WhatsApp QR
  - Telegram bot टोकन
  - Gmail OAuth

---

## 1) VPS प्रोविजन करें

Hetzner में Ubuntu या Debian VPS बनाएँ।

root के रूप में कनेक्ट करें:

```bash
ssh root@YOUR_VPS_IP
```

यह गाइड मानती है कि VPS stateful है।  
इसे disposable इंफ्रास्ट्रक्चर की तरह न मानें।

---

## 2) Docker इंस्टॉल करें (VPS पर)

```bash
apt-get update
apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sh
```

सत्यापित करें:

```bash
docker --version
docker compose version
```

---

## 3) OpenClaw रिपॉज़िटरी क्लोन करें

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

यह गाइड मानती है कि आप बाइनरी persistence की गारंटी के लिए एक कस्टम इमेज बनाएँगे।

---

## 4) स्थायी होस्ट डायरेक्टरी बनाएँ

Docker कंटेनर ephemeral होते हैं।  
सभी दीर्घकालिक state होस्ट पर रहनी चाहिए।

```bash
mkdir -p /root/.openclaw
mkdir -p /root/.openclaw/workspace

# Set ownership to the container user (uid 1000):
chown -R 1000:1000 /root/.openclaw
chown -R 1000:1000 /root/.openclaw/workspace
```

---

## 5) पर्यावरण चर विन्यस्त करें

रिपॉज़िटरी रूट में `.env` बनाएँ।

```bash
OPENCLAW_IMAGE=openclaw:latest
OPENCLAW_GATEWAY_TOKEN=change-me-now
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_PORT=18789

OPENCLAW_CONFIG_DIR=/root/.openclaw
OPENCLAW_WORKSPACE_DIR=/root/.openclaw/workspace

GOG_KEYRING_PASSWORD=change-me-now
XDG_CONFIG_HOME=/home/node/.openclaw
```

मज़बूत सीक्रेट्स जनरेट करें:

```bash
openssl rand -hex 32
```

**इस फ़ाइल को कमिट न करें।**

---

## 6) Docker Compose विन्यास

`docker-compose.yml` बनाएँ या अपडेट करें।

```yaml
services:
  openclaw-gateway:
    image: ${OPENCLAW_IMAGE}
    build: .
    restart: unless-stopped
    env_file:
      - .env
    environment:
      - HOME=/home/node
      - NODE_ENV=production
      - TERM=xterm-256color
      - OPENCLAW_GATEWAY_BIND=${OPENCLAW_GATEWAY_BIND}
      - OPENCLAW_GATEWAY_PORT=${OPENCLAW_GATEWAY_PORT}
      - OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}
      - GOG_KEYRING_PASSWORD=${GOG_KEYRING_PASSWORD}
      - XDG_CONFIG_HOME=${XDG_CONFIG_HOME}
      - PATH=/home/linuxbrew/.linuxbrew/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    volumes:
      - ${OPENCLAW_CONFIG_DIR}:/home/node/.openclaw
      - ${OPENCLAW_WORKSPACE_DIR}:/home/node/.openclaw/workspace
    ports:
      # Recommended: keep the Gateway loopback-only on the VPS; access via SSH tunnel.
      # To expose it publicly, remove the `127.0.0.1:` prefix and firewall accordingly.
      - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"

      # Optional: only if you run iOS/Android nodes against this VPS and need Canvas host.
      # If you expose this publicly, read /gateway/security and firewall accordingly.
      # - "18793:18793"
    command:
      [
        "node",
        "dist/index.js",
        "gateway",
        "--bind",
        "${OPENCLAW_GATEWAY_BIND}",
        "--port",
        "${OPENCLAW_GATEWAY_PORT}",
      ]
```

---

## 7) आवश्यक बाइनरीज़ को इमेज में बेक करें (महत्वपूर्ण)

चलते हुए कंटेनर के भीतर बाइनरीज़ इंस्टॉल करना एक जाल है।  
रनटाइम पर इंस्टॉल की गई कोई भी चीज़ रीस्टार्ट पर खो जाएगी।

Skills द्वारा आवश्यक सभी बाहरी बाइनरीज़ को इमेज बिल्ड समय पर इंस्टॉल किया जाना चाहिए।

नीचे दिए गए उदाहरण केवल तीन सामान्य बाइनरीज़ दिखाते हैं:

- Gmail एक्सेस के लिए `gog`
- Google Places के लिए `goplaces`
- WhatsApp के लिए `wacli`

ये उदाहरण हैं, पूरी सूची नहीं।  
आप उसी पैटर्न का उपयोग करके जितनी चाहें उतनी बाइनरीज़ इंस्टॉल कर सकते हैं।

यदि आप बाद में नए Skills जोड़ते हैं जो अतिरिक्त बाइनरीज़ पर निर्भर करते हैं, तो आपको करना होगा:

1. Dockerfile अपडेट करें
2. इमेज को रीबिल्ड करें
3. कंटेनरों को रीस्टार्ट करें

**उदाहरण Dockerfile**

```dockerfile
FROM node:22-bookworm

RUN apt-get update && apt-get install -y socat && rm -rf /var/lib/apt/lists/*

# Example binary 1: Gmail CLI
RUN curl -L https://github.com/steipete/gog/releases/latest/download/gog_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/gog

# Example binary 2: Google Places CLI
RUN curl -L https://github.com/steipete/goplaces/releases/latest/download/goplaces_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/goplaces

# Example binary 3: WhatsApp CLI
RUN curl -L https://github.com/steipete/wacli/releases/latest/download/wacli_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/wacli

# Add more binaries below using the same pattern

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts

RUN corepack enable
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

CMD ["node","dist/index.js"]
```

---

## 8) बिल्ड और लॉन्च करें

```bash
docker compose build
docker compose up -d openclaw-gateway
```

बाइनरीज़ सत्यापित करें:

```bash
docker compose exec openclaw-gateway which gog
docker compose exec openclaw-gateway which goplaces
docker compose exec openclaw-gateway which wacli
```

अपेक्षित आउटपुट:

```
/usr/local/bin/gog
/usr/local/bin/goplaces
/usr/local/bin/wacli
```

---

## 9) Gateway सत्यापित करें

```bash
docker compose logs -f openclaw-gateway
```

सफलता:

```
[gateway] listening on ws://0.0.0.0:18789
```

अपने लैपटॉप से:

```bash
ssh -N -L 18789:127.0.0.1:18789 root@YOUR_VPS_IP
```

खोलें:

`http://127.0.0.1:18789/`

अपना gateway टोकन पेस्ट करें।

---

## क्या कहाँ स्थायी रहता है (source of truth)

OpenClaw Docker में चलता है, लेकिन Docker source of truth नहीं है।  
सभी दीर्घकालिक state को रीस्टार्ट, रीबिल्ड और रीबूट के बाद भी जीवित रहना चाहिए।

| घटक                 | स्थान                             | Persistence तंत्र       | नोट्स                         |
| ------------------- | --------------------------------- | ----------------------- | ----------------------------- |
| Gateway विन्यास     | `/home/node/.openclaw/`           | होस्ट वॉल्यूम माउंट     | `openclaw.json`, टोकन शामिल   |
| मॉडल auth प्रोफ़ाइल | `/home/node/.openclaw/`           | होस्ट वॉल्यूम माउंट     | OAuth टोकन, एपीआई कुंजियाँ    |
| Skill विन्यास       | `/home/node/.openclaw/skills/`    | होस्ट वॉल्यूम माउंट     | Skill-स्तरीय state            |
| एजेंट वर्कस्पेस     | `/home/node/.openclaw/workspace/` | होस्ट वॉल्यूम माउंट     | कोड और एजेंट आर्टिफ़ैक्ट्स    |
| WhatsApp सत्र       | `/home/node/.openclaw/`           | होस्ट वॉल्यूम माउंट     | QR लॉगिन को सुरक्षित रखता है  |
| Gmail कीरिंग        | `/home/node/.openclaw/`           | होस्ट वॉल्यूम + पासवर्ड | `GOG_KEYRING_PASSWORD` आवश्यक |
| बाहरी बाइनरीज़      | `/usr/local/bin/`                 | Docker इमेज             | बिल्ड समय पर बेक होना चाहिए   |
| Node रनटाइम         | कंटेनर फ़ाइलसिस्टम                | Docker इमेज             | हर इमेज बिल्ड पर रीबिल्ड      |
| OS पैकेज            | कंटेनर फ़ाइलसिस्टम                | Docker इमेज             | रनटाइम पर इंस्टॉल न करें      |
| Docker कंटेनर       | Ephemeral                         | रीस्टार्ट योग्य         | नष्ट करना सुरक्षित            |
