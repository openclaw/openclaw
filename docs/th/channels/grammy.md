---
summary: "การผสานรวม Telegram Bot API ผ่าน grammY พร้อมหมายเหตุการตั้งค่า"
read_when:
  - กำลังทำงานกับเส้นทาง Telegram หรือ grammY
title: grammY
---

# การผสานรวม grammY (Telegram Bot API)

# ทำไมต้อง grammY

- ไคลเอนต์ Bot API ที่เน้น TypeScript เป็นหลัก พร้อมตัวช่วย long-poll และ webhook ในตัว, middleware, การจัดการข้อผิดพลาด และตัวจำกัดอัตรา
- ตัวช่วยจัดการสื่อสะอาดกว่าการเขียน fetch + FormData เอง; รองรับทุกเมธอดของ Bot API
- ขยายได้: รองรับพร็อกซีผ่าน custom fetch, session middleware (ไม่บังคับ), และ context ที่ปลอดภัยด้านชนิดข้อมูล

# สิ่งที่เราได้ส่งมอบ

- **เส้นทางไคลเอนต์เดียว:** ลบการทำงานแบบ fetch-based ออก; ขณะนี้ grammY เป็นไคลเอนต์ Telegram เพียงหนึ่งเดียว (ส่ง + Gateway) โดยเปิดใช้งานตัวจำกัดอัตราของ grammY เป็นค่าเริ่มต้น
- **Gateway:** `monitorTelegramProvider` สร้าง grammY `Bot` เชื่อมการกรอง mention/allowlist, ดาวน์โหลดสื่อผ่าน `getFile`/`download`, และส่งคำตอบด้วย `sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument`. รองรับ long-poll หรือ webhook ผ่าน `webhookCallback`
- **Proxy:** `channels.telegram.proxy` (ไม่บังคับ) ใช้ `undici.ProxyAgent` ผ่าน `client.baseFetch` ของ grammY
- **รองรับ Webhook:** `webhook-set.ts` ครอบ `setWebhook/deleteWebhook`; `webhook.ts` โฮสต์ callback พร้อม health และ graceful shutdown. Gateway จะเปิดโหมด webhook เมื่อกำหนด `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` (มิฉะนั้นจะใช้ long-poll)
- **Sessions:** แชตส่วนตัวจะถูกรวมเข้าเซสชันหลักของเอเจนต์ (`agent:<agentId>:<mainKey>`); กลุ่มใช้ `agent:<agentId>:telegram:group:<chatId>`; การตอบกลับจะถูกส่งกลับไปยังช่องทางเดิม
- **ตัวเลือกการคอนฟิก:** `channels.telegram.botToken`, `channels.telegram.dmPolicy`, `channels.telegram.groups` (ค่าเริ่มต้นของ allowlist + mention), `channels.telegram.allowFrom`, `channels.telegram.groupAllowFrom`, `channels.telegram.groupPolicy`, `channels.telegram.mediaMaxMb`, `channels.telegram.linkPreview`, `channels.telegram.proxy`, `channels.telegram.webhookSecret`, `channels.telegram.webhookUrl`
- **Draft streaming:** `channels.telegram.streamMode` (ไม่บังคับ) ใช้ `sendMessageDraft` ในแชตหัวข้อส่วนตัว (Bot API 9.3+). แยกจากการสตรีมแบบบล็อกของช่องทาง
- **การทดสอบ:** mock ของ grammY ครอบคลุม DM + การกรอง mention ในกลุ่ม และการส่งออก; ยินดีต้อนรับฟิกซ์เจอร์สื่อ/เว็บฮุคเพิ่มเติม

คำถามที่ยังเปิดอยู่

- ปลั๊กอิน grammY (throttler) แบบไม่บังคับ หากพบ Bot API 429s
- เพิ่มการทดสอบสื่อที่มีโครงสร้างมากขึ้น (สติกเกอร์, โน้ตเสียง)
- ทำให้พอร์ตที่ webhook รับฟังสามารถกำหนดค่าได้ (ปัจจุบันตรึงไว้ที่ 8787 เว้นแต่จะเชื่อมผ่าน Gateway)
