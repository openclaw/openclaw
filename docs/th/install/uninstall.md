---
summary: "ถอนการติดตั้ง OpenClaw ออกทั้งหมด (CLI, บริการ, สถานะ, เวิร์กสเปซ)"
read_when:
  - คุณต้องการลบ OpenClaw ออกจากเครื่อง
  - บริการGatewayยังคงทำงานอยู่หลังจากถอนการติดตั้ง
title: "ถอนการติดตั้ง"
---

# ถอนการติดตั้ง

มีสองวิธี:

- **วิธีง่าย** หาก `openclaw` ยังติดตั้งอยู่
- **ลบบริการด้วยตนเอง** หากไม่มี CLI แล้วแต่บริการยังคงทำงานอยู่

## วิธีง่าย (ยังติดตั้ง CLI อยู่)

แนะนำ: ใช้ตัวถอนการติดตั้งที่มีมาให้:

```bash
openclaw uninstall
```

แบบไม่โต้ตอบ (อัตโนมัติ / npx):

```bash
openclaw uninstall --all --yes --non-interactive
npx -y openclaw uninstall --all --yes --non-interactive
```

ขั้นตอนด้วยตนเอง (ผลลัพธ์เหมือนกัน):

1. หยุดบริการGateway:

```bash
openclaw gateway stop
```

2. ถอนการติดตั้งบริการGateway (launchd/systemd/schtasks):

```bash
openclaw gateway uninstall
```

3. ลบสถานะ + คอนฟิก:

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
```

หากคุณตั้งค่า `OPENCLAW_CONFIG_PATH` ไปยังตำแหน่งกำหนดเองนอกไดเรกทอรีสถานะ ให้ลบไฟล์นั้นด้วย

4. ลบเวิร์กสเปซของคุณ (ไม่บังคับ จะลบไฟล์เอเจนต์):

```bash
rm -rf ~/.openclaw/workspace
```

5. ลบการติดตั้ง CLI (เลือกวิธีที่คุณใช้):

```bash
npm rm -g openclaw
pnpm remove -g openclaw
bun remove -g openclaw
```

6. หากคุณติดตั้งแอปmacOS:

```bash
rm -rf /Applications/OpenClaw.app
```

หมายเหตุ:

- หากคุณใช้โปรไฟล์ (`--profile` / `OPENCLAW_PROFILE`) ให้ทำขั้นตอนที่ 3 ซ้ำสำหรับแต่ละไดเรกทอรีสถานะ (ค่าเริ่มต้นคือ `~/.openclaw-<profile>`)
- ในโหมดรีโมต ไดเรกทอรีสถานะจะอยู่บน **โฮสต์Gateway** ดังนั้นให้ทำขั้นตอนที่ 1-4 ที่นั่นด้วย

## ลบบริการด้วยตนเอง (ไม่ได้ติดตั้ง CLI)

ใช้วิธีนี้หากบริการGatewayยังคงทำงานอยู่แต่ไม่มี `openclaw`

### macOS (launchd)

ป้ายกำกับเริ่มต้นคือ `bot.molt.gateway` (หรือ `bot.molt.<profile>`; อาจยังมีของเดิม `com.openclaw.*` อยู่):

```bash
launchctl bootout gui/$UID/bot.molt.gateway
rm -f ~/Library/LaunchAgents/bot.molt.gateway.plist
```

หากคุณใช้โปรไฟล์ ให้แทนที่ป้ายกำกับและชื่อ plist ด้วย `bot.molt.<profile>`. `ลบ plist แบบเดิม`com.openclaw.\*\` หากมีอยู่

### Linux (systemd user unit)

ชื่อยูนิตเริ่มต้นคือ `openclaw-gateway.service` (หรือ `openclaw-gateway-<profile>.service`):

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows (Scheduled Task)

ชื่องานเริ่มต้นคือ `OpenClaw Gateway` (หรือ `OpenClaw Gateway (<profile>)`)
สคริปต์งานจะอยู่ภายใต้ไดเรกทอรีสถานะของคุณ
สคริปต์งานจะอยู่ภายใต้ไดเรกทอรี state ของคุณ

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd"
```

หากคุณใช้โปรไฟล์ ให้ลบชื่องานที่ตรงกันและ `~\.openclaw-<profile>\gateway.cmd`

## การติดตั้งปกติเทียบกับซอร์สโค้ดที่เช็กเอาต์

### การติดตั้งปกติ (install.sh / npm / pnpm / bun)

หากคุณใช้ `https://openclaw.ai/install.sh` หรือ `install.ps1` CLI จะถูกติดตั้งด้วย `npm install -g openclaw@latest`
ให้ลบออกด้วย `npm rm -g openclaw` (หรือ `pnpm remove -g` / `bun remove -g` หากคุณติดตั้งด้วยวิธีนั้น)
ลบออกด้วย `npm rm -g openclaw` (หรือ `pnpm remove -g` / `bun remove -g` หากคุณติดตั้งด้วยวิธีนั้น)

### ซอร์สโค้ดที่เช็กเอาต์ (git clone)

หากคุณรันจากรีโปที่เช็กเอาต์ (`git clone` + `openclaw ...` / `bun run openclaw ...`):

1. ถอนการติดตั้งบริการGateway **ก่อน** ลบรีโป (ใช้วิธีง่ายด้านบนหรือการลบบริการด้วยตนเอง)
2. ลบไดเรกทอรีรีโป
3. ลบสถานะ + เวิร์กสเปซตามที่แสดงด้านบน
