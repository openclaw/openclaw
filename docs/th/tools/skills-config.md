---
summary: "สคีมาคอนฟิกSkillsและตัวอย่าง"
read_when:
  - เพิ่มหรือแก้ไขคอนฟิกSkills
  - ปรับรายการอนุญาตแบบรวมมาหรือพฤติกรรมการติดตั้ง
title: "คอนฟิกSkills"
---

# คอนฟิกSkills

การกำหนดค่าที่เกี่ยวข้องกับSkillsทั้งหมดอยู่ภายใต้ `skills` ใน `~/.openclaw/openclaw.json`.

```json5
{
  skills: {
    allowBundled: ["gemini", "peekaboo"],
    load: {
      extraDirs: ["~/Projects/agent-scripts/skills", "~/Projects/oss/some-skill-pack/skills"],
      watch: true,
      watchDebounceMs: 250,
    },
    install: {
      preferBrew: true,
      nodeManager: "npm", // npm | pnpm | yarn | bun (Gateway runtime still Node; bun not recommended)
    },
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

## ฟิลด์

- `allowBundled`: allowlist แบบไม่บังคับสำหรับสกิลแบบ **bundled** เท่านั้น `allowBundled`: รายการอนุญาตแบบไม่บังคับสำหรับSkillsที่ **รวมมา** เท่านั้น เมื่อกำหนดแล้ว จะมีสิทธิ์เฉพาะSkillsที่รวมมาและอยู่ในรายการ (ไม่กระทบSkillsแบบ managed/workspace)
- `load.extraDirs`: ไดเรกทอรีSkillsเพิ่มเติมที่จะสแกน (ลำดับความสำคัญต่ำสุด)
- `load.watch`: เฝ้าดูโฟลเดอร์Skillsและรีเฟรชสแน็ปช็อตSkills (ค่าเริ่มต้น: true)
- `load.watchDebounceMs`: ค่า debounce สำหรับอีเวนต์ของตัวเฝ้าดูSkillsเป็นมิลลิวินาที (ค่าเริ่มต้น: 250)
- `install.preferBrew`: เลือกใช้ตัวติดตั้งผ่าน brew เมื่อมีให้ใช้ (ค่าเริ่มต้น: true)
- `install.nodeManager`: ค่ากำหนดตัวติดตั้ง node (`npm` | `pnpm` | `yarn` | `bun`, ค่าเริ่มต้น: npm)
  `install.nodeManager`: ค่าความชอบของตัวติดตั้งโหนด (`npm` | `pnpm` | `yarn` | `bun`, ค่าเริ่มต้น: npm)
  สิ่งนี้มีผลเฉพาะกับ **การติดตั้งSkills** เท่านั้น; รันไทม์ของ Gateway ควรยังเป็น Node
  (ไม่แนะนำ Bun สำหรับ WhatsApp/Telegram)
- `entries.<skillKey>`: การ override รายSkill

ฟิลด์ต่อSkill:

- `enabled`: ตั้งค่า `false` เพื่อปิดการใช้งานSkill แม้ว่าจะถูกรวมมาหรือติดตั้งแล้ว
- `env`: ตัวแปรสภาพแวดล้อมที่ฉีดให้กับการรันเอเจนต์ (เฉพาะกรณีที่ยังไม่ได้ตั้งค่า)
- `apiKey`: ตัวช่วยแบบไม่บังคับสำหรับSkillsที่ประกาศตัวแปรสภาพแวดล้อมหลัก

## หมายเหตุ

- คีย์ภายใต้ `entries` จะถูกแมปกับชื่อสกิลโดยค่าเริ่มต้น คีย์ภายใต้ `entries` จะแมปกับชื่อSkillโดยค่าเริ่มต้น หากSkillกำหนด
  `metadata.openclaw.skillKey` ให้ใช้คีย์นั้นแทน
- การเปลี่ยนแปลงSkillsจะถูกรับรู้ในเทิร์นถัดไปของเอเจนต์เมื่อเปิดใช้งานตัวเฝ้าดู

### SkillsแบบSandboxed+ตัวแปรสภาพแวดล้อม

เมื่อเซสชันเป็น **sandboxed**, โพรเซสของSkillจะรันภายใน Docker โดย sandbox
จะ **ไม่** สืบทอด `process.env` ของโฮสต์ sandbox **ไม่** สืบทอดค่า `process.env` ของโฮสต์

ใช้วิธีใดวิธีหนึ่ง:

- `agents.defaults.sandbox.docker.env` (หรือแบบต่อเอเจนต์ `agents.list[].sandbox.docker.env`)
- ฝังตัวแปรสภาพแวดล้อมลงในอิมเมจ sandbox แบบกำหนดเองของคุณ

`env` และ `skills.entries.<skill>.env/apiKey` แบบส่วนกลางมีผลกับการรันบน **โฮสต์** เท่านั้น
