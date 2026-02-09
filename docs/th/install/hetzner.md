---
summary: "รัน OpenClaw Gateway ตลอด 24/7 บน VPS ราคาประหยัดของ Hetzner (Docker) พร้อมสถานะที่คงทนและไบนารีที่ฝังมาในอิมเมจ"
read_when:
  - คุณต้องการให้ OpenClaw ทำงานตลอด 24/7 บน VPS บนคลาวด์ (ไม่ใช่บนแล็ปท็อปของคุณ)
  - คุณต้องการ Gateway ระดับโปรดักชันที่เปิดใช้งานตลอดเวลาบน VPS ของคุณเอง
  - คุณต้องการควบคุมการคงอยู่ของข้อมูล ไบนารี และพฤติกรรมการรีสตาร์ตได้อย่างเต็มที่
  - คุณกำลังรัน OpenClaw ใน Docker บน Hetzner หรือผู้ให้บริการที่คล้ายกัน
title: "Hetzner"
---

# OpenClaw บน Hetzner (Docker, คู่มือ VPS สำหรับโปรดักชัน)

## เป้าหมาย

รัน OpenClaw Gateway แบบถาวรบน Hetzner VPS โดยใช้ Docker พร้อมสถานะที่คงทน ไบนารีที่ฝังมาในอิมเมจ และพฤติกรรมการรีสตาร์ตที่ปลอดภัย

If you want “OpenClaw 24/7 for ~$5”, this is the simplest reliable setup.
หากคุณต้องการ “OpenClaw 24/7 ประมาณ ~$5” นี่คือการตั้งค่าที่ง่ายและเชื่อถือได้ที่สุด  
ราคาของ Hetzner อาจเปลี่ยนแปลงได้ เลือก VPS Debian/Ubuntu ขนาดเล็กที่สุดก่อน และค่อยขยายเมื่อพบ OOM

## เรากำลังทำอะไรอยู่ (อธิบายแบบง่าย)?

- เช่าเซิร์ฟเวอร์ Linux ขนาดเล็ก (Hetzner VPS)
- ติดตั้ง Docker (สภาพแวดล้อมรันแอปแบบแยก)
- เริ่ม OpenClaw Gateway ใน Docker
- คงอยู่ของ `~/.openclaw` + `~/.openclaw/workspace` บนโฮสต์ (อยู่รอดผ่านการรีสตาร์ต/รีบิลด์)
- เข้าถึง Control UI จากแล็ปท็อปของคุณผ่านอุโมงค์ SSH

การเข้าถึง Gateway ทำได้ผ่าน:

- การทำ SSH port forwarding จากแล็ปท็อปของคุณ
- การเปิดพอร์ตโดยตรง หากคุณจัดการไฟร์วอลล์และโทเคนเอง

This guide assumes Ubuntu or Debian on Hetzner.  
If you are on another Linux VPS, map packages accordingly.
For the generic Docker flow, see [Docker](/install/docker).

---

## เส้นทางด่วน (สำหรับผู้มีประสบการณ์)

1. จัดเตรียม Hetzner VPS
2. ติดตั้ง Docker
3. โคลนรีโพซิทอรี OpenClaw
4. สร้างไดเรกทอรีถาวรบนโฮสต์
5. กำหนดค่า `.env` และ `docker-compose.yml`
6. ฝังไบนารีที่จำเป็นลงในอิมเมจ
7. `docker compose up -d`
8. ตรวจสอบความคงอยู่และการเข้าถึง Gateway

---

## สิ่งที่ต้องมี

- Hetzner VPS พร้อมสิทธิ์ root
- การเข้าถึงผ่าน SSH จากแล็ปท็อปของคุณ
- คุ้นเคยกับ SSH + คัดลอก/วางขั้นพื้นฐาน
- เวลาประมาณ ~20 นาที
- Docker และ Docker Compose
- ข้อมูลรับรองการยืนยันตัวตนของโมเดล
- Optional provider credentials
  - QR ของ WhatsApp
  - โทเคนบอต Telegram
  - Gmail OAuth

---

## 1. จัดเตรียม VPS

สร้าง Ubuntu หรือ Debian VPS บน Hetzner

เชื่อมต่อเป็น root:

```bash
ssh root@YOUR_VPS_IP
```

คู่มือนี้สมมติว่า VPS มีสถานะถาวร  
อย่าปฏิบัติกับมันเหมือนโครงสร้างพื้นฐานแบบใช้แล้วทิ้ง
Do not treat it as disposable infrastructure.

---

## 2. ติดตั้ง Docker (บน VPS)

```bash
apt-get update
apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sh
```

ตรวจสอบ:

```bash
docker --version
docker compose version
```

---

## 3. โคลนรีโพซิทอรี OpenClaw

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

คู่มือนี้สมมติว่าคุณจะสร้างอิมเมจแบบกำหนดเองเพื่อรับประกันการคงอยู่ของไบนารี

---

## 4. สร้างไดเรกทอรีถาวรบนโฮสต์

Docker containers are ephemeral.
คอนเทนเนอร์Dockerเป็นแบบชั่วคราว
สถานะที่ต้องอยู่ระยะยาวทั้งหมดต้องอยู่บนโฮสต์

```bash
mkdir -p /root/.openclaw
mkdir -p /root/.openclaw/workspace

# Set ownership to the container user (uid 1000):
chown -R 1000:1000 /root/.openclaw
chown -R 1000:1000 /root/.openclaw/workspace
```

