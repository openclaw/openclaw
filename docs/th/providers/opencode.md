---
summary: "ใช้ OpenCode Zen(โมเดลที่คัดสรร)ร่วมกับ OpenClaw"
read_when:
  - คุณต้องการใช้ OpenCode Zen เพื่อเข้าถึงโมเดล
  - คุณต้องการรายการโมเดลที่คัดสรรซึ่งเหมาะกับงานเขียนโค้ด
title: "OpenCode Zen"
---

# OpenCode Zen

OpenCode Zen คือ**รายการโมเดลที่คัดสรร**ซึ่งทีม OpenCode แนะนำสำหรับเอเจนต์เขียนโค้ด
เป็นเส้นทางการเข้าถึงโมเดลแบบโฮสต์เสริมที่ใช้คีย์APIและผู้ให้บริการ `opencode`
ขณะนี้ Zen อยู่ในสถานะเบต้า
เป็นเส้นทางการเข้าถึงโมเดลแบบโฮสต์เสริม ที่ใช้คีย์ API และผู้ให้บริการ `opencode`
Zen อยู่ในสถานะเบต้าในขณะนี้

## CLI setup

```bash
openclaw onboard --auth-choice opencode-zen
# or non-interactive
openclaw onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
```

## Config snippet

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

## Notes

- รองรับ `OPENCODE_ZEN_API_KEY` ด้วยเช่นกัน
- คุณต้องลงชื่อเข้าใช้ Zen เพิ่มรายละเอียดการเรียกเก็บเงิน และคัดลอกคีย์API ของคุณ
- OpenCode Zen คิดค่าบริการต่อคำขอ โปรดตรวจสอบรายละเอียดในแดชบอร์ด OpenCode
