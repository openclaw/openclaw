---
summary: "پائیدار اسٹیٹ کے ساتھ GCP Compute Engine VM (Docker) پر OpenClaw Gateway کو 24/7 چلائیں"
read_when:
  - آپ GCP پر OpenClaw کو 24/7 چلانا چاہتے ہیں
  - آپ اپنی ہی VM پر پروڈکشن گریڈ، ہمہ وقت فعال Gateway چاہتے ہیں
  - آپ پرسسٹنس، بائنریز، اور ری اسٹارٹ کے رویّے پر مکمل کنٹرول چاہتے ہیں
title: "GCP"
---

# GCP Compute Engine پر OpenClaw (Docker، پروڈکشن VPS گائیڈ)

## ہدف

Docker استعمال کرتے ہوئے GCP Compute Engine VM پر ایک مستقل OpenClaw Gateway چلانا، جس میں پائیدار اسٹیٹ، پہلے سے شامل بائنریز، اور محفوظ ری اسٹارٹ رویّہ ہو۔

اگر آپ "OpenClaw 24/7 تقریباً $5-12/ماہ" چاہتے ہیں تو یہ Google Cloud پر ایک قابلِ اعتماد سیٹ اپ ہے۔
قیمت مشین ٹائپ اور ریجن کے لحاظ سے مختلف ہوتی ہے؛ سب سے چھوٹا VM منتخب کریں جو آپ کے ورک لوڈ کے لیے مناسب ہو اور اگر OOM آئیں تو اسکیل اپ کریں۔

## ہم کیا کر رہے ہیں (سادہ الفاظ میں)؟

- GCP پروجیکٹ بنانا اور بلنگ فعال کرنا
- Compute Engine VM بنانا
- Docker انسٹال کرنا (الگ تھلگ ایپ رن ٹائم)
- Docker میں OpenClaw Gateway شروع کرنا
- `~/.openclaw` + `~/.openclaw/workspace` کو ہوسٹ پر محفوظ رکھنا (ری اسٹارٹس/ری بلڈز کے بعد بھی برقرار)
- SSH سرنگ کے ذریعے اپنے لیپ ٹاپ سے کنٹرول UI تک رسائی

Gateway تک رسائی کے طریقے:

- اپنے لیپ ٹاپ سے SSH پورٹ فارورڈنگ
- براہِ راست پورٹ ایکسپوژر، اگر آپ خود فائر وال اور ٹوکنز منیج کریں

This guide uses Debian on GCP Compute Engine.
Ubuntu بھی کام کرتا ہے؛ پیکجز کو اسی کے مطابق میپ کریں۔
جنیرک Docker فلو کے لیے [Docker](/install/docker) دیکھیں۔

---

## فوری راستہ (تجربہ کار آپریٹرز)

1. GCP پروجیکٹ بنائیں + Compute Engine API فعال کریں
2. Compute Engine VM بنائیں (e2-small، Debian 12، 20GB)
3. VM میں SSH کریں
4. Docker انسٹال کریں
5. OpenClaw ریپوزٹری کلون کریں
6. مستقل ہوسٹ ڈائریکٹریاں بنائیں
7. `.env` اور `docker-compose.yml` کنفیگر کریں
8. مطلوبہ بائنریز بیک کریں، بلڈ کریں، اور لانچ کریں

---

## آپ کو کیا درکار ہے

- GCP اکاؤنٹ (e2-micro کے لیے فری ٹائر اہل)
- gcloud CLI انسٹال (یا Cloud Console استعمال کریں)
- اپنے لیپ ٹاپ سے SSH رسائی
- SSH + کاپی/پیسٹ میں بنیادی سہولت
- ~20-30 منٹ
- Docker اور Docker Compose
- ماڈل کی تصدیقی اسناد
- اختیاری فراہم کنندہ اسناد
  - WhatsApp QR
  - Telegram بوٹ ٹوکن
  - Gmail OAuth

---

## 1. gcloud CLI انسٹال کریں (یا Console استعمال کریں)

**آپشن A: gcloud CLI** (آٹومیشن کے لیے تجویز کردہ)

