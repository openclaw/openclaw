---
summary: "UIการตั้งค่าSkillsบนmacOSและสถานะที่ขับเคลื่อนโดยGateway"
read_when:
  - การอัปเดตUIการตั้งค่าSkillsบนmacOS
  - การเปลี่ยนการควบคุมการเข้าถึงSkillsหรือพฤติกรรมการติดตั้ง
title: "Skills"
---

# Skills (macOS)

แอปmacOSแสดงOpenClaw Skillsผ่านGatewayโดยไม่ได้ทำการพาร์สSkillsในเครื่อง

## แหล่งข้อมูล

- `skills.status` (Gateway) ส่งคืนSkillsทั้งหมดพร้อมสถานะความสามารถใช้งานและข้อกำหนดที่ขาดหาย
  (รวมถึงการบล็อกด้วยรายการอนุญาตสำหรับSkillsที่มาพร้อมแพ็กเกจ)
- ข้อกำหนดได้มาจาก `metadata.openclaw.requires` ในแต่ละ `SKILL.md`.

## การดำเนินการติดตั้ง

- `metadata.openclaw.install` กำหนดตัวเลือกการติดตั้ง (brew/node/go/uv)
- แอปเรียก `skills.install` เพื่อรันตัวติดตั้งบนโฮสต์Gateway
- Gatewayจะแสดงตัวติดตั้งที่แนะนำเพียงรายการเดียวเมื่อมีหลายตัวเลือก
  (ใช้brewเมื่อมีให้ใช้ มิฉะนั้นใช้ตัวจัดการnodeจาก `skills.install` ค่าเริ่มต้นคือnpm)

## Env/API keys

- แอปจัดเก็บคีย์ไว้ใน `~/.openclaw/openclaw.json` ภายใต้ `skills.entries.<skillKey>`
- `skills.update` ทำการแพตช์ `enabled`, `apiKey` และ `env`

## โหมดระยะไกล

- การติดตั้งและการอัปเดตคอนฟิกจะเกิดขึ้นบนโฮสต์Gateway (ไม่ใช่บนMacภายในเครื่อง)
