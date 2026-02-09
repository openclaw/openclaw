---
summary: "แนวทางในการเลือกใช้ heartbeat และ cron jobs สำหรับระบบอัตโนมัติ"
read_when:
  - การตัดสินใจว่าจะตั้งเวลางานที่ทำซ้ำอย่างไร
  - การตั้งค่าการมอนิเตอร์หรือการแจ้งเตือนเบื้องหลัง
  - การเพิ่มประสิทธิภาพการใช้โทเคนสำหรับการตรวจสอบเป็นระยะ
title: "Cron เทียบกับ Heartbeat"
---

# Cron เทียบกับ Heartbeat: ควรใช้เมื่อใด

ทั้ง heartbeat และ cron jobs ช่วยให้คุณรันงานตามตารางเวลาได้ คู่มือนี้ช่วยให้คุณเลือกกลไกที่เหมาะสมกับกรณีการใช้งานของคุณ This guide helps you choose the right mechanism for your use case.

## คู่มือการตัดสินใจอย่างรวดเร็ว

| กรณีการใช้งาน                                                    | แนะนำ                                  | เหตุผล                                    |
| ---------------------------------------------------------------- | -------------------------------------- | ----------------------------------------- |
| ตรวจสอบกล่องข้อความทุก 30 นาที                                   | Heartbeat                              | รวมกับการตรวจสอบอื่นๆและรับรู้บริบท       |
| ส่งรายงานประจำวันตรงเวลา 9:00 น. | Cron (isolated)     | ต้องการเวลาที่แม่นยำ                      |
| มอนิเตอร์ปฏิทินสำหรับอีเวนต์ที่จะมาถึง                           | Heartbeat                              | เหมาะสมตามธรรมชาติสำหรับการรับรู้เป็นระยะ |
| รันการวิเคราะห์เชิงลึกรายสัปดาห์                                 | Cron (isolated)     | งานเดี่ยวสามารถใช้โมเดลอื่นได้            |
| เตือนฉันในอีก 20 นาที                                            | Cron (main, `--at`) | งานครั้งเดียวที่ต้องการความแม่นยำ         |
| ตรวจสอบสุขภาพโปรเจ็กต์เบื้องหลัง                                 | Heartbeat                              | Piggybacks on existing cycle              |

## Heartbeat: การรับรู้เป็นระยะ

Heartbeat จะรันใน **main session** ตามช่วงเวลาที่กำหนดอย่างสม่ำเสมอ (ค่าเริ่มต้น: 30 นาที) ออกแบบมาเพื่อให้เอเจนต์ตรวจสอบสิ่งต่างๆและนำเสนอสิ่งสำคัญ They're designed for the agent to check on things and surface anything important.

### เมื่อใดควรใช้ heartbeat

- **การตรวจสอบเป็นระยะหลายรายการ**: แทนที่จะมี cron jobs แยก 5 งานเพื่อตรวจสอบกล่องข้อความ ปฏิทิน สภาพอากาศ การแจ้งเตือน และสถานะโปรเจ็กต์ heartbeat เดียวสามารถรวมทั้งหมดได้
- **การตัดสินใจที่รับรู้บริบท**: เอเจนต์มีบริบทของ main session ครบถ้วน จึงตัดสินใจได้อย่างชาญฉลาดว่าอะไรเร่งด่วนหรือรอได้
- **ความต่อเนื่องของการสนทนา**: การรัน heartbeat ใช้เซสชันเดียวกัน เอเจนต์จึงจำการสนทนาล่าสุดและติดตามต่อได้อย่างเป็นธรรมชาติ
- **การมอนิเตอร์ที่มีโอเวอร์เฮดต่ำ**: heartbeat หนึ่งครั้งแทนที่งาน polling เล็กๆหลายงาน

### ข้อดีของ heartbeat

