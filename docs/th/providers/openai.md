---
summary: "ใช้ OpenAI ผ่านคีย์APIหรือการสมัครสมาชิกCodexในOpenClaw"
read_when:
  - คุณต้องการใช้โมเดลOpenAIในOpenClaw
  - คุณต้องการการยืนยันตัวตนด้วยการสมัครสมาชิกCodexแทนคีย์API
title: "OpenAI"
---

# OpenAI

OpenAI ให้บริการ API สำหรับนักพัฒนาสำหรับโมเดล GPT Codex รองรับ **การเข้าสู่ระบบด้วย ChatGPT** สำหรับการเข้าถึงตามการสมัครสมาชิก หรือ **คีย์ API** สำหรับการเข้าถึงแบบคิดค่าบริการตามการใช้งาน Codex cloud requires ChatGPT sign-in.

## ตัวเลือก A: คีย์APIของ OpenAI (OpenAI Platform)

**เหมาะสำหรับ:** การเข้าถึง API โดยตรงและการเรียกเก็บเงินตามการใช้งาน
รับคีย์APIของคุณจากแดชบอร์ด OpenAI
รับคีย์ API ของคุณจากแดชบอร์ด OpenAI

### การตั้งค่าCLI

```bash
openclaw onboard --auth-choice openai-api-key
# or non-interactive
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### Config snippet

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

## ตัวเลือก B: การสมัครสมาชิก OpenAI Code (Codex)

**เหมาะที่สุดสำหรับ:** การใช้สิทธิ์การเข้าถึงแบบสมัครสมาชิก ChatGPT/Codex แทนการใช้คีย์ API
**เหมาะสำหรับ:** การใช้สิทธิ์การเข้าถึงแบบสมัครสมาชิก ChatGPT/Codex แทนคีย์API
Codex cloud ต้องลงชื่อเข้าใช้ด้วย ChatGPT ขณะที่ Codex CLI รองรับการลงชื่อเข้าใช้ด้วย ChatGPT หรือคีย์API

### การตั้งค่าCLI (Codex OAuth)

```bash
# Run Codex OAuth in the wizard
openclaw onboard --auth-choice openai-codex

# Or run OAuth directly
openclaw models auth login --provider openai-codex
```

### ตัวอย่างคอนฟิก (การสมัครสมาชิกCodex)

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

## หมายเหตุ

- การอ้างอิงโมเดลจะใช้ `provider/model` เสมอ (ดูที่ [/concepts/models](/concepts/models)).
- รายละเอียดการยืนยันตัวตนและกฎการนำกลับมาใช้ซ้ำอยู่ที่ [/concepts/oauth](/concepts/oauth).
