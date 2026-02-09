---
summary: "เอกสารอ้างอิงCLIสำหรับ `openclaw logs` (ติดตามล็อกไฟล์ของGateway（เกตเวย์）ผ่านRPC)"
read_when:
  - คุณต้องการติดตามล็อกของGateway（เกตเวย์）จากระยะไกล(โดยไม่ใช้SSH)
  - คุณต้องการบรรทัดล็อกแบบJSONสำหรับเครื่องมือ
title: "logs"
---

# `openclaw logs`

ติดตามล็อกไฟล์ของGateway（เกตเวย์）ผ่านRPC(ทำงานในโหมดremote)

เกี่ยวข้อง:

- ภาพรวมการบันทึกล็อก: [Logging](/logging)

## ตัวอย่าง

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
```
