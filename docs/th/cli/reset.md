---
summary: "เอกสารอ้างอิงCLIสำหรับ`openclaw reset`(รีเซ็ตคอนฟิก/สถานะภายในเครื่อง)"
read_when:
  - คุณต้องการล้างสถานะภายในเครื่องโดยยังคงติดตั้งCLIไว้
  - คุณต้องการดูแบบdry-runว่ามีอะไรบ้างที่จะถูกลบ
title: "รีเซ็ต"
---

# `openclaw reset`

รีเซ็ตคอนฟิก/สถานะภายในเครื่อง(ยังคงติดตั้งCLIไว้)

```bash
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```
