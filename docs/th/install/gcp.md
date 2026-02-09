---
summary: "รันOpenClaw Gatewayตลอด24/7บนVMของGCP Compute Engine(Docker)พร้อมสถานะถาวร"
read_when:
  - คุณต้องการให้OpenClawทำงานตลอด24/7บนGCP
  - คุณต้องการGatewayระดับโปรดักชันที่เปิดตลอดเวลาบนVMของคุณเอง
  - คุณต้องการควบคุมการคงอยู่ของข้อมูล ไบนารี และพฤติกรรมการรีสตาร์ตอย่างเต็มที่
title: "GCP"
---

# OpenClawบนGCP Compute Engine(Docker,คู่มือVPSสำหรับโปรดักชัน)

## เป้าหมาย

รันOpenClaw Gatewayแบบคงอยู่บนVMของGCP Compute Engineโดยใช้Dockerพร้อมสถานะถาวร ไบนารีที่ฝังไว้ในอิมเมจ และพฤติกรรมการรีสตาร์ตที่ปลอดภัย

หากคุณต้องการ“OpenClawตลอด24/7ในงบประมาณประมาณ$5-12/เดือน”นี่คือการตั้งค่าที่เชื่อถือได้บนGoogle Cloud
ราคาขึ้นอยู่กับประเภทเครื่องและภูมิภาคเลือกVMที่เล็กที่สุดที่รองรับภาระงานของคุณและขยายเมื่อพบปัญหาOOM
Pricing varies by machine type and region; pick the smallest VM that fits your workload and scale up if you hit OOMs.

## เรากำลังทำอะไร(อธิบายแบบง่าย)?

- สร้างโปรเจ็กต์GCPและเปิดใช้งานการเรียกเก็บเงิน
- สร้างVMของCompute Engine
- ติดตั้งDocker(สภาพแวดล้อมรันแอปแบบแยก)
- เริ่มOpenClaw GatewayในDocker
- ทำให้`~/.openclaw`+`~/.openclaw/workspace`คงอยู่บนโฮสต์(อยู่รอดจากการรีสตาร์ต/สร้างใหม่)
- เข้าถึงControl UIจากแล็ปท็อปของคุณผ่านอุโมงค์SSH

สามารถเข้าถึงGatewayได้ผ่าน:

- การฟอร์เวิร์ดพอร์ตSSHจากแล็ปท็อปของคุณ
- การเปิดพอร์ตโดยตรงหากคุณจัดการไฟร์วอลล์และโทเคนเอง

คู่มือนี้ใช้DebianบนGCP Compute Engine
Ubuntuก็ใช้ได้เช่นกันให้แมปแพ็กเกจให้เหมาะสม
สำหรับโฟลว์Dockerทั่วไปดูที่[Docker](/install/docker)
Ubuntu also works; map packages accordingly.
For the generic Docker flow, see [Docker](/install/docker).

---

## เส้นทางด่วน(ผู้มีประสบการณ์)

1. สร้างโปรเจ็กต์GCP+เปิดCompute Engine API
2. สร้างVMของCompute Engine(e2-small,Debian 12,20GB)
3. SSHเข้าVM
4. ติดตั้งDocker
5. โคลนรีโพซิทอรีOpenClaw
6. สร้างไดเรกทอรีถาวรบนโฮสต์
7. กำหนดค่า`.env`และ`docker-compose.yml`
8. Bake required binaries, build, and launch

---

## สิ่งที่ต้องมี

- บัญชีGCP(ฟรีเทียร์ใช้ได้กับe2-micro)
- ติดตั้งgcloud CLI(หรือใช้Cloud Console)
- การเข้าถึงSSHจากแล็ปท็อปของคุณ
- ความคุ้นเคยพื้นฐานกับSSH+คัดลอก/วาง
- เวลาประมาณ20-30นาที
- DockerและDocker Compose
- ข้อมูลยืนยันตัวตนของโมเดล
- Optional provider credentials
  - QRของWhatsApp
  - โทเคนบอต Telegram
  - Gmail OAuth

---

## 1. ติดตั้งgcloud CLI(หรือใช้Console)

**ตัวเลือกA: gcloud CLI**(แนะนำสำหรับระบบอัตโนมัติ)

