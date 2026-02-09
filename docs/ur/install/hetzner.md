---
summary: "سستے Hetzner VPS (Docker) پر پائیدار اسٹیٹ اور پہلے سے شامل بائنریز کے ساتھ OpenClaw Gateway کو 24/7 چلائیں"
read_when:
  - آپ OpenClaw کو کلاؤڈ VPS پر 24/7 چلانا چاہتے ہیں (اپنے لیپ ٹاپ پر نہیں)
  - آپ اپنے VPS پر پروڈکشن گریڈ، ہمیشہ فعال Gateway چاہتے ہیں
  - آپ پائیداری، بائنریز اور ری اسٹارٹ رویّے پر مکمل کنٹرول چاہتے ہیں
  - آپ Hetzner یا ملتے جلتے فراہم کنندہ پر Docker میں OpenClaw چلا رہے ہیں
title: "Hetzner"
---

# Hetzner پر OpenClaw (Docker، پروڈکشن VPS گائیڈ)

## مقصد

Docker کا استعمال کرتے ہوئے Hetzner VPS پر ایک مستقل OpenClaw Gateway چلانا، جس میں پائیدار اسٹیٹ، پہلے سے شامل بائنریز، اور محفوظ ری اسٹارٹ رویّہ شامل ہو۔

اگر آپ “OpenClaw 24/7 تقریباً $5” چاہتے ہیں تو یہ سب سے سادہ اور قابلِ اعتماد سیٹ اپ ہے۔
Hetzner کی قیمتیں بدلتی رہتی ہیں؛ سب سے چھوٹا Debian/Ubuntu VPS منتخب کریں اور اگر OOM آئیں تو اسکیل اپ کریں۔

## ہم کیا کر رہے ہیں (سادہ الفاظ میں)؟

- ایک چھوٹا Linux سرور کرائے پر لینا (Hetzner VPS)
- Docker انسٹال کرنا (الگ تھلگ ایپ رن ٹائم)
- Docker میں OpenClaw Gateway شروع کرنا
- ہوسٹ پر `~/.openclaw` + `~/.openclaw/workspace` کو محفوظ رکھنا (ری اسٹارٹس/ری بلڈز کے بعد بھی برقرار)
- SSH سرنگ کے ذریعے اپنے لیپ ٹاپ سے کنٹرول UI تک رسائی

Gateway تک رسائی کے طریقے:

- اپنے لیپ ٹاپ سے SSH پورٹ فارورڈنگ
- براہِ راست پورٹ ایکسپوژر، اگر آپ فائر وال اور ٹوکنز خود منیج کرتے ہیں

یہ گائیڈ Hetzner پر Ubuntu یا Debian فرض کرتی ہے۔  
اگر آپ کسی اور Linux VPS پر ہیں تو پیکجز کو اسی کے مطابق میپ کریں۔
For the generic Docker flow, see [Docker](/install/docker).

---

## فوری راستہ (تجربہ کار آپریٹرز)

1. Hetzner VPS فراہم کریں
2. Docker انسٹال کریں
3. OpenClaw ریپوزٹری کلون کریں
4. مستقل ہوسٹ ڈائریکٹریز بنائیں
5. `.env` اور `docker-compose.yml` کنفیگر کریں
6. مطلوبہ بائنریز کو امیج میں شامل کریں
7. `docker compose up -d`
8. پائیداری اور Gateway رسائی کی تصدیق کریں

---

## آپ کو کیا درکار ہے

- روٹ رسائی کے ساتھ Hetzner VPS
- اپنے لیپ ٹاپ سے SSH رسائی
- SSH + کاپی/پیسٹ کے ساتھ بنیادی سہولت
- تقریباً 20 منٹ
- Docker اور Docker Compose
- ماڈل تصدیقی اسناد
- اختیاری فراہم کنندہ اسناد
  - WhatsApp QR
  - Telegram بوٹ ٹوکن
  - Gmail OAuth

---

## 1. VPS فراہم کریں

Hetzner میں Ubuntu یا Debian VPS بنائیں۔

روٹ کے طور پر کنیکٹ کریں:

```bash
ssh root@YOUR_VPS_IP
```

This guide assumes the VPS is stateful.
Do not treat it as disposable infrastructure.

---

## 2. Docker انسٹال کریں (VPS پر)

```bash
apt-get update
apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sh
```

تصدیق کریں:

```bash
docker --version
docker compose version
```

---

## 3. OpenClaw ریپوزٹری کلون کریں

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

