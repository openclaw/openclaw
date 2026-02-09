---
title: refactor/outbound-session-mirroring.md #1520)
description: Track outbound session mirroring refactor notes, decisions, tests, and open items.
---

# การปรับโครงสร้าง Outbound Session Mirroring (Issue #1520)

## สถานะ

- กำลังดำเนินการ
- อัปเดตการกำหนดเส้นทางช่องทางของ core + ปลั๊กอินสำหรับการมิเรอร์ขาออกแล้ว
- การส่งผ่านGatewayตอนนี้อนุมานเซสชันเป้าหมายเมื่อไม่ระบุ sessionKey

## บริบท

การส่งออกแบบ Outbound ถูกมิเรอร์ไปยังเซสชันเอเจนต์ _ปัจจุบัน_ (คีย์เซสชันของเครื่องมือ) แทนที่จะเป็นเซสชันของช่องทางเป้าหมาย การส่งขาออกเคยถูกมิเรอร์ไปยังเซสชันเอเจนต์ _ปัจจุบัน_ (tool session key) แทนที่จะเป็นเซสชันของช่องทางเป้าหมาย การกำหนดเส้นทางขาเข้าใช้คีย์เซสชันตามช่องทาง/เพียร์ ดังนั้นการตอบกลับขาออกจึงไปลงผิดเซสชัน และเป้าหมายที่ติดต่อครั้งแรกมักไม่มีรายการเซสชัน

## เป้าหมาย

- มิเรอร์ข้อความขาออกไปยังคีย์เซสชันของช่องทางเป้าหมาย
- สร้างรายการเซสชันเมื่อส่งขาออกและยังไม่มี
- ทำให้การกำหนดขอบเขตเธรด/หัวข้อสอดคล้องกับคีย์เซสชันขาเข้า
- ครอบคลุมช่องทางหลักและส่วนขยายที่มาพร้อมกัน

## สรุปการติดตั้ง

- ตัวช่วยกำหนดเส้นทางเซสชันขาออกใหม่:
  - `src/infra/outbound/outbound-session.ts`
  - `resolveOutboundSessionRoute` สร้าง sessionKey เป้าหมายโดยใช้ `buildAgentSessionKey` (dmScope + identityLinks)
  - `ensureOutboundSessionEntry` เขียน `MsgContext` แบบขั้นต่ำผ่าน `recordSessionMetaFromInbound`
- `runMessageAction` (send) อนุมาน sessionKey เป้าหมายและส่งต่อไปยัง `executeSendAction` เพื่อมิเรอร์
- `message-tool` ไม่มิเรอร์โดยตรงอีกต่อไป โดยทำเพียงแก้ไข agentId จากคีย์เซสชันปัจจุบัน
- เส้นทางการส่งของปลั๊กอินมิเรอร์ผ่าน `appendAssistantMessageToSessionTranscript` โดยใช้ sessionKey ที่อนุมานแล้ว
- การส่งผ่านGatewayจะอนุมานคีย์เซสชันเป้าหมายเมื่อไม่ได้ระบุ (เอเจนต์เริ่มต้น) และรับประกันว่ามีรายการเซสชัน

## การจัดการเธรด/หัวข้อ

- Slack: replyTo/threadId -> `resolveThreadSessionKeys` (suffix)
- Discord: threadId/replyTo -> `resolveThreadSessionKeys` พร้อม `useSuffix=false` เพื่อให้ตรงกับขาเข้า (id ช่องเธรดกำหนดขอบเขตเซสชันอยู่แล้ว)
- Telegram: topic IDs แมปไปยัง `chatId:topic:<id>` ผ่าน `buildTelegramGroupPeerId`

## ส่วนขยายที่ครอบคลุม

