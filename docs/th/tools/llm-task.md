---
summary: "งาน LLM แบบเฉพาะ JSON สำหรับเวิร์กโฟลว์(เครื่องมือปลั๊กอินเสริม)"
read_when:
  - คุณต้องการขั้นตอน LLM แบบเฉพาะ JSON ภายในเวิร์กโฟลว์
  - คุณต้องการเอาต์พุต LLM ที่ตรวจสอบด้วยสคีมาสำหรับงานอัตโนมัติ
title: "งาน LLM"
---

# งาน LLM

`llm-task` เป็น **เครื่องมือปลั๊กอินเสริม** ที่รันงาน LLM แบบเฉพาะ JSON และ
ส่งคืนเอาต์พุตแบบมีโครงสร้าง(สามารถตรวจสอบกับ JSON Schema ได้ตามตัวเลือก)

เหมาะอย่างยิ่งสำหรับเอนจินเวิร์กโฟลว์อย่าง Lobster: คุณสามารถเพิ่มขั้นตอน LLM เพียงขั้นตอนเดียว
โดยไม่ต้องเขียนโค้ด OpenClaw แบบกำหนดเองสำหรับแต่ละเวิร์กโฟลว์

## เปิดใช้งานปลั๊กอิน

1. เปิดใช้งานปลั๊กอิน:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  }
}
```

2. เพิ่มเครื่องมือลงใน allowlist (เครื่องมือนี้ลงทะเบียนด้วย `optional: true`):

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "allow": ["llm-task"] }
      }
    ]
  }
}
```

## คอนฟิก(ไม่บังคับ)

```json
{
  "plugins": {
    "entries": {
      "llm-task": {
        "enabled": true,
        "config": {
          "defaultProvider": "openai-codex",
          "defaultModel": "gpt-5.2",
          "defaultAuthProfileId": "main",
          "allowedModels": ["openai-codex/gpt-5.3-codex"],
          "maxTokens": 800,
          "timeoutMs": 30000
        }
      }
    }
  }
}
```

`allowedModels` is an allowlist of `provider/model` strings. `allowedModels` เป็น allowlist ของสตริง `provider/model` หากตั้งค่าไว้ คำขอใดๆ
ที่อยู่นอกเหนือรายการจะถูกปฏิเสธ

## พารามิเตอร์ของเครื่องมือ

- `prompt` (สตริง, จำเป็น)
- `input` (ใดๆ, ไม่บังคับ)
- `schema` (อ็อบเจ็กต์, JSON Schema ไม่บังคับ)
- `provider` (สตริง, ไม่บังคับ)
- `model` (สตริง, ไม่บังคับ)
- `authProfileId` (สตริง, ไม่บังคับ)
- `temperature` (ตัวเลข, ไม่บังคับ)
- `maxTokens` (ตัวเลข, ไม่บังคับ)
- `timeoutMs` (ตัวเลข, ไม่บังคับ)

## เอาต์พุต

ส่งคืน `details.json` ที่มี JSON ที่แยกวิเคราะห์แล้ว(และตรวจสอบกับ
`schema` เมื่อมีการระบุ)

## ตัวอย่าง: ขั้นตอนเวิร์กโฟลว์ของ Lobster

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "input": {
    "subject": "Hello",
    "body": "Can you help?"
  },
  "schema": {
    "type": "object",
    "properties": {
      "intent": { "type": "string" },
      "draft": { "type": "string" }
    },
    "required": ["intent", "draft"],
    "additionalProperties": false
  }
}'
```

## หมายเหตุด้านความปลอดภัย

- เครื่องมือนี้เป็นแบบ **เฉพาะ JSON** และสั่งให้โมเดลส่งออกเฉพาะ JSON เท่านั้น(ไม่มี
  code fence และไม่มีคำอธิบายเพิ่มเติม)
- ไม่มีเครื่องมือใดถูกเปิดเผยให้โมเดลสำหรับการรันครั้งนี้
- ควรถือว่าเอาต์พุตไม่น่าเชื่อถือเว้นแต่คุณจะตรวจสอบด้วย `schema`
- วางขั้นตอนการอนุมัติก่อนขั้นตอนใดๆ ที่มีผลข้างเคียง(ส่ง, โพสต์, exec)
