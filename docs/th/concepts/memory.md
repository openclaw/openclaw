---
summary: "หน่วยความจำของOpenClawทำงานอย่างไร(ไฟล์เวิร์กสเปซ+การล้างหน่วยความจำอัตโนมัติ)"
read_when:
  - คุณต้องการโครงร่างไฟล์หน่วยความจำและเวิร์กโฟลว์
  - คุณต้องการปรับแต่งการล้างหน่วยความจำอัตโนมัติก่อนการคอมแพ็กชัน
x-i18n:
  source_path: concepts/memory.md
  source_hash: e160dc678bb8fda2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:08Z
---

# หน่วยความจำ

หน่วยความจำของOpenClawคือ**Markdownธรรมดาในเวิร์กสเปซของเอเจนต์**ไฟล์เหล่านี้คือแหล่งอ้างอิงความจริงเพียงหนึ่งเดียวโมเดลจะ“จำ”ได้เฉพาะสิ่งที่ถูกเขียนลงดิสก์เท่านั้น

เครื่องมือค้นหาหน่วยความจำถูกจัดเตรียมโดยปลั๊กอินหน่วยความจำที่เปิดใช้งานอยู่(ค่าเริ่มต้น: `memory-core`)ปิดใช้งานปลั๊กอินหน่วยความจำได้ด้วย`plugins.slots.memory = "none"`.

## ไฟล์หน่วยความจำ(Markdown)

เลย์เอาต์เวิร์กสเปซค่าเริ่มต้นใช้หน่วยความจำสองชั้น:

- `memory/YYYY-MM-DD.md`
  - บันทึกรายวัน(เพิ่มต่อท้ายเท่านั้น)
  - อ่านของวันนี้+เมื่อวานตอนเริ่มเซสชัน
- `MEMORY.md`(ไม่บังคับ)
  - หน่วยความจำระยะยาวที่คัดสรรแล้ว
  - **โหลดเฉพาะในเซสชันหลักแบบส่วนตัวเท่านั้น**(ไม่โหลดในบริบทกลุ่ม)

ไฟล์เหล่านี้อยู่ใต้เวิร์กสเปซ(`agents.defaults.workspace`, ค่าเริ่มต้น`~/.openclaw/workspace`)ดู[Agent workspace](/concepts/agent-workspace)สำหรับโครงร่างทั้งหมด

## ควรเขียนหน่วยความจำเมื่อใด

- การตัดสินใจ ความชอบ และข้อเท็จจริงที่คงทนให้เขียนลง`MEMORY.md`.
- บันทึกประจำวันและบริบทที่กำลังดำเนินอยู่ให้เขียนลง`memory/YYYY-MM-DD.md`.
- หากมีคนพูดว่า“จำสิ่งนี้ไว้”ให้เขียนลงไป(อย่าเก็บไว้ในRAM)
- ส่วนนี้ยังพัฒนาอยู่การเตือนโมเดลให้จัดเก็บหน่วยความจำจะช่วยได้มันจะรู้ว่าควรทำอย่างไร
- หากต้องการให้สิ่งใดคงอยู่**ขอให้บอตเขียนลงหน่วยความจำ**

## การล้างหน่วยความจำอัตโนมัติ(pre-compaction ping)

เมื่อเซสชัน**ใกล้ถึงการคอมแพ็กชันอัตโนมัติ**OpenClawจะทริกเกอร์**รอบการทำงานเงียบแบบเอเจนต์**เพื่อเตือนโมเดลให้เขียนหน่วยความจำที่คงทน**ก่อน**ที่บริบทจะถูกคอมแพ็กต์พรอมป์ต์ค่าเริ่มต้นระบุชัดว่าโมเดล*อาจตอบกลับ*แต่โดยทั่วไป`NO_REPLY`คือคำตอบที่ถูกต้องเพื่อไม่ให้ผู้ใช้เห็นรอบนี้

การควบคุมทำผ่าน`agents.defaults.compaction.memoryFlush`:

```json5
{
  agents: {
    defaults: {
      compaction: {
        reserveTokensFloor: 20000,
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 4000,
          systemPrompt: "Session nearing compaction. Store durable memories now.",
          prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.",
        },
      },
    },
  },
}
```

รายละเอียด:

