---
summary: "การตั้งค่าขั้นสูงและเวิร์กโฟลว์การพัฒนาสำหรับ OpenClaw"
read_when:
  - การตั้งค่าเครื่องใหม่
  - คุณต้องการ “ล่าสุดและดีที่สุด” โดยไม่กระทบการตั้งค่าส่วนตัว
title: "การตั้งค่า"
---

# การตั้งค่า

<Note>
หากคุณกำลังตั้งค่าเป็นครั้งแรก ให้เริ่มที่ [Getting Started](/start/getting-started)

หากเป็นการตั้งค่าครั้งแรก ให้เริ่มจาก [เริ่มต้นใช้งาน](/start/getting-started)
สำหรับรายละเอียดของวิซาร์ด ดูที่ [Onboarding Wizard](/start/wizard)

</Note>

อัปเดตล่าสุด: 2026-01-01

## TL;DR

- **การปรับแต่งอยู่นอกรีโป:** `~/.openclaw/workspace` (workspace) + `~/.openclaw/openclaw.json` (คอนฟิก)
- **เวิร์กโฟลว์เสถียร:** ติดตั้งแอปmacOS; ให้แอปรัน Gateway ที่มาพร้อมแพ็กเกจ
- **เวิร์กโฟลว์สายล้ำ:** รัน Gateway เองผ่าน `pnpm gateway:watch` จากนั้นให้แอปmacOS เชื่อมต่อในโหมด Local

## ข้อกำหนดก่อนเริ่มต้น (จากซอร์ส)

- Node `>=22`
- `pnpm`
- Docker (ไม่บังคับ; ใช้เฉพาะการตั้งค่าแบบคอนเทนเนอร์/e2e — ดู [Docker](/install/docker))

## กลยุทธ์การปรับแต่ง (เพื่อให้อัปเดตไม่กระทบ)

หากต้องการ “ปรับให้ตรงตัวฉัน 100%” _และ_ อัปเดตได้ง่าย ให้เก็บการปรับแต่งไว้ที่:

- **คอนฟิก:** `~/.openclaw/openclaw.json` (JSON/JSON5-ish)
- **Workspace:** `~/.openclaw/workspace` (skills, prompts, memories; แนะนำทำเป็นรีโป git ส่วนตัว)

บูตสแตรปครั้งเดียว:

```bash
openclaw setup
```

จากภายในรีโปนี้ ให้ใช้จุดเข้า CLI แบบ local:

```bash
openclaw setup
```

หากยังไม่มีการติดตั้งแบบ global ให้รันผ่าน `pnpm openclaw setup`.

## รัน Gateway จากรีโปนี้

หลังจาก `pnpm build` แล้ว คุณสามารถรัน CLI ที่แพ็กเกจมาได้โดยตรง:

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## เวิร์กโฟลว์เสถียร (เริ่มจากแอปmacOS)

1. ติดตั้งและเปิด **OpenClaw.app** (แถบเมนู)
2. ทำเช็กลิสต์ onboarding/สิทธิ์ให้ครบ (TCC prompts)
3. ตรวจสอบว่า Gateway เป็น **Local** และกำลังรันอยู่ (แอปจัดการให้)
4. เชื่อมต่อช่องทาง (ตัวอย่าง: WhatsApp):

```bash
openclaw channels login
```

5. ตรวจสอบความเรียบร้อย:

```bash
openclaw health
```

หากไม่มี onboarding ในบิลด์ของคุณ:

- รัน `openclaw setup` จากนั้น `openclaw channels login` แล้วเริ่ม Gateway ด้วยตนเอง (`openclaw gateway`).

## เวิร์กโฟลว์สายล้ำ (Gateway ในเทอร์มินัล)

เป้าหมาย: ทำงานกับ Gateway แบบ TypeScript ได้ hot reload และยังคงเชื่อม UI ของแอปmacOS

### 0. (ไม่บังคับ) รันแอปmacOS จากซอร์สด้วย

หากต้องการให้แอปmacOS อยู่สายล้ำเช่นกัน:

```bash
./scripts/restart-mac.sh
```

