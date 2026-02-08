---
summary: "Gateway โหนด และโฮสต์แคนวาสเชื่อมต่อกันอย่างไร"
read_when:
  - คุณต้องการภาพรวมแบบกระชับของโมเดลเครือข่ายของGateway
title: "โมเดลเครือข่าย"
x-i18n:
  source_path: gateway/network-model.md
  source_hash: e3508b884757ef19
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:09Z
---

การทำงานส่วนใหญ่จะไหลผ่านGateway(`openclaw gateway`)ซึ่งเป็นโปรเซสเดียวที่รันต่อเนื่องยาวนานและเป็นเจ้าของการเชื่อมต่อช่องทางและคอนโทรลเพลนWebSocket

## กฎหลัก

- แนะนำให้มีGatewayหนึ่งตัวต่อโฮสต์เป็นอย่างน้อยเป็นโปรเซสเดียวที่ได้รับอนุญาตให้เป็นเจ้าของเซสชันWhatsApp Webสำหรับบอตกู้คืนหรือการแยกที่เข้มงวดให้รันหลายGatewayโดยใช้โปรไฟล์และพอร์ตที่แยกจากกันดู[Multiple gateways](/gateway/multiple-gateways)
- Loopbackก่อน: ค่าเริ่มต้นของGateway WSคือ`ws://127.0.0.1:18789`วิซาร์ดจะสร้างโทเคนของGatewayเป็นค่าเริ่มต้นแม้สำหรับloopbackสำหรับการเข้าถึงผ่านtailnetให้รัน`openclaw gateway --bind tailnet --token ...`เนื่องจากการbindที่ไม่ใช่loopbackต้องใช้โทเคน
- โหนดเชื่อมต่อกับGateway WSผ่านLAN, tailnetหรือSSHตามความจำเป็นบริดจ์TCPแบบเดิมถูกเลิกใช้งานแล้ว
- โฮสต์แคนวาสเป็นเซิร์ฟเวอร์ไฟล์HTTPที่`canvasHost.port`(ค่าเริ่มต้น`18793`)ให้บริการ`/__openclaw__/canvas/`สำหรับWebViewของโหนดดู[Gateway configuration](/gateway/configuration)(`canvasHost`)
- การใช้งานจากระยะไกลมักเป็นอุโมงค์SSHหรือVPNแบบtailnetดู[Remote access](/gateway/remote)และ[Discovery](/gateway/discovery)