- **เกณฑ์อ่อน**: การล้างจะทริกเกอร์เมื่อการประมาณโทเคนของเซสชันข้าม`contextWindow - reserveTokensFloor - softThresholdTokens`.
- **เงียบเป็นค่าเริ่มต้น**: พรอมป์ต์มี`NO_REPLY`จึงไม่มีการส่งถึงผู้ใช้
- **สองพรอมป์ต์**: พรอมป์ต์ผู้ใช้และพรอมป์ต์ระบบจะต่อท้ายการเตือน
- **หนึ่งการล้างต่อรอบคอมแพ็กชัน**(ติดตามใน`sessions.json`)
- **เวิร์กสเปซต้องเขียนได้**: หากเซสชันรันแบบsandboxด้วย`workspaceAccess: "ro"`หรือ`"none"`การล้างจะถูกข้าม

ดูวงจรคอมแพ็กชันทั้งหมดได้ที่
[Session management + compaction](/reference/session-management-compaction).

## การค้นหาหน่วยความจำแบบเวกเตอร์

OpenClawสามารถสร้างดัชนีเวกเตอร์ขนาดเล็กเหนือ`MEMORY.md`และ`memory/*.md`เพื่อให้การค้นหาเชิงความหมายพบโน้ตที่เกี่ยวข้องแม้ถ้อยคำต่างกัน

ค่าเริ่มต้น:

- เปิดใช้งานเป็นค่าเริ่มต้น
- เฝ้าดูไฟล์หน่วยความจำเพื่อการเปลี่ยนแปลง(debounced)
- ใช้การฝังแบบรีโมตเป็นค่าเริ่มต้นหากไม่ตั้งค่า`memorySearch.provider`OpenClawจะเลือกอัตโนมัติ:
  1. `local`หากมีการตั้งค่า`memorySearch.local.modelPath`และไฟล์มีอยู่
  2. `openai`หากสามารถแก้ไขคีย์OpenAIได้
  3. `gemini`หากสามารถแก้ไขคีย์Geminiได้
  4. `voyage`หากสามารถแก้ไขคีย์Voyageได้
  5. มิฉะนั้นการค้นหาหน่วยความจำจะยังคงปิดจนกว่าจะตั้งค่า
- โหมดโลคัลใช้node-llama-cppและอาจต้องการ`pnpm approve-builds`.
- ใช้sqlite-vec(เมื่อมี)เพื่อเร่งการค้นหาเวกเตอร์ภายในSQLite

การฝังแบบรีโมต**ต้องการ**คีย์APIสำหรับผู้ให้บริการการฝังOpenClawจะแก้ไขคีย์จากโปรไฟล์การยืนยันตัวตน,`models.providers.*.apiKey`,หรือตัวแปรสภาพแวดล้อมCodex OAuthครอบคลุมเฉพาะแชต/คอมพลีชันและ**ไม่**ครอบคลุมการฝังสำหรับการค้นหาหน่วยความจำสำหรับGeminiให้ใช้`GEMINI_API_KEY`หรือ`models.providers.google.apiKey`สำหรับVoyageให้ใช้`VOYAGE_API_KEY`หรือ`models.providers.voyage.apiKey`เมื่อใช้เอนด์พอยต์ที่เข้ากันได้กับOpenAIแบบกำหนดเองให้ตั้งค่า`memorySearch.remote.apiKey`(และไม่บังคับ`memorySearch.remote.headers`).

### แบ็กเอนด์QMD(ทดลอง)

