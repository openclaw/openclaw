---
summary: "ข้อกำหนดของPlugin manifestและJSON schema(การตรวจสอบคอนฟิกแบบเข้มงวด)"
read_when:
  - คุณกำลังสร้างปลั๊กอินOpenClaw
  - คุณต้องส่งมอบschemaคอนฟิกของปลั๊กอินหรือแก้ไขข้อผิดพลาดการตรวจสอบปลั๊กอิน
title: "Plugin Manifest"
---

# Plugin manifest (openclaw.plugin.json)

ทุกปลั๊กอิน**ต้อง**มีไฟล์`openclaw.plugin.json`อยู่ใน**รากของปลั๊กอิน**  
OpenClawใช้manifestนี้เพื่อทำการตรวจสอบคอนฟิก**โดยไม่ต้องรันโค้ดของปลั๊กอิน**  
manifestที่หายไปหรือไม่ถูกต้องจะถูกมองว่าเป็นข้อผิดพลาดของปลั๊กอินและจะบล็อกการตรวจสอบคอนฟิก
11. OpenClaw ใช้แมนิฟেস্টนี้เพื่อตรวจสอบการตั้งค่า **โดยไม่ต้องรันโค้ดปลั๊กอิน** 12. แมนิฟেস্টที่ขาดหายหรือไม่ถูกต้องจะถูกมองว่าเป็นข้อผิดพลาดของปลั๊กอินและบล็อก
การตรวจสอบการตั้งค่า

ดูคู่มือระบบปลั๊กอินฉบับเต็ม: [Plugins](/tools/plugin)

## Required fields

```json
{
  "id": "voice-call",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

คีย์ที่จำเป็น:

- `id` (string): idปลั๊กอินแบบ canonical
- `configSchema` (object): JSON Schemaสำหรับคอนฟิกของปลั๊กอิน(ฝังในไฟล์)

คีย์ที่ไม่บังคับ:

- `kind` (string): ประเภทของปลั๊กอิน(ตัวอย่าง: `"memory"`)
- `channels` (array): idของช่องทางที่ปลั๊กอินนี้ลงทะเบียน(ตัวอย่าง: `["matrix"]`)
- `providers` (array): idของผู้ให้บริการที่ปลั๊กอินนี้ลงทะเบียน
- `skills` (array): ไดเรกทอรีSkillsที่จะโหลด(อ้างอิงจากรากของปลั๊กอิน)
- `name` (string): ชื่อที่ใช้แสดงของปลั๊กอิน
- `description` (string): สรุปสั้นๆของปลั๊กอิน
- `uiHints` (object): ป้ายกำกับฟิลด์คอนฟิก/placeholder/แฟล็กความอ่อนไหวสำหรับการเรนเดอร์UI
- `version` (string): เวอร์ชันของปลั๊กอิน(เชิงข้อมูล)

## JSON Schema requirements

- **ทุกปลั๊กอินต้องมีJSON Schema**แม้ว่าจะไม่รับคอนฟิกก็ตาม
- อนุญาตให้ใช้schemaว่างได้(เช่น `{ "type": "object", "additionalProperties": false }`)
- Schemaจะถูกตรวจสอบในช่วงอ่าน/เขียนคอนฟิกไม่ใช่ตอนรันไทม์

## Validation behavior

- คีย์`channels.*`ที่ไม่รู้จักถือเป็น**ข้อผิดพลาด**ยกเว้นกรณีที่channel idถูกประกาศไว้ในplugin manifest
- `plugins.entries.<id>`, `plugins.allow`, `plugins.deny`และ`plugins.slots.*`ต้องอ้างอิงidของปลั๊กอินที่**ค้นพบได้**idที่ไม่รู้จักถือเป็น**ข้อผิดพลาด** 13. id ที่ไม่รู้จักถือเป็น **ข้อผิดพลาด**
- หากติดตั้งปลั๊กอินแล้วแต่manifestหรือschemaเสียหายหรือหายไปการตรวจสอบจะล้มเหลวและDoctorจะแจ้งข้อผิดพลาดของปลั๊กอิน
- หากมีคอนฟิกของปลั๊กอินอยู่แต่ปลั๊กอินถูก**ปิดใช้งาน**คอนฟิกจะถูกเก็บไว้และจะแสดง**คำเตือน**ในDoctorและlogs

## Notes

- manifestเป็น**สิ่งจำเป็นสำหรับปลั๊กอินทุกตัว**รวมถึงการโหลดจากระบบไฟล์ภายในเครื่อง
- รันไทม์ยังคงโหลดโมดูลของปลั๊กอินแยกต่างหากmanifestใช้สำหรับการค้นหาและการตรวจสอบเท่านั้น
- หากปลั๊กอินของคุณพึ่งพาnative modulesให้จัดทำเอกสารขั้นตอนการ buildและข้อกำหนดของallowlistจากpackage-manager(เช่น pnpm `allow-build-scripts` - `pnpm rebuild <package>`)
  - 14. `pnpm rebuild <package>`).
