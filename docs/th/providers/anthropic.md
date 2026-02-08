---
summary: "ใช้ Anthropic Claude ผ่านคีย์APIหรือsetup-tokenในOpenClaw"
read_when:
  - คุณต้องการใช้โมเดลAnthropicในOpenClaw
  - คุณต้องการใช้setup-tokenแทนคีย์API
title: "Anthropic"
x-i18n:
  source_path: providers/anthropic.md
  source_hash: a0e91ae9fc5b67ba
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:43Z
---

# Anthropic (Claude)

Anthropicพัฒนาโมเดลตระกูล **Claude** และให้การเข้าถึงผ่านAPI
ในOpenClawคุณสามารถยืนยันตัวตนด้วยคีย์APIหรือ **setup-token** ได้

## ตัวเลือก A: คีย์APIของAnthropic

**เหมาะสำหรับ:** การเข้าถึงAPIมาตรฐานและการคิดค่าบริการตามการใช้งาน
สร้างคีย์APIของคุณในAnthropic Console

### การตั้งค่าCLI

```bash
openclaw onboard
# choose: Anthropic API key

# or non-interactive
openclaw onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

### ตัวอย่างคอนฟิก

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## การแคชพรอมต์ (Anthropic API)

OpenClawรองรับฟีเจอร์การแคชพรอมต์ของAnthropic ซึ่งเป็น **เฉพาะAPIเท่านั้น**; การยืนยันตัวตนแบบสมัครสมาชิกจะไม่ใช้การตั้งค่าแคช

### การกำหนดค่า

ใช้พารามิเตอร์ `cacheRetention` ในคอนฟิกโมเดลของคุณ:

| ค่า     | ระยะเวลาแคช | คำอธิบาย                                   |
| ------- | ----------- | ------------------------------------------ |
| `none`  | ไม่แคช      | ปิดการแคชพรอมต์                            |
| `short` | 5 นาที      | ค่าเริ่มต้นสำหรับการยืนยันตัวตนด้วยคีย์API |
| `long`  | 1 ชั่วโมง   | แคชแบบขยาย (ต้องใช้แฟล็กเบตา)              |

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": {
          params: { cacheRetention: "long" },
        },
      },
    },
  },
}
```

### ค่าเริ่มต้น

เมื่อใช้การยืนยันตัวตนด้วยคีย์APIของAnthropic OpenClawจะตั้งค่า `cacheRetention: "short"` (แคช 5 นาที) ให้กับโมเดลAnthropicทั้งหมดโดยอัตโนมัติ คุณสามารถเขียนทับได้โดยตั้งค่า `cacheRetention` อย่างชัดเจนในคอนฟิกของคุณ

### พารามิเตอร์แบบเดิม

พารามิเตอร์รุ่นเก่า `cacheControlTtl` ยังรองรับเพื่อความเข้ากันได้ย้อนหลัง:

- `"5m"` จับคู่กับ `short`
- `"1h"` จับคู่กับ `long`

เราแนะนำให้ย้ายไปใช้พารามิเตอร์ใหม่ `cacheRetention`

OpenClawมีแฟล็กเบตา `extended-cache-ttl-2025-04-11` สำหรับคำขอAnthropic API
ให้คงไว้หากคุณเขียนทับเฮดเดอร์ของผู้ให้บริการ (ดู [/gateway/configuration](/gateway/configuration))

## ตัวเลือก B: Claude setup-token

**เหมาะสำหรับ:** การใช้การสมัครสมาชิกClaudeของคุณ

### วิธีรับ setup-token

setup-tokenถูกสร้างโดย **Claude Code CLI** ไม่ใช่Anthropic Console คุณสามารถรันได้บน **เครื่องใดก็ได้**:

```bash
claude setup-token
```

วางโทเคนลงในOpenClaw (วิซาร์ด: **Anthropic token (วาง setup-token)**) หรือรันบนโฮสต์Gateway:

```bash
openclaw models auth setup-token --provider anthropic
```

หากคุณสร้างโทเคนบนเครื่องอื่น ให้วางโทเคน:

```bash
openclaw models auth paste-token --provider anthropic
```

### การตั้งค่าCLI (setup-token)

```bash
# Paste a setup-token during onboarding
openclaw onboard --auth-choice setup-token
```

### ตัวอย่างคอนฟิก (setup-token)

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## หมายเหตุ

- สร้าง setup-token ด้วย `claude setup-token` แล้ววาง หรือรัน `openclaw models auth setup-token` บนโฮสต์Gateway
- หากพบข้อความ “OAuth token refresh failed …” บนการสมัครสมาชิกClaude ให้ยืนยันตัวตนใหม่ด้วย setup-token ดู [/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription](/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription)
- รายละเอียดการยืนยันตัวตนและกติกาการนำกลับมาใช้ซ้ำอยู่ที่ [/concepts/oauth](/concepts/oauth)

## การแก้ไขปัญหา

**ข้อผิดพลาด401 / โทเคนกลายเป็นโมฆะกะทันหัน**

- การยืนยันตัวตนแบบสมัครสมาชิกClaudeอาจหมดอายุหรือถูกเพิกถอน ให้รัน `claude setup-token`
  แล้ววางลงใน **โฮสต์Gateway**
- หากการล็อกอินClaude CLIอยู่บนเครื่องอื่น ให้ใช้
  `openclaw models auth paste-token --provider anthropic` บนโฮสต์Gateway

**ไม่พบคีย์APIสำหรับผู้ให้บริการ "anthropic"**

- การยืนยันตัวตนเป็นแบบ **ต่อเอเจนต์** เอเจนต์ใหม่จะไม่สืบทอดคีย์ของเอเจนต์หลัก
- รันการเริ่มต้นใช้งานใหม่สำหรับเอเจนต์นั้น หรือวาง setup-token / คีย์API บน
  โฮสต์Gateway จากนั้นตรวจสอบด้วย `openclaw models status`

**ไม่พบข้อมูลรับรองสำหรับโปรไฟล์ `anthropic:default`**

- รัน `openclaw models status` เพื่อดูว่าโปรไฟล์การยืนยันตัวตนใดกำลังใช้งานอยู่
- รันการเริ่มต้นใช้งานใหม่ หรือวาง setup-token / คีย์API สำหรับโปรไฟล์นั้น

**ไม่มีโปรไฟล์การยืนยันตัวตนที่ใช้งานได้ (ทั้งหมดอยู่ในช่วงคูลดาวน์/ไม่พร้อมใช้งาน)**

- ตรวจสอบ `openclaw models status --json` สำหรับ `auth.unusableProfiles`
- เพิ่มโปรไฟล์Anthropicอื่นหรือรอให้คูลดาวน์สิ้นสุด

เพิ่มเติม: [/gateway/troubleshooting](/gateway/troubleshooting) และ [/help/faq](/help/faq)
