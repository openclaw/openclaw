---
summary: "OpenProse: เวิร์กโฟลว์ .prose คำสั่งสแลช และสถานะใน OpenClaw"
read_when:
  - คุณต้องการรันหรือเขียนเวิร์กโฟลว์ .prose
  - คุณต้องการเปิดใช้งานปลั๊กอิน OpenProse
  - คุณจำเป็นต้องเข้าใจการจัดเก็บสถานะ
title: "OpenProse"
---

# OpenProse

OpenProse คือรูปแบบเวิร์กโฟลว์แบบพกพาที่ยึด Markdown เป็นหลัก สำหรับการควบคุมการทำงานของเซสชัน AI ใน OpenClaw จะมาในรูปแบบปลั๊กอินที่ติดตั้งแพ็ก Skills ของ OpenProse พร้อมคำสั่งสแลช `/prose` โปรแกรมจะอยู่ในไฟล์ `.prose` และสามารถสร้างซับเอเจนต์หลายตัวพร้อมการควบคุมโฟลว์อย่างชัดเจน 24. ใน OpenClaw จะถูกจัดส่งมาในรูปแบบปลั๊กอินที่ติดตั้งชุดสกิล OpenProse พร้อมคำสั่งสแลช `/prose` 25. โปรแกรมจะอยู่ในไฟล์ `.prose` และสามารถสร้างซับเอเจนต์หลายตัวพร้อมการควบคุมโฟลว์อย่างชัดเจน

เว็บไซต์ทางการ: [https://www.prose.md](https://www.prose.md)

## ทำอะไรได้บ้าง

- การวิจัยและสังเคราะห์แบบหลายเอเจนต์พร้อมการทำงานขนานที่ชัดเจน
- เวิร์กโฟลว์ที่ทำซ้ำได้และปลอดภัยต่อการอนุมัติ(เช่น การรีวิวโค้ด การคัดแยกเหตุขัดข้อง พายป์ไลน์เนื้อหา)
- โปรแกรม `.prose` ที่นำกลับมาใช้ซ้ำได้และรันข้ามรันไทม์เอเจนต์ที่รองรับ

## ติดตั้งและเปิดใช้งาน

ปลั๊กอินที่มาพร้อมระบบจะถูกปิดใช้งานเป็นค่าเริ่มต้น ให้เปิดใช้งาน OpenProse: 26. เปิดใช้งาน OpenProse:

```bash
openclaw plugins enable open-prose
```

รีสตาร์ท Gateway หลังจากเปิดใช้งานปลั๊กอิน

สำหรับการเช็กเอาต์แบบ Dev/Local: `openclaw plugins install ./extensions/open-prose`

เอกสารที่เกี่ยวข้อง: [Plugins](/tools/plugin), [Plugin manifest](/plugins/manifest), [Skills](/tools/skills)

## คำสั่งสแลช

27. OpenProse ลงทะเบียน `/prose` เป็นคำสั่งสกิลที่ผู้ใช้เรียกใช้ได้ OpenProse ลงทะเบียน `/prose` เป็นคำสั่ง Skills ที่ผู้ใช้เรียกได้ โดยจะส่งต่อไปยังคำสั่งของ OpenProse VM และใช้เครื่องมือของ OpenClaw เบื้องหลัง

คำสั่งที่ใช้บ่อย:

```
/prose help
/prose run <file.prose>
/prose run <handle/slug>
/prose run <https://example.com/file.prose>
/prose compile <file.prose>
/prose examples
/prose update
```

## ตัวอย่าง: ไฟล์ `.prose` แบบง่าย

```prose
# Research + synthesis with two agents running in parallel.

input topic: "What should we research?"

agent researcher:
  model: sonnet
  prompt: "You research thoroughly and cite sources."

agent writer:
  model: opus
  prompt: "You write a concise summary."

parallel:
  findings = session: researcher
    prompt: "Research {topic}."
  draft = session: writer
    prompt: "Summarize {topic}."

session "Merge the findings + draft into a final answer."
context: { findings, draft }
```

## ตำแหน่งไฟล์

OpenProse จัดเก็บสถานะไว้ที่ `.prose/` ในเวิร์กสเปซของคุณ:

```
.prose/
├── .env
├── runs/
│   └── {YYYYMMDD}-{HHMMSS}-{random}/
│       ├── program.prose
│       ├── state.md
│       ├── bindings/
│       └── agents/
└── agents/
```

เอเจนต์ถาวรระดับผู้ใช้จะอยู่ที่:

```
~/.prose/agents/
```

## โหมดสถานะ

OpenProse รองรับแบ็กเอนด์สถานะหลายแบบ:

- **filesystem** (ค่าเริ่มต้น): `.prose/runs/...`
- **in-context**: ชั่วคราว เหมาะสำหรับโปรแกรมขนาดเล็ก
- **sqlite** (ทดลองใช้): ต้องมีไบนารี `sqlite3`
- **postgres** (ทดลองใช้): ต้องมี `psql` และสตริงการเชื่อมต่อ

หมายเหตุ:

- sqlite/postgres เป็นตัวเลือกเสริมและอยู่ในสถานะทดลอง
- ข้อมูลรับรองของ postgres จะไหลไปยังล็อกของซับเอเจนต์ ควรใช้ฐานข้อมูลเฉพาะที่ให้สิทธิ์น้อยที่สุด

## โปรแกรมระยะไกล

`/prose run <handle/slug>` จะถูกแก้ไขเป็น `https://p.prose.md/<handle>/<slug>`.
28. URL โดยตรงจะถูกดึงมาใช้งานตามสภาพเดิม URL แบบตรงจะถูกดึงตามที่เป็นอยู่ ใช้เครื่องมือ `web_fetch` (หรือ `exec` สำหรับ POST)

## การแมประหว่างรันไทม์ของ OpenClaw

โปรแกรม OpenProse จะถูกแมปกับองค์ประกอบของ OpenClaw ดังนี้:

| แนวคิดของ OpenProse           | เครื่องมือ OpenClaw |
| ----------------------------- | ------------------- |
| สร้างเซสชัน / เครื่องมือ Task | `sessions_spawn`    |
| อ่าน/เขียนไฟล์                | `read` / `write`    |
| ดึงข้อมูลเว็บ                 | `web_fetch`         |

หาก allowlist ของเครื่องมือบล็อกเครื่องมือเหล่านี้ โปรแกรม OpenProse จะล้มเหลว ดู [Skills config](/tools/skills-config) 29. ดูที่ [Skills config](/tools/skills-config).

## ความปลอดภัยและการอนุมัติ

30. ปฏิบัติต่อไฟล์ `.prose` เหมือนโค้ด 31. ตรวจสอบก่อนรัน ปฏิบัติต่อไฟล์ `.prose` เสมือนโค้ด ตรวจทานก่อนรัน ใช้ allowlist ของเครื่องมือ OpenClaw และเกตการอนุมัติเพื่อควบคุมผลข้างเคียง

สำหรับเวิร์กโฟลว์ที่กำหนดผลลัพธ์ได้แน่นอนและต้องผ่านการอนุมัติ เปรียบเทียบกับ [Lobster](/tools/lobster)
