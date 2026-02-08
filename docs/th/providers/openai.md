---
summary: "ใช้ OpenAI ผ่านคีย์APIหรือการสมัครสมาชิกCodexในOpenClaw"
read_when:
  - คุณต้องการใช้โมเดลOpenAIในOpenClaw
  - คุณต้องการการยืนยันตัวตนด้วยการสมัครสมาชิกCodexแทนคีย์API
title: "OpenAI"
x-i18n:
  source_path: providers/openai.md
  source_hash: 6d78698351c3d2f5
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:35Z
---

# OpenAI

OpenAI มี API สำหรับนักพัฒนาสำหรับโมเดล GPT โดย Codex รองรับการ **ลงชื่อเข้าใช้ด้วย ChatGPT** สำหรับการเข้าถึงแบบสมัครสมาชิก หรือการลงชื่อเข้าใช้ด้วย **คีย์API** สำหรับการเข้าถึงแบบคิดค่าบริการตามการใช้งาน Codex cloud ต้องลงชื่อเข้าใช้ด้วย ChatGPT

## ตัวเลือก A: คีย์APIของ OpenAI (OpenAI Platform)

**เหมาะสำหรับ:** การเข้าถึง API โดยตรงและการเรียกเก็บเงินตามการใช้งาน
รับคีย์APIของคุณจากแดชบอร์ด OpenAI

### การตั้งค่าCLI

```bash
openclaw onboard --auth-choice openai-api-key
# or non-interactive
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### ตัวอย่างคอนฟิก

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

## ตัวเลือก B: การสมัครสมาชิก OpenAI Code (Codex)

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
