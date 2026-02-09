---
summary: "เวิร์กโฟลว์ Bun(ทดลอง): การติดตั้งและข้อควรระวังเมื่อเทียบกับ pnpm"
read_when:
  - คุณต้องการลูปการพัฒนาในเครื่องที่เร็วที่สุด(bun + watch)
  - คุณพบปัญหา Bun ในขั้นตอนติดตั้ง/แพตช์/สคริปต์ lifecycle
title: "Bun(ทดลอง)"
---

# Bun(ทดลอง)

เป้าหมาย: รันรีโปนี้ด้วย **Bun** (ไม่บังคับ และไม่แนะนำสำหรับ WhatsApp/Telegram)
โดยไม่แยกออกจากเวิร์กโฟลว์ pnpm

⚠️ **ไม่แนะนำสำหรับ Gateway runtime** (มีบั๊กกับ WhatsApp/Telegram) ให้ใช้ Node สำหรับโปรดักชัน Use Node for production.

## สถานะ

- Bun เป็นรันไทม์ในเครื่องแบบไม่บังคับสำหรับรัน TypeScript โดยตรง (`bun run …`, `bun --watch …`).
- `pnpm` เป็นค่าเริ่มต้นสำหรับการบิลด์และยังคงรองรับอย่างเต็มที่ (และถูกใช้โดยเครื่องมือเอกสารบางส่วน).
- Bun ไม่สามารถใช้ `pnpm-lock.yaml` และจะเพิกเฉยต่อมัน

## ติดตั้ง

ค่าเริ่มต้น:

```sh
bun install
```

หมายเหตุ: `bun.lock`/`bun.lockb` ถูก gitignore ดังนั้นจะไม่ทำให้รีโปมีการเปลี่ยนแปลงไม่ว่าทางไหน หากต้องการ _ไม่ให้มีการเขียน lockfile_: If you want _no lockfile writes_:

```sh
bun install --no-save
```

## บิลด์ / ทดสอบ(Bun)

```sh
bun run build
bun run vitest run
```

## สคริปต์ lifecycle ของ Bun(ถูกบล็อกเป็นค่าเริ่มต้น)

Bun อาจบล็อกสคริปต์ lifecycle ของ dependency เว้นแต่จะเชื่อถืออย่างชัดเจน (`bun pm untrusted` / `bun pm trust`).
สำหรับรีโปนี้ สคริปต์ที่มักถูกบล็อกไม่จำเป็นต้องใช้:

- `@whiskeysockets/baileys` `preinstall`: ตรวจสอบ Node เวอร์ชันหลัก >= 20 (เราใช้ Node 22+).
- `protobufjs` `postinstall`: แสดงคำเตือนเกี่ยวกับสคีมเวอร์ชันที่ไม่เข้ากัน (ไม่มีอาร์ติแฟกต์จากการบิลด์).

หากคุณพบปัญหารันไทม์จริงที่ต้องใช้สคริปต์เหล่านี้ ให้เชื่อถืออย่างชัดเจน:

```sh
bun pm trust @whiskeysockets/baileys protobufjs
```

## Caveats

- สคริปต์บางส่วนยังฮาร์ดโค้ด pnpm อยู่ (เช่น `docs:build`, `ui:*`, `protocol:check`). ให้รันสคริปต์เหล่านั้นผ่าน pnpm ไปก่อน
