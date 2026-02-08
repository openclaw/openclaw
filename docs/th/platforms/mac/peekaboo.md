---
summary: "การผสานรวม PeekabooBridge สำหรับการทำอัตโนมัติ UI บน macOS"
read_when:
  - โฮสต์ PeekabooBridge ใน OpenClaw.app
  - ผสานรวม Peekaboo ผ่าน Swift Package Manager
  - เปลี่ยนโปรโตคอล/พาธของ PeekabooBridge
title: "Peekaboo Bridge"
x-i18n:
  source_path: platforms/mac/peekaboo.md
  source_hash: b5b9ddb9a7c59e15
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:26Z
---

# Peekaboo Bridge (การทำอัตโนมัติ UI บน macOS)

OpenClaw สามารถโฮสต์ **PeekabooBridge** เป็นโบรกเกอร์การทำอัตโนมัติ UI แบบโลคัลที่คำนึงถึงสิทธิ์การอนุญาตได้ ซึ่งช่วยให้ `peekaboo` CLI ควบคุมการทำอัตโนมัติ UI ได้ โดยยังคงใช้สิทธิ์ TCC ของแอป macOS ร่วมกัน

## สิ่งนี้คืออะไร (และไม่ใช่อะไร)

- **โฮสต์**: OpenClaw.app สามารถทำหน้าที่เป็นโฮสต์ PeekabooBridge ได้
- **ไคลเอนต์**: ใช้ `peekaboo` CLI (ไม่มีผิวการใช้งาน `openclaw ui ...` แยกต่างหาก)
- **UI**: โอเวอร์เลย์แบบภาพยังคงอยู่ใน Peekaboo.app; OpenClaw เป็นโฮสต์โบรกเกอร์แบบบาง

## เปิดใช้งานบริดจ์

ในแอป macOS:

- การตั้งค่า → **Enable Peekaboo Bridge**

เมื่อเปิดใช้งาน OpenClaw จะเริ่มเซิร์ฟเวอร์ซ็อกเก็ต UNIX แบบโลคัล หากปิดใช้งาน โฮสต์จะถูกหยุดและ `peekaboo` จะถอยกลับไปใช้โฮสต์อื่นที่มีอยู่

## ลำดับการค้นหาไคลเอนต์

โดยทั่วไปไคลเอนต์ Peekaboo จะพยายามค้นหาโฮสต์ตามลำดับนี้:

1. Peekaboo.app (UX เต็มรูปแบบ)
2. Claude.app (หากติดตั้ง)
3. OpenClaw.app (โบรกเกอร์แบบบาง)

ใช้ `peekaboo bridge status --verbose` เพื่อดูว่าโฮสต์ใดกำลังทำงานอยู่และใช้พาธซ็อกเก็ตใด คุณสามารถบังคับแทนที่ได้ด้วย:

```bash
export PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock
```

## ความปลอดภัยและสิทธิ์การอนุญาต

- บริดจ์จะตรวจสอบ **ลายเซ็นโค้ดของผู้เรียก** และบังคับใช้รายการอนุญาตของ TeamID (TeamID ของโฮสต์ Peekaboo + TeamID ของแอป OpenClaw)
- คำขอจะหมดเวลาประมาณ ~10 วินาที
- หากขาดสิทธิ์ที่จำเป็น บริดจ์จะส่งข้อความข้อผิดพลาดที่ชัดเจน แทนการเปิด System Settings

## พฤติกรรมสแนปช็อต (การทำอัตโนมัติ)

สแนปช็อตจะถูกเก็บไว้ในหน่วยความจำและหมดอายุอัตโนมัติหลังจากช่วงเวลาสั้นๆ หากต้องการเก็บไว้นานขึ้น ให้จับภาพใหม่จากฝั่งไคลเอนต์

## การแก้ไขปัญหา

- หาก `peekaboo` รายงานว่า “bridge client is not authorized” ให้ตรวจสอบว่าไคลเอนต์ถูกเซ็นอย่างถูกต้อง หรือรันโฮสต์ด้วย `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` ในโหมด **debug** เท่านั้น
- หากไม่พบโฮสต์ ให้เปิดแอปโฮสต์ใดแอปหนึ่ง (Peekaboo.app หรือ OpenClaw.app) และยืนยันว่าได้อนุญาตสิทธิ์แล้ว
