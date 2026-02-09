---
summary: บันทึกปัญหาและวิธีแก้ไขชั่วคราวของการแครช Node + tsx "__name is not a function"
read_when:
  - ดีบักสคริปต์พัฒนาแบบ Node เท่านั้นหรือความล้มเหลวของโหมด watch
  - ตรวจสอบการแครชของตัวโหลด tsx/esbuild ใน OpenClaw
title: "การแครช Node + tsx"
---

# Node + tsx "\_\_name is not a function" crash

## Summary

การรัน OpenClaw ผ่าน Node โดยมี `tsx` ล้มเหลวตั้งแต่เริ่มต้นด้วย:

```
[openclaw] Failed to start CLI: TypeError: __name is not a function
    at createSubsystemLogger (.../src/logging/subsystem.ts:203:25)
    at .../src/agents/auth-profiles/constants.ts:25:20
```

ปัญหานี้เริ่มขึ้นหลังจากสลับสคริปต์พัฒนาจาก Bun เป็น `tsx` (คอมมิต `2871657e`, 2026-01-06) เส้นทางรันไทม์เดียวกันทำงานได้กับ Bun `tsx` ใช้ esbuild เพื่อแปลง TS/ESM

## Environment

- Node: v25.x (พบใน v25.3.0)
- tsx: 4.21.0
- OS: macOS (มีแนวโน้มจะทำซ้ำได้บนแพลตฟอร์มอื่นที่รัน Node 25)

## Repro (Node-only)

```bash
# in repo root
node --version
pnpm install
node --import tsx src/entry.ts status
```

## Minimal repro in repo

```bash
node --import tsx scripts/repro/tsx-name-repro.ts
```

## Node version check

- Node 25.3.0: ล้มเหลว
- Node 22.22.0 (Homebrew `node@22`): ล้มเหลว
- Node 24: ยังไม่ได้ติดตั้งที่นี่; ต้องตรวจสอบ

## Notes / hypothesis

- `tsx` uses esbuild to transform TS/ESM. `tsx` ใช้ esbuild เพื่อแปลง TS/ESM โดย esbuild’s `keepNames` จะปล่อยเฮลเปอร์ `__name` และห่อหุ้มคำจำกัดความของฟังก์ชันด้วย `__name(...)`.
- การแครชบ่งชี้ว่า `__name` มีอยู่แต่ไม่ใช่ฟังก์ชันในขณะรันไทม์ ซึ่งสื่อว่าเฮลเปอร์หายไปหรือถูกเขียนทับสำหรับโมดูลนี้ในเส้นทางตัวโหลดของ Node 25
- มีรายงานปัญหาเฮลเปอร์ `__name` ที่คล้ายกันในผู้ใช้ esbuild รายอื่นเมื่อเฮลเปอร์หายไปหรือถูกเขียนใหม่

## Regression history

- `2871657e` (2026-01-06): เปลี่ยนสคริปต์จาก Bun เป็น tsx เพื่อทำให้ Bun เป็นทางเลือก
- ก่อนหน้านั้น (เส้นทาง Bun), `openclaw status` และ `gateway:watch` ทำงานได้

## Workarounds

- ใช้ Bun สำหรับสคริปต์พัฒนา (การย้อนกลับชั่วคราวในปัจจุบัน)

- ใช้ Node + tsc watch จากนั้นรันเอาต์พุตที่คอมไพล์แล้ว:

  ```bash
  pnpm exec tsc --watch --preserveWatchOutput
  node --watch openclaw.mjs status
  ```

- ยืนยันในเครื่องแล้ว: `pnpm exec tsc -p tsconfig.json` + `node openclaw.mjs status` ใช้งานได้บน Node 25

- ปิด esbuild keepNames ในตัวโหลด TS หากเป็นไปได้ (ป้องกันการแทรกเฮลเปอร์ `__name`); ปัจจุบัน tsx ยังไม่เปิดเผยตัวเลือกนี้

- ทดสอบ Node LTS (22/24) ด้วย `tsx` เพื่อดูว่าปัญหาเฉพาะ Node 25 หรือไม่

## References

- [https://opennext.js.org/cloudflare/howtos/keep_names](https://opennext.js.org/cloudflare/howtos/keep_names)
- [https://esbuild.github.io/api/#keep-names](https://esbuild.github.io/api/#keep-names)
- [https://github.com/evanw/esbuild/issues/1031](https://github.com/evanw/esbuild/issues/1031)

## Next steps

- ทำซ้ำบน Node 22/24 เพื่อยืนยันว่าเป็นรีเกรสชันของ Node 25
- ทดสอบ `tsx` รุ่น nightly หรือปักหมุดไปยังเวอร์ชันก่อนหน้า หากมีรีเกรสชันที่ทราบ
- หากทำซ้ำได้บน Node LTS ให้ยื่นรายงาน repro ขั้นต่ำ upstream พร้อมสแตกเทรซ `__name`
