---
summary: "การเข้าถึงและการยืนยันตัวตนของแดชบอร์ดGateway(Control UI)"
read_when:
  - การเปลี่ยนโหมดการยืนยันตัวตนหรือการเปิดเผยแดชบอร์ด
title: "แดชบอร์ด"
x-i18n:
  source_path: web/dashboard.md
  source_hash: e4fc372b72f030f9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:47Z
---

# แดชบอร์ด(Control UI)

แดชบอร์ดGatewayคือControl UIบนเบราว์เซอร์ซึ่งให้บริการที่ `/` เป็นค่าเริ่มต้น
(สามารถแทนที่ได้ด้วย `gateway.controlUi.basePath`)。

เปิดอย่างรวดเร็ว(Gatewayภายในเครื่อง):

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (หรือ [http://localhost:18789/](http://localhost:18789/))

เอกสารอ้างอิงหลัก:

- [Control UI](/web/control-ui) สำหรับการใช้งานและความสามารถของUI
- [Tailscale](/gateway/tailscale) สำหรับการทำอัตโนมัติของServe/Funnel
- [Web surfaces](/web) สำหรับโหมดการผูก(bind)และหมายเหตุด้านความปลอดภัย

การยืนยันตัวตนถูกบังคับใช้ในขั้นตอนWebSocket handshakeผ่าน `connect.params.auth`
(โทเคนหรือรหัสผ่าน) ดู `gateway.auth` ใน [การกำหนดค่าGateway](/gateway/configuration)

หมายเหตุด้านความปลอดภัย: Control UIเป็น **พื้นผิวผู้ดูแลระบบ** (แชต, คอนฟิก, การอนุมัติการรันคำสั่ง)
อย่าเปิดเผยสู่สาธารณะ UIจะเก็บโทเคนไว้ใน `localStorage` หลังจากโหลดครั้งแรก
ควรใช้ localhost, Tailscale Serve หรืออุโมงค์SSH

## ทางลัด(fast path)(แนะนำ)

- หลังจากการเริ่มต้นใช้งาน CLIจะเปิดแดชบอร์ดให้อัตโนมัติและพิมพ์ลิงก์ที่สะอาด(ไม่มีโทเคน)
- เปิดใหม่ได้ทุกเมื่อ: `openclaw dashboard` (คัดลอกลิงก์, เปิดเบราว์เซอร์หากเป็นไปได้, แสดงคำแนะนำSSHหากเป็นโหมดheadless)
- หากUIร้องขอการยืนยันตัวตน ให้วางโทเคนจาก `gateway.auth.token` (หรือ `OPENCLAW_GATEWAY_TOKEN`) ลงในการตั้งค่าControl UI

## พื้นฐานของโทเคน(ภายในเครื่อง vs ระยะไกล)

- **Localhost**: เปิด `http://127.0.0.1:18789/`
- **แหล่งที่มาของโทเคน**: `gateway.auth.token` (หรือ `OPENCLAW_GATEWAY_TOKEN`); UIจะเก็บสำเนาไว้ใน localStorage หลังจากเชื่อมต่อ
- **ไม่ใช่ localhost**: ใช้ Tailscale Serve (ไม่ต้องใช้โทเคนหาก `gateway.auth.allowTailscale: true`), การผูกกับtailnetพร้อมโทเคน หรืออุโมงค์SSH ดู [Web surfaces](/web)

## หากพบ “unauthorized” / 1008

- ตรวจสอบว่าGatewayเข้าถึงได้ (ภายในเครื่อง: `openclaw status`; ระยะไกล: อุโมงค์SSH `ssh -N -L 18789:127.0.0.1:18789 user@host` จากนั้นเปิด `http://127.0.0.1:18789/`)
- ดึงโทเคนจากโฮสต์Gateway: `openclaw config get gateway.auth.token` (หรือสร้างใหม่: `openclaw doctor --generate-gateway-token`)
- ในการตั้งค่าแดชบอร์ด ให้วางโทเคนลงในช่องการยืนยันตัวตน แล้วเชื่อมต่อ
