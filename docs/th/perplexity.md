---
summary: "การตั้งค่า Perplexity Sonar สำหรับ web_search"
read_when:
  - คุณต้องการใช้ Perplexity Sonar สำหรับการค้นหาเว็บ
  - คุณต้องการ PERPLEXITY_API_KEY หรือการตั้งค่า OpenRouter
title: "Perplexity Sonar"
---

# Perplexity Sonar

45. OpenClaw สามารถใช้ Perplexity Sonar สำหรับเครื่องมือ `web_search` OpenClaw สามารถใช้ Perplexity Sonar สำหรับเครื่องมือ `web_search` ได้ คุณสามารถเชื่อมต่อ
    ผ่าน API โดยตรงของ Perplexity หรือผ่าน OpenRouter

## ตัวเลือก API

### Perplexity (โดยตรง)

- Base URL: [https://api.perplexity.ai](https://api.perplexity.ai)
- ตัวแปรสภาพแวดล้อม: `PERPLEXITY_API_KEY`

### OpenRouter (ทางเลือก)

- Base URL: [https://openrouter.ai/api/v1](https://openrouter.ai/api/v1)
- ตัวแปรสภาพแวดล้อม: `OPENROUTER_API_KEY`
- รองรับเครดิตแบบเติมเงิน/คริปโต

## ตัวอย่างคอนฟิก

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai",
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

## การสลับจาก Brave

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai",
        },
      },
    },
  },
}
```

หากตั้งค่าทั้ง `PERPLEXITY_API_KEY` และ `OPENROUTER_API_KEY` ให้ตั้งค่า
`tools.web.search.perplexity.baseUrl` (หรือ `tools.web.search.perplexity.apiKey`)
เพื่อแยกความกำกวม

หากไม่ได้ตั้งค่า base URL ไว้ OpenClaw จะเลือกค่าเริ่มต้นตามแหล่งที่มาของคีย์ API:

- `PERPLEXITY_API_KEY` หรือ `pplx-...` → Perplexity โดยตรง (`https://api.perplexity.ai`)
- `OPENROUTER_API_KEY` หรือ `sk-or-...` → OpenRouter (`https://openrouter.ai/api/v1`)
- รูปแบบคีย์ที่ไม่รู้จัก → OpenRouter (ทางเลือกสำรองที่ปลอดภัย)

## โมเดล

- `perplexity/sonar` — Q&A ที่รวดเร็วพร้อมการค้นหาเว็บ
- `perplexity/sonar-pro` (ค่าเริ่มต้น) — การให้เหตุผลหลายขั้นตอน + การค้นหาเว็บ
- `perplexity/sonar-reasoning-pro` — การวิจัยเชิงลึก

ดู [Web tools](/tools/web) สำหรับการกำหนดค่า web_search แบบเต็ม
