---
summary: "การอัปเดต OpenClaw อย่างปลอดภัย(ติดตั้งแบบ global หรือจากซอร์ส)พร้อมกลยุทธ์การย้อนกลับ"
read_when:
  - การอัปเดต OpenClaw
  - มีบางอย่างพังหลังการอัปเดต
title: "การอัปเดต"
---

# การอัปเดต

OpenClaw พัฒนาอย่างรวดเร็ว (ก่อน “1.0”) OpenClaw พัฒนาอย่างรวดเร็ว(ก่อนเวอร์ชัน“1.0”)ให้ปฏิบัติกับการอัปเดตเหมือนการส่งโครงสร้างพื้นฐาน: อัปเดต→รันการตรวจสอบ→รีสตาร์ต(หรือใช้ `openclaw update` ซึ่งจะรีสตาร์ตให้)→ยืนยันผลลัพธ์

## แนะนำ: รันตัวติดตั้งจากเว็บไซต์อีกครั้ง(อัปเกรดทับของเดิม)

เส้นทางการอัปเดตที่ **แนะนำ** คือการรันตัวติดตั้งจากเว็บไซต์อีกครั้ง ตัวติดตั้งจะตรวจพบการติดตั้งที่มีอยู่ อัปเกรดทับของเดิม และรัน `openclaw doctor` เมื่อจำเป็น มัน
ตรวจจับการติดตั้งที่มีอยู่ อัปเกรดในที่เดิม และรัน `openclaw doctor` เมื่อจำเป็น

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

หมายเหตุ:

- เพิ่ม `--no-onboard` หากไม่ต้องการให้ตัวช่วยเริ่มต้น(onboarding wizard)รันอีกครั้ง

- สำหรับ **การติดตั้งจากซอร์ส**, ใช้:

  ```bash
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
  ```

  ตัวติดตั้งจะ `git pull --rebase` **เฉพาะ** เมื่อ repo สะอาด

- สำหรับ **การติดตั้งแบบ global**, สคริปต์จะใช้ `npm install -g openclaw@latest` เบื้องหลัง

- หมายเหตุระบบเดิม: `clawdbot` ยังมีให้ใช้เป็นชิมเพื่อความเข้ากันได้

## ก่อนอัปเดต

- รู้วิธีที่คุณติดตั้ง: **global** (npm/pnpm)หรือ **จากซอร์ส** (git clone)
- รู้ว่า Gateway ของคุณรันอย่างไร: **เทอร์มินัลโหมดหน้าโฟร์กราวด์** หรือ **บริการที่มีตัวควบคุม** (launchd/systemd)
- ทำสแนปช็อตการปรับแต่งของคุณ:
  - คอนฟิก: `~/.openclaw/openclaw.json`
  - ข้อมูลรับรอง: `~/.openclaw/credentials/`
  - เวิร์กสเปซ: `~/.openclaw/workspace`

## อัปเดต(ติดตั้งแบบ global)

การติดตั้งแบบ global(เลือกอย่างใดอย่างหนึ่ง):