انسٹال کریں: [https://cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install)

ابتدائی سیٹ اپ اور تصدیق:

```bash
gcloud init
gcloud auth login
```

**آپشن B: Cloud Console**

تمام مراحل ویب UI کے ذریعے یہاں کیے جا سکتے ہیں: [https://console.cloud.google.com](https://console.cloud.google.com)

---

## 2. GCP پروجیکٹ بنائیں

**CLI:**

```bash
gcloud projects create my-openclaw-project --name="OpenClaw Gateway"
gcloud config set project my-openclaw-project
```

بلنگ فعال کریں: [https://console.cloud.google.com/billing](https://console.cloud.google.com/billing) (Compute Engine کے لیے ضروری)۔

Compute Engine API فعال کریں:

```bash
gcloud services enable compute.googleapis.com
```

**Console:**

1. IAM & Admin > Create Project پر جائیں
2. نام دیں اور بنائیں
3. پروجیکٹ کے لیے بلنگ فعال کریں
4. APIs & Services > Enable APIs > "Compute Engine API" تلاش کریں > Enable

---

## 3. VM بنائیں

**مشین ٹائپس:**

| قسم      | خصوصیات                                    | لاگت                     | نوٹس                 |
| -------- | ------------------------------------------ | ------------------------ | -------------------- |
| e2-small | 2 vCPU، 2GB RAM                            | ~$12/ماہ | تجویز کردہ           |
| e2-micro | 2 vCPU (مشترک)، 1GB RAM | فری ٹائر اہل             | لوڈ پر OOM آ سکتا ہے |

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

1. Compute Engine > VM instances > Create instance پر جائیں
2. نام: `openclaw-gateway`
3. ریجن: `us-central1`، زون: `us-central1-a`
4. مشین ٹائپ: `e2-small`
5. بوٹ ڈسک: Debian 12، 20GB
6. Create

---

## 4. VM میں SSH کریں

**CLI:**

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

**Console:**

Compute Engine ڈیش بورڈ میں اپنی VM کے ساتھ موجود "SSH" بٹن پر کلک کریں۔

نوٹ: VM بنانے کے بعد SSH key propagation میں 1-2 منٹ لگ سکتے ہیں۔ اگر کنکشن ریفیوز ہو تو انتظار کریں اور دوبارہ کوشش کریں۔

---

## 5. Docker انسٹال کریں (VM پر)

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

گروپ تبدیلی کے نافذ ہونے کے لیے لاگ آؤٹ کریں اور دوبارہ لاگ اِن ہوں:

```bash
exit
```

پھر دوبارہ SSH کریں:

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

تصدیق کریں:

```bash
docker --version
docker compose version
```

---

## 6. OpenClaw ریپوزٹری کلون کریں

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

یہ گائیڈ فرض کرتی ہے کہ آپ بائنری پرسسٹنس کی ضمانت کے لیے ایک کسٹم امیج بنائیں گے۔

---

## 7. مستقل ہوسٹ ڈائریکٹریاں بنائیں

Docker کنٹینرز ephemeral ہوتے ہیں۔
تمام طویل المدتی state کو ہوسٹ پر رہنا چاہیے۔

```bash
mkdir -p ~/.openclaw
mkdir -p ~/.openclaw/workspace
```

---

## 8. ماحولیاتی متغیرات کنفیگر کریں

ریپوزٹری روٹ میں `.env` بنائیں۔

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

مضبوط سیکرٹس تیار کریں:

```bash
openssl rand -hex 32
```

**اس فائل کو کمٹ نہ کریں۔**

---

## 9. Docker Compose کنفیگریشن

`docker-compose.yml` بنائیں یا اپڈیٹ کریں۔

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

## 10. مطلوبہ بائنریز کو امیج میں بیک کریں (انتہائی اہم)

Installing binaries inside a running container is a trap.
رن ٹائم پر انسٹال کی گئی کوئی بھی چیز ری اسٹارٹ پر ختم ہو جائے گی۔

Skills کے لیے درکار تمام بیرونی بائنریز امیج بلڈ کے وقت انسٹال ہونی چاہئیں۔

نیچے کی مثالیں صرف تین عام بائنریز دکھاتی ہیں:

- Gmail رسائی کے لیے `gog`
- Google Places کے لیے `goplaces`
- WhatsApp کے لیے `wacli`

یہ مثالیں ہیں، مکمل فہرست نہیں۔
اسی پیٹرن کا استعمال کرتے ہوئے آپ جتنی چاہیں binaries انسٹال کر سکتے ہیں۔

اگر بعد میں نئی Skills شامل کریں جنہیں اضافی بائنریز درکار ہوں، تو لازم ہے کہ:

1. Dockerfile اپڈیٹ کریں
2. امیج دوبارہ بلڈ کریں
3. کنٹینرز ری اسٹارٹ کریں

**مثالی Dockerfile**

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

## 11. بلڈ اور لانچ کریں

```bash
docker compose build
docker compose up -d openclaw-gateway
```

بائنریز کی تصدیق کریں:

```bash
docker compose exec openclaw-gateway which gog
docker compose exec openclaw-gateway which goplaces
docker compose exec openclaw-gateway which wacli
```

متوقع آؤٹ پٹ:

```
/usr/local/bin/gog
/usr/local/bin/goplaces
/usr/local/bin/wacli
```

---

## 12. Gateway کی تصدیق کریں

```bash
docker compose logs -f openclaw-gateway
```

کامیابی:

```
[gateway] listening on ws://0.0.0.0:18789
```

---

## 13. اپنے لیپ ٹاپ سے رسائی

Gateway پورٹ فارورڈ کرنے کے لیے SSH سرنگ بنائیں:

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a -- -L 18789:127.0.0.1:18789
```

اپنے براؤزر میں کھولیں:

`http://127.0.0.1:18789/`

اپنا gateway ٹوکن پیسٹ کریں۔

---

## کیا کہاں محفوظ رہتا ہے (سورس آف ٹروتھ)

OpenClaw Docker میں چلتا ہے، لیکن Docker واحد source of truth نہیں ہے۔
تمام طویل المدتی state کو ری اسٹارٹس، rebuilds، اور reboots کو برداشت کرنا چاہیے۔

| جزو               | مقام                              | پرسسٹنس میکانزم       | نوٹس                          |
| ----------------- | --------------------------------- | --------------------- | ----------------------------- |
| Gateway کنفیگ     | `/home/node/.openclaw/`           | ہوسٹ والیوم ماؤنٹ     | `openclaw.json`، ٹوکنز شامل   |
| ماڈل آتھ پروفائلز | `/home/node/.openclaw/`           | ہوسٹ والیوم ماؤنٹ     | OAuth ٹوکنز، API کلیدیں       |
| Skill کنفیگز      | `/home/node/.openclaw/skills/`    | ہوسٹ والیوم ماؤنٹ     | Skill سطح کی اسٹیٹ            |
| ایجنٹ ورک اسپیس   | `/home/node/.openclaw/workspace/` | ہوسٹ والیوم ماؤنٹ     | کوڈ اور ایجنٹ آرٹی فیکٹس      |
| WhatsApp سیشن     | `/home/node/.openclaw/`           | ہوسٹ والیوم ماؤنٹ     | QR لاگ اِن محفوظ رکھتا ہے     |
| Gmail کی رنگ      | `/home/node/.openclaw/`           | ہوسٹ والیوم + پاس ورڈ | `GOG_KEYRING_PASSWORD` درکار  |
| بیرونی بائنریز    | `/usr/local/bin/`                 | Docker امیج           | بلڈ وقت پر بیک ہونا لازم      |
| Node رن ٹائم      | کنٹینر فائل سسٹم                  | Docker امیج           | ہر امیج بلڈ پر دوبارہ بنتا ہے |
| OS پیکجز          | کنٹینر فائل سسٹم                  | Docker امیج           | رن ٹائم پر انسٹال نہ کریں     |
| Docker کنٹینر     | عارضی                             | قابلِ ری اسٹارٹ       | ختم کرنا محفوظ ہے             |

---

## اپڈیٹس

VM پر OpenClaw اپڈیٹ کرنے کے لیے:

```bash
cd ~/openclaw
git pull
docker compose build
docker compose up -d
```

---

## خرابیوں کا ازالہ

**SSH کنکشن ریفیوز**

VM بنانے کے بعد SSH key propagation میں 1-2 منٹ لگ سکتے ہیں۔ انتظار کریں اور دوبارہ کوشش کریں۔

**OS Login مسائل**

اپنا OS Login پروفائل چیک کریں:

```bash
gcloud compute os-login describe-profile
```

یقینی بنائیں کہ آپ کے اکاؤنٹ کے پاس درکار IAM اجازتیں ہیں (Compute OS Login یا Compute OS Admin Login)۔

**میموری ختم ہونا (OOM)**

اگر e2-micro استعمال کرتے ہوئے OOM آ رہا ہے تو e2-small یا e2-medium پر اپگریڈ کریں:

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

## سروس اکاؤنٹس (سکیورٹی کی بہترین مشق)

ذاتی استعمال کے لیے آپ کا ڈیفالٹ یوزر اکاؤنٹ کافی ہے۔

آٹومیشن یا CI/CD پائپ لائنز کے لیے کم سے کم اجازتوں کے ساتھ ایک مخصوص سروس اکاؤنٹ بنائیں:

1. سروس اکاؤنٹ بنائیں:

   ```bash
   gcloud iam service-accounts create openclaw-deploy \
     --display-name="OpenClaw Deployment"
   ```

2. Compute Instance Admin رول دیں (یا اس سے محدود کسٹم رول):

   ```bash
   gcloud projects add-iam-policy-binding my-openclaw-project \
     --member="serviceAccount:openclaw-deploy@my-openclaw-project.iam.gserviceaccount.com" \
     --role="roles/compute.instanceAdmin.v1"
   ```

آٹومیشن کے لیے Owner رول استعمال کرنے سے گریز کریں۔ least privilege کے اصول پر عمل کریں۔

IAM رولز کی تفصیلات کے لیے دیکھیں:
[https://cloud.google.com/iam/docs/understanding-roles](https://cloud.google.com/iam/docs/understanding-roles)

---

## اگلے اقدامات

- میسجنگ چینلز سیٹ اپ کریں: [Channels](/channels)
- مقامی ڈیوائسز کو نوڈز کے طور پر جوڑیں: [Nodes](/nodes)
- Gateway کنفیگر کریں: [Gateway configuration](/gateway/configuration)
