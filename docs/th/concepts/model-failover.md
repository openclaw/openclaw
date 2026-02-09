---
summary: "วิธีที่ OpenClaw หมุนเวียนโปรไฟล์การยืนยันตัวตนและสลับไปใช้โมเดลสำรอง"
read_when:
  - การวินิจฉัยการหมุนเวียนโปรไฟล์การยืนยันตัวตน ช่วงคูลดาวน์ หรือพฤติกรรมการสลับโมเดลสำรอง
  - การอัปเดตกฎการสลับเมื่อเกิดความล้มเหลวสำหรับโปรไฟล์การยืนยันตัวตนหรือโมเดล
title: "Model Failover"
---

# การสลับโมเดลเมื่อเกิดความล้มเหลว

OpenClaw จัดการความล้มเหลวเป็นสองขั้นตอน:

1. **การหมุนเวียนโปรไฟล์การยืนยันตัวตน** ภายในผู้ให้บริการปัจจุบัน
2. **การสลับโมเดลสำรอง** ไปยังโมเดลถัดไปใน `agents.defaults.model.fallbacks`

เอกสารนี้อธิบายกฎการทำงานขณะรันไทม์และข้อมูลที่ใช้รองรับกฎเหล่านั้น

## การจัดเก็บการยืนยันตัวตน (คีย์ + OAuth)

OpenClaw ใช้ **โปรไฟล์การยืนยันตัวตน** สำหรับทั้งคีย์APIและโทเคนOAuth

