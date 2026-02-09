---
summary: "ใช้ API แบบรวมศูนย์ของ Qianfan เพื่อเข้าถึงโมเดลจำนวนมากใน OpenClaw"
read_when:
  - คุณต้องการคีย์APIเพียงชุดเดียวสำหรับLLMหลายตัว
  - คุณต้องการคำแนะนำการตั้งค่า Baidu Qianfan
title: "Qianfan"
---

# คู่มือผู้ให้บริการ Qianfan

Qianfan เป็นแพลตฟอร์ม MaaS ของ Baidu ที่ให้ **API แบบรวมศูนย์** ซึ่งกำหนดเส้นทางคำขอไปยังโมเดลจำนวนมากผ่านเอ็นด์พอยต์และคีย์APIเพียงชุดเดียว รองรับความเข้ากันได้กับ OpenAI ดังนั้น SDK ของ OpenAI ส่วนใหญ่สามารถใช้งานได้เพียงสลับ base URL มันเข้ากันได้กับ OpenAI ดังนั้น SDK ของ OpenAI ส่วนใหญ่จึงใช้งานได้โดยการสลับ base URL

## ข้อกำหนดก่อนเริ่มต้น

1. บัญชี Baidu Cloud ที่มีสิทธิ์เข้าถึง Qianfan API
2. คีย์APIจากคอนโซล Qianfan
3. ติดตั้ง OpenClaw บนระบบของคุณแล้ว

## การรับคีย์APIของคุณ

1. ไปที่ [Qianfan Console](https://console.bce.baidu.com/qianfan/ais/console/apiKey)
2. สร้างแอปพลิเคชันใหม่หรือเลือกแอปที่มีอยู่
3. สร้างคีย์API (รูปแบบ: `bce-v3/ALTAK-...`)
4. คัดลอกคีย์APIเพื่อนำไปใช้กับ OpenClaw

## การตั้งค่าCLI

```bash
openclaw onboard --auth-choice qianfan-api-key
```

## เอกสารที่เกี่ยวข้อง

- [การกำหนดค่า OpenClaw](/gateway/configuration)
- [ผู้ให้บริการโมเดล](/concepts/model-providers)
- [การตั้งค่าเอเจนต์](/concepts/agent)
- [เอกสาร Qianfan API](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
