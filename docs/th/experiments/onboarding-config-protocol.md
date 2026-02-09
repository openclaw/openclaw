---
summary: "บันทึกโปรโตคอลRPCสำหรับวิซาร์ดเริ่มต้นใช้งานและสคีมาคอนฟิก"
read_when: "Changing onboarding wizard steps or config schema endpoints"
title: "โปรโตคอลการเริ่มต้นใช้งานและคอนฟิก"
---

# การเริ่มต้นใช้งาน + โปรโตคอลคอนฟิก

วัตถุประสงค์: พื้นผิวการเริ่มต้นใช้งานและคอนฟิกร่วมกันระหว่างCLI แอปmacOS และ Web UI

## องค์ประกอบ

- เอนจินวิซาร์ด(เซสชันร่วม + พรอมป์ต์ + สถานะการเริ่มต้นใช้งาน)
- การเริ่มต้นใช้งานผ่านCLIใช้โฟลว์วิซาร์ดเดียวกับไคลเอนต์UI
- Gateway RPC exposes wizard + config schema endpoints.
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