---

## 5. กำหนดค่าตัวแปรสภาพแวดล้อม

สร้าง `.env` ที่รูทของรีโพซิทอรี

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

สร้างซีเคร็ตที่แข็งแรง:

```bash
openssl rand -hex 32
```

**ห้ามคอมมิตไฟล์นี้**

---

## 6. การกำหนดค่า Docker Compose

สร้างหรืออัปเดต `docker-compose.yml`

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

## 7. ฝังไบนารีที่จำเป็นลงในอิมเมจ (สำคัญมาก)

Installing binaries inside a running container is a trap.
การติดตั้งไบนารีภายในคอนเทนเนอร์ที่กำลังรันอยู่เป็นกับดัก  
ทุกอย่างที่ติดตั้งตอนรันไทม์จะหายไปเมื่อรีสตาร์ต

ไบนารีภายนอกทั้งหมดที่ Skills ต้องใช้ ต้องติดตั้งตั้งแต่ขั้นตอนสร้างอิมเมจ

ตัวอย่างด้านล่างแสดงไบนารีที่พบบ่อยเพียงสามรายการ:

- `gog` สำหรับการเข้าถึง Gmail
- `goplaces` สำหรับ Google Places
- `wacli` สำหรับ WhatsApp

These are examples, not a complete list.
นี่เป็นเพียงตัวอย่าง ไม่ใช่รายการครบถ้วน  
คุณสามารถติดตั้งไบนารีได้มากเท่าที่ต้องการด้วยรูปแบบเดียวกัน

หากภายหลังคุณเพิ่ม Skills ใหม่ที่พึ่งพาไบนารีเพิ่มเติม คุณต้อง:

1. อัปเดต Dockerfile
2. สร้างอิมเมจใหม่
3. รีสตาร์ตคอนเทนเนอร์

**ตัวอย่าง Dockerfile**

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

## 8. บิลด์และเริ่มใช้งาน

```bash
docker compose build
docker compose up -d openclaw-gateway
```

ตรวจสอบไบนารี:

```bash
docker compose exec openclaw-gateway which gog
docker compose exec openclaw-gateway which goplaces
docker compose exec openclaw-gateway which wacli
```

เอาต์พุตที่คาดหวัง:

```
/usr/local/bin/gog
/usr/local/bin/goplaces
/usr/local/bin/wacli
```

---

## 9. ตรวจสอบ Gateway

```bash
docker compose logs -f openclaw-gateway
```

สำเร็จ:

```
[gateway] listening on ws://0.0.0.0:18789
```

จากแล็ปท็อปของคุณ:

```bash
ssh -N -L 18789:127.0.0.1:18789 root@YOUR_VPS_IP
```

เปิด:

`http://127.0.0.1:18789/`

วางโทเคนของ Gateway ของคุณ

---

## อะไรคงอยู่ที่ไหน (แหล่งความจริง)

OpenClaw รันใน Docker แต่ Docker ไม่ใช่แหล่งความจริง  
สถานะที่มีอายุยาวทั้งหมดต้องอยู่รอดผ่านการรีสตาร์ต รีบิลด์ และรีบูต
OpenClawรันในDockerแต่Dockerไม่ใช่แหล่งอ้างอิงหลัก
สถานะที่อยู่ระยะยาวทั้งหมดต้องอยู่รอดจากการรีสตาร์ต การสร้างใหม่ และการรีบูต

| องค์ประกอบ                 | ตำแหน่ง                           | กลไกการคงอยู่         | หมายเหตุ                       |
| -------------------------- | --------------------------------- | --------------------- | ------------------------------ |
| คอนฟิก Gateway             | `/home/node/.openclaw/`           | การเมานต์วอลุ่มโฮสต์  | รวม `openclaw.json` และโทเคน   |
| โปรไฟล์ยืนยันตัวตนของโมเดล | `/home/node/.openclaw/`           | การเมานต์วอลุ่มโฮสต์  | โทเคน OAuth, คีย์ API          |
| คอนฟิก Skill               | `/home/node/.openclaw/skills/`    | การเมานต์วอลุ่มโฮสต์  | สถานะระดับ Skill               |
| เวิร์กสเปซเอเจนต์          | `/home/node/.openclaw/workspace/` | การเมานต์วอลุ่มโฮสต์  | โค้ดและอาร์ติแฟกต์ของเอเจนต์   |
| เซสชัน WhatsApp            | `/home/node/.openclaw/`           | การเมานต์วอลุ่มโฮสต์  | คงอยู่ของการล็อกอินด้วย QR     |
| พวงกุญแจ Gmail             | `/home/node/.openclaw/`           | โวลุมโฮสต์ + รหัสผ่าน | ต้องใช้ `GOG_KEYRING_PASSWORD` |
| ไบนารีภายนอก               | `/usr/local/bin/`                 | อิมเมจ Docker         | Must be baked at build time    |
| Node runtime               | ไฟล์ระบบของคอนเทนเนอร์            | อิมเมจ Docker         | รีบิลด์ทุกครั้งที่สร้างอิมเมจ  |
| แพ็กเกจ OS                 | ไฟล์ระบบของคอนเทนเนอร์            | อิมเมจ Docker         | อย่าติดตั้งตอนรันไทม์          |
| คอนเทนเนอร์ Docker         | Ephemeral                         | รีสตาร์ตได้           | ทำลายได้อย่างปลอดภัย           |
