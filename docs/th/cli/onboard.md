---
summary: "เอกสารอ้างอิงCLIสำหรับ `openclaw onboard` (วิซาร์ดการเริ่มต้นใช้งานแบบโต้ตอบ)"
read_when:
  - คุณต้องการการตั้งค่าแบบมีคำแนะนำสำหรับGateway, เวิร์กสเปซ, การยืนยันตัวตน, ช่องทาง และSkills
title: "onboard"
---

# `openclaw onboard`

วิซาร์ดการเริ่มต้นใช้งานแบบโต้ตอบ(การตั้งค่าGatewayภายในเครื่องหรือระยะไกล)

## Related guides

- ศูนย์รวมการเริ่มต้นใช้งานCLI: [Onboarding Wizard (CLI)](/start/wizard)
- เอกสารอ้างอิงการเริ่มต้นใช้งานCLI: [CLI Onboarding Reference](/start/wizard-cli-reference)
- ระบบอัตโนมัติCLI: [CLI Automation](/start/wizard-cli-automation)
- การเริ่มต้นใช้งานบนmacOS: [Onboarding (macOS App)](/start/onboarding)

## Examples

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url ws://gateway-host:18789
```

Flow notes:

- `quickstart`: พรอมต์น้อยที่สุด สร้างโทเคนGatewayให้อัตโนมัติ
- `manual`: พรอมต์แบบครบถ้วนสำหรับพอร์ต/การผูก/การยืนยันตัวตน(นามแฝงของ `advanced`)
- การแชตครั้งแรกที่เร็วที่สุด: `openclaw dashboard` (Control UI ไม่ต้องตั้งค่าช่องทาง)

## Common follow-up commands

```bash
openclaw configure
openclaw agents add <name>
```

<Note>

`--json` ไม่ได้หมายถึงโหมดไม่โต้ตอบ ใช้ `--non-interactive` สำหรับสคริปต์
 ใช้ `--non-interactive` สำหรับสคริปต์
</Note>
