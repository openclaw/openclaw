---
title: "เวิร์กโฟลว์การพัฒนา Pi"
---

# เวิร์กโฟลว์การพัฒนา Pi

คู่มือนี้สรุปเวิร์กโฟลว์ที่เหมาะสมสำหรับการทำงานกับการผสานรวม Pi ใน OpenClaw

## การตรวจสอบชนิดและการลินต์

- ตรวจสอบชนิดและบิลด์: `pnpm build`
- ลินต์: `pnpm lint`
- ตรวจสอบรูปแบบ: `pnpm format`
- เกตเต็มรูปแบบก่อนพุช: `pnpm lint && pnpm build && pnpm test`

## การรันทดสอบ Pi

ใช้สคริปต์เฉพาะสำหรับชุดทดสอบการผสานรวม Pi:

```bash
scripts/pi/run-tests.sh
```

เพื่อรวมการทดสอบแบบไลฟ์ที่ทดสอบพฤติกรรมจริงของผู้ให้บริการ:

```bash
scripts/pi/run-tests.sh --live
```

สคริปต์จะรันทดสอบยูนิตที่เกี่ยวข้องกับ Pi ทั้งหมดผ่านกลอบเหล่านี้:

- `src/agents/pi-*.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-extensions/*.test.ts`

## การทดสอบด้วยตนเอง

โฟลว์ที่แนะนำ:

- รัน Gateway（เกตเวย์）ในโหมดdev:
  - `pnpm gateway:dev`
- เรียกเอเจนต์โดยตรง:
  - `pnpm openclaw agent --message "Hello" --thinking low`
- ใช้ TUI สำหรับการดีบักแบบโต้ตอบ:
  - `pnpm tui`

สำหรับพฤติกรรมการเรียกเครื่องมือ ให้พรอมป์สำหรับการกระทำ `read` หรือ `exec` เพื่อให้คุณเห็นการสตรีมของเครื่องมือและการจัดการเพย์โหลด

## 46. รีเซ็ตล้างสถานะทั้งหมด

47. สถานะถูกเก็บไว้ภายใต้ไดเรกทอรีสถานะของ OpenClaw 48. ค่าเริ่มต้นคือ `~/.openclaw` สถานะจะอยู่ภายใต้ไดเรกทอรีสถานะของ OpenClaw ค่าเริ่มต้นคือ `~/.openclaw` หากตั้งค่า `OPENCLAW_STATE_DIR` ให้ใช้ไดเรกทอรีนั้นแทน

เพื่อรีเซ็ตทุกอย่าง:

- `openclaw.json` สำหรับคอนฟิก
- `credentials/` สำหรับโปรไฟล์การยืนยันตัวตนและโทเคน
- `agents/<agentId>/sessions/` สำหรับประวัติเซสชันของเอเจนต์
- `agents/<agentId>/sessions.json` สำหรับดัชนีเซสชัน
- `sessions/` หากมีพาธแบบเลกาซีอยู่
- `workspace/` หากคุณต้องการเวิร์กสเปซว่างเปล่า

หากคุณต้องการรีเซ็ตเฉพาะเซสชัน ให้ลบ `agents/<agentId>/sessions/` และ `agents/<agentId>/sessions.json` สำหรับเอเจนต์นั้น เก็บ `credentials/` ไว้หากคุณไม่ต้องการยืนยันตัวตนใหม่ 49. เก็บ `credentials/` ไว้หากคุณไม่ต้องการยืนยันตัวตนใหม่

## อ้างอิง

- [https://docs.openclaw.ai/testing](https://docs.openclaw.ai/testing)
- [https://docs.openclaw.ai/start/getting-started](https://docs.openclaw.ai/start/getting-started)
