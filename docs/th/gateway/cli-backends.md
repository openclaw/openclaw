---
summary: "แบ็กเอนด์CLI: ทางสำรองแบบข้อความล้วนผ่านCLIของAIในเครื่อง"
read_when:
  - คุณต้องการทางสำรองที่เชื่อถือได้เมื่อผู้ให้บริการAPIล้มเหลว
  - คุณกำลังใช้งานClaude Code CLIหรือCLIของAIในเครื่องอื่นๆและต้องการนำมาใช้ซ้ำ
  - คุณต้องการเส้นทางแบบข้อความล้วนที่ไม่ใช้เครื่องมือแต่ยังรองรับเซสชันและรูปภาพ
title: "แบ็กเอนด์CLI"
---

# แบ็กเอนด์CLI(รันไทม์สำรอง)

OpenClawสามารถรัน**CLIของAIในเครื่อง**เป็น**ทางสำรองแบบข้อความล้วน**เมื่อผู้ให้บริการAPIล่ม
ถูกจำกัดอัตรา หรือทำงานผิดพลาดชั่วคราว แนวทางนี้ตั้งใจให้保守เป็นพิเศษ: This is intentionally conservative:

- **ปิดการใช้งานเครื่องมือ**(ไม่มีการเรียกเครื่องมือ)
- **ข้อความเข้า→ข้อความออก**(เชื่อถือได้)
- **รองรับเซสชัน**(เพื่อให้การสนทนาต่อเนื่องสอดคล้องกัน)
- **สามารถส่งผ่านรูปภาพได้**หากCLIยอมรับพาธของรูปภาพ

This is designed as a **safety net** rather than a primary path. ออกแบบมาเป็น**ตาข่ายนิรภัย**มากกว่าเส้นทางหลัก ใช้เมื่อคุณต้องการคำตอบแบบข้อความที่
“ใช้งานได้เสมอ”โดยไม่ต้องพึ่งพาAPIภายนอก

## เริ่มต้นอย่างรวดเร็วสำหรับผู้เริ่มต้น

คุณสามารถใช้Claude Code CLIได้**โดยไม่ต้องตั้งค่าใดๆ**(OpenClawมีค่าเริ่มต้นในตัว):

```bash
openclaw agent --message "hi" --model claude-cli/opus-4.6
```

Codex CLIก็ใช้งานได้ทันทีเช่นกัน:

```bash
openclaw agent --message "hi" --model codex-cli/gpt-5.3-codex
```

หากGatewayของคุณรันภายใต้launchd/systemdและPATHมีน้อย ให้เพิ่มเพียง
พาธของคำสั่ง:

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
      },
    },
  },
}
```

That’s it. เพียงเท่านี้ ไม่ต้องใช้คีย์ และไม่ต้องตั้งค่าการยืนยันตัวตนเพิ่มเติมนอกเหนือจากตัวCLIเอง

## การใช้เป็นทางสำรอง

เพิ่มแบ็กเอนด์CLIลงในรายการทางสำรองเพื่อให้ทำงานเฉพาะเมื่อโมเดลหลักล้มเหลว:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["claude-cli/opus-4.6", "claude-cli/opus-4.5"],
      },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "claude-cli/opus-4.6": {},
        "claude-cli/opus-4.5": {},
      },
    },
  },
}
```

หมายเหตุ:

- หากคุณใช้`agents.defaults.models`(allowlist)คุณต้องรวม`claude-cli/...`ด้วย
- หากผู้ให้บริการหลักล้มเหลว(การยืนยันตัวตน ข้อจำกัดอัตรา ไทม์เอาต์)OpenClawจะ
  ลองใช้แบ็กเอนด์CLIถัดไป

## ภาพรวมการกำหนดค่า

แบ็กเอนด์CLIทั้งหมดอยู่ภายใต้:

```
agents.defaults.cliBackends
```

แต่ละรายการใช้คีย์เป็น**provider id**(เช่น`claude-cli`,`my-cli`)
provider idจะกลายเป็นฝั่งซ้ายของการอ้างอิงโมเดลของคุณ:
The provider id becomes the left side of your model ref:

```
<provider>/<model>
```

