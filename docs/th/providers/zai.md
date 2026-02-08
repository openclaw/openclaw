---
summary: "ใช้ Z.AI (โมเดล GLM) กับ OpenClaw"
read_when:
  - คุณต้องการใช้โมเดล Z.AI/GLM ใน OpenClaw
  - คุณต้องการการตั้งค่า ZAI_API_KEY ที่เรียบง่าย
title: "Z.AI"
x-i18n:
  source_path: providers/zai.md
  source_hash: 2c24bbad86cf86c3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:31Z
---

# Z.AI

Z.AI เป็นแพลตฟอร์ม API สำหรับโมเดล **GLM** โดยให้บริการ REST API สำหรับ GLM และใช้คีย์ API
สำหรับการยืนยันตัวตน ให้สร้างคีย์ API ของคุณในคอนโซล Z.AI จากนั้น OpenClaw จะใช้ผู้ให้บริการ `zai`
ร่วมกับคีย์ API ของ Z.AI

## การตั้งค่าCLI

```bash
openclaw onboard --auth-choice zai-api-key
# or non-interactive
openclaw onboard --zai-api-key "$ZAI_API_KEY"
```

## ตัวอย่างคอนฟิก

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
