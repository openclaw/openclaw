---
summary: "รันไทม์GatewayบนmacOS(บริการlaunchdภายนอก)"
read_when:
  - การแพ็กเกจ OpenClaw.app
  - การดีบักบริการlaunchdของGatewayบนmacOS
  - การติดตั้งGateway CLIสำหรับmacOS
title: "GatewayบนmacOS"
---

# GatewayบนmacOS(launchdภายนอก)

OpenClaw.app ไม่ได้บันเดิล Node/Bun หรือรันไทม์ Gateway อีกต่อไป OpenClaw.appไม่รวมNode/Bunหรือรันไทม์Gatewayอีกต่อไป แอปmacOSคาดหวังการติดตั้งCLI `openclaw` แบบ**ภายนอก** ไม่สตาร์ทGatewayเป็นโปรเซสลูก และจัดการบริการlaunchdต่อผู้ใช้เพื่อให้Gatewayทำงานต่อเนื่อง(หรือแนบกับGatewayภายในเครื่องที่กำลังทำงานอยู่แล้วหากมี)

## ติดตั้งCLI(จำเป็นสำหรับโหมดLocal)

คุณต้องมีNode 22+บนMac จากนั้นติดตั้ง `openclaw` แบบโกลบอล:

```bash
npm install -g openclaw@<version>
```

ปุ่ม **Install CLI** ในแอปmacOSจะรันโฟลว์เดียวกันผ่านnpm/pnpm(ไม่แนะนำให้ใช้bunสำหรับรันไทม์Gateway)

## Launchd(Gatewayเป็นLaunchAgent)

Label:

- `bot.molt.gateway` (หรือ `bot.molt.<profile>`; อาจยังคงมีค่าเดิม `com.openclaw.*`)

ตำแหน่งPlist(ต่อผู้ใช้):

- `~/Library/LaunchAgents/bot.molt.gateway.plist`
  (หรือ `~/Library/LaunchAgents/bot.molt.<profile>.plist`)

ตัวจัดการ:

- แอปmacOSเป็นผู้ดูแลการติดตั้ง/อัปเดตLaunchAgentในโหมดLocal
- CLIก็สามารถติดตั้งได้: `openclaw gateway install`.

พฤติกรรม:

- “OpenClaw Active” เปิด/ปิดLaunchAgent
- การปิดแอป **ไม่** หยุดGateway(launchdจะคงให้ทำงานต่อ)
- หากมีGatewayที่กำลังทำงานบนพอร์ตที่กำหนดค่าไว้แล้ว แอปจะเชื่อมต่อกับตัวนั้นแทนการเริ่มตัวใหม่

การบันทึกล็อก:

- stdout/errของlaunchd: `/tmp/openclaw/openclaw-gateway.log`

## ความเข้ากันได้ของเวอร์ชัน

แอป macOS จะตรวจสอบเวอร์ชันของ gateway เทียบกับเวอร์ชันของตัวเอง แอปmacOSจะตรวจสอบเวอร์ชันของGatewayเทียบกับเวอร์ชันของแอป หากไม่เข้ากัน ให้ อัปเดตCLIแบบโกลบอลให้ตรงกับเวอร์ชันของแอป

## การตรวจสอบเบื้องต้น

```bash
openclaw --version

OPENCLAW_SKIP_CHANNELS=1 \
OPENCLAW_SKIP_CANVAS_HOST=1 \
openclaw gateway --port 18999 --bind loopback
```

จากนั้น:

```bash
openclaw gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