ตั้งค่า`memory.backend = "qmd"`เพื่อสลับตัวทำดัชนีSQLiteในตัวเป็น
[QMD](https://github.com/tobi/qmd):ไซด์คาร์ค้นหาแบบโลคัลเฟิร์สต์ที่ผสานBM25+เวกเตอร์+การจัดอันดับซ้ำMarkdownยังคงเป็นแหล่งอ้างอิงความจริงOpenClawจะเรียกใช้QMDเพื่อการดึงข้อมูลประเด็นสำคัญ:

**ข้อกำหนดก่อนเริ่มต้น**

- ปิดใช้งานเป็นค่าเริ่มต้นเลือกใช้ต่อคอนฟิก(`memory.backend = "qmd"`)
- ติดตั้งQMD CLIแยกต่างหาก(`bun install -g https://github.com/tobi/qmd`หรือดาวน์โหลดรีลีส)และตรวจสอบว่าไบนารี`qmd`อยู่ใน`PATH`ของเกตเวย์
- QMDต้องการบิลด์SQLiteที่อนุญาตส่วนขยาย(`brew install sqlite`บนmacOS)
- QMDรันแบบโลคัลทั้งหมดผ่านBun+`node-llama-cpp`และดาวน์โหลดโมเดลGGUFจากHuggingFaceอัตโนมัติเมื่อใช้งานครั้งแรก(ไม่ต้องมีดีมอนOllamaแยก)
- เกตเวย์รันQMDในXDG homeแบบแยกส่วนภายใต้`~/.openclaw/agents/<agentId>/qmd/`โดยตั้งค่า`XDG_CONFIG_HOME`และ`XDG_CACHE_HOME`.
- รองรับระบบปฏิบัติการ: macOSและLinuxใช้งานได้ทันทีเมื่อมีBun+SQLiteติดตั้งWindowsแนะนำผ่านWSL2

**วิธีการรันไซด์คาร์**

- เกตเวย์เขียนQMD homeแบบแยกส่วนภายใต้`~/.openclaw/agents/<agentId>/qmd/`(คอนฟิก+แคช+sqlite DB)
- คอลเลกชันถูกสร้างผ่าน`qmd collection add`จาก`memory.qmd.paths`(รวมไฟล์หน่วยความจำเวิร์กสเปซค่าเริ่มต้น)จากนั้น`qmd update`+`qmd embed`จะรันตอนบูตและตามช่วงเวลาที่กำหนดได้(`memory.qmd.update.interval`, ค่าเริ่มต้น5 นาที)
- การรีเฟรชตอนบูตจะรันเบื้องหลังเป็นค่าเริ่มต้นเพื่อไม่ให้การเริ่มแชตถูกบล็อกตั้งค่า`memory.qmd.update.waitForBootSync = true`เพื่อคงพฤติกรรมบล็อกเดิม
- การค้นหารันผ่าน`qmd query --json`หากQMDล้มเหลวหรือไม่มีไบนารีOpenClawจะถอยกลับไปใช้ตัวจัดการSQLiteในตัวโดยอัตโนมัติเพื่อให้เครื่องมือหน่วยความจำยังทำงาน
- OpenClawยังไม่เปิดเผยการปรับbatch-sizeของการฝังQMDวันนี้พฤติกรรมแบตช์ถูกควบคุมโดยQMDเอง
- **การค้นหาครั้งแรกอาจช้า**:QMDอาจดาวน์โหลดโมเดลGGUFแบบโลคัล(การจัดอันดับซ้ำ/การขยายคำค้น)ในการรัน`qmd query`ครั้งแรก
  - OpenClawตั้งค่า`XDG_CONFIG_HOME`/`XDG_CACHE_HOME`อัตโนมัติเมื่อรันQMD
  - หากต้องการพรีดาวน์โหลดโมเดลด้วยตนเอง(และอุ่นดัชนีเดียวกับที่OpenClawใช้)ให้รันคิวรีครั้งเดียวด้วยไดเรกทอรีXDGของเอเจนต์

    สถานะQMDของOpenClawอยู่ใต้**ไดเรกทอรีสถานะ**ของคุณ(ค่าเริ่มต้น`~/.openclaw`)คุณสามารถชี้`qmd`ไปยังดัชนีเดียวกันได้โดยเอ็กซ์พอร์ตตัวแปรXDGเดียวกับที่OpenClawใช้:

    ```bash
    # Pick the same state dir OpenClaw uses
    STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
    if [ -d "$HOME/.moltbot" ] && [ ! -d "$HOME/.openclaw" ] \
      && [ -z "${OPENCLAW_STATE_DIR:-}" ]; then
      STATE_DIR="$HOME/.moltbot"
    fi

    export XDG_CONFIG_HOME="$STATE_DIR/agents/main/qmd/xdg-config"
    export XDG_CACHE_HOME="$STATE_DIR/agents/main/qmd/xdg-cache"

    # (Optional) force an index refresh + embeddings
    qmd update
    qmd embed

    # Warm up / trigger first-time model downloads
    qmd query "test" -c memory-root --json >/dev/null 2>&1
    ```

**พื้นผิวคอนฟิก(`memory.qmd.*`)**

- `command`(ค่าเริ่มต้น`qmd`):แทนที่พาธไฟล์ปฏิบัติการ
- `includeDefaultMemory`(ค่าเริ่มต้น`true`):ทำดัชนีอัตโนมัติ`MEMORY.md`+`memory/**/*.md`
- `paths[]`:เพิ่มไดเรกทอรี/ไฟล์เพิ่มเติม(`path`, ไม่บังคับ`pattern`, ไม่บังคับ
  stable `name`)
- `sessions`:เลือกใช้การทำดัชนีJSONLของเซสชัน(`enabled`, `retentionDays`,
  `exportDir`)
- `update`:ควบคุมรอบการรีเฟรชและการรันบำรุงรักษา:
  (`interval`, `debounceMs`, `onBoot`, `waitForBootSync`, `embedInterval`,
  `commandTimeoutMs`, `updateTimeoutMs`, `embedTimeoutMs`)
- `limits`:จำกัดเพย์โหลดการเรียกคืน(`maxResults`, `maxSnippetChars`,
  `maxInjectedChars`, `timeoutMs`)
- `scope`:สคีมาเดียวกับ[`session.sendPolicy`](/gateway/configuration#session)
  ค่าเริ่มต้นคือDMเท่านั้น(`deny`ทั้งหมด,`allow`แชตตรง)ผ่อนคลายเพื่อแสดงผลQMDในกลุ่ม/ช่องทาง
- สแนิปเพ็ตที่มาจากนอกเวิร์กสเปซจะแสดงเป็น`qmd/<collection>/<relative-path>`ในผลลัพธ์`memory_search`;`memory_get`เข้าใจพรีฟิกซ์นั้นและอ่านจากรูทคอลเลกชันQMDที่ตั้งค่าไว้
- เมื่อ`memory.qmd.sessions.enabled = true`,OpenClawจะส่งออกทรานสคริปต์เซสชันที่ผ่านการทำความสะอาด(รอบผู้ใช้/ผู้ช่วย)ไปยังคอลเลกชันQMDเฉพาะภายใต้`~/.openclaw/agents/<id>/qmd/sessions/`,เพื่อให้`memory_search`สามารถเรียกคืนบทสนทนาล่าสุดได้โดยไม่แตะดัชนีSQLiteในตัว
- สแนิปเพ็ต`memory_search`จะมีฟุตเตอร์`Source: <path#line>`เมื่อ`memory.citations`เป็น`auto`/`on`;ตั้งค่า`memory.citations = "off"`เพื่อเก็บเมทาดาทาพาธไว้ภายใน(เอเจนต์ยังคงได้รับพาธสำหรับ`memory_get`แต่ข้อความสแนิปเพ็ตจะละฟุตเตอร์และพรอมป์ต์ระบบจะเตือนเอเจนต์ไม่ให้อ้างอิง)

**ตัวอย่าง**

```json5
memory: {
  backend: "qmd",
  citations: "auto",
  qmd: {
    includeDefaultMemory: true,
    update: { interval: "5m", debounceMs: 15000 },
    limits: { maxResults: 6, timeoutMs: 4000 },
    scope: {
      default: "deny",
      rules: [{ action: "allow", match: { chatType: "direct" } }]
    },
    paths: [
      { name: "docs", path: "~/notes", pattern: "**/*.md" }
    ]
  }
}
```

**การอ้างอิงและการถอยกลับ**

- `memory.citations`มีผลไม่ว่าจะแบ็กเอนด์ใด(`auto`/`on`/`off`)
- เมื่อ`qmd`รันเราจะติดแท็ก`status().backend = "qmd"`เพื่อให้ไดแอกนอสติกแสดงว่าเอนจินใดให้ผลลัพธ์หากซับโปรเซสQMDออกหรือเอาต์พุตJSONแยกวิเคราะห์ไม่ได้ตัวจัดการการค้นหาจะบันทึกคำเตือนและคืนผู้ให้บริการในตัว(การฝังMarkdownที่มีอยู่)จนกว่าQMDจะกู้คืน

### พาธหน่วยความจำเพิ่มเติม

หากต้องการทำดัชนีไฟล์Markdownนอกเลย์เอาต์เวิร์กสเปซค่าเริ่มต้นให้เพิ่มพาธแบบชัดเจน:

```json5
agents: {
  defaults: {
    memorySearch: {
      extraPaths: ["../team-docs", "/srv/shared-notes/overview.md"]
    }
  }
}
```

หมายเหตุ:

- พาธอาจเป็นแบบสัมบูรณ์หรือสัมพันธ์กับเวิร์กสเปซ
- ไดเรกทอรีจะถูกสแกนแบบรีเคอร์ซีฟสำหรับไฟล์`.md`
- ทำดัชนีเฉพาะไฟล์Markdownเท่านั้น
- ไม่สนใจซิมลิงก์(ไฟล์หรือไดเรกทอรี)

### การฝังGemini(เนทีฟ)

ตั้งค่าผู้ให้บริการเป็น`gemini`เพื่อใช้Gemini embeddings APIโดยตรง:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "gemini",
      model: "gemini-embedding-001",
      remote: {
        apiKey: "YOUR_GEMINI_API_KEY"
      }
    }
  }
}
```

หมายเหตุ:

- `remote.baseUrl`ไม่บังคับ(ค่าเริ่มต้นคือฐานURLของGemini API)
- `remote.headers`ช่วยให้เพิ่มเฮดเดอร์เพิ่มเติมได้หากจำเป็น
- โมเดลค่าเริ่มต้น:`gemini-embedding-001`

หากต้องการใช้**เอนด์พอยต์ที่เข้ากันได้กับOpenAIแบบกำหนดเอง**(OpenRouter, vLLMหรือพร็อกซี)
สามารถใช้คอนฟิก`remote`กับผู้ให้บริการOpenAIได้:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://api.example.com/v1/",
        apiKey: "YOUR_OPENAI_COMPAT_API_KEY",
        headers: { "X-Custom-Header": "value" }
      }
    }
  }
}
```

