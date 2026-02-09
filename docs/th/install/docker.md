---
summary: "การตั้งค่าและการเริ่มต้นใช้งาน OpenClaw ด้วย Docker แบบไม่บังคับ"
read_when:
  - คุณต้องการ Gateway แบบคอนเทนเนอร์แทนการติดตั้งในเครื่อง
  - คุณกำลังตรวจสอบขั้นตอนการทำงานของ Docker
title: "Docker"
---

# Docker (ไม่บังคับ)

Docker is **optional**. Docker เป็นตัวเลือก**ไม่บังคับ** ใช้เฉพาะเมื่อคุณต้องการ Gateway แบบคอนเทนเนอร์หรือเพื่อตรวจสอบขั้นตอนการทำงานของ Docker

## Docker เหมาะกับฉันหรือไม่?

- **ใช่**: คุณต้องการสภาพแวดล้อม Gateway ที่แยกอิสระและลบทิ้งได้ง่ายหรือรัน OpenClaw บนโฮสต์ที่ไม่สามารถติดตั้งซอฟต์แวร์ในเครื่องได้
- **ไม่**: คุณรันบนเครื่องของตัวเองและต้องการรอบการพัฒนาที่เร็วที่สุด ให้ใช้ขั้นตอนการติดตั้งปกติแทน Use the normal install flow instead.
- **หมายเหตุเรื่อง sandboxing**: agent sandboxing ก็ใช้ Docker เช่นกัน แต่**ไม่จำเป็น**ต้องรัน Gateway ทั้งหมดใน Docker ดู [Sandboxing](/gateway/sandboxing) See [Sandboxing](/gateway/sandboxing).

คู่มือนี้ครอบคลุม:

- Gateway แบบคอนเทนเนอร์ (OpenClaw ทั้งหมดใน Docker)
- Agent Sandbox ต่อเซสชัน (Gateway บนโฮสต์ + เครื่องมือเอเจนต์ที่แยกด้วย Docker)

รายละเอียด sandboxing: [Sandboxing](/gateway/sandboxing)

## ข้อกำหนด

- Docker Desktop (หรือ Docker Engine) + Docker Compose v2
- พื้นที่ดิสก์เพียงพอสำหรับอิมเมจและล็อก

## Containerized Gateway (Docker Compose)

### เริ่มต้นอย่างรวดเร็ว (แนะนำ)

จากโฟลเดอร์รากของรีโป:

```bash
./docker-setup.sh
```

สคริปต์นี้จะ:

- สร้างอิมเมจ Gateway
- รันวิซาร์ด onboarding
- prints optional provider setup hints
- เริ่ม Gateway ผ่าน Docker Compose
- สร้างโทเคน Gateway และเขียนลงใน `.env`

Optional env vars:

- `OPENCLAW_DOCKER_APT_PACKAGES` — ติดตั้งแพ็กเกจ apt เพิ่มเติมระหว่างการ build
- `OPENCLAW_EXTRA_MOUNTS` — เพิ่ม bind mount จากโฮสต์
- `OPENCLAW_HOME_VOLUME` — ทำให้ `/home/node` คงอยู่ใน named volume

หลังจากเสร็จสิ้น:

- เปิด `http://127.0.0.1:18789/` ในเบราว์เซอร์
- วางโทเคนลงใน Control UI (Settings → token)
- ต้องการ URL อีกครั้งใช่ไหม? รัน `docker compose run --rm openclaw-cli dashboard --no-open`

ระบบจะเขียนคอนฟิก/เวิร์กสเปซไว้บนโฮสต์:

- `~/.openclaw/`
- `~/.openclaw/workspace`

รันบน VPS ใช่ไหม? ดู [Hetzner (Docker VPS)](/install/hetzner)