```bash
npm i -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

เรา **ไม่แนะนำ** Bun สำหรับรันไทม์ของ Gateway(มีบั๊กกับ WhatsApp/Telegram)

การสลับช่องทางการอัปเดต(สำหรับการติดตั้งแบบ git + npm):

```bash
openclaw update --channel beta
openclaw update --channel dev
openclaw update --channel stable
```

ใช้ `--tag <dist-tag|version>` สำหรับการติดตั้งแท็ก/เวอร์ชันแบบครั้งเดียว

ดู [Development channels](/install/development-channels) สำหรับความหมายของช่องทางและบันทึกการปล่อยเวอร์ชัน

หมายเหตุ: สำหรับการติดตั้งผ่าน npm เกตเวย์จะบันทึกคำแนะนำการอัปเดตตอนเริ่มต้น(ตรวจแท็กของช่องทางปัจจุบัน)ปิดได้ด้วย `update.checkOnStart: false`. ปิดการใช้งานด้วย `update.checkOnStart: false`

จากนั้น:

```bash
openclaw doctor
openclaw gateway restart
openclaw health
```

หมายเหตุ:

- หาก Gateway ของคุณรันเป็นบริการ แนะนำใช้ `openclaw gateway restart` แทนการฆ่า PID
- หากคุณปักหมุดไว้ที่เวอร์ชันใดเวอร์ชันหนึ่ง ดู “Rollback / pinning” ด้านล่าง

## อัปเดต(`openclaw update`)

สำหรับ **การติดตั้งจากซอร์ส** (git checkout)แนะนำให้ใช้:

```bash
openclaw update
```

คำสั่งนี้จะรันโฟลว์อัปเดตที่ค่อนข้างปลอดภัย:

- ต้องมี worktree ที่สะอาด
- สลับไปยังช่องทางที่เลือก(แท็กหรือสาขา)
- ดึงข้อมูลและ rebase กับ upstream ที่กำหนด(ช่องทาง dev)
- ติดตั้ง dependencies, build, build Control UI และรัน `openclaw doctor`
- รีสตาร์ตเกตเวย์เป็นค่าเริ่มต้น(ใช้ `--no-restart` เพื่อข้าม)

หากคุณติดตั้งผ่าน **npm/pnpm** (ไม่มีเมตาดาทา git) `openclaw update` จะพยายามอัปเดตผ่านตัวจัดการแพ็กเกจของคุณ หากตรวจไม่พบการติดตั้ง ให้ใช้ “อัปเดต(ติดตั้งแบบ global)” แทน หากตรวจจับการติดตั้งไม่ได้ ให้ใช้ “Update (global install)” แทน

## อัปเดต(Control UI / RPC)

Control UI มีปุ่ม **Update & Restart** (RPC: `update.run`) ซึ่งจะ: มัน:

1. รันโฟลว์อัปเดตจากซอร์สแบบเดียวกับ `openclaw update`(เฉพาะ git checkout)
2. เขียนตัวบ่งชี้การรีสตาร์ตพร้อมรายงานแบบมีโครงสร้าง(stdout/stderr tail)
3. รีสตาร์ตเกตเวย์และ ping เซสชันที่ใช้งานล่าสุดพร้อมรายงาน

หาก rebase ล้มเหลว เกตเวย์จะยกเลิกและรีสตาร์ตโดยไม่ใช้การอัปเดต

## อัปเดต(จากซอร์ส)

จาก repo checkout:

แนะนำ:

```bash
openclaw update
```

ทำเอง (เทียบเท่าโดยประมาณ):

```bash
git pull
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps on first run
openclaw doctor
openclaw health
```

หมายเหตุ:

- `pnpm build` มีความสำคัญเมื่อคุณรันไบนารีแบบแพ็กเกจ `openclaw` ([`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs)) หรือใช้ Node เพื่อรัน `dist/`
- หากคุณรันจาก repo checkout โดยไม่มีการติดตั้งแบบ global ให้ใช้ `pnpm openclaw ...` สำหรับคำสั่ง CLI
- หากคุณรันโดยตรงจาก TypeScript (`pnpm openclaw ...`) โดยปกติไม่จำเป็นต้อง rebuild แต่ **การย้ายคอนฟิกยังคงมีผล** → ให้รัน doctor
- การสลับระหว่างการติดตั้งแบบ global และแบบ git ทำได้ง่าย: ติดตั้งอีกแบบหนึ่ง จากนั้นรัน `openclaw doctor` เพื่อให้ entrypoint ของบริการเกตเวย์ถูกเขียนใหม่ไปยังการติดตั้งปัจจุบัน

## ต้องรันเสมอ: `openclaw doctor`

