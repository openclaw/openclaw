---
summary: "ตำแหน่งที่OpenClawโหลดตัวแปรสภาพแวดล้อมและลำดับความสำคัญ"
read_when:
  - คุณต้องการทราบว่ามีการโหลดenv varsใดบ้างและตามลำดับใด
  - คุณกำลังแก้ไขปัญหาคีย์APIหายไปในGateway
  - คุณกำลังจัดทำเอกสารการยืนยันตัวตนของผู้ให้บริการหรือสภาพแวดล้อมการปรับใช้
title: "ตัวแปรสภาพแวดล้อม"
x-i18n:
  source_path: help/environment.md
  source_hash: b49ae50e5d306612
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:15Z
---

# ตัวแปรสภาพแวดล้อม

OpenClawดึงตัวแปรสภาพแวดล้อมจากหลายแหล่ง กฎคือ **ไม่เขียนทับค่าที่มีอยู่แล้ว** เด็ดขาด

## ลำดับความสำคัญ(สูงสุด→ต่ำสุด)

1. **สภาพแวดล้อมของโปรเซส** (สิ่งที่โปรเซสGatewayได้รับมาจากเชลล์/เดมอนแม่อยู่แล้ว)
2. **`.env` ในไดเรกทอรีทำงานปัจจุบัน** (ค่าเริ่มต้นของdotenv;ไม่เขียนทับ)
3. **`.env`แบบส่วนกลาง** ที่ `~/.openclaw/.env` (หรือที่เรียกว่า `$OPENCLAW_STATE_DIR/.env`;ไม่เขียนทับ)
4. **บล็อกคอนฟิก `env`** ใน `~/.openclaw/openclaw.json` (นำไปใช้เฉพาะเมื่อยังไม่มีค่า)
5. **การนำเข้าจากlogin-shellแบบไม่บังคับ** (`env.shellEnv.enabled` หรือ `OPENCLAW_LOAD_SHELL_ENV=1`),นำไปใช้เฉพาะคีย์ที่คาดหวังซึ่งยังขาดอยู่

หากไฟล์คอนฟิกหายไปทั้งหมด ขั้นตอนที่4จะถูกข้ามไป;การนำเข้าจากเชลล์ยังคงทำงานหากเปิดใช้งาน

## บล็อกคอนฟิก `env`

สองวิธีที่เทียบเท่ากันในการตั้งค่าenv varsแบบอินไลน์(ทั้งคู่ไม่เขียนทับค่าเดิม):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: {
      GROQ_API_KEY: "gsk-...",
    },
  },
}
```

## การนำเข้าenvจากเชลล์

`env.shellEnv`จะรันlogin shellของคุณและนำเข้าเฉพาะคีย์ที่คาดหวังซึ่ง **ยังขาดอยู่** เท่านั้น:

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

ค่าเทียบเท่าในรูปแบบenv var:

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

## การแทนที่env varในคอนฟิก

คุณสามารถอ้างอิงenv varsได้โดยตรงในค่าสตริงของคอนฟิกโดยใช้ไวยากรณ์ `${VAR_NAME}`:

```json5
{
  models: {
    providers: {
      "vercel-gateway": {
        apiKey: "${VERCEL_GATEWAY_API_KEY}",
      },
    },
  },
}
```

ดูรายละเอียดทั้งหมดได้ที่ [Configuration: Env var substitution](/gateway/configuration#env-var-substitution-in-config)

## เกี่ยวข้อง

- [Gateway configuration](/gateway/configuration)
- [FAQ: env vars and .env loading](/help/faq#env-vars-and-env-loading)
- [Models overview](/concepts/models)