- **รวมการตรวจสอบหลายรายการ**: การทำงานของเอเจนต์หนึ่งรอบสามารถตรวจสอบกล่องข้อความ ปฏิทิน และการแจ้งเตือนพร้อมกัน
- **ลดการเรียก API**: heartbeat เดียวมีต้นทุนต่ำกว่า cron jobs แยก 5 งาน
- **รับรู้บริบท**: เอเจนต์รู้ว่าคุณกำลังทำอะไรอยู่และจัดลำดับความสำคัญได้
- **การระงับอย่างชาญฉลาด**: หากไม่มีสิ่งที่ต้องสนใจ เอเจนต์จะตอบกลับเป็น `HEARTBEAT_OK` และจะไม่มีการส่งข้อความ
- **จังหวะเวลาที่เป็นธรรมชาติ**: เวลาอาจคลาดเคลื่อนเล็กน้อยตามโหลดของคิว ซึ่งเหมาะกับงานมอนิเตอร์ส่วนใหญ่

### ตัวอย่าง heartbeat: เช็กลิสต์ HEARTBEAT.md

```md
# Heartbeat checklist

- Check email for urgent messages
- Review calendar for events in next 2 hours
- If a background task finished, summarize results
- If idle for 8+ hours, send a brief check-in
```

เอเจนต์จะอ่านสิ่งนี้ในทุก heartbeat และจัดการทุกรายการในหนึ่งรอบ

### การตั้งค่า heartbeat

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // interval
        target: "last", // where to deliver alerts
        activeHours: { start: "08:00", end: "22:00" }, // optional
      },
    },
  },
}
```

ดู [Heartbeat](/gateway/heartbeat) สำหรับการกำหนดค่าแบบครบถ้วน

## Cron: การตั้งเวลาที่แม่นยำ

Cron jobs จะรันใน **เวลาที่แน่นอน** และสามารถรันในเซสชันแบบ isolated โดยไม่กระทบบริบทหลัก

### เมื่อใดควรใช้ cron

- **ต้องการเวลาที่แม่นยำ**: “ส่งสิ่งนี้ทุกวันจันทร์เวลา 9:00 น.” (ไม่ใช่ “ประมาณ 9 โมง”)
- **งานเดี่ยว**: งานที่ไม่ต้องใช้บริบทการสนทนา
- **โมเดล/การคิดที่แตกต่าง**: การวิเคราะห์หนักที่ควรใช้โมเดลที่ทรงพลังขึ้น
- **การเตือนแบบครั้งเดียว**: “เตือนฉันในอีก 20 นาที” พร้อม `--at`
- **งานที่ถี่หรือมีเสียงรบกวน**: งานที่อาจทำให้ประวัติ main session รกรุงรัง
- **ทริกเกอร์ภายนอก**: งานที่ควรรันได้เองโดยไม่ขึ้นกับการทำงานอื่นของเอเจนต์

### ข้อดีของ cron

- **เวลาที่แม่นยำ**: นิพจน์ cron 5 ฟิลด์พร้อมรองรับโซนเวลา
- **แยกเซสชัน**: รันใน `cron:<jobId>` โดยไม่ปนกับประวัติหลัก
- **การแทนที่โมเดล**: เลือกใช้โมเดลที่ถูกกว่าหรือทรงพลังกว่าต่อหนึ่งงาน
- **การควบคุมการส่งมอบ**: งาน isolated ค่าเริ่มต้นคือ `announce` (สรุป); เลือก `none` ได้ตามต้องการ
- **การส่งทันที**: โหมด announce จะโพสต์โดยตรงโดยไม่ต้องรอ heartbeat
- **ไม่ต้องใช้บริบทเอเจนต์**: รันได้แม้ main session จะว่างหรือถูกย่อ
- **รองรับงานครั้งเดียว**: `--at` สำหรับเวลาที่แม่นยำในอนาคต

### ตัวอย่าง cron: บรีฟรายงานตอนเช้าประจำวัน

```bash
openclaw cron add \
  --name "Morning briefing" \
  --cron "0 7 * * *" \
  --tz "America/New_York" \
  --session isolated \
  --message "Generate today's briefing: weather, calendar, top emails, news summary." \
  --model opus \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

งานนี้จะรันตรงเวลา 7:00 น. ตามเวลา New York ใช้ Opus เพื่อคุณภาพ และประกาศสรุปไปยัง WhatsApp โดยตรง

### ตัวอย่าง cron: การเตือนแบบครั้งเดียว

```bash
openclaw cron add \
  --name "Meeting reminder" \
  --at "20m" \
  --session main \
  --system-event "Reminder: standup meeting starts in 10 minutes." \
  --wake now \
  --delete-after-run
```

