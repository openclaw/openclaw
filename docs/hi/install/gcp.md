---
summary: "GCP Compute Engine VM (Docker) पर OpenClaw Gateway को 24/7 चलाएँ, टिकाऊ स्टेट के साथ"
read_when:
  - आप GCP पर OpenClaw को 24/7 चलाना चाहते हैं
  - आप अपनी स्वयं की VM पर प्रोडक्शन-ग्रेड, हमेशा-चालू Gateway चाहते हैं
  - आप persistence, binaries और restart व्यवहार पर पूर्ण नियंत्रण चाहते हैं
title: "GCP"
---

# GCP Compute Engine पर OpenClaw (Docker, प्रोडक्शन VPS गाइड)

## लक्ष्य

Docker का उपयोग करके GCP Compute Engine VM पर एक स्थायी OpenClaw Gateway चलाना, जिसमें टिकाऊ स्टेट, इमेज में बेक किए गए binaries, और सुरक्षित restart व्यवहार हो।

34. यदि आप "OpenClaw 24/7 लगभग ~$5-12/महीना" चाहते हैं, तो यह Google Cloud पर एक भरोसेमंद सेटअप है।
35. कीमत मशीन प्रकार और क्षेत्र के अनुसार बदलती है; अपने वर्कलोड के लिए सबसे छोटा VM चुनें और यदि OOM आए तो स्केल अप करें।

## हम क्या कर रहे हैं (सरल शब्दों में)?

- एक GCP प्रोजेक्ट बनाना और बिलिंग सक्षम करना
- एक Compute Engine VM बनाना
- Docker इंस्टॉल करना (आइसोलेटेड ऐप रनटाइम)
- Docker में OpenClaw Gateway शुरू करना
- होस्ट पर `~/.openclaw` + `~/.openclaw/workspace` को स्थायी रखना (restart/rebuild के बाद भी सुरक्षित)
- SSH टनल के माध्यम से अपने लैपटॉप से Control UI एक्सेस करना

Gateway तक पहुँचा जा सकता है:

- आपके लैपटॉप से SSH पोर्ट फ़ॉरवर्डिंग के माध्यम से
- यदि आप फ़ायरवॉलिंग और टोकन स्वयं प्रबंधित करते हैं तो सीधे पोर्ट एक्सपोज़र द्वारा

36. यह गाइड GCP Compute Engine पर Debian का उपयोग करती है।
37. Ubuntu भी काम करता है; पैकेजों को उसी अनुसार मैप करें।
38. सामान्य Docker फ़्लो के लिए, [Docker](/install/docker) देखें।

---

## त्वरित मार्ग (अनुभवी ऑपरेटर)

1. GCP प्रोजेक्ट बनाएँ + Compute Engine API सक्षम करें
2. Compute Engine VM बनाएँ (e2-small, Debian 12, 20GB)
3. VM में SSH करें
4. Docker इंस्टॉल करें
5. OpenClaw रिपॉज़िटरी क्लोन करें
6. स्थायी होस्ट डायरेक्टरी बनाएँ
7. `.env` और `docker-compose.yml` कॉन्फ़िगर करें
8. आवश्यक binaries बेक करें, बिल्ड करें और लॉन्च करें

---

## आपको क्या चाहिए

- GCP खाता (e2-micro के लिए फ्री टियर योग्य)
- gcloud CLI इंस्टॉल (या Cloud Console का उपयोग करें)
- अपने लैपटॉप से SSH एक्सेस
- SSH + कॉपी/पेस्ट का बुनियादी अनुभव
- ~20–30 मिनट
- Docker और Docker Compose
- मॉडल प्रमाणीकरण क्रेडेंशियल्स
- वैकल्पिक प्रदाता क्रेडेंशियल्स
  - WhatsApp QR
  - Telegram बॉट टोकन
  - Gmail OAuth

---

## 1. gcloud CLI इंस्टॉल करें (या Console का उपयोग करें)

**विकल्प A: gcloud CLI** (ऑटोमेशन के लिए अनुशंसित)