### ขั้นตอนแบบแมนนวล (compose)

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose run --rm openclaw-cli onboard
docker compose up -d openclaw-gateway
```

Note: run `docker compose ...` from the repo root. หมายเหตุ: รัน `docker compose ...` จากโฟลเดอร์รากของรีโป หากคุณเปิดใช้งาน
`OPENCLAW_EXTRA_MOUNTS` หรือ `OPENCLAW_HOME_VOLUME` สคริปต์ตั้งค่าจะเขียน
`docker-compose.extra.yml` ให้รวมไฟล์นี้เมื่อรัน Compose จากที่อื่น:

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml <command>
```

### โทเคน Control UI + การจับคู่ (Docker)

หากคุณเห็น “unauthorized” หรือ “disconnected (1008): pairing required” ให้ดึงลิงก์แดชบอร์ดใหม่และอนุมัติอุปกรณ์เบราว์เซอร์:

```bash
docker compose run --rm openclaw-cli dashboard --no-open
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>
```

รายละเอียดเพิ่มเติม: [Dashboard](/web/dashboard), [Devices](/cli/devices)

### เมานต์เพิ่มเติม (ไม่บังคับ)

หากต้องการเมานต์ไดเรกทอรีจากโฮสต์เพิ่มเติมเข้าไปในคอนเทนเนอร์ ให้ตั้งค่า
`OPENCLAW_EXTRA_MOUNTS` ก่อนรัน `docker-setup.sh` ตัวแปรนี้รับรายการ Docker bind mount
คั่นด้วยเครื่องหมายจุลภาค และนำไปใช้กับทั้ง
`openclaw-gateway` และ `openclaw-cli` โดยสร้างไฟล์ `docker-compose.extra.yml` This accepts a
comma-separated list of Docker bind mounts and applies them to both
`openclaw-gateway` and `openclaw-cli` by generating `docker-compose.extra.yml`.

ตัวอย่าง:

```bash
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

หมายเหตุ:

- พาธต้องถูกแชร์กับ Docker Desktop บน macOS/Windows
- หากคุณแก้ไข `OPENCLAW_EXTRA_MOUNTS` ให้รัน `docker-setup.sh` ใหม่เพื่อสร้างไฟล์ compose เพิ่มเติม
- `docker-compose.extra.yml` ถูกสร้างอัตโนมัติ อย่าแก้ไขด้วยมือ Don’t hand-edit it.

### ทำให้ home ของคอนเทนเนอร์ทั้งหมดคงอยู่ (ไม่บังคับ)

หากต้องการให้ `/home/node` คงอยู่หลังจากสร้างคอนเทนเนอร์ใหม่ ให้ตั้งค่า named volume ผ่าน `OPENCLAW_HOME_VOLUME`. หากคุณต้องการให้ `/home/node` คงอยู่แม้จะสร้างคอนเทนเนอร์ใหม่ ให้ตั้งค่า named
volume ผ่าน `OPENCLAW_HOME_VOLUME` วิธีนี้จะสร้าง Docker volume และเมานต์ที่
`/home/node` โดยยังคงใช้ bind mount มาตรฐานสำหรับคอนฟิก/เวิร์กสเปซ ใช้
named volume ในกรณีนี้ (ไม่ใช่ bind path); สำหรับ bind mount ให้ใช้
`OPENCLAW_EXTRA_MOUNTS` Use a
named volume here (not a bind path); for bind mounts, use
`OPENCLAW_EXTRA_MOUNTS`.

ตัวอย่าง:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

คุณสามารถใช้ร่วมกับเมานต์เพิ่มเติมได้:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

หมายเหตุ:

- หากคุณเปลี่ยน `OPENCLAW_HOME_VOLUME` ให้รัน `docker-setup.sh` ใหม่เพื่อสร้างไฟล์ compose เพิ่มเติม
- named volume จะคงอยู่จนกว่าจะลบด้วย `docker volume rm <name>`

### ติดตั้งแพ็กเกจ apt เพิ่มเติม (ไม่บังคับ)

หากคุณต้องการแพ็กเกจระบบภายในอิมเมจ (เช่น เครื่องมือ build หรือไลบรารีสื่อ)
ให้ตั้งค่า `OPENCLAW_DOCKER_APT_PACKAGES` ก่อนรัน `docker-setup.sh`
แพ็กเกจจะถูกติดตั้งระหว่างการ build อิมเมจ จึงคงอยู่แม้คอนเทนเนอร์ถูกลบ
This installs the packages during the image build, so they persist even if the
container is deleted.

ตัวอย่าง:

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential"
./docker-setup.sh
```