ดู [Cron jobs](/automation/cron-jobs) สำหรับเอกสารอ้างอิง CLI แบบครบถ้วน

## ผังการตัดสินใจ

```
Does the task need to run at an EXACT time?
  YES -> Use cron
  NO  -> Continue...

Does the task need isolation from main session?
  YES -> Use cron (isolated)
  NO  -> Continue...

Can this task be batched with other periodic checks?
  YES -> Use heartbeat (add to HEARTBEAT.md)
  NO  -> Use cron

Is this a one-shot reminder?
  YES -> Use cron with --at
  NO  -> Continue...

Does it need a different model or thinking level?
  YES -> Use cron (isolated) with --model/--thinking
  NO  -> Use heartbeat
```

## การใช้ร่วมกันทั้งสองแบบ

การตั้งค่าที่มีประสิทธิภาพที่สุดคือใช้ **ทั้งคู่**:

1. **Heartbeat** จัดการการมอนิเตอร์ประจำ (กล่องข้อความ ปฏิทิน การแจ้งเตือน) ในหนึ่งรอบทุก 30 นาที
2. **Cron** จัดการตารางเวลาที่แม่นยำ (รายงานประจำวัน การทบทวนรายสัปดาห์) และการเตือนแบบครั้งเดียว

### ตัวอย่าง: การตั้งค่าระบบอัตโนมัติอย่างมีประสิทธิภาพ

**HEARTBEAT.md** (ตรวจทุก 30 นาที):

```md
# Heartbeat checklist

- Scan inbox for urgent emails
- Check calendar for events in next 2h
- Review any pending tasks
- Light check-in if quiet for 8+ hours
```

**Cron jobs** (เวลาที่แม่นยำ):

```bash
# Daily morning briefing at 7am
openclaw cron add --name "Morning brief" --cron "0 7 * * *" --session isolated --message "..." --announce

# Weekly project review on Mondays at 9am
openclaw cron add --name "Weekly review" --cron "0 9 * * 1" --session isolated --message "..." --model opus

# One-shot reminder
openclaw cron add --name "Call back" --at "2h" --session main --system-event "Call back the client" --wake now
```

## Lobster: เวิร์กโฟลว์แบบกำหนดแน่นอนพร้อมการอนุมัติ

Lobster คือรันไทม์เวิร์กโฟลว์สำหรับ **pipeline เครื่องมือหลายขั้นตอน** ที่ต้องการการทำงานแบบกำหนดแน่นอนและการอนุมัติที่ชัดเจน
ใช้เมื่อภารกิจมีมากกว่าการทำงานของเอเจนต์หนึ่งรอบ และคุณต้องการเวิร์กโฟลว์ที่หยุดต่อได้พร้อมจุดตรวจจากมนุษย์
Use it when the task is more than a single agent turn, and you want a resumable workflow with human checkpoints.

### เมื่อใดที่ Lobster เหมาะสม

- **ระบบอัตโนมัติหลายขั้นตอน**: ต้องการ pipeline ของการเรียกเครื่องมือแบบคงที่ ไม่ใช่พรอมป์ครั้งเดียว
- **ประตูการอนุมัติ**: ผลข้างเคียงควรหยุดรอการอนุมัติ แล้วจึงทำต่อ
- **การรันต่อได้**: ดำเนินเวิร์กโฟลว์ที่หยุดไว้ต่อโดยไม่ต้องรันขั้นตอนก่อนหน้าใหม่

### การทำงานร่วมกับ heartbeat และ cron

- **Heartbeat/cron** ตัดสินใจว่า _เมื่อใด_ จะเริ่มรัน
- **Lobster** กำหนดว่า _มีขั้นตอนใด_ เกิดขึ้นเมื่อเริ่มรันแล้ว

สำหรับเวิร์กโฟลว์ตามตาราง ให้ใช้ cron หรือ heartbeat เพื่อทริกเกอร์การทำงานของเอเจนต์ที่เรียก Lobster
สำหรับเวิร์กโฟลว์เฉพาะกิจ ให้เรียก Lobster โดยตรง
For ad-hoc workflows, call Lobster directly.

### หมายเหตุการปฏิบัติงาน (จากโค้ด)

