---
summary: "เอกสารอ้างอิงCLIสำหรับ `openclaw memory` (status/index/search)"
read_when:
  - คุณต้องการทำดัชนีหรือค้นหาหน่วยความจำเชิงความหมาย
  - คุณกำลังแก้ไขปัญหาความพร้อมใช้งานหรือการทำดัชนีของหน่วยความจำ
title: "หน่วยความจำ"
x-i18n:
  source_path: cli/memory.md
  source_hash: cb8ee2c9b2db2d57
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:57Z
---

# `openclaw memory`

จัดการการทำดัชนีและการค้นหาหน่วยความจำเชิงความหมาย
ให้บริการโดยปลั๊กอินหน่วยความจำที่ใช้งานอยู่ (ค่าเริ่มต้น: `memory-core`; ตั้งค่า `plugins.slots.memory = "none"` เพื่อปิดใช้งาน)

เกี่ยวข้อง:

- แนวคิดหน่วยความจำ: [Memory](/concepts/memory)
- ปลั๊กอิน: [Plugins](/tools/plugin)

## ตัวอย่าง

```bash
openclaw memory status
openclaw memory status --deep
openclaw memory status --deep --index
openclaw memory status --deep --index --verbose
openclaw memory index
openclaw memory index --verbose
openclaw memory search "release checklist"
openclaw memory status --agent main
openclaw memory index --agent main --verbose
```

## ตัวเลือก

ทั่วไป:

- `--agent <id>`: จำกัดขอบเขตให้กับเอเจนต์เดียว (ค่าเริ่มต้น: เอเจนต์ที่คอนฟิกไว้ทั้งหมด)
- `--verbose`: แสดงล็อกโดยละเอียดระหว่างการตรวจสอบและการทำดัชนี

หมายเหตุ:

- `memory status --deep` ตรวจสอบความพร้อมใช้งานของเวกเตอร์และเอมเบดดิ้ง
- `memory status --deep --index` รันการทำดัชนีใหม่หากสโตร์อยู่ในสถานะสกปรก
- `memory index --verbose` แสดงรายละเอียดรายเฟส (ผู้ให้บริการ, โมเดล, แหล่งที่มา, กิจกรรมแบบแบตช์)
- `memory status` รวมพาธเพิ่มเติมใดๆที่คอนฟิกไว้ผ่าน `memorySearch.extraPaths`