### ตัวอย่างการกำหนดค่า

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
        "my-cli": {
          command: "my-cli",
          args: ["--json"],
          output: "json",
          input: "arg",
          modelArg: "--model",
          modelAliases: {
            "claude-opus-4-6": "opus",
            "claude-opus-4-5": "opus",
            "claude-sonnet-4-5": "sonnet",
          },
          sessionArg: "--session",
          sessionMode: "existing",
          sessionIdFields: ["session_id", "conversation_id"],
          systemPromptArg: "--system",
          systemPromptWhen: "first",
          imageArg: "--image",
          imageMode: "repeat",
          serialize: true,
        },
      },
    },
  },
}
```

## ทำงานอย่างไร

1. **เลือกแบ็กเอนด์**ตามคำนำหน้าprovider(`claude-cli/...`)
2. **สร้างsystem prompt**โดยใช้พรอมป์ของOpenClawเดียวกัน+บริบทเวิร์กสเปซ
3. **รันCLI**พร้อมsession id(ถ้ารองรับ)เพื่อให้ประวัติคงความสอดคล้อง
4. **แยกผลลัพธ์**(JSONหรือข้อความล้วน)และส่งคืนข้อความสุดท้าย
5. **บันทึกsession id**แยกตามแบ็กเอนด์เพื่อให้การติดตามผลใช้เซสชันCLIเดิม

## เซสชัน

- หากCLIรองรับเซสชัน ให้ตั้งค่า`sessionArg`(เช่น`--session-id`)หรือ
  `sessionArgs`(ตัวยึดตำแหน่ง`{sessionId}`)เมื่อจำเป็นต้องแทรกIDลงในหลายแฟลก
- หากCLIใช้**คำสั่งย่อยสำหรับresume**ที่มีแฟลกต่างกัน ให้ตั้งค่า
  `resumeArgs`(แทนที่`args`เมื่อresume)และเลือกตั้งค่า`resumeOutput`
  (สำหรับการresumeที่ไม่ใช่JSON)
- `sessionMode`:
  - `always`: ส่งsession idเสมอ(สร้างUUIDใหม่หากยังไม่ถูกเก็บ)
  - `existing`: ส่งsession idเฉพาะเมื่อมีการเก็บไว้ก่อนหน้า
  - `none`: ไม่ส่งsession idเลย

## รูปภาพ(ส่งผ่าน)

หากCLIของคุณยอมรับพาธของรูปภาพ ให้ตั้งค่า`imageArg`:

```json5
imageArg: "--image",
imageMode: "repeat"
```

OpenClaw will write base64 images to temp files. If `imageArg` is set, those
paths are passed as CLI args. OpenClawจะเขียนรูปภาพแบบbase64ลงไฟล์ชั่วคราว หากตั้งค่า`imageArg`
พาธเหล่านั้นจะถูกส่งเป็นอาร์กิวเมนต์ให้CLI หากไม่มี`imageArg` OpenClawจะต่อท้าย
พาธไฟล์ลงในพรอมป์(การฉีดพาธ)ซึ่งเพียงพอสำหรับCLIที่โหลดไฟล์ในเครื่องอัตโนมัติจากพาธธรรมดา
(พฤติกรรมของClaude Code CLI)

## อินพุต/เอาต์พุต

- `output: "json"`(ค่าเริ่มต้น)พยายามแยกJSONและดึงข้อความ+session id
- `output: "jsonl"`แยกสตรีมJSONL(Codex CLI `--json`)และดึงข้อความเอเจนต์สุดท้าย
  พร้อม`thread_id`เมื่อมี
- `output: "text"`ถือว่าstdoutคือคำตอบสุดท้าย

โหมดอินพุต:

- `input: "arg"`(ค่าเริ่มต้น)ส่งพรอมป์เป็นอาร์กิวเมนต์สุดท้ายของCLI
- `input: "stdin"`ส่งพรอมป์ผ่านstdin
- หากพรอมป์ยาวมากและตั้งค่า`maxPromptArgChars`จะใช้stdin

## ค่าเริ่มต้น(มีในตัว)

OpenClawมีค่าเริ่มต้นสำหรับ`claude-cli`:

- `command: "claude"`
- `args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"]`
- `resumeArgs: ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--resume", "{sessionId}"]`
- `modelArg: "--model"`
- `systemPromptArg: "--append-system-prompt"`
- `sessionArg: "--session-id"`
- `systemPromptWhen: "first"`
- `sessionMode: "always"`

OpenClawยังมีค่าเริ่มต้นสำหรับ`codex-cli`:

- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`

ให้โอเวอร์ไรด์เฉพาะเมื่อจำเป็น(ที่พบบ่อย: พาธ`command`แบบสัมบูรณ์)

## ข้อจำกัด

- **ไม่มีเครื่องมือของOpenClaw**(แบ็กเอนด์CLIจะไม่รับการเรียกเครื่องมือ)บางCLI
  อาจยังรันเครื่องมือเอเจนต์ของตนเอง Some CLIs
  may still run their own agent tooling.
- **ไม่มีการสตรีม**(รวบรวมเอาต์พุตจากCLIแล้วจึงส่งคืน)
- **เอาต์พุตแบบมีโครงสร้าง**ขึ้นกับรูปแบบJSONของCLI
- **เซสชันของCodex CLI**resumeผ่านเอาต์พุตข้อความ(ไม่ใช่JSONL)ซึ่งมีโครงสร้างน้อยกว่า
  การรัน`--json`ครั้งแรก เซสชันของOpenClawยังทำงานตามปกติ OpenClaw sessions still work
  normally.

## การแก้ไขปัญหา

- **ไม่พบCLI**: ตั้งค่า`command`เป็นพาธเต็ม
- **ชื่อโมเดลไม่ถูกต้อง**: ใช้`modelAliases`เพื่อแมป`provider/model`→โมเดลของCLI
- **เซสชันไม่ต่อเนื่อง**: ตรวจสอบให้ตั้งค่า`sessionArg`และ`sessionMode`ไม่ใช่
  `none`(Codex CLIปัจจุบันไม่สามารถresumeด้วยเอาต์พุตJSON)
- **รูปภาพถูกละเลย**: ตั้งค่า`imageArg`(และตรวจสอบว่าCLIรองรับพาธไฟล์)
