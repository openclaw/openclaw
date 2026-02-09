---
summary: "ใช้ Z.AI (โมเดล GLM) กับ OpenClaw"
read_when:
  - คุณต้องการใช้โมเดล Z.AI/GLM ใน OpenClaw
  - คุณต้องการการตั้งค่า ZAI_API_KEY ที่เรียบง่าย
title: "Z.AI"
---

# Z.AI

Z.AI คือแพลตฟอร์ม API สำหรับโมเดล **GLM** ให้บริการ REST API สำหรับ GLM และใช้ API key
สำหรับการยืนยันตัวตน สร้าง API key ของคุณในคอนโซล Z.AI OpenClaw ใช้ผู้ให้บริการ `zai`
พร้อมกับ Z.AI API key

## การตั้งค่าCLI

```bash
openclaw onboard --auth-choice zai-api-key
# or non-interactive
openclaw onboard --zai-api-key "$ZAI_API_KEY"
```

## Config snippet

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## หมายเหตุ

- โมเดล GLM พร้อมใช้งานในชื่อ `zai/<model>` (ตัวอย่าง: `zai/glm-4.7`)
- ดู [/providers/glm](/providers/glm) เพื่อภาพรวมของตระกูลโมเดล
- Z.AI ใช้การยืนยันตัวตนแบบ Bearer ด้วยคีย์ API ของคุณ