### 1. เริ่ม Gateway สำหรับพัฒนา

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch` จะรัน gateway ในโหมด watch และรีโหลดเมื่อมีการเปลี่ยนแปลง TypeScript

### 2. ชี้แอปmacOS ไปยัง Gateway ที่กำลังรันอยู่

ใน **OpenClaw.app**:

- Connection Mode: **Local**
  แอปจะเชื่อมต่อกับ gateway ที่กำลังรันบนพอร์ตที่ตั้งค่าไว้

### 3. ตรวจสอบ

- สถานะ Gateway ในแอปควรแสดง **“Using existing gateway …”**
- หรือผ่าน CLI:

```bash
openclaw health
```

### ข้อผิดพลาดที่พบบ่อย

- **พอร์ตผิด:** WS ของ Gateway ค่าเริ่มต้นคือ `ws://127.0.0.1:18789`; ตรวจให้แอปและ CLI ใช้พอร์ตเดียวกัน
- **ตำแหน่งที่เก็บสถานะ:**
  - Credentials: `~/.openclaw/credentials/`
  - Sessions: `~/.openclaw/agents/<agentId>/sessions/`
  - Logs: `/tmp/openclaw/`

## แผนผังการจัดเก็บข้อมูลรับรอง

ใช้เมื่อดีบักการยืนยันตัวตนหรือพิจารณาว่าควรสำรองอะไร:

- **WhatsApp**: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Telegram bot token**: คอนฟิก/ตัวแปรสภาพแวดล้อม หรือ `channels.telegram.tokenFile`
- **Discord bot token**: คอนฟิก/ตัวแปรสภาพแวดล้อม (ยังไม่รองรับไฟล์โทเคน)
- **Slack tokens**: คอนฟิก/ตัวแปรสภาพแวดล้อม (`channels.slack.*`)
- **Pairing allowlists**: `~/.openclaw/credentials/<channel>-allowFrom.json`
- **โปรไฟล์การยืนยันตัวตนของโมเดล**: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **การนำเข้า OAuth แบบเดิม**: `~/.openclaw/credentials/oauth.json`
  รายละเอียดเพิ่มเติม: [Security](/gateway/security#credential-storage-map).

## การอัปเดต (โดยไม่พังการตั้งค่า)

- เก็บ `~/.openclaw/workspace` และ `~/.openclaw/` เป็น “ของคุณ”; อย่าใส่พรอมป์ต์/คอนฟิกส่วนตัวลงในรีโป `openclaw`
- อัปเดตซอร์ส: `git pull` + `pnpm install` (เมื่อ lockfile เปลี่ยน) + ใช้ `pnpm gateway:watch` ต่อไป

## Linux (systemd user service)

การติดตั้งบน Linux ใช้บริการ systemd แบบ **user** การติดตั้งบน Linux ใช้ systemd แบบ **user** service โดยค่าเริ่มต้น systemd จะหยุด user
services เมื่อออกจากระบบ/ว่าง ซึ่งจะทำให้ Gateway หยุด Onboarding จะพยายามเปิด
lingering ให้คุณ (อาจขอ sudo) หากยังปิดอยู่ ให้รัน: ขั้นตอน onboarding จะพยายามเปิดใช้งาน
lingering ให้คุณ (อาจมีการขอ sudo) หากยังปิดอยู่ ให้รัน:

```bash
sudo loginctl enable-linger $USER
```

สำหรับเซิร์ฟเวอร์ที่ต้องเปิดตลอดหรือหลายผู้ใช้ พิจารณาใช้ **system** service แทน
user service (ไม่ต้องใช้ lingering) ดูหมายเหตุ systemd ใน [Gateway runbook](/gateway). ดู [Gateway runbook](/gateway) สำหรับหมายเหตุเกี่ยวกับ systemd

## เอกสารที่เกี่ยวข้อง

- [Gateway runbook](/gateway) (แฟล็ก การดูแล พอร์ต)
- [Gateway configuration](/gateway/configuration) (สคีมาคอนฟิก + ตัวอย่าง)
- [Discord](/channels/discord) และ [Telegram](/channels/telegram) (แท็กการตอบกลับ + การตั้งค่า replyToMode)
- [OpenClaw assistant setup](/start/openclaw)
- [macOS app](/platforms/macos) (วงจรชีวิต gateway)
