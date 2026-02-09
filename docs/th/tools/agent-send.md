---
summary: "การรัน CLI `openclaw agent` โดยตรง(พร้อมการส่งมอบแบบไม่บังคับ)"
read_when:
  - การเพิ่มหรือแก้ไขจุดเริ่มต้นของ agent CLI
title: "Agent Send"
---

# `openclaw agent` (การรันเอเจนต์โดยตรง)

`openclaw agent` จะรันเอเจนต์หนึ่งรอบโดยไม่ต้องมีข้อความแชตขาเข้า
`openclaw agent` รันหนึ่งเทิร์นของเอเจนต์โดยไม่ต้องมีข้อความแชตขาเข้า
โดยค่าเริ่มต้นจะ **ผ่าน Gateway（เกตเวย์）**; เพิ่ม `--local` เพื่อบังคับใช้
รันไทม์แบบฝังบนเครื่องปัจจุบัน

## พฤติกรรม

- ต้องมี: `--message <text>`
- การเลือกเซสชัน:
  - `--to <dest>` สร้างคีย์เซสชัน(เป้าหมายแบบกลุ่ม/ช่องทางยังคงการแยก; แชตโดยตรงจะถูกรวมเป็น `main`), **หรือ**
  - `--session-id <id>` ใช้เซสชันที่มีอยู่แล้วตาม id ซ้ำ, **หรือ**
  - `--agent <id>` เล็งเป้าไปที่เอเจนต์ที่กำหนดค่าไว้โดยตรง(ใช้คีย์เซสชัน `main` ของเอเจนต์นั้น)
- รันรันไทม์เอเจนต์แบบฝังเดียวกันกับการตอบกลับขาเข้าปกติ
- แฟล็กการคิด/โหมด verbose จะถูกเก็บคงไว้ในสโตร์ของเซสชัน
- เอาต์พุต:
  - ค่าเริ่มต้น: พิมพ์ข้อความตอบกลับ(รวมบรรทัด `MEDIA:<url>`)
  - `--json`: พิมพ์เพย์โหลดแบบมีโครงสร้าง+เมตาดาตา
- การส่งมอบกลับไปยังช่องทางเป็นทางเลือกด้วย `--deliver` + `--channel`(รูปแบบเป้าหมายตรงกับ `openclaw message --target`)
- ใช้ `--reply-channel`/`--reply-to`/`--reply-account` เพื่อแทนที่การส่งมอบโดยไม่เปลี่ยนเซสชัน

หาก Gateway（เกตเวย์）ไม่สามารถเข้าถึงได้ CLI จะ **ถอยกลับ** ไปใช้การรันแบบโลคอลที่ฝังอยู่

## ตัวอย่าง

```bash
openclaw agent --to +15555550123 --message "status update"
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json
openclaw agent --to +15555550123 --message "Summon reply" --deliver
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```

## แฟล็ก

- `--local`: รันแบบโลคอล(ต้องมีคีย์ API ของผู้ให้บริการโมเดลในเชลล์ของคุณ)
- `--deliver`: ส่งคำตอบไปยังช่องทางที่เลือก
- `--channel`: ช่องทางการส่งมอบ(`whatsapp|telegram|discord|googlechat|slack|signal|imessage`, ค่าเริ่มต้น: `whatsapp`)
- `--reply-to`: แทนที่เป้าหมายการส่งมอบ
- `--reply-channel`: แทนที่ช่องทางการส่งมอบ
- `--reply-account`: แทนที่ id บัญชีการส่งมอบ
- `--thinking <off|minimal|low|medium|high|xhigh>`: คงระดับการคิด(เฉพาะโมเดล GPT-5.2+Codex)
- `--verbose <on|full|off>`: คงระดับ verbose
- `--timeout <seconds>`: แทนที่เวลาไทม์เอาต์ของเอเจนต์
- `--json`: เอาต์พุต JSON แบบมีโครงสร้าง
