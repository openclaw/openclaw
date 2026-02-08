---
summary: "อะแดปเตอร์RPCสำหรับCLIภายนอก(signal-cli, imsgแบบเดิม)และแพตเทิร์นGateway"
read_when:
  - การเพิ่มหรือเปลี่ยนการเชื่อมต่อCLIภายนอก
  - การดีบักอะแดปเตอร์RPC(signal-cli, imsg)
title: "อะแดปเตอร์RPC"
x-i18n:
  source_path: reference/rpc.md
  source_hash: 06dc6b97184cc704
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:40Z
---

# อะแดปเตอร์RPC

OpenClawผสานรวมCLIภายนอกผ่านJSON-RPC ปัจจุบันมีการใช้งานอยู่สองแพตเทิร์น

## แพตเทิร์นA: HTTP daemon (signal-cli)

- `signal-cli` ทำงานเป็นเดมอนด้วยJSON-RPCผ่านHTTP
- สตรีมอีเวนต์เป็นSSE (`/api/v1/events`)
- Health probe: `/api/v1/check`
- OpenClawเป็นผู้ดูแลวงจรชีวิตเมื่อ `channels.signal.autoStart=true`

ดูการตั้งค่าและเอ็นด์พอยต์ได้ที่[Signal](/channels/signal)

## แพตเทิร์นB: โปรเซสลูกผ่านstdio (แบบเดิม: imsg)

> **หมายเหตุ:** สำหรับการตั้งค่าiMessageใหม่ แนะนำให้ใช้[BlueBubbles](/channels/bluebubbles)แทน

- OpenClawสปอว์น `imsg rpc` เป็นโปรเซสลูก(การเชื่อมต่อiMessageแบบเดิม)
- JSON-RPCถูกคั่นบรรทัดผ่านstdin/stdout (หนึ่งอ็อบเจ็กต์JSONต่อหนึ่งบรรทัด)
- ไม่มีพอร์ตTCP และไม่ต้องใช้เดมอน

เมธอดหลักที่ใช้:

- `watch.subscribe` → การแจ้งเตือน (`method: "message"`)
- `watch.unsubscribe`
- `send`
- `chats.list` (probe/การวินิจฉัย)

ดูการตั้งค่าแบบเดิมและการกำหนดที่อยู่ได้ที่[iMessage](/channels/imessage) (แนะนำ `chat_id`)

## แนวทางสำหรับอะแดปเตอร์

- Gatewayเป็นผู้ดูแลโปรเซส(เริ่ม/หยุดผูกกับวงจรชีวิตของผู้ให้บริการ)
- ทำให้RPC clientมีความทนทาน: ตั้งค่าtimeout และรีสตาร์ตเมื่อโปรเซสออก
- ควรใช้IDที่เสถียร(เช่น `chat_id`)มากกว่าสตริงที่ใช้แสดงผล