หมายเหตุ:

- รองรับรายชื่อแพ็กเกจ apt คั่นด้วยช่องว่าง
- หากคุณเปลี่ยน `OPENCLAW_DOCKER_APT_PACKAGES` ให้รัน `docker-setup.sh` ใหม่เพื่อ build อิมเมจอีกครั้ง

### คอนเทนเนอร์แบบ power-user / ฟีเจอร์ครบ (เลือกใช้)

อิมเมจ Docker ค่าเริ่มต้นเน้น **ความปลอดภัยเป็นหลัก** และรันด้วยผู้ใช้ที่ไม่ใช่ root คือ
`node` ซึ่งช่วยลดพื้นที่โจมตี แต่หมายความว่า: This keeps the attack surface small, but it means:

- ไม่สามารถติดตั้งแพ็กเกจระบบขณะรันได้
- ไม่มี Homebrew โดยค่าเริ่มต้น
- ไม่มี Chromium/Playwright แบบรวมมาให้

หากคุณต้องการคอนเทนเนอร์ที่มีฟีเจอร์ครบมากขึ้น ให้ใช้ตัวเลือกต่อไปนี้:

1. **ทำให้ `/home/node` คงอยู่** เพื่อให้การดาวน์โหลดเบราว์เซอร์และแคชเครื่องมือไม่หายไป:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

2. **ฝัง system deps ลงในอิมเมจ** (ทำซ้ำได้และคงอยู่):

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"
./docker-setup.sh
```

3. **ติดตั้ง Playwright browsers โดยไม่ใช้ `npx`** (หลีกเลี่ยงความขัดแย้งของ npm override):

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

หากคุณต้องการให้ Playwright ติดตั้ง system deps ให้ build อิมเมจใหม่ด้วย
`OPENCLAW_DOCKER_APT_PACKAGES` แทนการใช้ `--with-deps` ระหว่างรัน

4. **ทำให้การดาวน์โหลด Playwright browser คงอยู่**:

- ตั้งค่า `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright` ใน
  `docker-compose.yml`
- ตรวจสอบให้แน่ใจว่า `/home/node` คงอยู่ผ่าน `OPENCLAW_HOME_VOLUME` หรือเมานต์
  `/home/node/.cache/ms-playwright` ผ่าน `OPENCLAW_EXTRA_MOUNTS`

### สิทธิ์ + EACCES

The image runs as `node` (uid 1000). อิมเมจรันด้วย `node` (uid 1000) หากคุณพบข้อผิดพลาดด้านสิทธิ์บน
`/home/node/.openclaw` ให้ตรวจสอบว่า bind mount บนโฮสต์เป็นเจ้าของโดย uid 1000

ตัวอย่าง (โฮสต์ Linux):

```bash
sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
```

หากคุณเลือกจะรันเป็น root เพื่อความสะดวก คุณยอมรับความเสี่ยงด้านความปลอดภัยนั้น

### Build เร็วขึ้น (แนะนำ)

เพื่อให้ rebuild เร็วขึ้น ให้จัดลำดับ Dockerfile เพื่อให้เลเยอร์ของ dependency ถูกแคช
จะช่วยหลีกเลี่ยงการรัน `pnpm install` ใหม่ เว้นแต่ lockfile จะเปลี่ยน:
This avoids re-running `pnpm install` unless lockfiles change:

```dockerfile
FROM node:22-bookworm

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