หากไม่ต้องการตั้งค่าคีย์APIให้ใช้`memorySearch.provider = "local"`หรือกำหนด`memorySearch.fallback = "none"`.

การถอยกลับ:

- `memorySearch.fallback`สามารถเป็น`openai`,`gemini`,`local`หรือ`none`.
- ผู้ให้บริการถอยกลับจะถูกใช้เฉพาะเมื่อผู้ให้บริการการฝังหลักล้มเหลว

การทำดัชนีแบบแบตช์(OpenAI+Gemini):

- เปิดใช้งานเป็นค่าเริ่มต้นสำหรับการฝังOpenAIและGeminiตั้งค่า`agents.defaults.memorySearch.remote.batch.enabled = false`เพื่อปิด
- พฤติกรรมค่าเริ่มต้นจะรอให้แบตช์เสร็จสิ้นปรับ`remote.batch.wait`,`remote.batch.pollIntervalMs`และ`remote.batch.timeoutMinutes`หากจำเป็น
- ตั้งค่า`remote.batch.concurrency`เพื่อควบคุมจำนวนงานแบตช์ที่ส่งพร้อมกัน(ค่าเริ่มต้น:2)
- โหมดแบตช์ใช้เมื่อ`memorySearch.provider = "openai"`หรือ`"gemini"`และใช้คีย์APIที่สอดคล้องกัน
- งานแบตช์Geminiใช้เอนด์พอยต์แบตช์การฝังแบบอะซิงก์และต้องมีความพร้อมของGemini Batch API

