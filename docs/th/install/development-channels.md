---
summary: "ช่องทาง stable, beta และ dev: ความหมาย การสลับ และการติดแท็ก"
read_when:
  - คุณต้องการสลับระหว่าง stable/beta/dev
  - คุณกำลังติดแท็กหรือเผยแพร่ prerelease
title: "ช่องทางการพัฒนา"
---

# ช่องทางการพัฒนา

อัปเดตล่าสุด: 2026-01-21

OpenClaw มีช่องทางอัปเดตสามช่องทาง:

- **stable**: npm dist-tag `latest`.
- **beta**: npm dist-tag `beta` (บิลด์ที่อยู่ระหว่างการทดสอบ).
- **dev**: head ที่เคลื่อนไหวของ `main` (git). npm dist-tag: `dev` (เมื่อมีการเผยแพร่).

เราจะส่งบิลด์ไปที่ **beta**, ทดสอบ จากนั้น **เลื่อนบิลด์ที่ผ่านการคัดกรองไปยัง `latest`**
โดยไม่เปลี่ยนหมายเลขเวอร์ชัน — dist-tag คือแหล่งความจริงสำหรับการติดตั้งผ่าน npm

## การสลับช่องทาง

Git checkout:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

- `stable`/`beta` จะ checkout แท็กล่าสุดที่ตรงกัน (มักเป็นแท็กเดียวกัน).
- `dev` สลับไปที่ `main` และ rebase กับ upstream.

การติดตั้งแบบ global ด้วย npm/pnpm:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

สิ่งนี้จะอัปเดตผ่าน npm dist-tag ที่สอดคล้องกัน (`latest`, `beta`, `dev`).

เมื่อคุณสลับช่องทาง **อย่างชัดเจน** ด้วย `--channel`, OpenClaw จะจัดแนววิธีการติดตั้งให้สอดคล้องกันด้วย:

- `dev` รับประกันว่าเป็น git checkout (ค่าเริ่มต้น `~/openclaw`, สามารถ override ด้วย `OPENCLAW_GIT_DIR`),
  อัปเดตมัน และติดตั้ง CLI แบบ global จาก checkout นั้น.
- `stable`/`beta` ติดตั้งจาก npm โดยใช้ dist-tag ที่ตรงกัน.

เคล็ดลับ: หากต้องการใช้ stable + dev ควบคู่กัน ให้เก็บสองโคลนและชี้ Gateway（เกตเวย์）ของคุณไปที่ตัว stable

## ปลั๊กอินและช่องทาง

เมื่อคุณสลับช่องทางด้วย `openclaw update`, OpenClaw จะซิงก์ซอร์สปลั๊กอินด้วย:

- `dev` จะเลือกใช้ปลั๊กอินที่มากับ git checkout เป็นหลัก.
- `stable` และ `beta` จะคืนค่าปลั๊กอินแพ็กเกจที่ติดตั้งผ่าน npm.

## แนวปฏิบัติที่ดีที่สุดในการติดแท็ก

- ติดแท็กรีลีสที่คุณต้องการให้ git checkout ไปลง (`vYYYY.M.D` หรือ `vYYYY.M.D-<patch>`).
- รักษาแท็กให้ไม่เปลี่ยนแปลง: ห้ามย้ายหรือใช้แท็กซ้ำ.
- npm dist-tag ยังคงเป็นแหล่งความจริงสำหรับการติดตั้งผ่าน npm:
  - `latest` → stable
  - `beta` → candidate build
  - `dev` → snapshot ของ main (ไม่บังคับ)

## ความพร้อมใช้งานของแอป macOS

บิลด์ beta และ dev อาจ **ไม่** มีรีลีสแอป macOS ซึ่งถือว่าโอเค: That’s OK:

- ยังสามารถเผยแพร่ git tag และ npm dist-tag ได้.
- ระบุว่า “ไม่มีบิลด์ macOS สำหรับ beta นี้” ในบันทึกรีลีสหรือ changelog.