# Cache dependencies unless package metadata changes
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

CMD ["node","dist/index.js"]
```

### การตั้งค่าช่องทาง (ไม่บังคับ)

ใช้ CLI container เพื่อคอนฟิกช่องทาง จากนั้นรีสตาร์ต Gateway หากจำเป็น

WhatsApp (QR):

```bash
docker compose run --rm openclaw-cli channels login
```

Telegram (bot token):

```bash
docker compose run --rm openclaw-cli channels add --channel telegram --token "<token>"
```

Discord (bot token):

```bash
docker compose run --rm openclaw-cli channels add --channel discord --token "<token>"
```

เอกสาร: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord)

### OpenAI Codex OAuth (Docker แบบ headless)

หากคุณเลือก OpenAI Codex OAuth ในวิซาร์ด ระบบจะเปิด URL ในเบราว์เซอร์และพยายามรับ
callback ที่ `http://127.0.0.1:1455/auth/callback` ใน Docker หรือการตั้งค่าแบบ headless
callback นี้อาจแสดงข้อผิดพลาดในเบราว์เซอร์ ให้คัดลอก URL redirect แบบเต็มที่คุณไปถึง
แล้ววางกลับเข้าไปในวิซาร์ดเพื่อจบการยืนยันตัวตน In Docker or
headless setups that callback can show a browser error. Copy the full redirect
URL you land on and paste it back into the wizard to finish auth.

### Health check