ติดตั้งจาก[https://cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install)

เริ่มต้นและยืนยันตัวตน:

```bash
gcloud init
gcloud auth login
```

**ตัวเลือกB: Cloud Console**

ทุกขั้นตอนสามารถทำผ่านเว็บUIที่[https://console.cloud.google.com](https://console.cloud.google.com)

---

## 2. สร้างโปรเจ็กต์GCP

**CLI:**

```bash
gcloud projects create my-openclaw-project --name="OpenClaw Gateway"
gcloud config set project my-openclaw-project
```

เปิดใช้งานการเรียกเก็บเงินที่[https://console.cloud.google.com/billing](https://console.cloud.google.com/billing)(จำเป็นสำหรับCompute Engine)

เปิดCompute Engine API:

```bash
gcloud services enable compute.googleapis.com
```

**Console:**

1. ไปที่IAM & Admin > Create Project
2. ตั้งชื่อและสร้าง
3. เปิดการเรียกเก็บเงินให้โปรเจ็กต์
4. ไปที่APIs & Services > Enable APIs > ค้นหา“Compute Engine API” > Enable

---

## 3. สร้างVM

**ประเภทเครื่อง:**

| Type     | Specs                                     | Cost                    | Notes              |
| -------- | ----------------------------------------- | ----------------------- | ------------------ |
| e2-small | 2 vCPU, 2GB RAM                           | ~$12/mo | แนะนำ              |
| e2-micro | 2 vCPU(shared),1GB RAM | ใช้ฟรีเทียร์ได้         | อาจOOMเมื่อโหลดสูง |

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

1. ไปที่Compute Engine > VM instances > Create instance
2. ชื่อ: `openclaw-gateway`
3. ภูมิภาค: `us-central1`, โซน: `us-central1-a`
4. ประเภทเครื่อง: `e2-small`
5. ดิสก์บูต: Debian 12,20GB
6. สร้าง

---

## 4. SSHเข้าVM

**CLI:**

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

**Console:**

คลิกปุ่ม“SSH”ถัดจากVMของคุณในแดชบอร์ดCompute Engine

Note: SSH key propagation can take 1-2 minutes after VM creation. If connection is refused, wait and retry.

---

## 5. ติดตั้งDocker(บนVM)

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

ออกจากระบบแล้วเข้าสู่ระบบใหม่เพื่อให้การเปลี่ยนแปลงกลุ่มมีผล:

```bash
exit
```

จากนั้นSSHเข้าอีกครั้ง:

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

ตรวจสอบ:

```bash
docker --version
docker compose version
```

---

## 6. โคลนรีโพซิทอรีOpenClaw

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

คู่มือนี้สมมติว่าคุณจะสร้างอิมเมจแบบกำหนดเองเพื่อรับประกันการคงอยู่ของไบนารี

---

## 7. สร้างไดเรกทอรีถาวรบนโฮสต์

Docker containers are ephemeral.
คอนเทนเนอร์Dockerเป็นแบบชั่วคราว
สถานะที่ต้องอยู่ระยะยาวทั้งหมดต้องอยู่บนโฮสต์

```bash
mkdir -p ~/.openclaw
mkdir -p ~/.openclaw/workspace
```

---

## 8. กำหนดค่าตัวแปรสภาพแวดล้อม

สร้าง`.env`ที่รากของรีโพซิทอรี

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

สร้างซีเคร็ตที่แข็งแรง:

```bash
openssl rand -hex 32
```

**ห้ามคอมมิตไฟล์นี้**

---

## 9. คอนฟิกDocker Compose

สร้างหรืออัปเดต`docker-compose.yml`

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

## 10. ฝังไบนารีที่จำเป็นลงในอิมเมจ(สำคัญ)

Installing binaries inside a running container is a trap.
การติดตั้งไบนารีภายในคอนเทนเนอร์ที่กำลังรันเป็นกับดัก
ทุกอย่างที่ติดตั้งขณะรันจะหายไปเมื่อรีสตาร์ต

ไบนารีภายนอกทั้งหมดที่Skillsต้องใช้ต้องติดตั้งตั้งแต่ขั้นตอนสร้างอิมเมจ

ตัวอย่างด้านล่างแสดงเพียงสามไบนารีที่พบบ่อย:

- `gog`สำหรับการเข้าถึงGmail
- `goplaces`สำหรับGoogle Places
- `wacli`สำหรับWhatsApp

These are examples, not a complete list.
นี่เป็นเพียงตัวอย่างไม่ใช่รายการทั้งหมด
คุณสามารถติดตั้งไบนารีได้มากเท่าที่ต้องการด้วยรูปแบบเดียวกัน

หากคุณเพิ่มSkillsใหม่ในภายหลังที่ต้องพึ่งพาไบนารีเพิ่มเติมคุณต้อง:

1. อัปเดตDockerfile
2. สร้างอิมเมจใหม่
3. รีสตาร์ตคอนเทนเนอร์

**ตัวอย่างDockerfile**

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

## 11. สร้างและเปิดใช้งาน

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

## 12. ตรวจสอบGateway

```bash
docker compose logs -f openclaw-gateway
```

สำเร็จ:

```
[gateway] listening on ws://0.0.0.0:18789
```

---

## 13. เข้าถึงจากแล็ปท็อปของคุณ

สร้างอุโมงค์SSHเพื่อฟอร์เวิร์ดพอร์ตของGateway:

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a -- -L 18789:127.0.0.1:18789
```

เปิดในเบราว์เซอร์ของคุณ:

`http://127.0.0.1:18789/`

วางโทเคนของ Gateway ของคุณ

---

## สิ่งใดคงอยู่ที่ใด(แหล่งอ้างอิงหลัก)

OpenClaw รันใน Docker แต่ Docker ไม่ใช่แหล่งความจริง  
สถานะที่มีอายุยาวทั้งหมดต้องอยู่รอดผ่านการรีสตาร์ต รีบิลด์ และรีบูต
OpenClawรันในDockerแต่Dockerไม่ใช่แหล่งอ้างอิงหลัก
สถานะที่อยู่ระยะยาวทั้งหมดต้องอยู่รอดจากการรีสตาร์ต การสร้างใหม่ และการรีบูต

| Component           | Location                          | Persistence mechanism | Notes                         |
| ------------------- | --------------------------------- | --------------------- | ----------------------------- |
| Gateway config      | `/home/node/.openclaw/`           | การเมานต์วอลุ่มโฮสต์  | รวม`openclaw.json`,โทเคน      |
| Model auth profiles | `/home/node/.openclaw/`           | การเมานต์วอลุ่มโฮสต์  | โทเคนOAuth,คีย์API            |
| Skill configs       | `/home/node/.openclaw/skills/`    | การเมานต์วอลุ่มโฮสต์  | สถานะระดับSkill               |
| Agent workspace     | `/home/node/.openclaw/workspace/` | การเมานต์วอลุ่มโฮสต์  | โค้ดและอาร์ติแฟกต์ของเอเจนต์  |
| WhatsApp session    | `/home/node/.openclaw/`           | การเมานต์วอลุ่มโฮสต์  | เก็บการล็อกอินด้วยQR          |
| Gmail keyring       | `/home/node/.openclaw/`           | วอลุ่มโฮสต์+รหัสผ่าน  | ต้องใช้`GOG_KEYRING_PASSWORD` |
| External binaries   | `/usr/local/bin/`                 | อิมเมจDocker          | Must be baked at build time   |
| Node runtime        | ระบบไฟล์คอนเทนเนอร์               | อิมเมจDocker          | รีบิลด์ทุกครั้งที่สร้างอิมเมจ |
| OS packages         | ระบบไฟล์คอนเทนเนอร์               | อิมเมจDocker          | ห้ามติดตั้งขณะรัน             |
| Docker container    | Ephemeral                         | รีสตาร์ตได้           | ทำลายได้อย่างปลอดภัย          |

---

## การอัปเดต

เพื่ออัปเดตOpenClawบนVM:

```bash
cd ~/openclaw
git pull
docker compose build
docker compose up -d
```

---

## การแก้ไขปัญหา

**SSHเชื่อมต่อไม่ได้**

การกระจายคีย์SSHอาจใช้เวลา1-2นาทีหลังสร้างVM รอแล้วลองใหม่ Wait and retry.

**ปัญหาOS Login**

ตรวจสอบโปรไฟล์OS Loginของคุณ:

```bash
gcloud compute os-login describe-profile
```

ตรวจสอบให้แน่ใจว่าบัญชีของคุณมีสิทธิ์IAMที่จำเป็น(Compute OS LoginหรือCompute OS Admin Login)

**หน่วยความจำไม่พอ(OOM)**

หากใช้e2-microแล้วพบOOMให้อัปเกรดเป็นe2-smallหรือe2-medium:

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

## Service accounts(แนวปฏิบัติด้านความปลอดภัย)

สำหรับการใช้งานส่วนตัวบัญชีผู้ใช้เริ่มต้นของคุณเพียงพอ

สำหรับระบบอัตโนมัติหรือCI/CDให้สร้างservice accountเฉพาะพร้อมสิทธิ์ขั้นต่ำ:

1. สร้างservice account:

   ```bash
   gcloud iam service-accounts create openclaw-deploy \
     --display-name="OpenClaw Deployment"
   ```

2. มอบบทบาทCompute Instance Admin(หรือบทบาทกำหนดเองที่แคบกว่า):

   ```bash
   gcloud projects add-iam-policy-binding my-openclaw-project \
     --member="serviceAccount:openclaw-deploy@my-openclaw-project.iam.gserviceaccount.com" \
     --role="roles/compute.instanceAdmin.v1"
   ```

หลีกเลี่ยงการใช้บทบาทOwnerสำหรับระบบอัตโนมัติ ใช้หลักการให้สิทธิ์เท่าที่จำเป็น Use the principle of least privilege.

ดูรายละเอียดบทบาทIAMที่[https://cloud.google.com/iam/docs/understanding-roles](https://cloud.google.com/iam/docs/understanding-roles)

---

## ขั้นตอนถัดไป

- ตั้งค่าช่องทางการส่งข้อความ: [Channels](/channels)
- จับคู่อุปกรณ์ภายในเครื่องเป็นโหนด: [Nodes](/nodes)
- กำหนดค่าGateway: [Gateway configuration](/gateway/configuration)