इंस्टॉल करें: [https://cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install)

इनिशियलाइज़ और ऑथेंटिकेट करें:

```bash
gcloud init
gcloud auth login
```

**विकल्प B: Cloud Console**

सभी चरण वेब UI के माध्यम से किए जा सकते हैं: [https://console.cloud.google.com](https://console.cloud.google.com)

---

## 2. GCP प्रोजेक्ट बनाएँ

**CLI:**

```bash
gcloud projects create my-openclaw-project --name="OpenClaw Gateway"
gcloud config set project my-openclaw-project
```

बिलिंग सक्षम करें: [https://console.cloud.google.com/billing](https://console.cloud.google.com/billing) (Compute Engine के लिए आवश्यक)।

Compute Engine API सक्षम करें:

```bash
gcloud services enable compute.googleapis.com
```

**Console:**

1. IAM & Admin > Create Project पर जाएँ
2. नाम दें और बनाएँ
3. प्रोजेक्ट के लिए बिलिंग सक्षम करें
4. APIs & Services > Enable APIs > “Compute Engine API” खोजें > Enable

---

## 3. VM बनाएँ

**Machine types:**

| Type     | Specs                                       | Cost                     | Notes                 |
| -------- | ------------------------------------------- | ------------------------ | --------------------- |
| e2-small | 2 vCPU, 2GB RAM                             | ~$12/माह | अनुशंसित              |
| e2-micro | 2 vCPU (shared), 1GB RAM | फ्री टियर योग्य          | लोड पर OOM हो सकता है |

**CLI:**

```bash
gcloud compute instances create openclaw-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small \
  --boot-disk-size=20GB \
  --image-family=debian-12 \
  --image-project=debian-cloud
```

**Console:**

1. Compute Engine > VM instances > Create instance पर जाएँ
2. नाम: `openclaw-gateway`
3. Region: `us-central1`, Zone: `us-central1-a`
4. Machine type: `e2-small`
5. Boot disk: Debian 12, 20GB
6. Create

---

## 4. VM में SSH करें

**CLI:**

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

**Console:**

Compute Engine डैशबोर्ड में अपनी VM के बगल में “SSH” बटन पर क्लिक करें।

39. नोट: VM बनाने के बाद SSH कुंजी प्रसार में 1-2 मिनट लग सकते हैं। 40. यदि कनेक्शन अस्वीकृत हो, तो प्रतीक्षा करें और फिर से प्रयास करें।

---

## 5. Docker इंस्टॉल करें (VM पर)

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

ग्रुप परिवर्तन प्रभावी होने के लिए लॉग आउट करें और फिर से लॉग इन करें:

```bash
exit
```

फिर SSH से दोबारा कनेक्ट करें:

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

सत्यापित करें:

```bash
docker --version
docker compose version
```

---

## 6. OpenClaw रिपॉज़िटरी क्लोन करें

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

यह गाइड मानती है कि आप binary persistence की गारंटी के लिए एक कस्टम इमेज बनाएँगे।

---

## 7. स्थायी होस्ट डायरेक्टरी बनाएँ

41. Docker कंटेनर ephemeral होते हैं।
42. सभी दीर्घकालिक स्टेट होस्ट पर रहनी चाहिए।

```bash
mkdir -p ~/.openclaw
mkdir -p ~/.openclaw/workspace
```

---

## 8. पर्यावरण चर कॉन्फ़िगर करें

रिपॉज़िटरी रूट में `.env` बनाएँ।

```bash
OPENCLAW_IMAGE=openclaw:latest
OPENCLAW_GATEWAY_TOKEN=change-me-now
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_PORT=18789

OPENCLAW_CONFIG_DIR=/home/$USER/.openclaw
OPENCLAW_WORKSPACE_DIR=/home/$USER/.openclaw/workspace

GOG_KEYRING_PASSWORD=change-me-now
XDG_CONFIG_HOME=/home/node/.openclaw
```

मज़बूत secrets जनरेट करें:

```bash
openssl rand -hex 32
```

**इस फ़ाइल को कमिट न करें।**

---

## 9. Docker Compose कॉन्फ़िगरेशन

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
      # Recommended: keep the Gateway loopback-only on the VM; access via SSH tunnel.
      # To expose it publicly, remove the `127.0.0.1:` prefix and firewall accordingly.
      - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"

      # Optional: only if you run iOS/Android nodes against this VM and need Canvas host.
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

## 10. आवश्यक binaries को इमेज में बेक करें (महत्वपूर्ण)

43. चल रहे कंटेनर के अंदर बाइनरीज़ इंस्टॉल करना एक जाल है।
44. रनटाइम पर इंस्टॉल की गई कोई भी चीज़ रीस्टार्ट पर खो जाएगी।

Skills द्वारा आवश्यक सभी बाहरी binaries को इमेज बिल्ड समय पर इंस्टॉल करना चाहिए।

नीचे दिए गए उदाहरण केवल तीन सामान्य binaries दिखाते हैं:

- Gmail एक्सेस के लिए `gog`
- Google Places के लिए `goplaces`
- WhatsApp के लिए `wacli`

45. ये उदाहरण हैं, पूरी सूची नहीं।
46. आप उसी पैटर्न का उपयोग करके जितनी चाहें उतनी बाइनरीज़ इंस्टॉल कर सकते हैं।

यदि आप बाद में नए Skills जोड़ते हैं जिनके लिए अतिरिक्त binaries चाहिए, तो आपको:

1. Dockerfile अपडेट करना होगा
2. इमेज पुनः बिल्ड करनी होगी
3. कंटेनरों को रीस्टार्ट करना होगा

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

## 11. बिल्ड और लॉन्च

```bash
docker compose build
docker compose up -d openclaw-gateway
```

binaries सत्यापित करें:

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

## 12. Gateway सत्यापित करें

```bash
docker compose logs -f openclaw-gateway
```

सफलता:

```
[gateway] listening on ws://0.0.0.0:18789
```

---

## 13. अपने लैपटॉप से एक्सेस करें

Gateway पोर्ट फ़ॉरवर्ड करने के लिए SSH टनल बनाएँ:

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a -- -L 18789:127.0.0.1:18789
```

अपने ब्राउज़र में खोलें:

`http://127.0.0.1:18789/`

अपना gateway टोकन पेस्ट करें।

---

## क्या कहाँ persist होता है (source of truth)

47. OpenClaw Docker में चलता है, लेकिन Docker स्रोत-of-truth नहीं है।
48. सभी दीर्घकालिक स्टेट को रीस्टार्ट, रीबिल्ड और रीबूट के बाद भी सुरक्षित रहना चाहिए।

| Component           | Location                          | Persistence mechanism | Notes                         |
| ------------------- | --------------------------------- | --------------------- | ----------------------------- |
| Gateway config      | `/home/node/.openclaw/`           | Host volume mount     | `openclaw.json`, टोकन शामिल   |
| Model auth profiles | `/home/node/.openclaw/`           | Host volume mount     | OAuth टोकन, API कुंजियाँ      |
| Skill configs       | `/home/node/.openclaw/skills/`    | Host volume mount     | Skill-स्तरीय स्टेट            |
| Agent workspace     | `/home/node/.openclaw/workspace/` | Host volume mount     | कोड और एजेंट आर्टिफ़ैक्ट्स    |
| WhatsApp session    | `/home/node/.openclaw/`           | Host volume mount     | QR लॉगिन सुरक्षित रखता है     |
| Gmail keyring       | `/home/node/.openclaw/`           | Host volume + पासवर्ड | `GOG_KEYRING_PASSWORD` आवश्यक |
| External binaries   | `/usr/local/bin/`                 | Docker image          | बिल्ड समय पर बेक होना चाहिए   |
| Node runtime        | Container filesystem              | Docker image          | हर इमेज बिल्ड पर पुनः बनता है |
| OS packages         | Container filesystem              | Docker image          | रनटाइम पर इंस्टॉल न करें      |
| Docker container    | अस्थायी                           | Restartable           | नष्ट करना सुरक्षित            |

---

## अपडेट्स

VM पर OpenClaw अपडेट करने के लिए:

```bash
cd ~/openclaw
git pull
docker compose build
docker compose up -d
```

---

## समस्या-निवारण

**SSH कनेक्शन अस्वीकृत**

49. VM बनाने के बाद SSH कुंजी प्रसार में 1-2 मिनट लग सकते हैं। 50. प्रतीक्षा करें और फिर से प्रयास करें।

**OS Login समस्याएँ**

अपनी OS Login प्रोफ़ाइल जाँचें:

```bash
gcloud compute os-login describe-profile
```

सुनिश्चित करें कि आपके खाते के पास आवश्यक IAM अनुमतियाँ हों (Compute OS Login या Compute OS Admin Login)।

**Out of memory (OOM)**

यदि e2-micro का उपयोग करते समय OOM आ रहा है, तो e2-small या e2-medium में अपग्रेड करें:

```bash
# Stop the VM first
gcloud compute instances stop openclaw-gateway --zone=us-central1-a

# Change machine type
gcloud compute instances set-machine-type openclaw-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small

# Start the VM
gcloud compute instances start openclaw-gateway --zone=us-central1-a
```

---

## Service accounts (सुरक्षा के लिए सर्वोत्तम अभ्यास)

व्यक्तिगत उपयोग के लिए, आपका डिफ़ॉल्ट यूज़र खाता पर्याप्त है।

ऑटोमेशन या CI/CD पाइपलाइनों के लिए, न्यूनतम अनुमतियों के साथ एक समर्पित service account बनाएँ:

1. एक service account बनाएँ:

   ```bash
   gcloud iam service-accounts create openclaw-deploy \
     --display-name="OpenClaw Deployment"
   ```

2. Compute Instance Admin भूमिका दें (या उससे संकीर्ण कस्टम भूमिका):

   ```bash
   gcloud projects add-iam-policy-binding my-openclaw-project \
     --member="serviceAccount:openclaw-deploy@my-openclaw-project.iam.gserviceaccount.com" \
     --role="roles/compute.instanceAdmin.v1"
   ```

ऑटोमेशन के लिए Owner भूमिका का उपयोग करने से बचें। न्यूनतम विशेषाधिकार के सिद्धांत का उपयोग करें।

IAM भूमिकाओं के विवरण के लिए देखें: [https://cloud.google.com/iam/docs/understanding-roles](https://cloud.google.com/iam/docs/understanding-roles)

---

## अगले चरण

- मैसेजिंग चैनल सेट करें: [Channels](/channels)
- लोकल डिवाइस को नोड्स के रूप में पेयर करें: [Nodes](/nodes)
- Gateway कॉन्फ़िगर करें: [Gateway configuration](/gateway/configuration)
