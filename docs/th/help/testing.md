---
summary: "ชุดเครื่องมือการทดสอบ: ชุด unit/e2e/live, ตัวรัน Docker และขอบเขตของการทดสอบแต่ละแบบ"
read_when:
  - การรันทดสอบในเครื่องหรือใน CI
  - การเพิ่มรีเกรสชันสำหรับบั๊กของโมเดล/ผู้ให้บริการ
  - การดีบักพฤติกรรมของเกตเวย์+เอเจนต์
title: "การทดสอบ"
---

# การทดสอบ

OpenClaw มีชุดการทดสอบ Vitest สามชุด (unit/integration, e2e, live) และตัวรัน Docker จำนวนเล็กน้อย

เอกสารนี้เป็นคู่มือ “เราทดสอบอย่างไร”:

- แต่ละชุดครอบคลุมอะไรบ้าง (และอะไรที่ตั้งใจไม่ครอบคลุม)
- คำสั่งที่ควรรันสำหรับเวิร์กโฟลว์ทั่วไป (ในเครื่อง, ก่อนพุช, การดีบัก)
- การที่การทดสอบแบบ live ค้นหาข้อมูลรับรองและเลือกโมเดล/ผู้ให้บริการอย่างไร
- วิธีเพิ่มรีเกรสชันสำหรับปัญหาโมเดล/ผู้ให้บริการในโลกจริง

## เริ่มต้นอย่างรวดเร็ว

ในวันปกติ:

- เกตเต็มรูปแบบ (คาดหวังก่อนพุช): `pnpm build && pnpm check && pnpm test`

เมื่อคุณแก้ไขการทดสอบหรือต้องการความมั่นใจเพิ่มเติม:

- เกตความครอบคลุม: `pnpm test:coverage`
- ชุด E2E: `pnpm test:e2e`

เมื่อดีบักผู้ให้บริการ/โมเดลจริง (ต้องใช้ข้อมูลรับรองจริง):

- ชุด Live (โมเดล + การโพรบเครื่องมือ/อิมเมจของเกตเวย์): `pnpm test:live`

เคล็ดลับ: เมื่อคุณต้องการเพียงเคสที่ล้มเหลวหนึ่งเคส ให้จำกัดการทดสอบแบบ live ด้วยตัวแปรสภาพแวดล้อม allowlist ที่อธิบายไว้ด้านล่าง

## ชุดการทดสอบ (รันที่ไหน อะไรบ้าง)

คิดว่าชุดเหล่านี้คือ “ความสมจริงที่เพิ่มขึ้น” (พร้อมความผันผวน/ต้นทุนที่เพิ่มขึ้น):

### Unit / integration (ค่าเริ่มต้น)

- คำสั่ง: `pnpm test`
- คอนฟิก: `vitest.config.ts`
- ไฟล์: `src/**/*.test.ts`
- ขอบเขต:
  - การทดสอบ unit ล้วน
  - การทดสอบ integration ภายในโปรเซส (การยืนยันตัวตนเกตเวย์, การกำหนดเส้นทาง, เครื่องมือ, การพาร์ส, คอนฟิก)
  - รีเกรสชันที่กำหนดผลลัพธ์ได้สำหรับบั๊กที่ทราบ
- ความคาดหวัง:
  - รันใน CI
  - ไม่ต้องใช้คีย์จริง
  - ควรเร็วและเสถียร

### E2E (gateway smoke)

- คำสั่ง: `pnpm test:e2e`
- คอนฟิก: `vitest.e2e.config.ts`
- ไฟล์: `src/**/*.e2e.test.ts`
- ขอบเขต:
  - พฤติกรรม end-to-end ของเกตเวย์หลายอินสแตนซ์
  - พื้นผิว WebSocket/HTTP, การจับคู่โหนด และเครือข่ายที่หนักขึ้น
- ความคาดหวัง:
  - รันใน CI (เมื่อเปิดใช้งานในไปป์ไลน์)
  - ไม่ต้องใช้คีย์จริง
  - ส่วนประกอบมากกว่าการทดสอบ unit (อาจช้ากว่า)