เหตุใดแบตช์OpenAIจึงเร็วและถูก:

- สำหรับการเติมข้อมูลย้อนกลับขนาดใหญ่OpenAIมักเป็นตัวเลือกที่เร็วที่สุดที่เรารองรับเพราะสามารถส่งคำขอการฝังจำนวนมากในงานแบตช์เดียวและปล่อยให้OpenAIประมวลผลแบบอะซิงก์
- OpenAIมีราคาลดสำหรับงานBatch APIดังนั้นการทำดัชนีขนาดใหญ่จึงมักถูกกว่าส่งคำขอเดียวกันแบบซิงก์
- ดูเอกสารและราคาOpenAI Batch API:
  - [https://platform.openai.com/docs/api-reference/batch](https://platform.openai.com/docs/api-reference/batch)
  - [https://platform.openai.com/pricing](https://platform.openai.com/pricing)

ตัวอย่างคอนฟิก:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      fallback: "openai",
      remote: {
        batch: { enabled: true, concurrency: 2 }
      },
      sync: { watch: true }
    }
  }
}
```

เครื่องมือ:

- `memory_search` — คืนสแนิปเพ็ตพร้อมไฟล์+ช่วงบรรทัด
- `memory_get` — อ่านเนื้อหาไฟล์หน่วยความจำตามพาธ

โหมดโลคัล:

- ตั้งค่า`agents.defaults.memorySearch.provider = "local"`
- ระบุ`agents.defaults.memorySearch.local.modelPath`(GGUFหรือ`hf:`URI)
- ไม่บังคับ:ตั้งค่า`agents.defaults.memorySearch.fallback = "none"`เพื่อหลีกเลี่ยงการถอยกลับไปรีโมต

### เครื่องมือหน่วยความจำทำงานอย่างไร

- `memory_search`ค้นหาเชิงความหมายในชิ้นส่วนMarkdown(~400โทเคนเป้าหมาย,ซ้อนทับ80โทเคน)จาก`MEMORY.md`+`memory/**/*.md`คืนข้อความสแนิปเพ็ต(จำกัด~700อักขระ),พาธไฟล์,ช่วงบรรทัด,คะแนน,ผู้ให้บริการ/โมเดลและระบุว่ามีการถอยจากโลคัล→รีโมตหรือไม่ไม่คืนเพย์โหลดไฟล์ทั้งหมด
- `memory_get`อ่านไฟล์Markdownหน่วยความจำเฉพาะ(สัมพันธ์กับเวิร์กสเปซ)เลือกได้จากบรรทัดเริ่มต้นและจำนวนบรรทัดNพาธนอก`MEMORY.md`/`memory/`จะถูกปฏิเสธ
- เครื่องมือทั้งสองเปิดใช้งานเฉพาะเมื่อ`memorySearch.enabled`ประเมินเป็นจริงสำหรับเอเจนต์

### สิ่งที่ถูกทำดัชนี(และเมื่อใด)

- ประเภทไฟล์:เฉพาะMarkdown(`MEMORY.md`,`memory/**/*.md`)
- ที่เก็บดัชนี:SQLiteต่อเอเจนต์ที่`~/.openclaw/memory/<agentId>.sqlite`(ตั้งค่าได้ผ่าน`agents.defaults.memorySearch.store.path`,รองรับโทเคน`{agentId}`)
- ความสดใหม่:ตัวเฝ้าดูบน`MEMORY.md`+`memory/`ทำเครื่องหมายดัชนีว่าสกปรก(debounce1.5วินาที)การซิงก์ถูกตั้งเวลาเมื่อเริ่มเซสชันเมื่อค้นหาหรือเป็นช่วงเวลาและรันแบบอะซิงก์ทรานสคริปต์เซสชันใช้เกณฑ์เดลต้าเพื่อทริกเกอร์การซิงก์เบื้องหลัง
- ทริกเกอร์การทำดัชนีใหม่:ดัชนีเก็บลายนิ้วมือของ**ผู้ให้บริการ/โมเดลการฝัง+เอนด์พอยต์+พารามิเตอร์การตัดชิ้น**หากสิ่งใดเปลี่ยนOpenClawจะรีเซ็ตและทำดัชนีใหม่ทั้งหมดโดยอัตโนมัติ

### การค้นหาไฮบริด(BM25+เวกเตอร์)

เมื่อเปิดใช้งานOpenClawจะผสาน:

- **ความคล้ายคลึงของเวกเตอร์**(จับคู่เชิงความหมายถ้อยคำอาจต่างกัน)
- **ความเกี่ยวข้องของคีย์เวิร์ดBM25**(โทเคนตรงเช่นIDตัวแปรสภาพแวดล้อมสัญลักษณ์โค้ด)

หากการค้นหาแบบข้อความเต็มไม่พร้อมใช้งานบนแพลตฟอร์มของคุณOpenClawจะถอยกลับเป็นการค้นหาเวกเตอร์อย่างเดียว

#### ทำไมต้องไฮบริด?

การค้นหาเวกเตอร์เก่งด้าน“ความหมายเดียวกัน”:

- “Mac Studio gateway host”เทียบกับ“เครื่องที่รันเกตเวย์”
- “debounce file updates”เทียบกับ“หลีกเลี่ยงการทำดัชนีทุกครั้งที่เขียน”

แต่จะอ่อนกับโทเคนที่ตรงและมีสัญญาณสูง:

- ID(`a828e60`,`b3b9895a…`)
- สัญลักษณ์โค้ด(`memorySearch.query.hybrid`)
- สตริงข้อผิดพลาด(“sqlite-vec unavailable”)

BM25(ข้อความเต็ม)ตรงข้าม:เก่งโทเคนตรงอ่อนกับการถอดความ
การค้นหาไฮบริดคือจุดกึ่งกลางเชิงปฏิบัติ: **ใช้สัญญาณการดึงข้อมูลทั้งสอง**เพื่อให้ได้ผลลัพธ์ที่ดีทั้งคิวรีภาษาธรรมชาติและคิวรีแบบ“เข็มในกองฟาง”

#### วิธีรวมผลลัพธ์(ดีไซน์ปัจจุบัน)

สเก็ตช์การทำงาน:

1. ดึงพูลผู้สมัครจากทั้งสองฝั่ง:

- **เวกเตอร์**:อันดับบน`maxResults * candidateMultiplier`ตามcosine similarity
- **BM25**:อันดับบน`maxResults * candidateMultiplier`ตามอันดับFTS5 BM25(ยิ่งต่ำยิ่งดี)

2. แปลงอันดับBM25เป็นคะแนนประมาณ0..1:

- `textScore = 1 / (1 + max(0, bm25Rank))`

3. รวมผู้สมัครตามchunk idและคำนวณคะแนนถ่วงน้ำหนัก:

- `finalScore = vectorWeight * vectorScore + textWeight * textScore`

หมายเหตุ:

- `vectorWeight`+`textWeight`ถูกทำให้เป็น1.0ในการแก้ไขคอนฟิกดังนั้นน้ำหนักจึงทำงานเหมือนเปอร์เซ็นต์
- หากการฝังไม่พร้อมใช้งาน(หรือผู้ให้บริการคืนเวกเตอร์ศูนย์)เรายังคงรันBM25และคืนผลลัพธ์คีย์เวิร์ด
- หากไม่สามารถสร้างFTS5ได้เราจะคงการค้นหาเวกเตอร์อย่างเดียว(ไม่ล้มเหลวแบบฮาร์ด)

นี่ไม่ใช่“สมบูรณ์แบบตามทฤษฎีIR”แต่เรียบง่ายเร็วและมักปรับปรุงrecall/precisionกับโน้ตจริง
หากต้องการซับซ้อนขึ้นในอนาคตขั้นถัดไปทั่วไปคือReciprocal Rank Fusion(RRF)หรือการทำ normalizationของคะแนน
(min/maxหรือz-score)ก่อนผสม

คอนฟิก:

```json5
agents: {
  defaults: {
    memorySearch: {
      query: {
        hybrid: {
          enabled: true,
          vectorWeight: 0.7,
          textWeight: 0.3,
          candidateMultiplier: 4
        }
      }
    }
  }
}
```

### แคชการฝัง

OpenClawสามารถแคช**การฝังของชิ้นส่วน**ในSQLiteเพื่อให้การทำดัชนีใหม่และการอัปเดตบ่อย(โดยเฉพาะทรานสคริปต์เซสชัน)ไม่ต้องฝังข้อความที่ไม่เปลี่ยนซ้ำ

คอนฟิก:

```json5
agents: {
  defaults: {
    memorySearch: {
      cache: {
        enabled: true,
        maxEntries: 50000
      }
    }
  }
}
```

### การค้นหาหน่วยความจำเซสชัน(ทดลอง)

คุณสามารถเลือกทำดัชนี**ทรานสคริปต์เซสชัน**และแสดงผ่าน`memory_search`ได้
ฟีเจอร์นี้ถูกกั้นด้วยแฟล็กทดลอง

```json5
agents: {
  defaults: {
    memorySearch: {
      experimental: { sessionMemory: true },
      sources: ["memory", "sessions"]
    }
  }
}
```

หมายเหตุ:

- การทำดัชนีเซสชันเป็น**แบบเลือกใช้**(ปิดเป็นค่าเริ่มต้น)
- การอัปเดตเซสชันถูกdebounceและ**ทำดัชนีแบบอะซิงก์**เมื่อข้ามเกณฑ์เดลต้า(พยายามอย่างดีที่สุด)
- `memory_search`ไม่บล็อกการทำดัชนีผลลัพธ์อาจล้าหลังเล็กน้อยจนกว่าการซิงก์เบื้องหลังจะเสร็จ
- ผลลัพธ์ยังคงเป็นสแนิปเพ็ตเท่านั้น;`memory_get`ยังคงจำกัดที่ไฟล์หน่วยความจำ
- การทำดัชนีเซสชันแยกต่อเอเจนต์(ทำดัชนีเฉพาะบันทึกเซสชันของเอเจนต์นั้น)
- บันทึกเซสชันอยู่บนดิสก์(`~/.openclaw/agents/<agentId>/sessions/*.jsonl`)กระบวนการ/ผู้ใช้ใดที่เข้าถึงไฟล์ระบบได้สามารถอ่านได้ดังนั้นให้ถือว่าการเข้าถึงดิสก์คือขอบเขตความเชื่อถือเพื่อการแยกที่เข้มงวดขึ้นให้รันเอเจนต์ภายใต้ผู้ใช้OSหรือโฮสต์แยกกัน

เกณฑ์เดลต้า(ค่าเริ่มต้นแสดง):

```json5
agents: {
  defaults: {
    memorySearch: {
      sync: {
        sessions: {
          deltaBytes: 100000,   // ~100 KB
          deltaMessages: 50     // JSONL lines
        }
      }
    }
  }
}
```

### การเร่งเวกเตอร์SQLite(sqlite-vec)

เมื่อมีส่วนขยายsqlite-vecOpenClawจะเก็บการฝังในตารางเสมือนSQLite(`vec0`)และทำคิวรีระยะเวกเตอร์ในฐานข้อมูลช่วยให้การค้นหาเร็วโดยไม่ต้องโหลดการฝังทั้งหมดเข้าJS

การกำหนดค่า(ไม่บังคับ):

```json5
agents: {
  defaults: {
    memorySearch: {
      store: {
        vector: {
          enabled: true,
          extensionPath: "/path/to/sqlite-vec"
        }
      }
    }
  }
}
```

หมายเหตุ:

- `enabled`ค่าเริ่มต้นเป็นtrue;เมื่อปิดการค้นหาจะถอยกลับไปใช้cosine similarityในโปรเซสเหนือการฝังที่เก็บไว้
- หากส่วนขยายsqlite-vecหายไปหรือโหลดไม่สำเร็จOpenClawจะบันทึกข้อผิดพลาดและทำงานต่อด้วยทางเลือกJS(ไม่มีตารางเวกเตอร์)
- `extensionPath`แทนที่พาธsqlite-vecที่มาพร้อม(มีประโยชน์สำหรับบิลด์กำหนดเองหรือที่ติดตั้งไม่มาตรฐาน)

### การดาวน์โหลดการฝังโลคัลอัตโนมัติ

- โมเดลการฝังโลคัลค่าเริ่มต้น:`hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf`(~0.6GB)
- เมื่อ`memorySearch.provider = "local"`,`node-llama-cpp`แก้ไขเป็น`modelPath`;หากไม่มีGGUFจะ**ดาวน์โหลดอัตโนมัติ**ไปยังแคช(หรือ`local.modelCacheDir`หากตั้งค่า)จากนั้นโหลดการดาวน์โหลดจะต่อเมื่อพยายามใหม่
- ข้อกำหนดบิลด์เนทีฟ:รัน`pnpm approve-builds`,เลือก`node-llama-cpp`,จากนั้น`pnpm rebuild node-llama-cpp`
- การถอยกลับ:หากการตั้งค่าโลคัลล้มเหลวและ`memorySearch.fallback = "openai"`เราจะสลับไปใช้การฝังแบบรีโมตโดยอัตโนมัติ(`openai/text-embedding-3-small`เว้นแต่มีการแทนที่)และบันทึกเหตุผล

### ตัวอย่างเอนด์พอยต์ที่เข้ากันได้กับOpenAIแบบกำหนดเอง

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://api.example.com/v1/",
        apiKey: "YOUR_REMOTE_API_KEY",
        headers: {
          "X-Organization": "org-id",
          "X-Project": "project-id"
        }
      }
    }
  }
}
```

หมายเหตุ:

- `remote.*`มีลำดับความสำคัญเหนือ`models.providers.openai.*`
- `remote.headers`ผสานกับเฮดเดอร์OpenAI;ฝั่งรีโมตชนะเมื่อคีย์ชนกันละ`remote.headers`ออกเพื่อใช้ค่าเริ่มต้นของOpenAI
