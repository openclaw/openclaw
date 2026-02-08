---
summary: "ภาพรวมตระกูลโมเดลGLM+วิธีใช้งานในOpenClaw"
read_when:
  - คุณต้องการใช้โมเดลGLMในOpenClaw
  - คุณต้องการทราบรูปแบบการตั้งชื่อโมเดลและการตั้งค่า
title: "โมเดลGLM"
x-i18n:
  source_path: providers/glm.md
  source_hash: 2d7b457f033f26f2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:26Z
---

# โมเดลGLM

GLMเป็น**ตระกูลโมเดล**(ไม่ใช่บริษัท)ที่ให้ใช้งานผ่านแพลตฟอร์มZ.AI ในOpenClaw โมเดลGLM
จะถูกเข้าถึงผ่านผู้ให้บริการ `zai` และใช้IDโมเดลเช่น `zai/glm-4.7`.

## การตั้งค่าCLI

```bash
openclaw onboard --auth-choice zai-api-key
```

## ตัวอย่างคอนฟิก

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## หมายเหตุ

- เวอร์ชันและความพร้อมใช้งานของGLMอาจมีการเปลี่ยนแปลง โปรดตรวจสอบเอกสารของZ.AIเพื่อข้อมูลล่าสุด
- ตัวอย่างIDโมเดลได้แก่ `glm-4.7` และ `glm-4.6`.
- สำหรับรายละเอียดผู้ให้บริการ ดูที่ [/providers/zai](/providers/zai).
