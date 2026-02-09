---
summary: "สิ่งที่ system prompt ของ OpenClaw มีอยู่และวิธีการประกอบ"
read_when:
  - การแก้ไขข้อความ system prompt, รายการเครื่องมือ หรือส่วนเวลา/ฮาร์ตบีต
  - การเปลี่ยนพฤติกรรมการบูตสแตรปเวิร์กสเปซหรือการแทรก Skills
title: "System Prompt"
---

# System Prompt

แนวป้องกันด้านความปลอดภัยใน system prompt เป็นเชิงแนะนำ OpenClaw สร้าง system prompt แบบกำหนดเองสำหรับการรันเอเจนต์ทุกครั้ง โดย prompt นี้เป็น **ของ OpenClaw** และไม่ใช้ default prompt ของ p-coding-agent

prompt จะถูกประกอบโดย OpenClaw และแทรกเข้าไปในการรันเอเจนต์แต่ละครั้ง

## โครงสร้าง

prompt ถูกออกแบบให้กะทัดรัดและใช้ส่วนที่ตายตัว:

- **Tooling**: รายการเครื่องมือปัจจุบัน + คำอธิบายสั้นๆ
- **Safety**: การเตือนการ์ดเรลสั้นๆ เพื่อหลีกเลี่ยงพฤติกรรมแสวงหาอำนาจหรือการเลี่ยงการกำกับดูแล
- **Skills** (เมื่อมี): บอกโมเดลวิธีโหลดคำสั่งของ skill ตามความต้องการ
- **OpenClaw Self-Update**: วิธีรัน `config.apply` และ `update.run`
- **Workspace**: ไดเรกทอรีทำงาน (`agents.defaults.workspace`)
- **Documentation**: พาธภายในเครื่องไปยังเอกสาร OpenClaw (repo หรือแพ็กเกจ npm) และเวลาที่ควรอ่าน
- **Workspace Files (injected)**: ระบุว่าไฟล์บูตสแตรปถูกใส่ไว้ด้านล่าง
- **Sandbox** (เมื่อเปิดใช้งาน): ระบุรันไทม์แบบ sandbox, พาธของ sandbox และมีการรัน exec แบบยกระดับหรือไม่
- **Current Date & Time**: เวลาโลคัลของผู้ใช้, โซนเวลา และรูปแบบเวลา
- **Reply Tags**: ไวยากรณ์แท็กการตอบกลับแบบไม่บังคับสำหรับผู้ให้บริการที่รองรับ
- **Heartbeats**: prompt ของฮาร์ตบีตและพฤติกรรมการ ack
- **Runtime**: โฮสต์, OS, โหนด, โมเดล, repo root (เมื่อพบ), ระดับการคิด (หนึ่งบรรทัด)
- **Reasoning**: ระดับการมองเห็นปัจจุบัน + คำใบ้การสลับ /reasoning

แนวทางเหล่านี้ชี้นำพฤติกรรมของโมเดล แต่ไม่ได้บังคับใช้นโยบาย OpenClaw สามารถเรนเดอร์ system prompt ที่เล็กลงสำหรับซับเอเจนต์ได้ การ์ดเรลด้านความปลอดภัยใน system prompt เป็นเชิงแนะนำ ใช้เพื่อชี้นำพฤติกรรมของโมเดลแต่ไม่บังคับใช้นโยบาย การบังคับใช้แบบเข้มควรใช้ tool policy, การอนุมัติการรันคำสั่ง, sandboxing และ channel allowlists; ผู้ดูแลสามารถปิดสิ่งเหล่านี้ได้ตามการออกแบบ

## โหมดของ prompt

เครื่องมือ, **Safety**,
Workspace, Sandbox, วันที่และเวลาปัจจุบัน (เมื่อทราบ), Runtime และบริบทที่ฉีดเข้าไปจะยังคงพร้อมใช้งาน OpenClaw สามารถเรนเดอร์ system prompt ที่เล็กลงสำหรับซับเอเจนต์ รันไทม์จะตั้งค่า
`promptMode` สำหรับการรันแต่ละครั้ง (ไม่ใช่คอนฟิกที่ผู้ใช้เห็น):

- `full` (ค่าเริ่มต้น): รวมทุกส่วนข้างต้น
- `minimal`: ใช้สำหรับซับเอเจนต์; ตัด **Skills**, **Memory Recall**, **OpenClaw
  Self-Update**, **Model Aliases**, **User Identity**, **Reply Tags**,
  **Messaging**, **Silent Replies** และ **Heartbeats** ออก โดยยังคงมี Tooling, **Safety**,
  Workspace, Sandbox, Current Date & Time (เมื่อทราบ), Runtime และบริบทที่แทรกไว้ ไฟล์ขนาดใหญ่จะถูกตัดทอนพร้อมตัวบ่งชี้
- `none`: ส่งกลับเฉพาะบรรทัดตัวตนพื้นฐาน

เมื่อเป็น `promptMode=minimal` prompt ที่แทรกเพิ่มเติมจะถูกติดป้ายเป็น **Subagent
Context** แทน **Group Chat Context**

