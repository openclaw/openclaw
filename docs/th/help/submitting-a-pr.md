---
summary: "วิธีส่ง PR ที่มีสัญญาณชัดเจนและคุณภาพสูง"
title: "การส่ง PR"
---

PR ที่ดีจะรีวิวได้ง่าย: ผู้รีวิวควรเข้าใจเจตนาได้อย่างรวดเร็ว ตรวจสอบพฤติกรรมได้ และนำการเปลี่ยนแปลงขึ้นระบบได้อย่างปลอดภัย คู่มือนี้ครอบคลุมการส่งงานที่กระชับและมีสัญญาณสูงสำหรับการรีวิวทั้งโดยมนุษย์และ LLM คู่มือนี้ครอบคลุมการส่งที่กระชับและมีสัญญาณสูงสำหรับการรีวิวโดยมนุษย์และ LLM

## อะไรทำให้ PR ดี

- [ ] อธิบายปัญหา เหตุผลที่สำคัญ และการเปลี่ยนแปลง
- [ ] โฟกัสการเปลี่ยนแปลงให้แคบ หลีกเลี่ยงการรีแฟกเตอร์ครั้งใหญ่
- [ ] สรุปการเปลี่ยนแปลงที่ผู้ใช้เห็น/คอนฟิก/ค่าเริ่มต้น
- [ ] ระบุความครอบคลุมของการทดสอบ การข้าม และเหตุผล
- [ ] เพิ่มหลักฐาน: ล็อก สกรีนช็อต หรือการบันทึก (UI/UX)
- [ ] คำโค้ด: ใส่ “lobster-biscuit” ในคำอธิบาย PR หากคุณอ่านคู่มือนี้
- [ ] รัน/แก้ไขคำสั่ง `pnpm` ที่เกี่ยวข้องก่อนสร้าง PR
- [ ] ค้นหาในโค้ดเบสและ GitHub สำหรับฟังก์ชัน/ปัญหา/การแก้ไขที่เกี่ยวข้อง
- [ ] อ้างอิงข้อกล่าวอ้างจากหลักฐานหรือการสังเกต
- [ ] ชื่อเรื่องที่ดี: กริยา + ขอบเขต + ผลลัพธ์ (เช่น `Docs: add PR and issue templates`)

กระชับ; การรีวิวที่กระชับ > ไวยากรณ์ ละเว้นส่วนที่ไม่เกี่ยวข้อง

### คำสั่งตรวจสอบพื้นฐาน (รัน/แก้ไขความล้มเหลวสำหรับการเปลี่ยนแปลงของคุณ)

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- การเปลี่ยนแปลงโปรโตคอล: `pnpm protocol:check`

## การเปิดเผยแบบเป็นขั้นเป็นตอน

- ส่วนบน: สรุป/เจตนา
- ถัดไป: การเปลี่ยนแปลง/ความเสี่ยง
- ถัดไป: การทดสอบ/การยืนยัน
- ท้ายสุด: การนำไปใช้/หลักฐาน

## ประเภท PR ที่พบบ่อย: รายละเอียดเฉพาะ

- [ ] แก้ไขบั๊ก: เพิ่มขั้นตอนทำซ้ำ สาเหตุราก การยืนยัน
- [ ] ฟีเจอร์: เพิ่มกรณีใช้งาน พฤติกรรม/เดโม/สกรีนช็อต (UI)
- [ ] รีแฟกเตอร์: ระบุว่า "ไม่มีการเปลี่ยนพฤติกรรม" และลิสต์สิ่งที่ย้าย/ทำให้ง่ายขึ้น
- [ ] งานจิปาถะ: ระบุเหตุผล (เช่น เวลา build, CI, dependencies)
- [ ] เอกสาร: บริบทก่อน/หลัง ลิงก์หน้าที่อัปเดต รัน `pnpm format`
- [ ] ทดสอบ: ช่องว่างที่ครอบคลุม; วิธีป้องกันการถดถอย
- [ ] ประสิทธิภาพ: เพิ่มตัวชี้วัดก่อน/หลัง และวิธีการวัด
- [ ] UX/UI: สกรีนช็อต/วิดีโอ ระบุผลกระทบด้านการเข้าถึง
- [ ] โครงสร้างพื้นฐาน/บิลด์: สภาพแวดล้อม/การยืนยัน
- [ ] ความปลอดภัย: สรุปความเสี่ยง ขั้นตอนทำซ้ำ การยืนยัน ไม่มีข้อมูลอ่อนไหว อ้างอิงเฉพาะข้อกล่าวอ้างที่มีหลักฐาน อ้างอิงเฉพาะข้อกล่าวอ้างที่มีหลักฐาน

## เช็กลิสต์

- [ ] ปัญหา/เจตนาชัดเจน
- [ ] ขอบเขตโฟกัส
- [ ] ระบุการเปลี่ยนแปลงพฤติกรรม
- [ ] รายการและผลลัพธ์การทดสอบ
- [ ] ขั้นตอนทดสอบด้วยตนเอง (เมื่อเหมาะสม)
- [ ] ไม่มีความลับ/ข้อมูลส่วนตัว
- [ ] อิงหลักฐาน

## เทมเพลต PR ทั่วไป

```md
#### Summary

#### Behavior Changes

#### Codebase and GitHub Search

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort (self-reported):
- Agent notes (optional, cite evidence):
```

## เทมเพลตตามประเภท PR (แทนที่ด้วยประเภทของคุณ)

### แก้ไขบั๊ก

```md
#### Summary

#### Repro Steps

#### Root Cause

#### Behavior Changes

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### ฟีเจอร์

```md
#### Summary

#### Use Cases

#### Behavior Changes

#### Existing Functionality Check

- [ ] I searched the codebase for existing functionality.
      Searches performed (1-3 bullets):
  -
  -

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### รีแฟกเตอร์

```md
#### Summary

#### Scope

#### No Behavior Change Statement

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### งานจิปาถะ/บำรุงรักษา

```md
#### Summary

#### Why This Matters

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### เอกสาร

```md
#### Summary

#### Pages Updated

#### Before/After

#### Formatting

pnpm format

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### ทดสอบ

```md
#### Summary

#### Gap Covered

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### ประสิทธิภาพ

```md
#### Summary

#### Baseline

#### After

#### Measurement Method

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### UX/UI

```md
#### Summary

#### Screenshots or Video

#### Accessibility Impact

#### Tests

#### Manual Testing

### Prerequisites

-

### Steps

1.
2. **Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### โครงสร้างพื้นฐาน/บิลด์

```md
#### Summary

#### Environments Affected

#### Validation Steps

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### ความปลอดภัย

```md
#### Summary

#### Risk Summary

#### Repro Steps

#### Mitigation or Fix

#### Verification

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```
