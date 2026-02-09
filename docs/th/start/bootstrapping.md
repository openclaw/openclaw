---
summary: "พิธีการบูตสแตรปเอเจนต์ที่เตรียมเวิร์กสเปซและไฟล์อัตลักษณ์"
read_when:
  - ทำความเข้าใจสิ่งที่เกิดขึ้นในการรันเอเจนต์ครั้งแรก
  - อธิบายตำแหน่งที่ไฟล์บูตสแตรปถูกจัดเก็บ
  - Debugging onboarding identity setup
title: "การบูตสแตรปเอเจนต์"
sidebarTitle: "Bootstrapping"
---

# การบูตสแตรปเอเจนต์

การบูตสแตรปคือพิธีการของการรัน **ครั้งแรก** ที่เตรียมเวิร์กสเปซของเอเจนต์และรวบรวมรายละเอียดอัตลักษณ์ กระบวนการนี้จะเกิดขึ้นหลังการเริ่มต้นใช้งาน เมื่อเอเจนต์เริ่มทำงานเป็นครั้งแรก It happens after onboarding, when the agent starts
for the first time.

## การบูตสแตรปทำอะไรบ้าง

ในการรันเอเจนต์ครั้งแรก OpenClaw จะบูตสแตรปเวิร์กสเปซ (ค่าเริ่มต้นคือ
`~/.openclaw/workspace`):

- สร้างไฟล์เริ่มต้น `AGENTS.md`, `BOOTSTRAP.md`, `IDENTITY.md`, `USER.md`.
- รันพิธีถาม‑ตอบสั้นๆ(ถามทีละคำถาม)
- เขียนข้อมูลอัตลักษณ์และค่ากำหนดไปยัง `IDENTITY.md`, `USER.md`, `SOUL.md`.
- ลบ `BOOTSTRAP.md` เมื่อเสร็จสิ้น เพื่อให้รันเพียงครั้งเดียว

## รันที่ไหน

Bootstrapping always runs on the **gateway host**. การบูตสแตรปจะรันบน **gateway host** เสมอ หากแอปmacOS เชื่อมต่อกับ Gateway ระยะไกล เวิร์กสเปซและไฟล์บูตสแตรปจะอยู่บนเครื่องระยะไกลนั้น

<Note>
เมื่อ Gateway รันอยู่บนเครื่องอื่น ให้แก้ไขไฟล์เวิร์กสเปซบนโฮสต์Gateway (เช่น `user@gateway-host:~/.openclaw/workspace`).
</Note>

## เอกสารที่เกี่ยวข้อง

- การเริ่มต้นใช้งานแอปmacOS: [Onboarding](/start/onboarding)
- โครงสร้างเวิร์กสเปซ: [Agent workspace](/concepts/agent-workspace)