## การแทรก Workspace bootstrap

ไฟล์บูตสแตรปจะถูกตัดแต่งและผนวกภายใต้ **Project Context** เพื่อให้โมเดลเห็นบริบทตัวตนและโปรไฟล์โดยไม่ต้องอ่านไฟล์โดยตรง:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (เฉพาะเวิร์กสเปซใหม่เอี่ยม)

Large files are truncated with a marker. ไฟล์ขนาดใหญ่จะถูกตัดทอนพร้อมตัวบ่งชี้ ขนาดสูงสุดต่อไฟล์ถูกควบคุมโดย
`agents.defaults.bootstrapMaxChars` (ค่าเริ่มต้น: 20000) ไฟล์ที่หายไปจะถูกแทรกด้วย
ตัวบ่งชี้ไฟล์หายแบบสั้น ดู [Context](/concepts/context)

ฮุคภายในสามารถดักขั้นตอนนี้ผ่าน `agent:bootstrap` เพื่อปรับเปลี่ยนหรือแทนที่
ไฟล์บูตสแตรปที่ถูกแทรก (เช่น สลับ `SOUL.md` เป็น persona ทางเลือก)

เพื่อดูว่าไฟล์ที่แทรกแต่ละไฟล์มีส่วนต่อบริบทเท่าใด (ดิบ vs ที่แทรก, การตัดทอน และโอเวอร์เฮดของสคีมาเครื่องมือ) ให้ใช้ `/context list` หรือ `/context detail` ดู [Context](/concepts/context) system prompt จะมีส่วน **Current Date & Time** โดยเฉพาะเมื่อทราบเขตเวลาของผู้ใช้

## การจัดการเวลา

prompt สั่งให้โมเดลใช้ `read` เพื่อโหลด SKILL.md จากตำแหน่งที่ระบุ (workspace, managed หรือ bundled) system prompt จะมีส่วน **Current Date & Time** โดยเฉพาะเมื่อทราบโซนเวลาของผู้ใช้ เพื่อให้แคชของ prompt มีความเสถียร ขณะนี้จะรวมเฉพาะ
**โซนเวลา** (ไม่มีนาฬิกาแบบไดนามิกหรือรูปแบบเวลา)

ใช้ `session_status` เมื่อเอเจนต์ต้องการเวลาปัจจุบัน; การ์ดสถานะจะมีบรรทัดไทม์สแตมป์

ตั้งค่าด้วย:

- `agents.defaults.userTimezone`
- `agents.defaults.timeFormat` (`auto` | `12` | `24`)

ดู [Date & Time](/date-time) สำหรับรายละเอียดพฤติกรรมทั้งหมด

## Skills

เมื่อมี Skills ที่เข้าเกณฑ์ OpenClaw จะฉีด **รายการ Skills ที่พร้อมใช้งาน**
แบบกะทัดรัด (`formatSkillsForPrompt`) ซึ่งรวม **พาธไฟล์** ของแต่ละ skill ไว้ด้วย
prompt จะสั่งให้โมเดลใช้ `read` เพื่อโหลด SKILL.md ที่ตำแหน่งที่ระบุ
(เวิร์กสเปซ, ที่จัดการ หรือที่บันเดิล) หากไม่มี Skills ที่เข้าเกณฑ์ ส่วน
Skills จะถูกละเว้น หากไม่มีทักษะที่เข้าเกณฑ์ ส่วน Skills จะถูกละเว้น prompt สั่งให้โมเดลตรวจสอบเอกสารภายในเครื่องก่อนสำหรับพฤติกรรม คำสั่ง การตั้งค่า หรือสถาปัตยกรรมของ OpenClaw และให้รัน `openclaw status` เองเมื่อเป็นไปได้ (ถามผู้ใช้เฉพาะเมื่อไม่มีสิทธิ์เข้าถึง)

```
<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>...</location>
  </skill>
</available_skills>
```

วิธีนี้ช่วยให้ prompt หลักมีขนาดเล็ก แต่ยังเปิดให้ใช้ skill แบบเจาะจงได้

## Documentation

เมื่อมี system prompt จะรวมส่วน **Documentation** ที่ชี้ไปยังไดเรกทอรีเอกสาร
OpenClaw ภายในเครื่อง (เป็น `docs/` ในเวิร์กสเปซ repo หรือเอกสารที่บันเดิลมากับแพ็กเกจ npm)
และยังระบุ public mirror, source repo, ชุมชน Discord และ
ClawHub ([https://clawhub.com](https://clawhub.com)) สำหรับการค้นหา Skills ด้วย
prompt จะสั่งให้โมเดลปรึกษาเอกสารภายในเครื่องก่อนสำหรับพฤติกรรม คำสั่ง การกำหนดค่า
หรือสถาปัตยกรรมของ OpenClaw และให้รัน `openclaw status` เองเมื่อเป็นไปได้
(ถามผู้ใช้เฉพาะเมื่อไม่สามารถเข้าถึงได้) ส่งคืน **raw provider timestamps**