یہ گائیڈ فرض کرتی ہے کہ آپ بائنری پائیداری کی ضمانت کے لیے ایک کسٹم امیج بنائیں گے۔

---

## 4. مستقل ہوسٹ ڈائریکٹریز بنائیں

Docker containers are ephemeral.
All long-lived state must live on the host.

```bash
mkdir -p /root/.openclaw
mkdir -p /root/.openclaw/workspace

# Set ownership to the container user (uid 1000):
chown -R 1000:1000 /root/.openclaw
chown -R 1000:1000 /root/.openclaw/workspace
```

---

## 5. ماحولیاتی متغیرات کنفیگر کریں

ریپوزٹری روٹ میں `.env` بنائیں۔

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

مضبوط راز بنائیں:

```bash
openssl rand -hex 32
```

**اس فائل کو کمٹ نہ کریں۔**

---

## 6. Docker Compose کنفیگریشن

`docker-compose.yml` بنائیں یا اپ ڈیٹ کریں۔

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

## 7. مطلوبہ بائنریز کو امیج میں شامل کریں (اہم)

Installing binaries inside a running container is a trap.
Anything installed at runtime will be lost on restart.

Skills کو درکار تمام بیرونی بائنریز امیج بلڈ کے وقت انسٹال ہونی چاہئیں۔

نیچے دی گئی مثالیں صرف تین عام بائنریز دکھاتی ہیں:

- Gmail رسائی کے لیے `gog`
- Google Places کے لیے `goplaces`
- WhatsApp کے لیے `wacli`

These are examples, not a complete list.
You may install as many binaries as needed using the same pattern.

اگر بعد میں آپ نئی Skills شامل کریں جو اضافی بائنریز پر منحصر ہوں، تو آپ کو لازماً:

1. Dockerfile اپ ڈیٹ کرنا ہوگا
2. امیج ری بلڈ کرنا ہوگا
3. کنٹینرز ری اسٹارٹ کرنے ہوں گے

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

## 8. بلڈ اور لانچ کریں

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

## 9. Gateway کی تصدیق کریں

```bash
docker compose logs -f openclaw-gateway
```

کامیابی:

```
[gateway] listening on ws://0.0.0.0:18789
```

اپنے لیپ ٹاپ سے:

```bash
ssh -N -L 18789:127.0.0.1:18789 root@YOUR_VPS_IP
```

کھولیں:

`http://127.0.0.1:18789/`

اپنا gateway ٹوکن پیسٹ کریں۔

---

## کیا کہاں محفوظ رہتا ہے (حقیقی ماخذ)

OpenClaw runs in Docker, but Docker is not the source of truth.
All long-lived state must survive restarts, rebuilds, and reboots.

| جزو                  | مقام                              | پائیداری کا طریقہ     | نوٹس                         |
| -------------------- | --------------------------------- | --------------------- | ---------------------------- |
| Gateway کنفیگ        | `/home/node/.openclaw/`           | ہوسٹ والیوم ماؤنٹ     | `openclaw.json`، ٹوکنز شامل  |
| ماڈل تصدیقی پروفائلز | `/home/node/.openclaw/`           | ہوسٹ والیوم ماؤنٹ     | OAuth ٹوکنز، API کلیدیں      |
| Skill کنفیگز         | `/home/node/.openclaw/skills/`    | ہوسٹ والیوم ماؤنٹ     | Skill سطح کی اسٹیٹ           |
| ایجنٹ ورک اسپیس      | `/home/node/.openclaw/workspace/` | ہوسٹ والیوم ماؤنٹ     | کوڈ اور ایجنٹ آرٹیفیکٹس      |
| WhatsApp سیشن        | `/home/node/.openclaw/`           | ہوسٹ والیوم ماؤنٹ     | QR لاگ اِن محفوظ رکھتا ہے    |
| Gmail کی رنگ         | `/home/node/.openclaw/`           | ہوسٹ والیوم + پاس ورڈ | `GOG_KEYRING_PASSWORD` درکار |
| بیرونی بائنریز       | `/usr/local/bin/`                 | Docker امیج           | بلڈ کے وقت شامل ہونی چاہئیں  |
| Node رن ٹائم         | کنٹینر فائل سسٹم                  | Docker امیج           | ہر امیج بلڈ پر ری بلڈ        |
| OS پیکجز             | کنٹینر فائل سسٹم                  | Docker امیج           | رن ٹائم پر انسٹال نہ کریں    |
| Docker کنٹینر        | عارضی                             | قابلِ ری اسٹارٹ       | ختم کرنا محفوظ ہے            |
