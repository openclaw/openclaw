---
summary: "แพลตฟอร์มข้อความที่ OpenClaw สามารถเชื่อมต่อได้"
read_when:
  - คุณต้องการเลือกช่องทางแชตสำหรับ OpenClaw
  - คุณต้องการภาพรวมอย่างรวดเร็วของแพลตฟอร์มข้อความที่รองรับ
title: "ช่องทางแชต"
---

# ช่องทางแชต

OpenClaw สามารถคุยกับคุณบนแอปแชตใดก็ได้ที่คุณใช้อยู่แล้ว Each channel connects via the Gateway.
รองรับข้อความในทุกที่; สื่อและรีแอ็กชันแตกต่างกันไปตามช่อง

## ช่องทางที่รองรับ

- [WhatsApp](/channels/whatsapp) — ได้รับความนิยมมากที่สุด; ใช้ Baileys และต้องจับคู่ด้วย QR
- [Telegram](/channels/telegram) — Bot API ผ่าน grammY; รองรับกลุ่ม
- [Discord](/channels/discord) — Discord Bot API + Gateway（เกตเวย์）; รองรับเซิร์ฟเวอร์ ช่องทาง และ DMs
- [Slack](/channels/slack) — Bolt SDK; แอปในเวิร์กสเปซ
- [Feishu](/channels/feishu) — บอต Feishu/Lark ผ่าน WebSocket (ต้องใช้ปลั๊กอิน ติดตั้งแยก)
- [Google Chat](/channels/googlechat) — แอป Google Chat API ผ่าน HTTP webhook
- [Mattermost](/channels/mattermost) — Bot API + WebSocket; ช่องทาง กลุ่ม และ DMs (ต้องใช้ปลั๊กอิน ติดตั้งแยก)
- [Signal](/channels/signal) — signal-cli; เน้นความเป็นส่วนตัว
- [BlueBubbles](/channels/bluebubbles) — **แนะนำสำหรับ iMessage**; ใช้ REST API ของ BlueBubbles macOS server พร้อมการรองรับฟีเจอร์ครบถ้วน (แก้ไข ยกเลิกการส่ง เอฟเฟกต์ รีแอ็กชัน การจัดการกลุ่ม — การแก้ไขขณะนี้มีปัญหาบน macOS 26 Tahoe)
- [iMessage (legacy)](/channels/imessage) — การผสานรวม macOS แบบเดิมผ่าน imsg CLI (เลิกใช้แล้ว แนะนำให้ใช้ BlueBubbles สำหรับการตั้งค่าใหม่)
- [Microsoft Teams](/channels/msteams) — Bot Framework; รองรับระดับองค์กร (ต้องใช้ปลั๊กอิน ติดตั้งแยก)
- [LINE](/channels/line) — บอต LINE Messaging API (ต้องใช้ปลั๊กอิน ติดตั้งแยก)
- [Nextcloud Talk](/channels/nextcloud-talk) — แชตแบบโฮสต์เองผ่าน Nextcloud Talk (ต้องใช้ปลั๊กอิน ติดตั้งแยก)
- [Matrix](/channels/matrix) — โปรโตคอล Matrix (ต้องใช้ปลั๊กอิน ติดตั้งแยก)
- [Nostr](/channels/nostr) — DMs แบบกระจายศูนย์ผ่าน NIP-04 (ต้องใช้ปลั๊กอิน ติดตั้งแยก)
- [Tlon](/channels/tlon) — เมสเซนเจอร์บน Urbit (ต้องใช้ปลั๊กอิน ติดตั้งแยก)
- [Twitch](/channels/twitch) — แชต Twitch ผ่านการเชื่อมต่อ IRC (ต้องใช้ปลั๊กอิน ติดตั้งแยก)
- [Zalo](/channels/zalo) — Zalo Bot API; เมสเซนเจอร์ยอดนิยมในเวียดนาม (ต้องใช้ปลั๊กอิน ติดตั้งแยก)
- [Zalo Personal](/channels/zalouser) — บัญชีส่วนตัว Zalo ผ่านการล็อกอินด้วย QR (ต้องใช้ปลั๊กอิน ติดตั้งแยก)
- [WebChat](/web/webchat) — UI ของ Gateway WebChat ผ่าน WebSocket

## หมายเหตุ

- ช่องทางสามารถทำงานพร้อมกันได้ ตั้งค่าหลายช่องทางแล้ว OpenClaw จะทำการกำหนดเส้นทางตามแชต
- การตั้งค่าที่เร็วที่สุดมักจะเป็น **Telegram** (โทเคนบอทง่าย ๆ) การตั้งค่าที่เร็วที่สุดมักเป็น **Telegram** (โทเคนบอตแบบง่าย) ส่วน WhatsApp ต้องจับคู่ด้วย QR และ
  จัดเก็บสถานะบนดิสก์มากกว่า
- พฤติกรรมของกลุ่มแตกต่างกันไปตามช่องทาง ดูที่ [Groups](/channels/groups)
- การจับคู่ DM และรายการอนุญาตถูกบังคับใช้เพื่อความปลอดภัย ดูที่ [Security](/gateway/security)
- รายละเอียดภายในของ Telegram: [grammY notes](/channels/grammy)
- การแก้ไขปัญหา: [Channel troubleshooting](/channels/troubleshooting)
- ผู้ให้บริการโมเดลมีเอกสารแยกต่างหาก ดูที่ [Model Providers](/providers/models)
