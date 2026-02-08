---
summary: "ความสามารถของOpenClawครอบคลุมช่องทางการสื่อสาร การกำหนดเส้นทาง สื่อ และประสบการณ์ผู้ใช้"
read_when:
  - คุณต้องการดูรายการทั้งหมดของสิ่งที่OpenClawรองรับ
title: "คุณสมบัติ"
x-i18n:
  source_path: concepts/features.md
  source_hash: 1b6aee0bfda75182
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:01Z
---

## ไฮไลต์

<Columns>
  <Card title="ช่องทาง" icon="message-square">
    WhatsApp,Telegram,DiscordและiMessageด้วยGatewayเดียว
  </Card>
  <Card title="ปลั๊กอิน" icon="plug">
    เพิ่มMattermostและอื่นๆด้วยส่วนขยาย
  </Card>
  <Card title="การกำหนดเส้นทาง" icon="route">
    การกำหนดเส้นทางแบบหลายเอเจนต์พร้อมเซสชันที่แยกจากกัน
  </Card>
  <Card title="สื่อ" icon="image">
    รองรับรูปภาพ เสียง และเอกสารทั้งขาเข้าและขาออก
  </Card>
  <Card title="แอปและUI" icon="monitor">
    Web Control UIและแอปคู่หูmacOS
  </Card>
  <Card title="โหนดมือถือ" icon="smartphone">
    โหนดiOSและAndroidพร้อมรองรับCanvas
  </Card>
</Columns>

## รายการทั้งหมด

- การเชื่อมต่อWhatsAppผ่านWhatsApp Web(Baileys)
- รองรับTelegram bot(grammY)
- รองรับDiscord bot(channels.discord.js)
- รองรับMattermost bot(ปลั๊กอิน)
- การเชื่อมต่อiMessageผ่านlocal imsg CLI(macOS)
- Agent bridgeสำหรับPiในโหมดRPCพร้อมการสตรีมเครื่องมือ
- การสตรีมและการแบ่งเป็นชิ้นสำหรับคำตอบที่ยาว
- การกำหนดเส้นทางแบบหลายเอเจนต์สำหรับเซสชันที่แยกจากกันต่อเวิร์กสเปซหรือผู้ส่ง
- การยืนยันตัวตนแบบสมัครสมาชิกสำหรับAnthropicและOpenAIผ่านOAuth
- เซสชัน: แชตตรงจะถูกรวมเป็น`main`; กลุ่มจะแยกจากกัน
- รองรับแชตกลุ่มพร้อมการเปิดใช้งานด้วยการกล่าวถึง
- รองรับสื่อสำหรับรูปภาพ เสียง และเอกสาร
- ตัวเลือกฮุคสำหรับถอดเสียงโน้ตเสียง
- WebChatและแอปแถบเมนูmacOS
- โหนดiOSพร้อมการจับคู่และพื้นผิวCanvas
- โหนดAndroidพร้อมการจับคู่ Canvas แชต และกล้อง

<Note>
เส้นทางLegacyของClaude,Codex,GeminiและOpencodeถูกนำออกแล้ว Piเป็นเส้นทางเอเจนต์สำหรับการเขียนโค้ดเพียงตัวเดียว
</Note>