- Matrix, MS Teams, Mattermost, BlueBubbles, Nextcloud Talk, Zalo, Zalo Personal, Nostr, Tlon
- หมายเหตุ:
  - เป้าหมาย Mattermost ตอนนี้ตัด `@` ออกสำหรับการกำหนดเส้นทางคีย์เซสชัน DM
  - Zalo Personal ใช้ชนิดเพียร์ DM สำหรับเป้าหมาย 1:1 (เป็นกลุ่มเฉพาะเมื่อมี `group:`)
  - เป้าหมายกลุ่มของ BlueBubbles ตัดคำนำหน้า `chat_*` เพื่อให้ตรงกับคีย์เซสชันขาเข้า
  - การมิเรอร์ออโต้เธรดของ Slack จับคู่ id ช่องแบบไม่สนใจตัวพิมพ์เล็ก/ใหญ่
  - การส่งผ่านGatewayจะแปลงคีย์เซสชันที่ระบุให้เป็นตัวพิมพ์เล็กก่อนทำการมิเรอร์

## การตัดสินใจ

- **การอนุมานเซสชันสำหรับการส่งผ่าน Gateway**: หากมีการระบุ `sessionKey` ให้ใช้ค่านั้น **การอนุมานเซสชันในการส่งผ่านGateway**: หากมี `sessionKey` ให้ใช้ค่านั้น หากไม่ระบุ ให้อนุมาน sessionKey จากเป้าหมาย + เอเจนต์เริ่มต้น และมิเรอร์ไปที่นั่น
- **การสร้างรายการเซสชัน**: ใช้ `recordSessionMetaFromInbound` เสมอ โดยให้ `Provider/From/To/ChatType/AccountId/Originating*` สอดคล้องกับรูปแบบขาเข้า
- **การทำให้เป้าหมายเป็นมาตรฐาน**: การกำหนดเส้นทางขาออกใช้เป้าหมายที่แก้ไขแล้ว (หลัง `resolveChannelTarget`) เมื่อมี
- **ตัวพิมพ์ของคีย์เซสชัน**: ทำให้คีย์เซสชันเป็นตัวพิมพ์เล็กแบบมาตรฐานทั้งตอนเขียนและระหว่างการย้ายข้อมูล

## การทดสอบที่เพิ่ม/อัปเดต

- `src/infra/outbound/outbound-session.test.ts`
  - คีย์เซสชันเธรดของ Slack
  - คีย์เซสชันหัวข้อของ Telegram
  - dmScope identityLinks กับ Discord
- `src/agents/tools/message-tool.test.ts`
  - อนุมาน agentId จากคีย์เซสชัน (ไม่ได้ส่ง sessionKey ผ่าน)
- `src/gateway/server-methods/send.test.ts`
  - อนุมานคีย์เซสชันเมื่อไม่ระบุและสร้างรายการเซสชัน

## รายการค้าง / ติดตามผล

- ปลั๊กอินโทรเสียงใช้คีย์เซสชันแบบกำหนดเอง `voice:<phone>` ปลั๊กอินการโทรด้วยเสียงใช้คีย์เซสชัน `voice:<phone>` แบบกำหนดเอง การแมปขาออกยังไม่เป็นมาตรฐานในส่วนนี้ หากเครื่องมือส่งข้อความควรรองรับการส่งแบบโทรด้วยเสียง ให้เพิ่มการแมปอย่างชัดเจน
- ยืนยันว่ามีปลั๊กอินภายนอกใดใช้รูปแบบ `From/To` ที่ไม่เป็นมาตรฐานนอกเหนือจากชุดที่มาพร้อมกันหรือไม่

## ไฟล์ที่ถูกแก้ไข

- `src/infra/outbound/outbound-session.ts`
- `src/infra/outbound/outbound-send-service.ts`
- `src/infra/outbound/message-action-runner.ts`
- `src/agents/tools/message-tool.ts`
- `src/gateway/server-methods/send.ts`
- การทดสอบใน:
  - `src/infra/outbound/outbound-session.test.ts`
  - `src/agents/tools/message-tool.test.ts`
  - `src/gateway/server-methods/send.test.ts`
