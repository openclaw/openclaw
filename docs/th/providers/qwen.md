---
summary: "ใช้ Qwen OAuth (ระดับฟรี) ใน OpenClaw"
read_when:
  - คุณต้องการใช้ Qwen กับ OpenClaw
  - คุณต้องการการเข้าถึง Qwen Coder แบบ OAuth ระดับฟรี
title: "Qwen"
---

# Qwen

Qwen มีโฟลว์ OAuth ระดับฟรีสำหรับโมเดล Qwen Coder และ Qwen Vision
(2,000 คำขอต่อวัน ทั้งนี้ขึ้นอยู่กับข้อจำกัดอัตราการใช้งานของ Qwen)

## เปิดใช้งานปลั๊กอิน

```bash
openclaw plugins enable qwen-portal-auth
```

รีสตาร์ท Gateway หลังจากเปิดใช้งานแล้ว

## การยืนยันตัวตน

```bash
openclaw models auth login --provider qwen-portal --set-default
```

คำสั่งนี้จะรันโฟลว์ OAuth แบบ device-code ของ Qwen และเขียนรายการผู้ให้บริการไปยัง
`models.json` (พร้อมทั้งสร้างนามแฝง `qwen` สำหรับการสลับอย่างรวดเร็ว)

## Model IDs

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

สลับโมเดลด้วย:

```bash
openclaw models set qwen-portal/coder-model
```

## การนำการล็อกอิน Qwen Code CLI มาใช้ซ้ำ

หากคุณเคยล็อกอินด้วย Qwen Code CLI แล้ว OpenClaw จะซิงค์ข้อมูลรับรองจาก
`~/.qwen/oauth_creds.json` เมื่อโหลดคลังการยืนยันตัวตน คุณยังคงต้องมีรายการ
`models.providers.qwen-portal` (ใช้คำสั่งล็อกอินด้านบนเพื่อสร้างรายการ) คุณยังคงต้องมีรายการ `models.providers.qwen-portal` (ใช้คำสั่งล็อกอินด้านบนเพื่อสร้างรายการหนึ่ง)

## หมายเหตุ

- โทเคนจะรีเฟรชอัตโนมัติ ให้รันคำสั่งล็อกอินอีกครั้งหากการรีเฟรชล้มเหลวหรือสิทธิ์การเข้าถึงถูกเพิกถอน
- URL ฐานค่าเริ่มต้น: `https://portal.qwen.ai/v1` (สามารถ override ได้ด้วย
  `models.providers.qwen-portal.baseUrl` หาก Qwen มีเอ็นด์พอยต์อื่นให้)
- ดู [Model providers](/concepts/model-providers) สำหรับกฎที่ใช้กับผู้ให้บริการทั้งหมด
