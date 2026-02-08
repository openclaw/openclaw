---
summary: "ทางเลือกสำรองของ Firecrawl สำหรับ web_fetch (ต้านบอต + การดึงข้อมูลแบบแคช)"
read_when:
  - คุณต้องการการดึงข้อมูลเว็บที่ใช้ Firecrawl เป็นแบ็กเอนด์
  - คุณต้องมีคีย์ API ของ Firecrawl
  - คุณต้องการการดึงข้อมูลแบบต้านบอตสำหรับ web_fetch
title: "Firecrawl"
x-i18n:
  source_path: tools/firecrawl.md
  source_hash: 08a7ad45b41af412
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:44Z
---

# Firecrawl

OpenClaw สามารถใช้ **Firecrawl** เป็นตัวดึงข้อมูลสำรองสำหรับ `web_fetch` ได้ ซึ่งเป็นบริการดึงเนื้อหาแบบโฮสต์ที่รองรับการหลบหลีกบอตและการแคช ช่วยให้ทำงานได้ดีกับเว็บไซต์ที่ใช้ JS หนักหรือหน้าที่บล็อกการดึงข้อมูล HTTP แบบธรรมดา

## รับคีย์ API

1. สร้างบัญชี Firecrawl และสร้างคีย์ API
2. เก็บคีย์ไว้ในคอนฟิกหรือกำหนด `FIRECRAWL_API_KEY` ในสภาพแวดล้อมของเกตเวย์

## กำหนดค่า Firecrawl

```json5
{
  tools: {
    web: {
      fetch: {
        firecrawl: {
          apiKey: "FIRECRAWL_API_KEY_HERE",
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 172800000,
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

หมายเหตุ:

- `firecrawl.enabled` จะเป็นค่า true โดยอัตโนมัติเมื่อมีคีย์ API
- `maxAgeMs` ควบคุมอายุของผลลัพธ์ที่แคชได้ (มิลลิวินาที) ค่าเริ่มต้นคือ 2 วัน

## Stealth / การหลบหลีกบอต

Firecrawl เปิดเผยพารามิเตอร์ **proxy mode** สำหรับการหลบหลีกบอต (`basic`, `stealth`, หรือ `auto`)  
OpenClaw จะใช้ `proxy: "auto"` ร่วมกับ `storeInCache: true` สำหรับคำขอไปยัง Firecrawl เสมอ  
หากไม่ระบุ proxy, Firecrawl จะใช้ค่าเริ่มต้นเป็น `auto` โดย `auto` จะลองใหม่ด้วยพร็อกซีแบบ stealth หากการพยายามแบบพื้นฐานล้มเหลว ซึ่งอาจใช้เครดิตมากกว่าการสแครปแบบพื้นฐานเท่านั้น

## วิธีที่ `web_fetch` ใช้ Firecrawl

ลำดับการดึงข้อมูลของ `web_fetch`:

1. Readability (ภายในเครื่อง)
2. Firecrawl (หากมีการกำหนดค่า)
3. การทำความสะอาด HTML ขั้นพื้นฐาน (ตัวเลือกสำรองสุดท้าย)

ดู [Web tools](/tools/web) สำหรับการตั้งค่าเครื่องมือเว็บทั้งหมด
