---
summary: "เอกสารอ้างอิงCLIสำหรับ `openclaw channels` (บัญชี, สถานะ, เข้าสู่ระบบ/ออกจากระบบ, บันทึก)"
read_when:
  - คุณต้องการเพิ่ม/ลบบัญชีช่องทาง (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (ปลั๊กอิน)/Signal/iMessage)
  - คุณต้องการตรวจสอบสถานะช่องทางหรือดูบันทึกช่องทางแบบต่อเนื่อง
title: "channels"
---

# `openclaw channels`

จัดการบัญชีช่องทางแชทและสถานะการทำงานขณะรันบน Gateway

เอกสารที่เกี่ยวข้อง:

- คู่มือช่องทาง: [Channels](/channels/index)
- การกำหนดค่าGateway: [Configuration](/gateway/configuration)

## คำสั่งที่ใช้บ่อย

```bash
openclaw channels list
openclaw channels status
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels logs --channel all
```

## เพิ่ม / ลบบัญชี

```bash
openclaw channels add --channel telegram --token <bot-token>
openclaw channels remove --channel telegram --delete
```

เคล็ดลับ: `openclaw channels add --help` แสดงแฟล็กต่อช่องทาง (โทเคน, app token, เส้นทาง signal-cli ฯลฯ)

## เข้าสู่ระบบ / ออกจากระบบ (โต้ตอบ)

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

## การแก้ไขปัญหา

- รัน `openclaw status --deep` เพื่อการตรวจสอบแบบครอบคลุม
- ใช้ `openclaw doctor` สำหรับการแก้ไขแบบมีคำแนะนำ
- `openclaw channels list` พิมพ์ `Claude: HTTP 403 ... user:profile` → สแนปช็อตการใช้งานต้องใช้ขอบเขต `user:profile` user:profile`→ สแนปช็อตการใช้งานต้องใช้ขอบเขต`user:profile`ใช้`--no-usage` หรือระบุคีย์เซสชัน claude.ai (`CLAUDE_WEB_SESSION_KEY`/`CLAUDE_WEB_COOKIE\`) หรือยืนยันตัวตนใหม่ผ่าน Claude Code CLI

## การตรวจสอบความสามารถ

ดึงข้อมูลคำใบ้ความสามารถของผู้ให้บริการ (intents/scopes เมื่อมีให้) พร้อมการรองรับฟีเจอร์แบบคงที่:

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

หมายเหตุ:

- `--channel` เป็นตัวเลือก ไม่ระบุเพื่อแสดงทุกช่องทาง (รวมส่วนขยาย)
- `--target` รองรับ `channel:<id>` หรือรหัสช่องทางแบบตัวเลขดิบ และใช้กับ Discord เท่านั้น
- การตรวจสอบเป็นแบบเฉพาะผู้ให้บริการ: intents ของ Discord + สิทธิ์ช่องทางเสริมตามตัวเลือก; bot + user scopes ของ Slack; แฟล็กบอต + webhook ของ Telegram; เวอร์ชันเดมอนของ Signal; app token + บทบาท/สโคปของ Graph สำหรับ Microsoft Teams (มีคำอธิบายเมื่อทราบ) ช่องทางที่ไม่มีการตรวจสอบจะรายงาน `Probe: unavailable` ช่องทางที่ไม่มีโพรบจะแสดง `Probe: unavailable`

## แปลงชื่อเป็น ID

แปลงชื่อช่องทาง/ผู้ใช้เป็น ID โดยใช้ไดเรกทอรีของผู้ให้บริการ:

```bash
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels resolve --channel discord "My Server/#support" "@someone"
openclaw channels resolve --channel matrix "Project Room"
```

หมายเหตุ:

- ใช้ `--kind user|group|auto` เพื่อบังคับประเภทเป้าหมาย
- การแก้ไขชื่อจะให้ความสำคัญกับรายการที่กำลังใช้งานเมื่อมีหลายรายการใช้ชื่อเดียวกัน
