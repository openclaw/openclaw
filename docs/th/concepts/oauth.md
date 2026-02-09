---
summary: "OAuth ใน OpenClaw: การแลกเปลี่ยนโทเคน การจัดเก็บ และรูปแบบหลายบัญชี"
read_when:
  - คุณต้องการเข้าใจ OAuth ของ OpenClaw แบบครบถ้วนตั้งแต่ต้นจนจบ
  - 12. คุณพบปัญหาโทเค็นถูกทำให้ใช้ไม่ได้ / ถูกล็อกเอาต์
  - คุณต้องการโฟลว์การยืนยันตัวตนแบบ setup-token หรือ OAuth
  - คุณต้องการหลายบัญชีหรือการกำหนดเส้นทางตามโปรไฟล์
title: "OAuth"
---

# OAuth

OpenClaw รองรับ “subscription auth” ผ่าน OAuth สำหรับผู้ให้บริการที่มีให้ใช้งาน (โดยเฉพาะ **OpenAI Codex (ChatGPT OAuth)**) สำหรับการสมัครสมาชิก Anthropic ให้ใช้โฟลว์ **setup-token** หน้านี้อธิบาย: 13. สำหรับการสมัคร Anthropic ให้ใช้โฟลว์ **setup-token** 14. หน้านี้อธิบาย:

- วิธีการทำงานของ **การแลกเปลี่ยนโทเคน** OAuth (PKCE)
- โทเคนถูก **จัดเก็บ** ที่ใด (และเพราะเหตุใด)
- วิธีจัดการ **หลายบัญชี** (โปรไฟล์ + การ override ต่อเซสชัน)

OpenClaw ยังรองรับ **provider plugins** ที่มาพร้อมโฟลว์ OAuth หรือ API‑key ของตนเอง รันได้ผ่าน: 15. รันผ่าน:

```bash
openclaw models auth login --provider <id>
```

## Token sink (ทำไมจึงมี)

16. ผู้ให้บริการ OAuth มักจะออก **refresh token ใหม่** ระหว่างโฟลว์การล็อกอิน/รีเฟรช ผู้ให้บริการ OAuth มักจะออก **refresh token ใหม่** ระหว่างโฟลว์การล็อกอิน/รีเฟรช ผู้ให้บริการบางราย (หรือไคลเอนต์ OAuth) อาจทำให้ refresh token เก่าถูกยกเลิกเมื่อมีการออกตัวใหม่สำหรับผู้ใช้/แอปเดียวกัน

อาการที่พบได้จริง:

- คุณล็อกอินผ่าน OpenClaw _และ_ ผ่าน Claude Code / Codex CLI → ต่อมามีอย่างใดอย่างหนึ่ง “หลุดออกจากระบบ” แบบสุ่ม

เพื่อลดปัญหานี้ OpenClaw ปฏิบัติต่อ `auth-profiles.json` เป็น **token sink**:

- รันไทม์อ่านข้อมูลรับรองจาก **ที่เดียว**
- เราสามารถเก็บหลายโปรไฟล์และกำหนดเส้นทางได้อย่างแน่นอน

## การจัดเก็บ (โทเคนอยู่ที่ไหน)

ความลับถูกจัดเก็บ **ต่อเอเจนต์**:

- โปรไฟล์การยืนยันตัวตน (OAuth + API keys): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- แคชรันไทม์ (จัดการอัตโนมัติ; อย่าแก้ไข): `~/.openclaw/agents/<agentId>/agent/auth.json`

ไฟล์แบบ legacy สำหรับนำเข้าเท่านั้น (ยังรองรับ แต่ไม่ใช่ที่เก็บหลัก):

- `~/.openclaw/credentials/oauth.json` (นำเข้าไปยัง `auth-profiles.json` เมื่อใช้งานครั้งแรก)

