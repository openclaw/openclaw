---
summary: "เอกสารอ้างอิงCLIสำหรับ `openclaw skills` (list/info/check) และคุณสมบัติความพร้อมของสกิล"
read_when:
  - คุณต้องการดูว่าสกิลใดบ้างที่มีให้ใช้งานและพร้อมรัน
  - คุณต้องการดีบักไบนารี/ตัวแปรสภาพแวดล้อม/คอนฟิกที่ขาดหายไปสำหรับสกิล
title: "skills"
x-i18n:
  source_path: cli/skills.md
  source_hash: 7878442c88a27ec8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:55Z
---

# `openclaw skills`

ตรวจสอบสกิล (แบบบันเดิล + เวิร์กสเปซ + การโอเวอร์ไรด์ที่จัดการ) และดูว่าสกิลใดพร้อมใช้งานเทียบกับข้อกำหนดที่ยังขาดอยู่

เกี่ยวข้อง:

- ระบบSkills: [Skills](/tools/skills)
- คอนฟิกSkills: [Skills config](/tools/skills-config)
- การติดตั้งClawHub: [ClawHub](/tools/clawhub)

## คำสั่ง

```bash
openclaw skills list
openclaw skills list --eligible
openclaw skills info <name>
openclaw skills check
```
