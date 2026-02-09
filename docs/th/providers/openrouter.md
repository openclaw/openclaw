---
summary: "ใช้ API แบบรวมศูนย์ของ OpenRouter เพื่อเข้าถึงโมเดลจำนวนมากใน OpenClaw"
read_when:
  - คุณต้องการคีย์ API เดียวสำหรับ LLM หลายตัว
  - คุณต้องการรันโมเดลผ่าน OpenRouter ใน OpenClaw
title: "OpenRouter"
---

# OpenRouter

OpenRouter มี **API แบบรวมศูนย์** ที่กำหนดเส้นทางคำขอไปยังโมเดลจำนวนมากผ่านเอนด์พอยต์และคีย์ API เดียว โดยเข้ากันได้กับ OpenAI ดังนั้น SDK ของ OpenAI ส่วนใหญ่จึงใช้งานได้ เพียงเปลี่ยน base URL มันเข้ากันได้กับ OpenAI ดังนั้น SDK ของ OpenAI ส่วนใหญ่จึงใช้งานได้โดยการสลับ base URL

## การตั้งค่าCLI

```bash
openclaw onboard --auth-choice apiKey --token-provider openrouter --token "$OPENROUTER_API_KEY"
```

## Config snippet

```json5
{
  env: { OPENROUTER_API_KEY: "sk-or-..." },
  agents: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
    },
  },
}
```

## หมายเหตุ

- การอ้างอิงโมเดลคือ `openrouter/<provider>/<model>`.
- สำหรับตัวเลือกโมเดล/ผู้ให้บริการเพิ่มเติม ดูที่ [/concepts/model-providers](/concepts/model-providers).
- OpenRouter ใช้ Bearer token พร้อมคีย์ API ของคุณภายในระบบ.