```bash
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

### การทดสอบ E2E smoke test (Docker)

```bash
scripts/e2e/onboard-docker.sh
```

### การทดสอบ QR import smoke test (Docker)

```bash
pnpm test:docker:qr
```

### หมายเหตุ

- Gateway bind ค่าเริ่มต้นเป็น `lan` สำหรับการใช้งานในคอนเทนเนอร์
- Dockerfile CMD ใช้ `--allow-unconfigured`; คอนฟิกที่เมานต์ด้วย `gateway.mode` ไม่ใช่ `local` จะยังเริ่มทำงานได้ ให้ override CMD หากต้องการบังคับใช้ guard Override CMD to enforce the guard.
- คอนเทนเนอร์ Gateway เป็นแหล่งอ้างอิงหลักของเซสชัน (`~/.openclaw/agents/<agentId>/sessions/`)

## Agent Sandbox (Gateway บนโฮสต์ + เครื่องมือ Docker)

เจาะลึก: [Sandboxing](/gateway/sandboxing)

### ทำอะไรได้บ้าง

เมื่อเปิดใช้งาน `agents.defaults.sandbox` เซสชันที่**ไม่ใช่เซสชันหลัก**จะรันเครื่องมือภายใน
คอนเทนเนอร์ Docker Gateway ยังคงอยู่บนโฮสต์ แต่การรันเครื่องมือจะถูกแยกออก: The gateway stays on your host, but the tool execution is isolated:

- ขอบเขต: `"agent"` โดยค่าเริ่มต้น (หนึ่งคอนเทนเนอร์ + เวิร์กสเปซต่อเอเจนต์)
- ขอบเขต: `"session"` สำหรับการแยกต่อเซสชัน
- โฟลเดอร์เวิร์กสเปซต่อขอบเขตเมานต์ที่ `/workspace`
- การเข้าถึงเวิร์กสเปซเอเจนต์แบบไม่บังคับ (`agents.defaults.sandbox.workspaceAccess`)
- นโยบายอนุญาต/ปฏิเสธเครื่องมือ (ปฏิเสธมีผลเหนือกว่า)
- สื่อขาเข้าจะถูกคัดลอกไปยังเวิร์กสเปซ sandbox ที่ใช้งานอยู่ (`media/inbound/*`) เพื่อให้เครื่องมืออ่านได้ (เมื่อใช้ `workspaceAccess: "rw"` จะไปอยู่ในเวิร์กสเปซเอเจนต์)

คำเตือน: `scope: "shared"` จะปิดการแยกระหว่างเซสชัน ทุกเซสชันใช้คอนเทนเนอร์และเวิร์กสเปซเดียวกัน All sessions share
one container and one workspace.

### โปรไฟล์ sandbox ต่อเอเจนต์ (หลายเอเจนต์)

หากคุณใช้การกำหนดเส้นทางหลายเอเจนต์ เอเจนต์แต่ละตัวสามารถ override การตั้งค่า
sandbox และเครื่องมือได้: `agents.list[].sandbox` และ `agents.list[].tools` (รวมถึง `agents.list[].tools.sandbox.tools`)
ช่วยให้คุณรันระดับการเข้าถึงที่หลากหลายใน Gateway เดียว: This lets you run
mixed access levels in one gateway:

- การเข้าถึงเต็มรูปแบบ (เอเจนต์ส่วนตัว)
- เครื่องมืออ่านอย่างเดียว + เวิร์กสเปซอ่านอย่างเดียว (เอเจนต์ครอบครัว/ที่ทำงาน)
- ไม่มีเครื่องมือไฟล์ระบบ/เชลล์ (เอเจนต์สาธารณะ)

ดูตัวอย่าง ลำดับความสำคัญ และการแก้ไขปัญหาที่
[Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)

### พฤติกรรมเริ่มต้น

- อิมเมจ: `openclaw-sandbox:bookworm-slim`
- หนึ่งคอนเทนเนอร์ต่อเอเจนต์
- การเข้าถึงเวิร์กสเปซเอเจนต์: `workspaceAccess: "none"` (ค่าเริ่มต้น) ใช้ `~/.openclaw/sandboxes`
  - `"ro"` จะเก็บเวิร์กสเปซ sandbox ไว้ที่ `/workspace` และเมานต์เวิร์กสเปซเอเจนต์แบบอ่านอย่างเดียวที่ `/agent` (ปิดใช้งาน `write`/`edit`/`apply_patch`)
  - `"rw"` เมานต์เวิร์กสเปซเอเจนต์แบบอ่าน/เขียนที่ `/workspace`
- ลบอัตโนมัติ: idle > 24 ชม. หรืออายุ > 7 วัน
- เครือข่าย: `none` โดยค่าเริ่มต้น (ต้อง opt-in ชัดเจนหากต้องการ egress)
- อนุญาตเริ่มต้น: `exec`, `process`, `read`, `write`, `edit`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- ปฏิเสธเริ่มต้น: `browser`, `canvas`, `nodes`, `cron`, `discord`, `gateway`

### เปิดใช้งาน sandboxing

หากคุณวางแผนจะติดตั้งแพ็กเกจใน `setupCommand` โปรดทราบว่า:

- ค่าเริ่มต้นของ `docker.network` คือ `"none"` (ไม่มี egress)
- `readOnlyRoot: true` จะบล็อกการติดตั้งแพ็กเกจ
- `user` must be root for `apt-get` (omit `user` or set `user: "0:0"`).
  `user` ต้องเป็น root สำหรับ `apt-get` (ละ `user` หรือกำหนด `user: "0:0"`)
  OpenClaw จะสร้างคอนเทนเนอร์ใหม่อัตโนมัติเมื่อ `setupCommand` (หรือคอนฟิก docker) เปลี่ยน
  เว้นแต่คอนเทนเนอร์จะถูกใช้งานเมื่อเร็ว ๆ นี้ (ภายใน ~5 นาที) คอนเทนเนอร์ที่ยังร้อนอยู่
  จะบันทึกคำเตือนพร้อมคำสั่ง `openclaw sandbox recreate ...` ที่แน่นอน Hot containers
  log a warning with the exact `openclaw sandbox recreate ...` command.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared (agent is default)
        workspaceAccess: "none", // none | ro | rw
        workspaceRoot: "~/.openclaw/sandboxes",
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp", "/var/tmp", "/run"],
          network: "none",
          user: "1000:1000",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
          setupCommand: "apt-get update && apt-get install -y git curl jq",
          pidsLimit: 256,
          memory: "1g",
          memorySwap: "2g",
          cpus: 1,
          ulimits: {
            nofile: { soft: 1024, hard: 2048 },
            nproc: 256,
          },
          seccompProfile: "/path/to/seccomp.json",
          apparmorProfile: "openclaw-sandbox",
          dns: ["1.1.1.1", "8.8.8.8"],
          extraHosts: ["internal.service:10.0.0.5"],
        },
        prune: {
          idleHours: 24, // 0 disables idle pruning
          maxAgeDays: 7, // 0 disables max-age pruning
        },
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        allow: [
          "exec",
          "process",
          "read",
          "write",
          "edit",
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "sessions_spawn",
          "session_status",
        ],
        deny: ["browser", "canvas", "nodes", "cron", "discord", "gateway"],
      },
    },
  },
}
```

ตัวเลือกการเสริมความแข็งแกร่งอยู่ภายใต้ `agents.defaults.sandbox.docker`:
`network`, `user`, `pidsLimit`, `memory`, `memorySwap`, `cpus`, `ulimits`,
`seccompProfile`, `apparmorProfile`, `dns`, `extraHosts`

หลายเอเจนต์: override `agents.defaults.sandbox.{docker,browser,prune}.*` ต่อเอเจนต์ผ่าน `agents.list[].sandbox.{docker,browser,prune}.*`
(จะถูกละเลยเมื่อ `agents.defaults.sandbox.scope` / `agents.list[].sandbox.scope` เป็น `"shared"`)

### สร้างอิมเมจ sandbox ค่าเริ่มต้น

```bash
scripts/sandbox-setup.sh
```

คำสั่งนี้จะสร้าง `openclaw-sandbox:bookworm-slim` โดยใช้ `Dockerfile.sandbox`

### อิมเมจ sandbox แบบ common (ไม่บังคับ)

หากคุณต้องการอิมเมจ sandbox ที่มีเครื่องมือ build ทั่วไป (Node, Go, Rust ฯลฯ)
ให้ build อิมเมจ common:

```bash
scripts/sandbox-common-setup.sh
```

จะสร้าง `openclaw-sandbox-common:bookworm-slim` วิธีใช้งาน: To use it:

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "openclaw-sandbox-common:bookworm-slim" } },
    },
  },
}
```

### อิมเมจ sandbox สำหรับเบราว์เซอร์

เพื่อรันเครื่องมือเบราว์เซอร์ภายใน sandbox ให้ build อิมเมจเบราว์เซอร์:

```bash
scripts/sandbox-browser-setup.sh
```

This builds `openclaw-sandbox-browser:bookworm-slim` using
`Dockerfile.sandbox-browser`. จะสร้าง `openclaw-sandbox-browser:bookworm-slim` โดยใช้
`Dockerfile.sandbox-browser` คอนเทนเนอร์จะรัน Chromium พร้อมเปิด CDP และ
มีตัวสังเกต noVNC แบบไม่บังคับ (headful ผ่าน Xvfb)

หมายเหตุ:

- โหมด headful (Xvfb) ลดการบล็อกบอตเมื่อเทียบกับ headless
- ยังสามารถใช้ headless ได้โดยตั้งค่า `agents.defaults.sandbox.browser.headless=true`
- ไม่จำเป็นต้องมีเดสก์ท็อปเต็มรูปแบบ (GNOME); Xvfb ทำหน้าที่เป็นจอแสดงผล

ใช้คอนฟิก:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        browser: { enabled: true },
      },
    },
  },
}
```

อิมเมจเบราว์เซอร์แบบกำหนดเอง:

```json5
{
  agents: {
    defaults: {
      sandbox: { browser: { image: "my-openclaw-browser" } },
    },
  },
}
```

เมื่อเปิดใช้งาน เอเจนต์จะได้รับ:

- URL ควบคุมเบราว์เซอร์ใน sandbox (สำหรับเครื่องมือ `browser`)
- URL noVNC (หากเปิดใช้งานและ headless=false)

โปรดจำไว้ว่า หากคุณใช้ allowlist สำหรับเครื่องมือ ให้เพิ่ม `browser`
(และลบออกจาก deny) มิฉะนั้นเครื่องมือจะยังถูกบล็อก
กฎการ prune (`agents.defaults.sandbox.prune`) ใช้กับคอนเทนเนอร์เบราว์เซอร์ด้วย
Prune rules (`agents.defaults.sandbox.prune`) apply to browser containers too.

### อิมเมจ sandbox แบบกำหนดเอง

สร้างอิมเมจของคุณเองและชี้คอนฟิกไปยังอิมเมจนั้น:

```bash
docker build -t my-openclaw-sbx -f Dockerfile.sandbox .
```

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "my-openclaw-sbx" } },
    },
  },
}
```

### นโยบายเครื่องมือ (อนุญาต/ปฏิเสธ)

- `deny` มีผลเหนือกว่า `allow`
- หาก `allow` ว่าง: เครื่องมือทั้งหมด (ยกเว้นที่ถูกปฏิเสธ) จะใช้งานได้
- หาก `allow` ไม่ว่าง: ใช้ได้เฉพาะเครื่องมือใน `allow` (ลบที่ถูกปฏิเสธออก)

### กลยุทธ์การลบ (Pruning)

Two knobs:

- `prune.idleHours`: ลบคอนเทนเนอร์ที่ไม่ได้ใช้งาน X ชั่วโมง (0 = ปิด)
- `prune.maxAgeDays`: ลบคอนเทนเนอร์ที่มีอายุมากกว่า X วัน (0 = ปิด)

ตัวอย่าง:

- เก็บเซสชันที่ใช้งานอยู่แต่จำกัดอายุ:
  `idleHours: 24`, `maxAgeDays: 7`
- ไม่ลบเลย:
  `idleHours: 0`, `maxAgeDays: 0`

### หมายเหตุด้านความปลอดภัย

- กำแพงแข็งมีผลเฉพาะกับ **เครื่องมือ** (exec/read/write/edit/apply_patch)
- เครื่องมือที่รันบนโฮสต์เท่านั้น เช่น browser/camera/canvas จะถูกบล็อกโดยค่าเริ่มต้น
- การอนุญาต `browser` ใน sandbox จะ**ทำลายการแยกอิสระ** (เบราว์เซอร์จะรันบนโฮสต์)

## การแก้ไขปัญหา

- ไม่พบอิมเมจ: build ด้วย [`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh) หรือกำหนด `agents.defaults.sandbox.docker.image`
- คอนเทนเนอร์ไม่รัน: ระบบจะสร้างอัตโนมัติต่อเซสชันเมื่อมีการเรียกใช้
- ข้อผิดพลาดด้านสิทธิ์ใน sandbox: ตั้งค่า `docker.user` เป็น UID:GID ที่ตรงกับ
  ความเป็นเจ้าของของเวิร์กสเปซที่เมานต์ (หรือ chown โฟลเดอร์เวิร์กสเปซ)
- Custom tools not found: OpenClaw runs commands with `sh -lc` (login shell), which
  sources `/etc/profile` and may reset PATH. ไม่พบเครื่องมือกำหนดเอง: OpenClaw รันคำสั่งด้วย `sh -lc` (login shell)
  ซึ่งจะ source `/etc/profile` และอาจรีเซ็ต PATH ให้ตั้งค่า `docker.env.PATH`
  เพื่อ prepend พาธของเครื่องมือคุณ (เช่น `/custom/bin:/usr/local/share/npm-global/bin`) หรือเพิ่มสคริปต์ไว้ใต้
  `/etc/profile.d/` ใน Dockerfile ของคุณ