### Live (ผู้ให้บริการจริง + โมเดลจริง)

- คำสั่ง: `pnpm test:live`
- คอนฟิก: `vitest.live.config.ts`
- ไฟล์: `src/**/*.live.test.ts`
- ค่าเริ่มต้น: **เปิดใช้งาน** โดย `pnpm test:live` (ตั้งค่า `OPENCLAW_LIVE_TEST=1`)
- ขอบเขต:
  - “ผู้ให้บริการ/โมเดลนี้ยังใช้งานได้จริง _วันนี้_ ด้วยข้อมูลรับรองจริงหรือไม่?”
  - ตรวจจับการเปลี่ยนรูปแบบของผู้ให้บริการ, ความแปลกของการเรียกเครื่องมือ, ปัญหาการยืนยันตัวตน และพฤติกรรมลิมิตอัตรา
- ความคาดหวัง:
  - ไม่เสถียรสำหรับ CI โดยตั้งใจ (เครือข่ายจริง, นโยบายผู้ให้บริการจริง, โควตา, เหตุขัดข้อง)
  - มีค่าใช้จ่าย/ใช้ลิมิตอัตรา
  - ควรเลือกชุดย่อยที่จำกัดแทนการรัน “ทั้งหมด”
  - การรันแบบ live จะอ้างอิง `~/.profile` เพื่อดึงคีย์ API ที่ขาดหาย
  - การหมุนคีย์ Anthropic: ตั้งค่า `OPENCLAW_LIVE_ANTHROPIC_KEYS="sk-...,sk-..."` (หรือ `OPENCLAW_LIVE_ANTHROPIC_KEY=sk-...`) หรือหลายตัวแปร `ANTHROPIC_API_KEY*`; การทดสอบจะลองใหม่เมื่อเจอลิมิตอัตรา

## ควรรันชุดไหน?

ใช้ตารางตัดสินใจนี้:

- แก้ไขลอจิก/การทดสอบ: รัน `pnpm test` (และ `pnpm test:coverage` หากเปลี่ยนเยอะ)
- แตะต้องเครือข่ายเกตเวย์/โปรโตคอล WS/การจับคู่: เพิ่ม `pnpm test:e2e`
- ดีบัก “บอตของฉันล่ม”/ความล้มเหลวเฉพาะผู้ให้บริการ/การเรียกเครื่องมือ: รัน `pnpm test:live` แบบจำกัด

## Live: โมเดลสโมค (คีย์โปรไฟล์)

การทดสอบ live แบ่งเป็นสองชั้นเพื่อแยกสาเหตุความล้มเหลว:

- “Direct model” บอกว่าโมเดล/ผู้ให้บริการตอบได้หรือไม่ด้วยคีย์ที่มี
- “Gateway smoke” บอกว่าทั้งพายป์ไลน์เกตเวย์+เอเจนต์ทำงานสำหรับโมเดลนั้นหรือไม่ (เซสชัน, ประวัติ, เครื่องมือ, นโยบาย sandbox ฯลฯ)

### ชั้นที่1: Direct model completion (ไม่ผ่านเกตเวย์)

- การทดสอบ: `src/agents/models.profiles.live.test.ts`
- เป้าหมาย:
  - ไล่รายการโมเดลที่ค้นพบ
  - ใช้ `getApiKeyForModel` เพื่อเลือกโมเดลที่คุณมีข้อมูลรับรอง
  - รัน completion ขนาดเล็กต่อโมเดล (และรีเกรสชันเฉพาะจุดเมื่อจำเป็น)
- วิธีเปิดใช้งาน:
  - `pnpm test:live` (หรือ `OPENCLAW_LIVE_TEST=1` หากเรียก Vitest โดยตรง)
