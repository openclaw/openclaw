---
summary: "เทมเพลตเวิร์กสเปซสำหรับ TOOLS.md"
read_when:
  - การบูตสแตรปเวิร์กสเปซด้วยตนเอง
x-i18n:
  source_path: reference/templates/TOOLS.md
  source_hash: 3ed08cd537620749
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:37Z
---

# TOOLS.md - บันทึกภายในเครื่อง

Skills กำหนดว่าเครื่องมือทำงาน _อย่างไร_ ไฟล์นี้มีไว้สำหรับรายละเอียดเฉพาะของ _คุณ_ — สิ่งที่เป็นเอกลักษณ์ของการตั้งค่าของคุณ

## ควรใส่อะไรไว้ที่นี่

ตัวอย่างเช่น:

- ชื่อและตำแหน่งของกล้อง
- โฮสต์และนามแฝงของ SSH
- เสียงที่ต้องการสำหรับ TTS
- ชื่อผู้พูด/ห้อง
- ชื่อเล่นของอุปกรณ์
- สิ่งใดๆที่ขึ้นกับสภาพแวดล้อม

## ตัวอย่าง

```markdown
### Cameras

- living-room → Main area, 180° wide angle
- front-door → Entrance, motion-triggered

### SSH

- home-server → 192.168.1.100, user: admin

### TTS

- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod
```

## ทำไมต้องแยกไฟล์

Skills ใช้ร่วมกันได้ การตั้งค่าของคุณเป็นของคุณเอง การแยกออกจากกันช่วยให้คุณอัปเดต Skills ได้โดยไม่สูญเสียบันทึกของคุณ และสามารถแชร์ Skills ได้โดยไม่เปิดเผยโครงสร้างพื้นฐานของคุณ

---

เพิ่มอะไรก็ได้ที่ช่วยให้คุณทำงานได้สะดวกขึ้น นี่คือชีตสรุปของคุณ
