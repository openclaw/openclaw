---
summary: "รองรับบัญชี Zalo ส่วนบุคคลผ่าน zca-cli (ล็อกอินด้วย QR), ความสามารถ และการกำหนดค่า"
read_when:
  - การตั้งค่า Zalo ส่วนบุคคลสำหรับ OpenClaw
  - การดีบักการล็อกอินหรือโฟลว์ข้อความของ Zalo ส่วนบุคคล
title: "Zalo ส่วนบุคคล"
---

# Zalo ส่วนบุคคล (ไม่เป็นทางการ)

สถานะ: ทดลอง สถานะ: ทดลองใช้งาน การผสานรวมนี้ทำงานอัตโนมัติกับ **บัญชี Zalo ส่วนบุคคล** ผ่าน `zca-cli`.

> **คำเตือน:** นี่เป็นการผสานรวมที่ไม่เป็นทางการและอาจทำให้บัญชีถูกระงับ/แบนได้ ใช้ด้วยความเสี่ยงของคุณเอง ใช้ด้วยความเสี่ยงของคุณเอง

## ต้องใช้ปลั๊กอิน

Zalo ส่วนบุคคลมาในรูปแบบปลั๊กอินและไม่ถูกรวมมากับการติดตั้งแกนหลัก

- ติดตั้งผ่าน CLI: `openclaw plugins install @openclaw/zalouser`
- หรือจากซอร์สที่เช็คเอาต์: `openclaw plugins install ./extensions/zalouser`
- รายละเอียด: [Plugins](/tools/plugin)

## ข้อกำหนดก่อนเริ่มต้น: zca-cli

เครื่อง Gateway（เกตเวย์）ต้องมีไบนารี `zca` พร้อมใช้งานใน `PATH`.

- ตรวจสอบ: `zca --version`
- หากไม่มี ให้ติดตั้ง zca-cli (ดู `extensions/zalouser/README.md` หรือเอกสาร zca-cli ต้นทาง)

## ตั้งค่าอย่างรวดเร็ว(ผู้เริ่มต้น)

1. ติดตั้งปลั๊กอิน (ดูด้านบน)
2. ล็อกอิน (QR บนเครื่อง Gateway（เกตเวย์）):
   - `openclaw channels login --channel zalouser`
   - สแกนโค้ด QR ในเทอร์มินัลด้วยแอป Zalo บนมือถือ
3. เปิดใช้งานช่องทาง:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

4. รีสตาร์ต Gateway（เกตเวย์） (หรือทำขั้นตอน onboarding ให้เสร็จ)
5. การเข้าถึง DM ค่าเริ่มต้นคือการจับคู่; อนุมัติรหัสการจับคู่เมื่อมีการติดต่อครั้งแรก

## คืออะไร

- ใช้ `zca listen` เพื่อรับข้อความขาเข้า
- ใช้ `zca msg ...` เพื่อส่งการตอบกลับ (ข้อความ/สื่อ/ลิงก์)
- ออกแบบมาสำหรับกรณีใช้งาน “บัญชีส่วนบุคคล” ที่ไม่สามารถใช้ Zalo Bot API ได้

## การตั้งชื่อ

Channel id คือ `zalouser` เพื่อระบุอย่างชัดเจนว่านี่คือการทำงานอัตโนมัติกับ **บัญชีผู้ใช้ Zalo ส่วนบุคคล** (ไม่เป็นทางการ) เราเก็บ `zalo` ไว้สำหรับการผสานรวม Zalo API อย่างเป็นทางการในอนาคตที่อาจเกิดขึ้น เราเก็บ `zalo` ไว้สำหรับการผสานรวม Zalo API อย่างเป็นทางการที่อาจเกิดขึ้นในอนาคต

## การค้นหา ID (ไดเรกทอรี)

ใช้ CLI ของไดเรกทอรีเพื่อค้นหาเพื่อน/กลุ่มและ ID ของพวกเขา:

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## ข้อจำกัด

- ข้อความขาออกถูกแบ่งเป็นชิ้นประมาณ ~2000 ตัวอักษร (ข้อจำกัดของไคลเอนต์ Zalo)
- การสตรีมถูกปิดใช้งานเป็นค่าเริ่มต้น

## การควบคุมการเข้าถึง(DMs)

`channels.zalouser.dmPolicy` รองรับ: `pairing | allowlist | open | disabled` (ค่าเริ่มต้น: `pairing`).
`channels.zalouser.allowFrom` รับ user ID หรือชื่อ วิซาร์ดจะแปลงชื่อเป็น ID ผ่าน `zca friend find` เมื่อมีให้ใช้งาน วิซาร์ดจะแปลงชื่อเป็น ID ผ่าน `zca friend find` เมื่อมีให้ใช้งาน

อนุมัติผ่าน:

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## การเข้าถึงกลุ่ม(ไม่บังคับ)

- ค่าเริ่มต้น: `channels.zalouser.groupPolicy = "open"` (อนุญาตกลุ่ม) ใช้ `channels.defaults.groupPolicy` เพื่อแทนที่ค่าเริ่มต้นเมื่อยังไม่ถูกตั้งค่า ใช้ `channels.defaults.groupPolicy` เพื่อแทนที่ค่าเริ่มต้นเมื่อยังไม่ตั้งค่า
- จำกัดด้วย allowlist:
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups` (คีย์คือ group ID หรือชื่อ)
- บล็อกทุกกลุ่ม: `channels.zalouser.groupPolicy = "disabled"`.
- วิซาร์ดการกำหนดค่าสามารถถามหา allowlist ของกลุ่มได้
- ตอนเริ่มต้น OpenClaw จะแปลงชื่อกลุ่ม/ผู้ใช้ใน allowlist เป็น ID และบันทึกการแมป; รายการที่แปลงไม่ได้จะคงไว้ตามที่พิมพ์

ตัวอย่าง:

```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groups: {
        "123456789": { allow: true },
        "Work Chat": { allow: true },
      },
    },
  },
}
```

## หลายบัญชี

บัญชีจะถูกแมปกับโปรไฟล์ zca ตัวอย่าง:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      defaultAccount: "default",
      accounts: {
        work: { enabled: true, profile: "work" },
      },
    },
  },
}
```

## การแก้ไขปัญหา

**ไม่พบ `zca`:**

- ติดตั้ง zca-cli และตรวจสอบให้แน่ใจว่าอยู่ใน `PATH` สำหรับโปรเซสของ Gateway（เกตเวย์）

**ล็อกอินไม่คงอยู่:**

- `openclaw channels status --probe`
- ล็อกอินใหม่: `openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`