- ตั้งค่า `OPENCLAW_LIVE_MODELS=modern` (หรือ `all`, ชื่อเรียกแทนแบบใหม่) เพื่อรันชุดนี้จริง มิฉะนั้นจะข้ามเพื่อให้ `pnpm test:live` โฟกัสที่ gateway smoke
- วิธีเลือกโมเดล:
  - `OPENCLAW_LIVE_MODELS=modern` เพื่อรัน allowlist แบบใหม่ (Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_MODELS=all` เป็นชื่อเรียกแทนของ allowlist แบบใหม่
  - หรือ `OPENCLAW_LIVE_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,..."` (allowlist แบบคอมมา)
- วิธีเลือกผู้ให้บริการ:
  - `OPENCLAW_LIVE_PROVIDERS="google,google-antigravity,google-gemini-cli"` (allowlist แบบคอมมา)
- แหล่งที่มาของคีย์:
  - ค่าเริ่มต้น: ที่เก็บโปรไฟล์และ env fallback
  - ตั้งค่า `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` เพื่อบังคับใช้ **ที่เก็บโปรไฟล์** เท่านั้น
- เหตุผลที่มีสิ่งนี้:
  - แยก “API ผู้ให้บริการพัง/คีย์ไม่ถูกต้อง” ออกจาก “พายป์ไลน์เอเจนต์ของเกตเวย์พัง”
  - รวมรีเกรสชันขนาดเล็กแบบแยกส่วน (ตัวอย่าง: OpenAI Responses/Codex Responses การเล่นซ้ำเหตุผล + โฟลว์เรียกเครื่องมือ)

### ชั้นที่2: Gateway + dev agent smoke (สิ่งที่ “@openclaw” ทำจริง)

- การทดสอบ: `src/gateway/gateway-models.profiles.live.test.ts`
- เป้าหมาย:
  - สตาร์ทเกตเวย์ในโปรเซส
  - สร้าง/แพตช์เซสชัน `agent:dev:*` (override โมเดลต่อการรัน)
  - วนโมเดลที่มีคีย์และยืนยัน:
    - การตอบกลับที่ “มีความหมาย” (ไม่มีเครื่องมือ)
    - การเรียกเครื่องมือจริงทำงาน (read probe)
    - โพรบเครื่องมือเพิ่มเติมแบบไม่บังคับ (exec+read probe)
    - เส้นทางรีเกรสชันของ OpenAI (เรียกเครื่องมืออย่างเดียว → ติดตามผล) ยังทำงาน
- รายละเอียดโพรบ (เพื่ออธิบายความล้มเหลวได้เร็ว):
  - โพรบ `read`: การทดสอบเขียนไฟล์ nonce ในเวิร์กสเปซ แล้วขอให้เอเจนต์ `read` และสะท้อน nonce กลับมา
  - โพรบ `exec+read`: การทดสอบขอให้เอเจนต์ `exec`-เขียน nonce ลงไฟล์ชั่วคราว แล้ว `read` กลับมา
  - image probe: แนบ PNG ที่สร้างขึ้น (แมว + โค้ดสุ่ม) และคาดหวังให้โมเดลส่งคืน `cat <CODE>`
  - อ้างอิงการติดตั้ง: `src/gateway/gateway-models.profiles.live.test.ts` และ `src/gateway/live-image-probe.ts`
- วิธีเปิดใช้งาน:
  - `pnpm test:live` (หรือ `OPENCLAW_LIVE_TEST=1` หากเรียก Vitest โดยตรง)
- วิธีเลือกโมเดล:
  - ค่าเริ่มต้น: allowlist แบบใหม่ (Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_GATEWAY_MODELS=all` เป็นชื่อเรียกแทนของ allowlist แบบใหม่
  - หรือกำหนด `OPENCLAW_LIVE_GATEWAY_MODELS="provider/model"` (หรือรายการคอมมา) เพื่อจำกัด
- วิธีเลือกผู้ให้บริการ (หลีกเลี่ยง “OpenRouter ทั้งหมด”):
  - `OPENCLAW_LIVE_GATEWAY_PROVIDERS="google,google-antigravity,google-gemini-cli,openai,anthropic,zai,minimax"` (allowlist แบบคอมมา)
- โพรบเครื่องมือ + รูปภาพเปิดตลอดในการทดสอบ live นี้:
  - โพรบ `read` + โพรบ `exec+read` (ทดสอบเครื่องมือหนัก)
  - image probe จะรันเมื่อโมเดลประกาศรองรับอินพุตรูปภาพ
  - โฟลว์ (ระดับสูง):
    - การทดสอบสร้าง PNG เล็กๆ ที่มี “CAT” + โค้ดสุ่ม (`src/gateway/live-image-probe.ts`)
    - ส่งผ่าน `agent` `attachments: [{ mimeType: "image/png", content: "<base64>" }]`
    - เกตเวย์พาร์สไฟล์แนบเป็น `images[]` (`src/gateway/server-methods/agent.ts` + `src/gateway/chat-attachments.ts`)
    - เอเจนต์ที่ฝังอยู่ส่งข้อความผู้ใช้แบบมัลติโหมดไปยังโมเดล
    - การยืนยัน: คำตอบมี `cat` + โค้ด (ยอมให้ OCR ผิดพลาดเล็กน้อย)

เคล็ดลับ: เพื่อดูว่าคุณทดสอบอะไรได้บนเครื่องของคุณ (และรหัส `provider/model` ที่แน่นอน) ให้รัน:

```bash
openclaw models list
openclaw models list --json
```

## Live: Anthropic setup-token smoke

- การทดสอบ: `src/agents/anthropic.setup-token.live.test.ts`
- เป้าหมาย: ตรวจสอบว่า setup-token ของ Claude Code CLI (หรือโปรไฟล์ setup-token ที่วางไว้) สามารถทำ prompt ของ Anthropic ให้เสร็จได้
- เปิดใช้งาน:
  - `pnpm test:live` (หรือ `OPENCLAW_LIVE_TEST=1` หากเรียก Vitest โดยตรง)
  - `OPENCLAW_LIVE_SETUP_TOKEN=1`
- แหล่งโทเคน (เลือกหนึ่ง):
  - โปรไฟล์: `OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test`
  - โทเคนดิบ: `OPENCLAW_LIVE_SETUP_TOKEN_VALUE=sk-ant-oat01-...`
- Override โมเดล (ไม่บังคับ):
  - `OPENCLAW_LIVE_SETUP_TOKEN_MODEL=anthropic/claude-opus-4-6`

ตัวอย่างการตั้งค่า:

```bash
openclaw models auth paste-token --provider anthropic --profile-id anthropic:setup-token-test
OPENCLAW_LIVE_SETUP_TOKEN=1 OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test pnpm test:live src/agents/anthropic.setup-token.live.test.ts
```

## Live: CLI backend smoke (Claude Code CLI หรือ CLI ภายในเครื่องอื่นๆ)

- การทดสอบ: `src/gateway/gateway-cli-backend.live.test.ts`
- เป้าหมาย: ตรวจสอบพายป์ไลน์ Gateway + เอเจนต์โดยใช้ CLI ภายในเครื่อง โดยไม่แตะคอนฟิกเริ่มต้นของคุณ
- เปิดใช้งาน:
  - `pnpm test:live` (หรือ `OPENCLAW_LIVE_TEST=1` หากเรียก Vitest โดยตรง)
  - `OPENCLAW_LIVE_CLI_BACKEND=1`
- ค่าเริ่มต้น:
  - โมเดล: `claude-cli/claude-sonnet-4-5`
  - คำสั่ง: `claude`
  - อาร์กิวเมนต์: `["-p","--output-format","json","--dangerously-skip-permissions"]`
- การ override (ไม่บังคับ):
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-opus-4-6"`
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="codex-cli/gpt-5.3-codex"`
  - `OPENCLAW_LIVE_CLI_BACKEND_COMMAND="/full/path/to/claude"`
  - `OPENCLAW_LIVE_CLI_BACKEND_ARGS='["-p","--output-format","json","--permission-mode","bypassPermissions"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV='["ANTHROPIC_API_KEY","ANTHROPIC_API_KEY_OLD"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE=1` เพื่อส่งไฟล์รูปภาพจริง (พาธจะถูกแทรกในพรอมป์ต์)
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG="--image"` เพื่อส่งพาธไฟล์รูปภาพเป็นอาร์กิวเมนต์ CLI แทนการแทรกในพรอมป์ต์
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE="repeat"` (หรือ `"list"`) เพื่อควบคุมวิธีส่งอาร์กิวเมนต์รูปภาพเมื่อกำหนด `IMAGE_ARG`
  - `OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE=1` เพื่อส่งเทิร์นที่สองและตรวจสอบโฟลว์การกลับมา
- `OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG=0` เพื่อคงการเปิดใช้งานคอนฟิก MCP ของ Claude Code CLI (ค่าเริ่มต้นจะปิด MCP ด้วยไฟล์ว่างชั่วคราว)

ตัวอย่าง:

```bash
OPENCLAW_LIVE_CLI_BACKEND=1 \
  OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-sonnet-4-5" \
  pnpm test:live src/gateway/gateway-cli-backend.live.test.ts
```

### สูตร live ที่แนะนำ

allowlist แบบแคบและชัดเจนจะเร็วและผันผวนน้อยที่สุด:

- โมเดลเดียว แบบตรง (ไม่ผ่านเกตเวย์):
  - `OPENCLAW_LIVE_MODELS="openai/gpt-5.2" pnpm test:live src/agents/models.profiles.live.test.ts`

- โมเดลเดียว gateway smoke:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- การเรียกเครื่องมือข้ามหลายผู้ให้บริการ:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,google/gemini-3-flash-preview,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- โฟกัส Google (คีย์ Gemini API + Antigravity):
  - Gemini (API key): `OPENCLAW_LIVE_GATEWAY_MODELS="google/gemini-3-flash-preview" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`
  - Antigravity (OAuth): `OPENCLAW_LIVE_GATEWAY_MODELS="google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-pro-high" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

หมายเหตุ:

- `google/...` ใช้ Gemini API (API key)
- `google-antigravity/...` ใช้ Antigravity OAuth bridge (เอ็นด์พอยต์เอเจนต์สไตล์ Cloud Code Assist)
- `google-gemini-cli/...` ใช้ Gemini CLI ภายในเครื่องของคุณ (การยืนยันตัวตนและความแปลกของเครื่องมือแยกต่างหาก)
- Gemini API เทียบกับ Gemini CLI:
  - API: OpenClaw เรียก Gemini API ที่โฮสต์โดย Google ผ่าน HTTP (API key/โปรไฟล์); นี่คือสิ่งที่ผู้ใช้ส่วนใหญ่หมายถึงเมื่อพูดว่า “Gemini”
  - CLI: OpenClaw เรียกไบนารี `gemini` ภายในเครื่อง; มีการยืนยันตัวตนของตนเองและอาจมีพฤติกรรมต่างกัน (สตรีม/การรองรับเครื่องมือ/เวอร์ชันคลาดเคลื่อน)

## Live: เมทริกซ์โมเดล (เราครอบคลุมอะไร)

ไม่มี “รายชื่อโมเดล CI” ที่ตายตัว (live เป็นแบบเลือกเปิด) แต่ต่อไปนี้คือโมเดลที่ **แนะนำ** ให้ครอบคลุมเป็นประจำบนเครื่องนักพัฒนาที่มีคีย์

### ชุด smoke แบบใหม่ (การเรียกเครื่องมือ + รูปภาพ)

นี่คือการรัน “โมเดลทั่วไป” ที่เราคาดหวังให้ยังทำงานได้:

- OpenAI (ไม่ใช่ Codex): `openai/gpt-5.2` (ไม่บังคับ: `openai/gpt-5.1`)
- OpenAI Codex: `openai-codex/gpt-5.3-codex` (ไม่บังคับ: `openai-codex/gpt-5.3-codex-codex`)
- Anthropic: `anthropic/claude-opus-4-6` (หรือ `anthropic/claude-sonnet-4-5`)
- Google (Gemini API): `google/gemini-3-pro-preview` และ `google/gemini-3-flash-preview` (หลีกเลี่ยง Gemini 2.x รุ่นเก่า)
- Google (Antigravity): `google-antigravity/claude-opus-4-6-thinking` และ `google-antigravity/gemini-3-flash`
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

รัน gateway smoke พร้อมเครื่องมือ + รูปภาพ:
`OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,openai-codex/gpt-5.3-codex,anthropic/claude-opus-4-6,google/gemini-3-pro-preview,google/gemini-3-flash-preview,google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-flash,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

### พื้นฐาน: การเรียกเครื่องมือ (Read + Exec แบบไม่บังคับ)

เลือกอย่างน้อยหนึ่งต่อกลุ่มผู้ให้บริการ:

- OpenAI: `openai/gpt-5.2` (หรือ `openai/gpt-5-mini`)
- Anthropic: `anthropic/claude-opus-4-6` (หรือ `anthropic/claude-sonnet-4-5`)
- Google: `google/gemini-3-flash-preview` (หรือ `google/gemini-3-pro-preview`)
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

ความครอบคลุมเพิ่มเติม (มีแล้วดี):

- xAI: `xai/grok-4` (หรือรุ่นล่าสุดที่มี)
- Mistral: `mistral/`… (เลือกหนึ่งรุ่นที่รองรับเครื่องมือ)
- Cerebras: `cerebras/`… (ถ้ามีสิทธิ์)
- LM Studio: `lmstudio/`… (ภายในเครื่อง; การเรียกเครื่องมือขึ้นกับโหมด API)

### Vision: การส่งรูปภาพ (ไฟล์แนบ → ข้อความมัลติโหมด)

รวมอย่างน้อยหนึ่งโมเดลที่รองรับรูปภาพใน `OPENCLAW_LIVE_GATEWAY_MODELS` (Claude/Gemini/OpenAI รุ่นที่รองรับ vision ฯลฯ) เพื่อทดสอบ image probe เพื่อทดสอบ image probe

### Aggregators / เกตเวย์ทางเลือก

หากคุณเปิดใช้คีย์ไว้ เรายังรองรับการทดสอบผ่าน:

- OpenRouter: `openrouter/...` (มีโมเดลหลายร้อย; ใช้ `openclaw models scan` เพื่อค้นหารุ่นที่รองรับเครื่องมือ+รูปภาพ)
- OpenCode Zen: `opencode/...` (ยืนยันตัวตนผ่าน `OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY`)

ผู้ให้บริการเพิ่มเติมที่สามารถรวมในเมทริกซ์ live (ถ้ามีข้อมูลรับรอง/คอนฟิก):

- แบบบิลต์อิน: `openai`, `openai-codex`, `anthropic`, `google`, `google-vertex`, `google-antigravity`, `google-gemini-cli`, `zai`, `openrouter`, `opencode`, `xai`, `groq`, `cerebras`, `mistral`, `github-copilot`
- ผ่าน `models.providers` (เอ็นด์พอยต์กำหนดเอง): `minimax` (คลาวด์/API) รวมถึงพร็อกซีที่เข้ากันได้กับ OpenAI/Anthropic ใดๆ (LM Studio, vLLM, LiteLLM ฯลฯ)

เคล็ดลับ: อย่าพยายามฮาร์ดโค้ด “โมเดลทั้งหมด” ไว้ในเอกสาร เคล็ดลับ: อย่าพยายามฮาร์ดโค้ด “ทุกโมเดล” ในเอกสาร รายการที่เป็นทางการคือสิ่งที่ `discoverModels(...)` ส่งกลับบนเครื่องของคุณ + คีย์ที่มีอยู่

## ข้อมูลรับรอง (ห้ามคอมมิต)

การทดสอบ live ค้นหาข้อมูลรับรองแบบเดียวกับ CLI นัยเชิงปฏิบัติ: ผลกระทบเชิงปฏิบัติ:

- หาก CLI ใช้งานได้ การทดสอบ live ควรพบคีย์เดียวกัน

- หากการทดสอบ live แจ้ง “no creds” ให้ดีบักแบบเดียวกับที่ดีบัก `openclaw models list` / การเลือกโมเดล

- ที่เก็บโปรไฟล์: `~/.openclaw/credentials/` (แนะนำ; นี่คือความหมายของ “คีย์โปรไฟล์” ในการทดสอบ)

- คอนฟิก: `~/.openclaw/openclaw.json` (หรือ `OPENCLAW_CONFIG_PATH`)

หากคุณต้องการพึ่งคีย์จาก env (เช่น export ไว้ใน `~/.profile`) ให้รันทดสอบในเครื่องหลังจาก `source ~/.profile` หรือใช้ตัวรัน Docker ด้านล่าง (สามารถเมานต์ `~/.profile` เข้าไปในคอนเทนเนอร์ได้)

## Deepgram live (ถอดเสียง)

- การทดสอบ: `src/media-understanding/providers/deepgram/audio.live.test.ts`
- เปิดใช้งาน: `DEEPGRAM_API_KEY=... DEEPGRAM_LIVE_TEST=1 pnpm test:live src/media-understanding/providers/deepgram/audio.live.test.ts`

## ตัวรัน Docker (ตัวเลือก “ทำงานบน Linux”)

สิ่งเหล่านี้รัน `pnpm test:live` ภายในอิมเมจ Docker ของรีโป โดยเมานต์ไดเรกทอรีคอนฟิกและเวิร์กสเปซในเครื่อง (และอ้างอิง `~/.profile` หากเมานต์):

- โมเดลตรง: `pnpm test:docker:live-models` (สคริปต์: `scripts/test-live-models-docker.sh`)
- Gateway + dev agent: `pnpm test:docker:live-gateway` (สคริปต์: `scripts/test-live-gateway-models-docker.sh`)
- วิซาร์ดออนบอร์ดดิ้ง (TTY, สร้างโครงครบ): `pnpm test:docker:onboard` (สคริปต์: `scripts/e2e/onboard-docker.sh`)
- เครือข่ายเกตเวย์ (สองคอนเทนเนอร์, WS auth + health): `pnpm test:docker:gateway-network` (สคริปต์: `scripts/e2e/gateway-network-docker.sh`)
- ปลั๊กอิน (โหลดส่วนขยายกำหนดเอง + registry smoke): `pnpm test:docker:plugins` (สคริปต์: `scripts/e2e/plugins-docker.sh`)

ตัวแปรสภาพแวดล้อมที่มีประโยชน์:

- `OPENCLAW_CONFIG_DIR=...` (ค่าเริ่มต้น: `~/.openclaw`) เมานต์ไปที่ `/home/node/.openclaw`
- `OPENCLAW_WORKSPACE_DIR=...` (ค่าเริ่มต้น: `~/.openclaw/workspace`) เมานต์ไปที่ `/home/node/.openclaw/workspace`
- `OPENCLAW_PROFILE_FILE=...` (ค่าเริ่มต้น: `~/.profile`) เมานต์ไปที่ `/home/node/.profile` และถูกอ้างอิงก่อนรันทดสอบ
- `OPENCLAW_LIVE_GATEWAY_MODELS=...` / `OPENCLAW_LIVE_MODELS=...` เพื่อจำกัดการรัน
- `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` เพื่อให้แน่ใจว่าข้อมูลรับรองมาจากที่เก็บโปรไฟล์ (ไม่ใช่ env)

## ความสมเหตุสมผลของเอกสาร

รันการตรวจเอกสารหลังแก้ไขเอกสาร: `pnpm docs:list`.

## รีเกรสชันออฟไลน์ (ปลอดภัยสำหรับ CI)

นี่คือรีเกรสชัน “พายป์ไลน์จริง” โดยไม่ใช้ผู้ให้บริการจริง:

- การเรียกเครื่องมือของเกตเวย์ (จำลอง OpenAI, เกตเวย์จริง + ลูปเอเจนต์): `src/gateway/gateway.tool-calling.mock-openai.test.ts`
- วิซาร์ดเกตเวย์ (WS `wizard.start`/`wizard.next`, เขียนคอนฟิก + บังคับการยืนยันตัวตน): `src/gateway/gateway.wizard.e2e.test.ts`

## การประเมินความน่าเชื่อถือของเอเจนต์ (skills)

เรามีการทดสอบที่ปลอดภัยสำหรับ CI บางส่วนซึ่งทำงานเหมือน “การประเมินความน่าเชื่อถือของเอเจนต์” อยู่แล้ว:

- จำลองการเรียกเครื่องมือผ่านลูปเกตเวย์ + เอเจนต์จริง (`src/gateway/gateway.tool-calling.mock-openai.test.ts`).
- โฟลว์วิซาร์ด end-to-end ที่ตรวจสอบการเดินสายเซสชันและผลของคอนฟิก (`src/gateway/gateway.wizard.e2e.test.ts`).

สิ่งที่ยังขาดสำหรับ skills (ดู [Skills](/tools/skills)):

- **การตัดสินใจ:** เมื่อมีการแสดงรายการ skills ในพรอมป์ต์ เอเจนต์เลือก skill ที่ถูกต้อง (หรือหลีกเลี่ยงที่ไม่เกี่ยวข้อง) หรือไม่
- **การปฏิบัติตาม:** เอเจนต์อ่าน `SKILL.md` ก่อนใช้งานและทำตามขั้นตอน/อาร์กิวเมนต์ที่จำเป็นหรือไม่
- **สัญญาเวิร์กโฟลว์:** สถานการณ์หลายเทิร์นที่ยืนยันลำดับเครื่องมือ การพกพาประวัติเซสชัน และขอบเขต sandbox

การประเมินในอนาคตควรคงความกำหนดผลลัพธ์แน่นอนก่อน:

- ตัวรันสถานการณ์ที่ใช้ผู้ให้บริการจำลองเพื่อยืนยันการเรียกเครื่องมือ+ลำดับ การอ่านไฟล์ skill และการเดินสายเซสชัน
- ชุดสถานการณ์ที่โฟกัส skills ขนาดเล็ก (ใช้ vs หลีกเลี่ยง, การกั้น, prompt injection)
- การประเมินแบบ live (เลือกเปิด, ควบคุมด้วย env) หลังจากมีชุดที่ปลอดภัยสำหรับ CI แล้วเท่านั้น

## การเพิ่มรีเกรสชัน (แนวทาง)

เมื่อคุณแก้ปัญหาผู้ให้บริการ/โมเดลที่พบจาก live:

- เพิ่มรีเกรสชันที่ปลอดภัยสำหรับ CI หากเป็นไปได้ (จำลอง/สตับผู้ให้บริการ หรือจับรูปทรงคำขอที่แปลงอย่างแม่นยำ)
- หากจำเป็นต้องเป็น live เท่านั้น (ลิมิตอัตรา, นโยบายการยืนยันตัวตน) ให้จำกัดการทดสอบและเลือกเปิดผ่าน env vars
- เลือกเลเยอร์ที่เล็กที่สุดที่จับบั๊กได้:
  - บั๊กการแปลง/เล่นซ้ำคำขอของผู้ให้บริการ → การทดสอบโมเดลตรง
  - บั๊กพายป์ไลน์เซสชัน/ประวัติ/เครื่องมือของเกตเวย์ → gateway live smoke หรือการทดสอบจำลองเกตเวย์ที่ปลอดภัยสำหรับ CI
