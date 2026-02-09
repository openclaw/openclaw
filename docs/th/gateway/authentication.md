---
summary: "การยืนยันตัวตนของโมเดล: OAuth, คีย์API และ setup-token"
read_when:
  - การดีบักการยืนยันตัวตนของโมเดลหรือการหมดอายุ OAuth
  - การจัดทำเอกสารเกี่ยวกับการยืนยันตัวตนหรือการจัดเก็บข้อมูลรับรอง
title: "การยืนยันตัวตน"
---

# การยืนยันตัวตน

OpenClaw รองรับ OAuth และคีย์API สำหรับผู้ให้บริการโมเดล สำหรับบัญชี Anthropic เราแนะนำให้ใช้ **คีย์API** สำหรับการเข้าถึงการสมัครสมาชิก Claude ให้ใช้โทเคนแบบอายุยาวที่สร้างโดย `claude setup-token`. For Anthropic
accounts, we recommend using an **API key**. For Claude subscription access,
use the long‑lived token created by `claude setup-token`.

ดู [/concepts/oauth](/concepts/oauth) สำหรับโฟลว์ OAuth แบบเต็มและผังการจัดเก็บข้อมูล

## การตั้งค่า Anthropic ที่แนะนำ (คีย์API)

หากคุณใช้ Anthropic โดยตรง ให้ใช้คีย์API

1. สร้างคีย์API ใน Anthropic Console
2. ใส่คีย์ไว้บน **Gateway（เกตเวย์） host** (เครื่องที่รัน `openclaw gateway`)

```bash
export ANTHROPIC_API_KEY="..."
openclaw models status
```

3. หาก Gateway รันภายใต้ systemd/launchd แนะนำให้ใส่คีย์ไว้ใน
   `~/.openclaw/.env` เพื่อให้ดีมอนอ่านได้:

```bash
cat >> ~/.openclaw/.env <<'EOF'
ANTHROPIC_API_KEY=...
EOF
```

จากนั้นรีสตาร์ตดีมอน (หรือรีสตาร์ตโปรเซส Gateway ของคุณ) แล้วตรวจสอบอีกครั้ง:

```bash
openclaw models status
openclaw doctor
```

หากคุณไม่ต้องการจัดการตัวแปรสภาพแวดล้อมด้วยตนเอง ตัวช่วยเริ่มต้นสามารถจัดเก็บคีย์API สำหรับการใช้งานของดีมอนได้: `openclaw onboard`.

ดู [Help](/help) สำหรับรายละเอียดเกี่ยวกับการสืบทอด env (`env.shellEnv`,
`~/.openclaw/.env`, systemd/launchd)

## Anthropic: setup-token (การยืนยันตัวตนแบบสมัครสมาชิก)

For Anthropic, the recommended path is an **API key**. If you’re using a Claude
subscription, the setup-token flow is also supported. Run it on the **gateway host**:

```bash
claude setup-token
```

จากนั้นวางลงใน OpenClaw:

```bash
openclaw models auth setup-token --provider anthropic
```

หากโทเคนถูกสร้างบนเครื่องอื่น ให้วางด้วยตนเอง:

```bash
openclaw models auth paste-token --provider anthropic
```

หากคุณเห็นข้อผิดพลาดของ Anthropic เช่น:

```
This credential is only authorized for use with Claude Code and cannot be used for other API requests.
```

…ให้ใช้คีย์API ของ Anthropic แทน

การป้อนโทเคนด้วยตนเอง (ผู้ให้บริการใดก็ได้; เขียน `auth-profiles.json` + อัปเดตคอนฟิก):

```bash
openclaw models auth paste-token --provider anthropic
openclaw models auth paste-token --provider openrouter
```

การตรวจสอบที่เหมาะกับงานอัตโนมัติ (ออกด้วย `1` เมื่อหมดอายุ/หายไป, `2` เมื่อใกล้หมดอายุ):

```bash
openclaw models status --check
```

สคริปต์ปฏิบัติการเสริม (systemd/Termux) มีเอกสารที่นี่:
[/automation/auth-monitoring](/automation/auth-monitoring)

> `claude setup-token` ต้องใช้ TTY แบบโต้ตอบ

## การตรวจสอบสถานะการยืนยันตัวตนของโมเดล

```bash
openclaw models status
openclaw doctor
```

## การควบคุมว่าจะใช้ข้อมูลรับรองใด

### ต่อเซสชัน (คำสั่งแชต)

ใช้ `/model <alias-or-id>@<profileId>` เพื่อปักหมุดข้อมูลรับรองของผู้ให้บริการเฉพาะสำหรับเซสชันปัจจุบัน (ตัวอย่างรหัสโปรไฟล์: `anthropic:default`, `anthropic:work`)

ใช้ `/model` (หรือ `/model list`) สำหรับตัวเลือกแบบย่อ; ใช้ `/model status` สำหรับมุมมองแบบเต็ม (ผู้สมัคร + โปรไฟล์การยืนยันตัวตนถัดไป พร้อมรายละเอียดเอนด์พอยต์ของผู้ให้บริการเมื่อมีการกำหนดค่า)

### ต่อเอเจนต์ (การ override ผ่าน CLI)

ตั้งค่าลำดับโปรไฟล์การยืนยันตัวตนแบบระบุชัดสำหรับเอเจนต์ (จัดเก็บใน `auth-profiles.json` ของเอเจนต์นั้น):

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

ใช้ `--agent <id>` เพื่อกำหนดเป้าหมายเอเจนต์เฉพาะ; หากละเว้น จะใช้เอเจนต์เริ่มต้นที่กำหนดค่าไว้

## การแก้ไขปัญหา

### “ไม่พบข้อมูลรับรอง”

หากโปรไฟล์โทเคนของ Anthropic หายไป ให้รัน `claude setup-token` บน
**Gateway（เกตเวย์） host** จากนั้นตรวจสอบอีกครั้ง:

```bash
openclaw models status
```

### Token expiring/expired

รัน `openclaw models status` เพื่อยืนยันว่าโปรไฟล์ใดกำลังหมดอายุ หากโปรไฟล์หายไป ให้รัน `claude setup-token` อีกครั้งและวางโทเคนใหม่ If the profile
is missing, rerun `claude setup-token` and paste the token again.

## ข้อกำหนด

- การสมัครสมาชิก Claude Max หรือ Pro (สำหรับ `claude setup-token`)
- ติดตั้ง Claude Code CLI แล้ว (มีคำสั่ง `claude` ให้ใช้งาน)
