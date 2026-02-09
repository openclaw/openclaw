---
summary: "การตั้งค่า Brave Search API สำหรับ web_search"
read_when:
  - คุณต้องการใช้ Brave Search สำหรับ web_search
  - คุณต้องการ BRAVE_API_KEY หรือรายละเอียดแพ็กเกจ
title: "Brave Search"
---

# Brave Search API

OpenClaw ใช้ Brave Search เป็นผู้ให้บริการค่าเริ่มต้นสำหรับ `web_search`.

## รับคีย์ API

1. สร้างบัญชี Brave Search API ที่ [https://brave.com/search/api/](https://brave.com/search/api/)
2. ในแดชบอร์ด ให้เลือกแพ็กเกจ **Data for Search** และสร้างคีย์ API
3. เก็บคีย์ไว้ในคอนฟิก(แนะนำ) หรือกำหนด `BRAVE_API_KEY` ในสภาพแวดล้อมของ Gateway（เกตเวย์）

## ตัวอย่างคอนฟิก

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave",
        apiKey: "BRAVE_API_KEY_HERE",
        maxResults: 5,
        timeoutSeconds: 30,
      },
    },
  },
}
```

## หมายเหตุ

- แพ็กเกจ Data for AI **ไม่** เข้ากันได้กับ `web_search`.
- Brave มีแพ็กเกจฟรีและแบบชำระเงิน โปรดตรวจสอบขีดจำกัดปัจจุบันในพอร์ทัล Brave API

ดู [Web tools](/tools/web) สำหรับการกำหนดค่า web_search แบบครบถ้วน
