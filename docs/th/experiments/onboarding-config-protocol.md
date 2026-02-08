---
summary: "บันทึกโปรโตคอลRPCสำหรับวิซาร์ดเริ่มต้นใช้งานและสคีมาคอนฟิก"
read_when: "เมื่อเปลี่ยนขั้นตอนวิซาร์ดเริ่มต้นใช้งานหรือเอ็นด์พอยต์สคีมาคอนฟิก"
title: "โปรโตคอลการเริ่มต้นใช้งานและคอนฟิก"
x-i18n:
  source_path: experiments/onboarding-config-protocol.md
  source_hash: 55163b3ee029c024
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:07Z
---

# การเริ่มต้นใช้งาน + โปรโตคอลคอนฟิก

วัตถุประสงค์: พื้นผิวการเริ่มต้นใช้งานและคอนฟิกร่วมกันระหว่างCLI แอปmacOS และ Web UI

## องค์ประกอบ

- เอนจินวิซาร์ด(เซสชันร่วม + พรอมป์ต์ + สถานะการเริ่มต้นใช้งาน)
- การเริ่มต้นใช้งานผ่านCLIใช้โฟลว์วิซาร์ดเดียวกับไคลเอนต์UI
- GatewayRPCเปิดเผยเอ็นด์พอยต์ของวิซาร์ดและสคีมาคอนฟิก
- การเริ่มต้นใช้งานบนmacOSใช้โมเดลขั้นตอนของวิซาร์ด
- Web UIเรนเดอร์ฟอร์มคอนฟิกจากJSON Schema + คำใบ้ของUI

## Gateway RPC

- `wizard.start` พารามิเตอร์: `{ mode?: "local"|"remote", workspace?: string }`
- `wizard.next` พารามิเตอร์: `{ sessionId, answer?: { stepId, value? } }`
- `wizard.cancel` พารามิเตอร์: `{ sessionId }`
- `wizard.status` พารามิเตอร์: `{ sessionId }`
- `config.schema` พารามิเตอร์: `{}`

การตอบกลับ(รูปแบบ)

- วิซาร์ด: `{ sessionId, done, step?, status?, error? }`
- สคีมาคอนฟิก: `{ schema, uiHints, version, generatedAt }`

## คำใบ้ของUI

- `uiHints` คีย์ตามพาธ; เมทาดาทาทางเลือก(label/help/group/order/advanced/sensitive/placeholder)
- ฟิลด์ที่เป็นข้อมูลอ่อนไหวจะแสดงเป็นอินพุตรหัสผ่าน; ไม่มีเลเยอร์ปกปิดข้อมูล
- โหนดสคีมาที่ไม่รองรับจะถอยกลับไปใช้ตัวแก้ไขJSONดิบ

## หมายเหตุ

- เอกสารนี้เป็นแหล่งเดียวสำหรับติดตามการปรับโครงสร้างโปรโตคอลของการเริ่มต้นใช้งาน/คอนฟิก
