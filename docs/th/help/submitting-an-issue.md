---
summary: "การยื่นประเด็นและรายงานบั๊กที่มีสัญญาณสูง"
title: "การส่งประเด็น"
x-i18n:
  source_path: help/submitting-an-issue.md
  source_hash: bcb33f05647e9f0d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:18Z
---

## การส่งประเด็น

ประเด็นที่ชัดเจนและกระชับช่วยให้วิเคราะห์และแก้ไขได้รวดเร็ว โปรดใส่ข้อมูลต่อไปนี้สำหรับบั๊ก การถดถอย หรือช่องว่างของฟีเจอร์:

### สิ่งที่ควรใส่

- [ ] ชื่อเรื่อง: พื้นที่ & อาการ
- [ ] ขั้นตอนการทำซ้ำแบบสั้นที่สุด
- [ ] ผลลัพธ์ที่คาดหวังเทียบกับผลลัพธ์จริง
- [ ] ผลกระทบ & ระดับความรุนแรง
- [ ] สภาพแวดล้อม: OS, รันไทม์, เวอร์ชัน, คอนฟิก
- [ ] หลักฐาน: ล็อกที่ปิดบังข้อมูล, สกรีนช็อต (ไม่ใช่ข้อมูลส่วนบุคคล)
- [ ] ขอบเขต: ใหม่, การถดถอย, หรือมีมานาน
- [ ] คำรหัส: ใส่คำว่า lobster-biscuit ในประเด็นของคุณ
- [ ] ค้นหาโค้ดเบส & GitHub แล้วว่ามีประเด็นเดิมหรือไม่
- [ ] ยืนยันว่าไม่ได้เพิ่งถูกแก้ไข/จัดการ (โดยเฉพาะด้านความปลอดภัย)
- [ ] ข้อกล่าวอ้างต้องมีหลักฐานหรือขั้นตอนการทำซ้ำรองรับ

เขียนให้สั้น กระชับมากกว่าภาษาไร้ที่ติ

การตรวจสอบความถูกต้อง (รัน/แก้ไขก่อน PR):

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- หากเป็นโค้ดโปรโตคอล: `pnpm protocol:check`

### เทมเพลต

#### รายงานบั๊ก

```md
- [ ] Minimal repro
- [ ] Expected vs actual
- [ ] Environment
- [ ] Affected channels, where not seen
- [ ] Logs/screenshots (redacted)
- [ ] Impact/severity
- [ ] Workarounds

### Summary

### Repro Steps

### Expected

### Actual

### Environment

### Logs/Evidence

### Impact

### Workarounds
```

#### ประเด็นด้านความปลอดภัย

```md
### Summary

### Impact

### Versions

### Repro Steps (safe to share)

### Mitigation/workaround

### Evidence (redacted)
```

_หลีกเลี่ยงการเปิดเผยความลับ/รายละเอียดการเอ็กซ์พลอยต์ในที่สาธารณะ สำหรับประเด็นอ่อนไหว ให้ลดรายละเอียดและขอการเปิดเผยแบบส่วนตัว_

#### รายงานการถดถอย

```md
### Summary

### Last Known Good

### First Known Bad

### Repro Steps

### Expected

### Actual

### Environment

### Logs/Evidence

### Impact
```

#### คำขอฟีเจอร์

```md
### Summary

### Problem

### Proposed Solution

### Alternatives

### Impact

### Evidence/examples
```

#### การปรับปรุง

```md
### Summary

### Current vs Desired Behavior

### Rationale

### Alternatives

### Evidence/examples
```

#### การสืบสวน

```md
### Summary

### Symptoms

### What Was Tried

### Environment

### Logs/Evidence

### Impact
```

### การส่ง PR เพื่อแก้ไข

การมีประเด็นก่อน PR เป็นทางเลือก หากข้าม ให้ใส่รายละเอียดใน PR รักษาโฟกัสของ PR ระบุหมายเลขประเด็น เพิ่มการทดสอบหรืออธิบายเหตุผลที่ไม่มี บันทึกการเปลี่ยนแปลงพฤติกรรม/ความเสี่ยง แนบล็อก/สกรีนช็อตที่ปิดบังข้อมูลเป็นหลักฐาน และรันการตรวจสอบที่เหมาะสมก่อนส่ง