- Lobster รันเป็น **subprocess ภายในเครื่อง** (`lobster` CLI) ในโหมดเครื่องมือและส่งกลับ **ซอง JSON**
- หากเครื่องมือส่งกลับ `needs_approval` คุณจะดำเนินการต่อด้วย `resumeToken` และแฟล็ก `approve`
- เครื่องมือนี้เป็น **ปลั๊กอินแบบไม่บังคับ**; เปิดใช้งานแบบเพิ่มเข้าไปผ่าน `tools.alsoAllow: ["lobster"]` (แนะนำ)
- หากคุณส่ง `lobsterPath` ต้องเป็น **พาธแบบ absolute**

ดู [Lobster](/tools/lobster) สำหรับการใช้งานและตัวอย่างทั้งหมด

## Main Session เทียบกับ Isolated Session

ทั้ง heartbeat และ cron สามารถโต้ตอบกับ main session ได้ แต่แตกต่างกัน:

|         | Heartbeat                    | Cron (main)              | Cron (isolated)          |
| ------- | ---------------------------- | ------------------------------------------- | ------------------------------------------- |
| Session | Main                         | Main (ผ่าน system event) | `cron:<jobId>`                              |
| History | ร่วมกัน                      | ร่วมกัน                                     | ใหม่ทุกครั้ง                                |
| Context | ครบถ้วน                      | ครบถ้วน                                     | ไม่มี (เริ่มใหม่)        |
| Model   | โมเดลของ main session        | โมเดลของ main session                       | สามารถแทนที่ได้                             |
| Output  | ส่งหากไม่เป็น `HEARTBEAT_OK` | พรอมป์ heartbeat + อีเวนต์                  | ประกาศสรุป (ค่าเริ่มต้น) |

### เมื่อใดควรใช้ cron แบบ main session

ใช้ `--session main` ร่วมกับ `--system-event` เมื่อคุณต้องการ:

- ให้การเตือน/อีเวนต์ปรากฏในบริบทของ main session
- ให้เอเจนต์จัดการใน heartbeat ถัดไปด้วยบริบทครบถ้วน
- ไม่มีการรันแบบ isolated แยกต่างหาก

```bash
openclaw cron add \
  --name "Check project" \
  --every "4h" \
  --session main \
  --system-event "Time for a project health check" \
  --wake now
```

### เมื่อใดควรใช้ cron แบบ isolated

ใช้ `--session isolated` เมื่อคุณต้องการ:

- A clean slate without prior context
- โมเดลหรือการตั้งค่าการคิดที่แตกต่าง
- ประกาศสรุปไปยังช่องทางโดยตรง
- ประวัติที่ไม่รบกวน main session

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 0" \
  --session isolated \
  --message "Weekly codebase analysis..." \
  --model opus \
  --thinking high \
  --announce
```

## การพิจารณาด้านต้นทุน

| กลไก                               | โปรไฟล์ต้นทุน                                                            |
| ---------------------------------- | ------------------------------------------------------------------------ |
| Heartbeat                          | หนึ่งรอบทุก N นาที; สเกลตามขนาด HEARTBEAT.md             |
| Cron (main)     | เพิ่มอีเวนต์ไปยัง heartbeat ถัดไป (ไม่มีรอบ isolated) |
| Cron (isolated) | หนึ่งรอบเอเจนต์เต็มต่อหนึ่งงาน; ใช้โมเดลที่ถูกกว่าได้                    |

**เคล็ดลับ**:

- รักษา `HEARTBEAT.md` ให้เล็กเพื่อลดโอเวอร์เฮดของโทเคน
- รวมการตรวจสอบที่คล้ายกันไว้ใน heartbeat แทนการใช้ cron jobs หลายรายการ
- ใช้ `target: "none"` บน heartbeat หากต้องการเพียงการประมวลผลภายใน
- ใช้ cron แบบ isolated กับโมเดลที่ถูกกว่าสำหรับงานประจำ

## เกี่ยวข้อง

- [Heartbeat](/gateway/heartbeat) - การกำหนดค่า heartbeat แบบครบถ้วน
- [Cron jobs](/automation/cron-jobs) - เอกสารอ้างอิง CLI และ API ของ cron แบบครบถ้วน
- [System](/cli/system) - system events และการควบคุม heartbeat
