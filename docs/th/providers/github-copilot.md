---
summary: "ลงชื่อเข้าใช้ GitHub Copilot จาก OpenClaw โดยใช้ device flow"
read_when:
  - คุณต้องการใช้ GitHub Copilot เป็นผู้ให้บริการโมเดล
  - คุณต้องการโฟลว์ `openclaw models auth login-github-copilot`
title: "GitHub Copilot"
---

# GitHub Copilot

## GitHub Copilot คืออะไร

48. GitHub Copilot คือผู้ช่วยเขียนโค้ดด้วย AI ของ GitHub GitHub Copilot คือผู้ช่วยเขียนโค้ดด้วย AI ของ GitHub โดยให้การเข้าถึงโมเดล Copilot สำหรับบัญชีและแพ็กเกจ GitHub ของคุณ OpenClaw สามารถใช้ Copilot เป็นผู้ให้บริการโมเดลได้สองวิธีที่แตกต่างกัน 49. OpenClaw สามารถใช้ Copilot เป็นผู้ให้บริการโมเดล
    ได้สองวิธีที่แตกต่างกัน

## สองวิธีในการใช้ Copilot ใน OpenClaw

### 1. ผู้ให้บริการ GitHub Copilot แบบบิลต์อิน (`github-copilot`)

ใช้โฟลว์เข้าสู่ระบบด้วยอุปกรณ์แบบเนทีฟเพื่อรับโทเคน GitHub จากนั้นแลกเป็นโทเคน Copilot API เมื่อ OpenClaw ทำงาน วิธีนี้เป็นค่าเริ่มต้นและง่ายที่สุด เพราะไม่ต้องใช้ VS Code 50. นี่คือเส้นทาง **ค่าเริ่มต้น** และง่ายที่สุด
เนื่องจากไม่ต้องใช้ VS Code

### 2. ปลั๊กอิน Copilot Proxy (`copilot-proxy`)

ใช้ส่วนขยาย VS Code **Copilot Proxy** เป็นสะพานเชื่อมภายในเครื่อง OpenClaw จะสื่อสารกับเอ็นด์พอยต์ `/v1` ของพร็อกซี และใช้รายการโมเดลที่คุณกำหนดค่าไว้ที่นั่น เลือกวิธีนี้เมื่อคุณใช้งาน Copilot Proxy ใน VS Code อยู่แล้วหรือจำเป็นต้องส่งทราฟฟิกผ่านมัน คุณต้องเปิดใช้งานปลั๊กอินและให้ส่วนขยาย VS Code ทำงานตลอดเวลา OpenClaw สื่อสารกับเอ็นด์พอยต์ `/v1` ของพร็อกซี และใช้รายการโมเดลที่คุณกำหนดค่าไว้ที่นั่น เลือกตัวเลือกนี้เมื่อคุณรัน Copilot Proxy ใน VS Code อยู่แล้ว หรือจำเป็นต้องกำหนดเส้นทางผ่านมัน
You must enable the plugin and keep the VS Code extension running.

ใช้ GitHub Copilot เป็นผู้ให้บริการโมเดล (`github-copilot`). คำสั่งล็อกอินจะรัน GitHub device flow บันทึกโปรไฟล์การยืนยันตัวตน และอัปเดตคอนฟิกของคุณให้ใช้โปรไฟล์นั้น

## การตั้งค่าCLI

```bash
openclaw models auth login-github-copilot
```

ระบบจะให้คุณไปที่ URL และป้อนโค้ดแบบใช้ครั้งเดียว โปรดเปิดเทอร์มินัลค้างไว้จนกว่าจะเสร็จสิ้น เปิดเทอร์มินัลทิ้งไว้จนกว่าจะเสร็จสิ้น

### แฟล็กเสริม

```bash
openclaw models auth login-github-copilot --profile-id github-copilot:work
openclaw models auth login-github-copilot --yes
```

## ตั้งค่าโมเดลเริ่มต้น

```bash
openclaw models set github-copilot/gpt-4o
```

### Config snippet

```json5
{
  agents: { defaults: { model: { primary: "github-copilot/gpt-4o" } } },
}
```

## หมายเหตุ

- ต้องใช้ TTY แบบโต้ตอบ ให้รันโดยตรงในเทอร์มินัล
- ความพร้อมใช้งานของโมเดล Copilot ขึ้นกับแพ็กเกจของคุณ หากโมเดลถูกปฏิเสธ ให้ลองใช้ ID อื่น (เช่น `github-copilot/gpt-4.1`)
- การล็อกอินจะจัดเก็บโทเคน GitHub ในที่เก็บโปรไฟล์การยืนยันตัวตน และแลกเป็นโทเคน Copilot API เมื่อ OpenClaw ทำงาน