17. ทั้งหมดข้างต้นยังเคารพ `$OPENCLAW_STATE_DIR` ด้วย (การแทนที่ไดเรกทอรีสถานะ) ทั้งหมดข้างต้นยังรองรับ `$OPENCLAW_STATE_DIR` (การ override ไดเรกทอรีสถานะ) อ้างอิงฉบับเต็ม: [/gateway/configuration](/gateway/configuration#auth-storage-oauth--api-keys)

## Anthropic setup-token (subscription auth)

รัน `claude setup-token` บนเครื่องใดก็ได้ จากนั้นวางลงใน OpenClaw:

```bash
openclaw models auth setup-token --provider anthropic
```

หากคุณสร้างโทเคนจากที่อื่น ให้วางด้วยตนเอง:

```bash
openclaw models auth paste-token --provider anthropic
```

ตรวจสอบ:

```bash
openclaw models status
```

## OAuth exchange (การล็อกอินทำงานอย่างไร)

โฟลว์การล็อกอินแบบโต้ตอบของ OpenClaw ถูกพัฒนาใน `@mariozechner/pi-ai` และเชื่อมเข้ากับวิซาร์ด/คำสั่งต่างๆ

### Anthropic (Claude Pro/Max) setup-token

รูปแบบโฟลว์:

1. รัน `claude setup-token`
2. วางโทเคนลงใน OpenClaw
3. จัดเก็บเป็นโปรไฟล์การยืนยันตัวตนแบบโทเคน (ไม่มีการรีเฟรช)

เส้นทางในวิซาร์ดคือ `openclaw onboard` → ตัวเลือกการยืนยันตัวตน `setup-token` (Anthropic)

### OpenAI Codex (ChatGPT OAuth)

รูปแบบโฟลว์ (PKCE):

1. สร้าง PKCE verifier/challenge + `state` แบบสุ่ม
2. เปิด `https://auth.openai.com/oauth/authorize?...`
3. พยายามจับ callback ที่ `http://127.0.0.1:1455/auth/callback`
4. หาก callback จับไม่ได้ (หรือคุณเป็น remote/headless) ให้วาง URL/โค้ดที่ redirect มา
5. แลกเปลี่ยนที่ `https://auth.openai.com/oauth/token`
6. ดึง `accountId` จาก access token และจัดเก็บ `{ access, refresh, expires, accountId }`

เส้นทางในวิซาร์ดคือ `openclaw onboard` → ตัวเลือกการยืนยันตัวตน `openai-codex`.

## การรีเฟรช + การหมดอายุ

โปรไฟล์จะจัดเก็บเวลา `expires`.

ขณะรันไทม์:

- หาก `expires` ยังอยู่ในอนาคต → ใช้ access token ที่จัดเก็บไว้
- หากหมดอายุ → รีเฟรช (ภายใต้ file lock) และเขียนทับข้อมูลรับรองที่จัดเก็บไว้

โฟลว์การรีเฟรชเป็นแบบอัตโนมัติ โดยทั่วไปคุณไม่จำเป็นต้องจัดการโทเคนด้วยตนเอง

## หลายบัญชี (โปรไฟล์) + การกำหนดเส้นทาง

มีสองรูปแบบ:

### 1. แนะนำ: แยกเอเจนต์

หากต้องการให้ “ส่วนตัว” และ “งาน” ไม่ปะปนกันเลย ให้ใช้เอเจนต์แยกกัน (แยกเซสชัน + ข้อมูลรับรอง + เวิร์กสเปซ):

```bash
openclaw agents add work
openclaw agents add personal
```

จากนั้นตั้งค่าการยืนยันตัวตนต่อเอเจนต์ (ผ่านวิซาร์ด) และกำหนดเส้นทางแชตไปยังเอเจนต์ที่ถูกต้อง

### 2. ขั้นสูง: หลายโปรไฟล์ในเอเจนต์เดียว

`auth-profiles.json` รองรับหลาย ID โปรไฟล์สำหรับผู้ให้บริการเดียวกัน

เลือกว่าจะใช้โปรไฟล์ใด:

- แบบ global ผ่านการจัดลำดับคอนฟิก (`auth.order`)
- ต่อเซสชันผ่าน `/model ...@<profileId>`

ตัวอย่าง (override ต่อเซสชัน):

- `/model Opus@anthropic:work`

วิธีดูว่ามี ID โปรไฟล์ใดบ้าง:

- `openclaw channels list --json` (แสดง `auth[]`)

เอกสารที่เกี่ยวข้อง:

- [/concepts/model-failover](/concepts/model-failover) (กฎการหมุนเวียน + cooldown)
- [/tools/slash-commands](/tools/slash-commands) (พื้นผิวคำสั่ง)
