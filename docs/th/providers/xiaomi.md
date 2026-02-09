---
summary: "ใช้ Xiaomi MiMo (mimo-v2-flash) กับ OpenClaw"
read_when:
  - คุณต้องการใช้โมเดล Xiaomi MiMo ใน OpenClaw
  - คุณต้องตั้งค่า XIAOMI_API_KEY
title: "Xiaomi MiMo"
---

# Xiaomi MiMo

Xiaomi MiMo เป็นแพลตฟอร์ม API สำหรับโมเดล **MiMo** ให้บริการ REST API ที่เข้ากันได้กับรูปแบบของ OpenAI และ Anthropic และใช้คีย์ API สำหรับการยืนยันตัวตน Xiaomi MiMo เป็นแพลตฟอร์ม API สำหรับโมเดล **MiMo** โดยให้บริการ REST API ที่เข้ากันได้กับฟอร์แมตของ
OpenAI และ Anthropic และใช้คีย์APIสำหรับการยืนยันตัวตน สร้างคีย์APIของคุณได้ใน
[Xiaomi MiMo console](https://platform.xiaomimimo.com/#/console/api-keys) OpenClaw ใช้
ผู้ให้บริการ `xiaomi` ร่วมกับคีย์APIของ Xiaomi MiMo OpenClaw ใช้ผู้ให้บริการ `xiaomi` พร้อมคีย์ API ของ Xiaomi MiMo

## ภาพรวมโมเดล

- **mimo-v2-flash**: หน้าต่างบริบท 262144 โทเคน เข้ากันได้กับ Anthropic Messages API
- Base URL: `https://api.xiaomimimo.com/anthropic`
- Authorization: `Bearer $XIAOMI_API_KEY`

## การตั้งค่าCLI

```bash
openclaw onboard --auth-choice xiaomi-api-key
# or non-interactive
openclaw onboard --auth-choice xiaomi-api-key --xiaomi-api-key "$XIAOMI_API_KEY"
```

## Config snippet

```json5
{
  env: { XIAOMI_API_KEY: "your-key" },
  agents: { defaults: { model: { primary: "xiaomi/mimo-v2-flash" } } },
  models: {
    mode: "merge",
    providers: {
      xiaomi: {
        baseUrl: "https://api.xiaomimimo.com/anthropic",
        api: "anthropic-messages",
        apiKey: "XIAOMI_API_KEY",
        models: [
          {
            id: "mimo-v2-flash",
            name: "Xiaomi MiMo V2 Flash",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## หมายเหตุ

- อ้างอิงโมเดล: `xiaomi/mimo-v2-flash`.
- ผู้ให้บริการจะถูกฉีดโดยอัตโนมัติเมื่อมีการตั้งค่า `XIAOMI_API_KEY` (หรือมีโปรไฟล์การยืนยันตัวตนอยู่แล้ว)
- ดู [/concepts/model-providers](/concepts/model-providers) สำหรับกฎของผู้ให้บริการ
