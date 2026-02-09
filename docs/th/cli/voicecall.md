---
summary: "เอกสารอ้างอิงCLIสำหรับ `openclaw voicecall` (พื้นผิวคำสั่งของปลั๊กอินการโทรด้วยเสียง)"
read_when:
  - คุณใช้ปลั๊กอินการโทรด้วยเสียงและต้องการจุดเข้าใช้งานของCLI
  - คุณต้องการตัวอย่างอย่างรวดเร็วสำหรับ `voicecall call|continue|status|tail|expose`
title: "voicecall"
---

# `openclaw voicecall`

10. `voicecall` เป็นคำสั่งที่มาจากปลั๊กอิน `voicecall` เป็นคำสั่งที่จัดเตรียมโดยปลั๊กอิน คำสั่งนี้จะแสดงเฉพาะเมื่อมีการติดตั้งและเปิดใช้งานปลั๊กอินการโทรด้วยเสียงแล้วเท่านั้น

เอกสารหลัก:

- ปลั๊กอินการโทรด้วยเสียง: [Voice Call](/plugins/voice-call)

## คำสั่งที่ใช้บ่อย

```bash
openclaw voicecall status --call-id <id>
openclaw voicecall call --to "+15555550123" --message "Hello" --mode notify
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall end --call-id <id>
```

## การเปิดเผยเว็บฮุค (Tailscale)

```bash
openclaw voicecall expose --mode serve
openclaw voicecall expose --mode funnel
openclaw voicecall unexpose
```

หมายเหตุด้านความปลอดภัย: ควรเปิดเผยเอ็นด์พอยต์ของเว็บฮุคเฉพาะกับเครือข่ายที่คุณเชื่อถือเท่านั้น และควรเลือกใช้ Tailscale Serve แทน Funnel เมื่อเป็นไปได้ 11. ควรใช้ Tailscale Serve แทน Funnel เมื่อเป็นไปได้