Doctor คือคำสั่ง “อัปเดตอย่างปลอดภัย” มันตั้งใจให้เรียบง่าย: ซ่อมแซม + ย้าย + เตือน มันตั้งใจให้เรียบง่าย: ซ่อมแซม + ย้ายข้อมูล + เตือน

หมายเหตุ: หากคุณอยู่บน **การติดตั้งจากซอร์ส** (git checkout) `openclaw doctor` จะเสนอให้รัน `openclaw update` ก่อน

สิ่งที่มักทำ:

- ย้ายคีย์คอนฟิกที่เลิกใช้แล้ว/ตำแหน่งไฟล์คอนฟิกแบบเดิม
- ตรวจสอบนโยบาย DM และเตือนการตั้งค่า “เปิด” ที่เสี่ยง
- ตรวจสุขภาพ Gateway และสามารถเสนอให้รีสตาร์ต
- ตรวจจับและย้ายบริการเกตเวย์รุ่นเก่า(launchd/systemd; schtasks แบบเดิม)ไปยังบริการ OpenClaw ปัจจุบัน
- บน Linux ตรวจให้แน่ใจว่ามี systemd user lingering(เพื่อให้ Gateway อยู่รอดหลังล็อกเอาต์)

รายละเอียด: [Doctor](/gateway/doctor)

## เริ่ม/หยุด/รีสตาร์ต Gateway

CLI(ใช้ได้ทุกระบบปฏิบัติการ):

```bash
openclaw gateway status
openclaw gateway stop
openclaw gateway restart
openclaw gateway --port 18789
openclaw logs --follow
```

หากคุณใช้ตัวควบคุม:

- macOS launchd(LaunchAgent ที่มาพร้อมแอป): `launchctl kickstart -k gui/$UID/bot.molt.gateway`(ใช้ `bot.molt.<profile>`; แบบเดิม `com.openclaw.*` ยังใช้ได้)
- Linux systemd user service: `systemctl --user restart openclaw-gateway[-<profile>].service`
- Windows(WSL2): `systemctl --user restart openclaw-gateway[-<profile>].service`
  - `launchctl`/`systemctl` ใช้ได้เฉพาะเมื่อมีการติดตั้งบริการแล้ว มิฉะนั้นให้รัน `openclaw gateway install`.

คู่มือปฏิบัติการ+ป้ายชื่อบริการที่แน่นอน: [Gateway runbook](/gateway)

## Rollback / pinning(เมื่อมีบางอย่างพัง)

### ปักหมุด(ติดตั้งแบบ global)

ติดตั้งเวอร์ชันที่ทราบว่าดี(แทนที่ `<version>` ด้วยเวอร์ชันที่ใช้งานได้ล่าสุด):

```bash
npm i -g openclaw@<version>
```

```bash
pnpm add -g openclaw@<version>
```

เคล็ดลับ: ดูเวอร์ชันที่เผยแพร่ปัจจุบันได้โดยรัน `npm view openclaw version`.

จากนั้นรีสตาร์ต+รัน doctor อีกครั้ง:

```bash
openclaw doctor
openclaw gateway restart
```

### ปักหมุด(จากซอร์ส)ตามวันที่

เลือกคอมมิตจากวันที่(ตัวอย่าง:“สถานะของ main ณ วันที่ 2026-01-01”):

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
```

จากนั้นติดตั้ง dependencies ใหม่+รีสตาร์ต:

```bash
pnpm install
pnpm build
openclaw gateway restart
```

หากต้องการกลับไปล่าสุดในภายหลัง:

```bash
git checkout main
git pull
```

## หากคุณติดขัด

- รัน `openclaw doctor` อีกครั้งและอ่านเอาต์พุตอย่างละเอียด(มักบอกวิธีแก้)
- ตรวจดู: [การแก้ไขปัญหา](/gateway/troubleshooting)
- ถามใน Discord: [https://discord.gg/clawd](https://discord.gg/clawd)