- ความลับถูกเก็บไว้ใน `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (เดิม: `~/.openclaw/agent/auth-profiles.json`)
- คอนฟิก `auth.profiles` / `auth.order` เป็น **เมทาดาทา + การกำหนดเส้นทางเท่านั้น** (ไม่มีความลับ)
- ไฟล์OAuthแบบเดิมที่ใช้สำหรับนำเข้าเท่านั้น: `~/.openclaw/credentials/oauth.json` (นำเข้าไปยัง `auth-profiles.json` เมื่อใช้งานครั้งแรก)

รายละเอียดเพิ่มเติม: [/concepts/oauth](/concepts/oauth)

ประเภทข้อมูลรับรอง:

- `type: "api_key"` → `{ provider, key }`
- `type: "oauth"` → `{ provider, access, refresh, expires, email? }` (+ `projectId`/`enterpriseUrl` สำหรับผู้ให้บริการบางราย)

## รหัสโปรไฟล์

การล็อกอินด้วยOAuthจะสร้างโปรไฟล์แยกกันเพื่อให้หลายบัญชีอยู่ร่วมกันได้

- ค่าเริ่มต้น: `provider:default` เมื่อไม่มีอีเมล
- OAuthพร้อมอีเมล: `provider:<email>` (ตัวอย่างเช่น `google-antigravity:user@gmail.com`)

โปรไฟล์ถูกเก็บไว้ใน `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` ภายใต้ `profiles`

## ลำดับการหมุนเวียน

เมื่อผู้ให้บริการมีหลายโปรไฟล์ OpenClaw จะเลือกลำดับดังนี้:

1. **คอนฟิกที่ระบุชัดเจน**: `auth.order[provider]` (หากตั้งค่าไว้)
2. **โปรไฟล์ที่ตั้งค่าไว้**: `auth.profiles` ที่กรองตามผู้ให้บริการ
3. **โปรไฟล์ที่จัดเก็บไว้**: รายการใน `auth-profiles.json` สำหรับผู้ให้บริการนั้น

หากไม่ได้ตั้งค่าลำดับแบบชัดเจน OpenClaw จะใช้ลำดับแบบรอบ‑โรบิน:

- **คีย์หลัก:** ประเภทโปรไฟล์ (**OAuthก่อนคีย์API**)
- **คีย์รอง:** `usageStats.lastUsed` (เก่าที่สุดก่อน ภายในแต่ละประเภท)
- **โปรไฟล์ที่อยู่ในคูลดาวน์/ถูกปิดใช้งาน** จะถูกย้ายไปท้ายสุด โดยเรียงตามเวลาหมดอายุที่ใกล้ที่สุด

### การยึดโปรไฟล์ตามเซสชัน (เป็นมิตรกับแคช)

OpenClaw **ยึดโปรไฟล์การยืนยันตัวตนที่เลือกไว้ต่อหนึ่งเซสชัน** เพื่อให้แคชของผู้ให้บริการยังอุ่นอยู่
โดยจะ **ไม่** หมุนเวียนทุกคำขอ โปรไฟล์ที่ยึดไว้จะถูกใช้ซ้ำจนกว่า:
It does **not** rotate on every request. The pinned profile is reused until:

- เซสชันถูกรีเซ็ต (`/new` / `/reset`)
- การคอมแพกชันเสร็จสิ้น (ตัวนับการคอมแพกชันเพิ่มขึ้น)
- โปรไฟล์เข้าสู่คูลดาวน์/ถูกปิดใช้งาน

การเลือกด้วยตนเองผ่าน `/model …@<profileId>` จะตั้งค่า **การแทนที่โดยผู้ใช้** สำหรับเซสชันนั้น
และจะไม่หมุนเวียนอัตโนมัติจนกว่าจะเริ่มเซสชันใหม่

โปรไฟล์ที่ถูกยึดอัตโนมัติ (เลือกโดยตัวกำหนดเส้นทางของเซสชัน) จะถือเป็น **ความชอบ**:
จะถูกลองก่อน แต่ OpenClaw อาจหมุนไปยังโปรไฟล์อื่นเมื่อเจอการจำกัดอัตราหรือหมดเวลา
โปรไฟล์ที่ผู้ใช้ยึดไว้จะล็อกอยู่กับโปรไฟล์นั้น หากล้มเหลวและมีการตั้งค่าการสลับโมเดล
OpenClaw จะไปยังโมเดลถัดไปแทนการสลับโปรไฟล์
User‑pinned profiles stay locked to that profile; if it fails and model fallbacks
are configured, OpenClaw moves to the next model instead of switching profiles.

### เหตุใดOAuthจึงอาจ “เหมือนหายไป”

หากคุณมีทั้งโปรไฟล์OAuthและโปรไฟล์คีย์APIสำหรับผู้ให้บริการเดียวกัน รอบ‑โรบินอาจสลับไปมาระหว่างกันข้ามข้อความได้หากไม่ได้ยึดไว้ เพื่อบังคับใช้โปรไฟล์เดียว: To force a single profile:

- ยึดด้วย `auth.order[provider] = ["provider:profileId"]` หรือ
- ใช้การแทนที่ต่อเซสชันผ่าน `/model …` พร้อมการแทนที่โปรไฟล์ (เมื่อ UI/พื้นผิวแชทของคุณรองรับ)

## Cooldowns

เมื่อโปรไฟล์ล้มเหลวจากข้อผิดพลาดด้านการยืนยันตัวตน/การจำกัดอัตรา (หรือหมดเวลาที่ดูเหมือนการจำกัดอัตรา)
OpenClaw จะทำเครื่องหมายว่าอยู่ในคูลดาวน์และย้ายไปยังโปรไฟล์ถัดไป
ข้อผิดพลาดด้านรูปแบบ/คำขอไม่ถูกต้อง (เช่น ความล้มเหลวในการตรวจสอบ ID การเรียกเครื่องมือ Cloud Code Assist)
จะถือว่าเข้าข่ายสลับเมื่อเกิดความล้มเหลวและใช้คูลดาวน์เดียวกัน
Format/invalid‑request errors (for example Cloud Code Assist tool call ID
validation failures) are treated as failover‑worthy and use the same cooldowns.

Cooldowns use exponential backoff:

- 1 นาที
- 5 นาที
- 25 นาที
- 1 ชั่วโมง (เพดาน)

สถานะถูกเก็บไว้ใน `auth-profiles.json` ภายใต้ `usageStats`:

```json
{
  "usageStats": {
    "provider:profile": {
      "lastUsed": 1736160000000,
      "cooldownUntil": 1736160600000,
      "errorCount": 2
    }
  }
}
```

## การปิดใช้งานจากการเรียกเก็บเงิน

Billing/credit failures (for example “insufficient credits” / “credit balance too low”) are treated as failover‑worthy, but they’re usually not transient. ความล้มเหลวด้านการเรียกเก็บเงิน/เครดิต (เช่น “เครดิตไม่เพียงพอ” / “ยอดเครดิตต่ำเกินไป”) จะถือว่าเข้าข่ายสลับเมื่อเกิดความล้มเหลว แต่โดยทั่วไปไม่ใช่ปัญหาชั่วคราว แทนที่จะใช้คูลดาวน์สั้น ๆ OpenClaw จะทำเครื่องหมายโปรไฟล์ว่า **ปิดใช้งาน** (พร้อมแบ็กออฟที่ยาวกว่า) และหมุนไปยังโปรไฟล์/ผู้ให้บริการถัดไป

สถานะถูกเก็บไว้ใน `auth-profiles.json`:

```json
{
  "usageStats": {
    "provider:profile": {
      "disabledUntil": 1736178000000,
      "disabledReason": "billing"
    }
  }
}
```

ค่าเริ่มต้น:

- แบ็กออฟด้านการเรียกเก็บเงินเริ่มที่ **5 ชั่วโมง** เพิ่มเป็นสองเท่าต่อความล้มเหลวด้านการเรียกเก็บเงิน และจำกัดที่ **24 ชั่วโมง**
- ตัวนับแบ็กออฟจะรีเซ็ตหากโปรไฟล์ไม่ล้มเหลวเป็นเวลา **24 ชั่วโมง** (ปรับค่าได้)

## การสลับโมเดลสำรอง

หากโปรไฟล์ทั้งหมดของผู้ให้บริการล้มเหลว OpenClaw จะไปยังโมเดลถัดไปใน
`agents.defaults.model.fallbacks` ซึ่งใช้กับความล้มเหลวด้านการยืนยันตัวตน การจำกัดอัตรา และ
การหมดเวลาที่ใช้การหมุนเวียนโปรไฟล์จนหมด (ข้อผิดพลาดอื่นจะไม่ทำให้สลับต่อ) This applies to auth failures, rate limits, and
timeouts that exhausted profile rotation (other errors do not advance fallback).

เมื่อเริ่มรันด้วยการแทนที่โมเดล (hooks หรือ CLI) การสลับสำรองจะยังสิ้นสุดที่
`agents.defaults.model.primary` หลังจากลองสำรองที่ตั้งค่าไว้แล้ว

## คอนฟิกที่เกี่ยวข้อง

ดู [Gateway configuration](/gateway/configuration) สำหรับ:

- `auth.profiles` / `auth.order`
- `auth.cooldowns.billingBackoffHours` / `auth.cooldowns.billingBackoffHoursByProvider`
- `auth.cooldowns.billingMaxHours` / `auth.cooldowns.failureWindowHours`
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`
- การกำหนดเส้นทาง `agents.defaults.imageModel`

ดู [Models](/concepts/models) สำหรับภาพรวมการเลือกโมเดลและการสลับสำรองในวงกว้าง
