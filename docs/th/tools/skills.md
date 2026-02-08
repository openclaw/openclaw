---
summary: "Skills: แบบจัดการกับเวิร์กสเปซ กฎการกำหนดสิทธิ์ และการเชื่อมต่อคอนฟิก/ตัวแปรสภาพแวดล้อม"
read_when:
  - การเพิ่มหรือแก้ไขSkills
  - การเปลี่ยนกฎการกำหนดสิทธิ์หรือกฎการโหลดSkills
title: "Skills"
x-i18n:
  source_path: tools/skills.md
  source_hash: 70d7eb9e422c17a4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:22Z
---

# Skills (OpenClaw)

OpenClaw ใช้โฟลเดอร์ทักษะที่ **เข้ากันได้กับ [AgentSkills](https://agentskills.io)** เพื่อสอนเอเจนต์ให้ใช้งานเครื่องมือ แต่ละSkillเป็นไดเรกทอรีที่มี `SKILL.md` พร้อม YAML frontmatter และคำสั่ง OpenClaw จะโหลด **Skills ที่มากับระบบ** รวมถึงตัวแทนที่ปรับแต่งในเครื่องแบบเลือกได้ และคัดกรองในช่วงโหลดตามสภาพแวดล้อม คอนฟิก และการมีอยู่ของไบนารี

## ตำแหน่งและลำดับความสำคัญ

Skills ถูกโหลดจาก **สาม** แหล่ง:

1. **Bundled skills**: มาพร้อมการติดตั้ง (แพ็กเกจ npm หรือ OpenClaw.app)
2. **Managed/local skills**: `~/.openclaw/skills`
3. **Workspace skills**: `<workspace>/skills`

หากชื่อSkillชนกัน ลำดับความสำคัญคือ:

`<workspace>/skills` (สูงสุด) → `~/.openclaw/skills` → bundled skills (ต่ำสุด)

นอกจากนี้ คุณสามารถตั้งค่าโฟลเดอร์Skillsเพิ่มเติม (ลำดับความสำคัญต่ำสุด) ผ่าน
`skills.load.extraDirs` ใน `~/.openclaw/openclaw.json`.

## Skills ต่อเอเจนต์เทียบกับแบบใช้ร่วมกัน

ในการตั้งค่าแบบ **หลายเอเจนต์** เอเจนต์แต่ละตัวมีเวิร์กสเปซของตนเอง ซึ่งหมายความว่า:

- **Skills ต่อเอเจนต์** อยู่ที่ `<workspace>/skills` สำหรับเอเจนต์นั้นเท่านั้น
- **Skills ที่ใช้ร่วมกัน** อยู่ที่ `~/.openclaw/skills` (managed/local) และมองเห็นได้โดย
  **เอเจนต์ทั้งหมด** บนเครื่องเดียวกัน
- **โฟลเดอร์ที่ใช้ร่วมกัน** ยังสามารถเพิ่มผ่าน `skills.load.extraDirs` (ลำดับความสำคัญต่ำสุด)
  หากต้องการชุดSkillsส่วนกลางที่ใช้โดยหลายเอเจนต์

หากชื่อSkillเดียวกันมีอยู่มากกว่าหนึ่งที่ จะใช้ลำดับความสำคัญปกติ:
workspace ชนะ จากนั้น managed/local แล้วจึง bundled

## ปลั๊กอิน + Skills

ปลั๊กอินสามารถมาพร้อมSkillsของตนเองได้โดยระบุไดเรกทอรี `skills` ใน
`openclaw.plugin.json` (พาธสัมพัทธ์จากรากปลั๊กอิน) Skills ของปลั๊กอินจะถูกโหลดเมื่อเปิดใช้งานปลั๊กอิน และเข้าร่วมกฎลำดับความสำคัญตามปกติ คุณสามารถกำหนดเงื่อนไขได้ผ่าน `metadata.openclaw.requires.config` ในรายการคอนฟิกของปลั๊กอิน ดู [Plugins](/tools/plugin) สำหรับการค้นหา/คอนฟิก และ [Tools](/tools) สำหรับพื้นผิวเครื่องมือที่Skillsเหล่านี้สอน

## ClawHub (ติดตั้ง + ซิงก์)

ClawHub คือรีจิสทรีSkillsสาธารณะสำหรับ OpenClaw เรียกดูได้ที่
[https://clawhub.com](https://clawhub.com) ใช้เพื่อค้นหา ติดตั้ง อัปเดต และสำรองSkills
คู่มือฉบับเต็ม: [ClawHub](/tools/clawhub)

โฟลว์ที่ใช้บ่อย:

- ติดตั้งSkillลงในเวิร์กสเปซของคุณ:
  - `clawhub install <skill-slug>`
- อัปเดตSkillsที่ติดตั้งทั้งหมด:
  - `clawhub update --all`
- ซิงก์ (สแกน + เผยแพร่การอัปเดต):
  - `clawhub sync --all`

โดยค่าเริ่มต้น `clawhub` จะติดตั้งไปที่ `./skills` ใต้ไดเรกทอรีทำงานปัจจุบันของคุณ (หรือถอยกลับไปใช้เวิร์กสเปซ OpenClaw ที่ตั้งค่าไว้) OpenClaw จะตรวจพบเป็น `<workspace>/skills` ในเซสชันถัดไป

## หมายเหตุด้านความปลอดภัย

- ปฏิบัติต่อSkillsจากบุคคลที่สามว่าเป็น **โค้ดที่ไม่น่าเชื่อถือ** อ่านก่อนเปิดใช้งาน
- แนะนำให้รันแบบ sandbox สำหรับอินพุตที่ไม่น่าเชื่อถือและเครื่องมือที่มีความเสี่ยง ดู [Sandboxing](/gateway/sandboxing)
- `skills.entries.*.env` และ `skills.entries.*.apiKey` จะฉีดความลับเข้าไปในโพรเซสของ **โฮสต์** สำหรับรอบการทำงานของเอเจนต์นั้น (ไม่ใช่ sandbox) หลีกเลี่ยงการใส่ความลับในพรอมต์และล็อก
- สำหรับโมเดลภัยคุกคามที่ครอบคลุมและเช็กลิสต์ ดู [Security](/gateway/security)

## รูปแบบ (AgentSkills + เข้ากันได้กับ Pi)

`SKILL.md` ต้องมีอย่างน้อย:

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
---
```

หมายเหตุ:

- เราปฏิบัติตามสเปก AgentSkills สำหรับเลย์เอาต์/เจตนา
- พาร์เซอร์ที่ใช้โดยเอเจนต์แบบฝังรองรับเฉพาะคีย์ frontmatter แบบ **บรรทัดเดียว**
- `metadata` ควรเป็น **อ็อบเจ็กต์ JSON บรรทัดเดียว**
- ใช้ `{baseDir}` ในคำสั่งเพื่ออ้างอิงพาธโฟลเดอร์Skill
- คีย์ frontmatter เสริม:
  - `homepage` — URL ที่แสดงเป็น “Website” ใน UI Skills ของ macOS (รองรับผ่าน `metadata.openclaw.homepage` ด้วย)
  - `user-invocable` — `true|false` (ค่าเริ่มต้น: `true`) เมื่อเป็น `true` Skill จะถูกเปิดเผยเป็นคำสั่งสแลชของผู้ใช้
  - `disable-model-invocation` — `true|false` (ค่าเริ่มต้น: `false`) เมื่อเป็น `true` Skill จะถูกตัดออกจากพรอมต์ของโมเดล (ยังเรียกใช้โดยผู้ใช้ได้)
  - `command-dispatch` — `tool` (ไม่บังคับ) เมื่อกำหนดเป็น `tool` คำสั่งสแลชจะข้ามโมเดลและส่งต่อไปยังเครื่องมือโดยตรง
  - `command-tool` — ชื่อเครื่องมือที่จะเรียกเมื่อกำหนด `command-dispatch: tool`
  - `command-arg-mode` — `raw` (ค่าเริ่มต้น) สำหรับการส่งต่อไปยังเครื่องมือ จะส่งสตริงอาร์กิวเมนต์ดิบไปยังเครื่องมือ (ไม่มีการพาร์สจากแกนกลาง)

    เครื่องมือถูกเรียกด้วยพารามิเตอร์:
    `{ command: "<raw args>", commandName: "<slash command>", skillName: "<skill name>" }`.

## การกำหนดสิทธิ์ (ตัวกรองขณะโหลด)

OpenClaw **คัดกรองSkillsขณะโหลด** โดยใช้ `metadata` (JSON บรรทัดเดียว):

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["uv"], "env": ["GEMINI_API_KEY"], "config": ["browser.enabled"] },
        "primaryEnv": "GEMINI_API_KEY",
      },
  }
---
```

ฟิลด์ภายใต้ `metadata.openclaw`:

- `always: true` — รวมSkillเสมอ (ข้ามเกตอื่น)
- `emoji` — อีโมจิเสริมที่ใช้โดย UI Skills ของ macOS
- `homepage` — URL เสริมที่แสดงเป็น “Website” ใน UI Skills ของ macOS
- `os` — รายการแพลตฟอร์มเสริม (`darwin`, `linux`, `win32`) หากตั้งค่า Skill จะมีสิทธิ์เฉพาะบน OS เหล่านั้น
- `requires.bins` — รายการ; แต่ละรายการต้องมีอยู่บน `PATH`
- `requires.anyBins` — รายการ; ต้องมีอย่างน้อยหนึ่งรายการบน `PATH`
- `requires.env` — รายการ; ตัวแปรสภาพแวดล้อมต้องมีอยู่ **หรือ** ถูกระบุในคอนฟิก
- `requires.config` — รายการพาธ `openclaw.json` ที่ต้องเป็นจริง
- `primaryEnv` — ชื่อตัวแปรสภาพแวดล้อมที่เชื่อมโยงกับ `skills.entries.<name>.apiKey`
- `install` — อาร์เรย์เสริมของสเปกตัวติดตั้งที่ใช้โดย UI Skills ของ macOS (brew/node/go/uv/download)

หมายเหตุเกี่ยวกับ sandboxing:

- `requires.bins` ถูกตรวจสอบบน **โฮสต์** ในช่วงโหลดSkill
- หากเอเจนต์อยู่ใน sandbox ไบนารีต้องมีอยู่ **ภายในคอนเทนเนอร์** ด้วย
  ติดตั้งผ่าน `agents.defaults.sandbox.docker.setupCommand` (หรืออิมเมจที่กำหนดเอง)
  `setupCommand` รันหนึ่งครั้งหลังจากสร้างคอนเทนเนอร์
  การติดตั้งแพ็กเกจยังต้องการการออกเครือข่าย ระบบไฟล์รากที่เขียนได้ และผู้ใช้ root ใน sandbox
  ตัวอย่าง: Skill `summarize` (`skills/summarize/SKILL.md`) ต้องการ CLI `summarize`
  ภายในคอนเทนเนอร์ sandbox เพื่อให้รันได้ที่นั่น

ตัวอย่างตัวติดตั้ง:

```markdown
---
name: gemini
description: Use Gemini CLI for coding assistance and Google search lookups.
metadata:
  {
    "openclaw":
      {
        "emoji": "♊️",
        "requires": { "bins": ["gemini"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gemini-cli",
              "bins": ["gemini"],
              "label": "Install Gemini CLI (brew)",
            },
          ],
      },
  }
---
```

หมายเหตุ:

- หากระบุตัวติดตั้งหลายรายการ Gateway จะเลือกตัวเลือกที่ต้องการ **เพียงหนึ่งเดียว** (brew เมื่อมี มิฉะนั้น node)
- หากตัวติดตั้งทั้งหมดเป็น `download` OpenClaw จะแสดงแต่ละรายการเพื่อให้คุณเห็นอาร์ติแฟกต์ที่มี
- สเปกตัวติดตั้งสามารถระบุ `os: ["darwin"|"linux"|"win32"]` เพื่อกรองตัวเลือกตามแพลตฟอร์ม
- การติดตั้งแบบ Node จะยึดตาม `skills.install.nodeManager` ใน `openclaw.json` (ค่าเริ่มต้น: npm; ตัวเลือก: npm/pnpm/yarn/bun)
  สิ่งนี้มีผลเฉพาะกับ **การติดตั้งSkill** เท่านั้น; รันไทม์ของ Gateway ควรยังเป็น Node
  (ไม่แนะนำ Bun สำหรับ WhatsApp/Telegram)
- การติดตั้ง Go: หากขาด `go` และมี `brew` Gateway จะติดตั้ง Go ผ่าน Homebrew ก่อนและตั้งค่า `GOBIN` เป็น `bin` ของ Homebrew เมื่อเป็นไปได้
- การติดตั้งแบบดาวน์โหลด: `url` (จำเป็น), `archive` (`tar.gz` | `tar.bz2` | `zip`), `extract` (ค่าเริ่มต้น: auto เมื่อพบไฟล์บีบอัด), `stripComponents`, `targetDir` (ค่าเริ่มต้น: `~/.openclaw/tools/<skillKey>`)

หากไม่มี `metadata.openclaw` Skill จะมีสิทธิ์เสมอ (เว้นแต่ถูกปิดใช้งานในคอนฟิกหรือถูกบล็อกโดย `skills.allowBundled` สำหรับ bundled skills)

## การเขียนทับคอนฟิก (`~/.openclaw/openclaw.json`)

Bundled/managed skills สามารถสลับเปิดปิดและระบุค่า env ได้:

```json5
{
  skills: {
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
        config: {
          endpoint: "https://example.invalid",
          model: "nano-pro",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

หมายเหตุ: หากชื่อSkillมีขีดกลาง ให้ใส่เครื่องหมายอัญประกาศที่คีย์ (JSON5 อนุญาตคีย์ที่ใส่อัญประกาศ)

คีย์คอนฟิกจะตรงกับ **ชื่อSkill** โดยค่าเริ่มต้น หาก Skill กำหนด
`metadata.openclaw.skillKey` ให้ใช้คีย์นั้นภายใต้ `skills.entries`.

กฎ:

- `enabled: false` ปิดใช้งานSkillแม้จะเป็น bundled/installed
- `env`: ฉีดค่า **เฉพาะเมื่อ** ตัวแปรยังไม่ได้ตั้งค่าในโพรเซส
- `apiKey`: ความสะดวกสำหรับSkillsที่ประกาศ `metadata.openclaw.primaryEnv`
- `config`: ถุงข้อมูลเสริมสำหรับฟิลด์ต่อSkillแบบกำหนดเอง; คีย์กำหนดเองต้องอยู่ที่นี่
- `allowBundled`: allowlist เสริมสำหรับ **bundled** skills เท่านั้น หากตั้งค่า จะมีสิทธิ์เฉพาะ bundled skills ในรายการ (managed/workspace ไม่ได้รับผล)

## การฉีดสภาพแวดล้อม (ต่อการรันเอเจนต์)

เมื่อเริ่มการรันเอเจนต์ OpenClaw จะ:

1. อ่านเมทาดาทาของSkills
2. ใช้ `skills.entries.<key>.env` หรือ `skills.entries.<key>.apiKey` กับ
   `process.env`
3. สร้าง system prompt ด้วยSkillsที่ **มีสิทธิ์**
4. คืนค่าสภาพแวดล้อมเดิมหลังจบการรัน

ขอบเขตนี้เป็น **เฉพาะการรันเอเจนต์** ไม่ใช่สภาพแวดล้อมเชลล์แบบโกลบอล

## สแน็ปช็อตเซสชัน (ประสิทธิภาพ)

OpenClaw จะทำสแน็ปช็อตรายการSkillsที่มีสิทธิ์ **เมื่อเริ่มเซสชัน** และใช้ซ้ำสำหรับเทิร์นถัดไปในเซสชันเดียวกัน การเปลี่ยนแปลงSkillsหรือคอนฟิกจะมีผลในเซสชันใหม่ถัดไป

Skills ยังสามารถรีเฟรชกลางเซสชันได้เมื่อเปิดใช้งานตัวเฝ้าดูSkills หรือเมื่อมีโหนดระยะไกลที่มีสิทธิ์ใหม่ปรากฏขึ้น (ดูด้านล่าง) ให้คิดว่านี่คือ **hot reload**: รายการที่รีเฟรชจะถูกนำมาใช้ในเทิร์นเอเจนต์ถัดไป

## โหนด macOS ระยะไกล (Gateway บน Linux)

หาก Gateway รันบน Linux แต่มี **โหนด macOS** เชื่อมต่อ **โดยอนุญาต `system.run`** (การตั้งค่าความปลอดภัย Exec approvals ไม่ได้ตั้งเป็น `deny`) OpenClaw สามารถถือว่าSkillsที่มีเฉพาะ macOS มีสิทธิ์ได้เมื่อมีไบนารีที่จำเป็นบนโหนดนั้น เอเจนต์ควรเรียกใช้Skillsเหล่านั้นผ่านเครื่องมือ `nodes` (โดยทั่วไปคือ `nodes.run`)

สิ่งนี้อาศัยการรายงานความสามารถคำสั่งของโหนดและการตรวจสอบไบนารีผ่าน `system.run` หากโหนด macOS ออฟไลน์ในภายหลัง Skills จะยังมองเห็นได้; การเรียกใช้อาจล้มเหลวจนกว่าโหนดจะเชื่อมต่อใหม่

## ตัวเฝ้าดูSkills (รีเฟรชอัตโนมัติ)

โดยค่าเริ่มต้น OpenClaw จะเฝ้าดูโฟลเดอร์Skills และอัปเดตสแน็ปช็อตSkillsเมื่อไฟล์ `SKILL.md` เปลี่ยนแปลง ตั้งค่าได้ภายใต้ `skills.load`:

```json5
{
  skills: {
    load: {
      watch: true,
      watchDebounceMs: 250,
    },
  },
}
```

## ผลกระทบต่อโทเคน (รายการSkills)

เมื่อSkillsมีสิทธิ์ OpenClaw จะฉีดรายการ XML แบบย่อของSkillsที่พร้อมใช้งานเข้าไปใน system prompt (ผ่าน `formatSkillsForPrompt` ใน `pi-coding-agent`) ค่าใช้จ่ายเป็นแบบกำหนดแน่นอน:

- **ค่าใช้จ่ายพื้นฐาน (เฉพาะเมื่อมี ≥1 Skill):** 195 ตัวอักษร
- **ต่อSkill:** 97 ตัวอักษร + ความยาวของค่า `<name>`, `<description>`, และ `<location>` หลังการ escape เป็น XML

สูตร (ตัวอักษร):

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

หมายเหตุ:

- การ escape เป็น XML จะขยาย `& < > " '` เป็นเอนทิตี (`&amp;`, `&lt;` เป็นต้น) ทำให้ความยาวเพิ่มขึ้น
- จำนวนโทเคนแตกต่างตามตัวแยกโทเคนของโมเดล โดยประมาณแบบ OpenAI คือ ~4 ตัวอักษร/โทเคน ดังนั้น **97 ตัวอักษร ≈ 24 โทเคน** ต่อSkill บวกความยาวฟิลด์จริงของคุณ

## วงจรชีวิตSkillsแบบจัดการ

OpenClaw มาพร้อมชุดSkillsพื้นฐานเป็น **bundled skills** เป็นส่วนหนึ่งของการติดตั้ง (แพ็กเกจ npm หรือ OpenClaw.app) `~/.openclaw/skills` มีไว้สำหรับการเขียนทับในเครื่อง (เช่น การตรึงเวอร์ชัน/แพตช์Skillโดยไม่เปลี่ยนสำเนาที่ bundled) Workspace skills เป็นของผู้ใช้และจะเขียนทับทั้งสองเมื่อชื่อชนกัน

## อ้างอิงคอนฟิก

ดู [Skills config](/tools/skills-config) สำหรับสคีมาคอนฟิกฉบับเต็ม

## กำลังมองหาSkillsเพิ่มเติมอยู่หรือไม่?

เรียกดูได้ที่ [https://clawhub.com](https://clawhub.com).

---
