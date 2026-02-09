---
summary: "ใช้ MiniMax M2.1 ใน OpenClaw"
read_when:
  - คุณต้องการใช้โมเดล MiniMax ใน OpenClaw
  - คุณต้องการคำแนะนำการตั้งค่า MiniMax
title: "MiniMax"
---

# MiniMax

MiniMax เป็นบริษัท AI ที่สร้างตระกูลโมเดล **M2/M2.1** MiniMax เป็นบริษัท AI ที่พัฒนาโมเดลตระกูล **M2/M2.1** โดยรุ่นที่เน้นงานเขียนโค้ดในปัจจุบันคือ **MiniMax M2.1** (23 ธันวาคม 2025) ซึ่งถูกสร้างมาเพื่อรองรับงานที่ซับซ้อนในโลกจริง

ที่มา: [MiniMax M2.1 release note](https://www.minimax.io/news/minimax-m21)

## ภาพรวมโมเดล (M2.1)

MiniMax เน้นย้ำการปรับปรุงเหล่านี้ใน M2.1:

- ความสามารถด้าน **การเขียนโค้ดหลายภาษา** ที่แข็งแกร่งยิ่งขึ้น (Rust, Java, Go, C++, Kotlin, Objective-C, TS/JS)
- การพัฒนา **เว็บ/แอป** และคุณภาพเอาต์พุตด้านความสวยงามที่ดีขึ้น (รวมถึงมือถือแบบเนทีฟ)
- การจัดการ **คำสั่งเชิงประกอบ** ที่ดีขึ้นสำหรับเวิร์กโฟลว์สไตล์งานออฟฟิศ โดยต่อยอดจากการคิดแบบสลับและการบังคับใช้ข้อจำกัดแบบผสาน
- **คำตอบกระชับขึ้น** ใช้โทเคนน้อยลง และรอบการทำงานเร็วขึ้น
- ความเข้ากันได้กับ **เฟรมเวิร์กเครื่องมือ/เอเจนต์** และการจัดการบริบทที่แข็งแกร่งขึ้น (Claude Code, Droid/Factory AI, Cline, Kilo Code, Roo Code, BlackBox)
- คุณภาพเอาต์พุตด้าน **บทสนทนาและงานเขียนเชิงเทคนิค** ที่สูงขึ้น

## MiniMax M2.1 เทียบกับ MiniMax M2.1 Lightning

- **ความเร็ว:** Lightning เป็นรุ่น “เร็ว” ตามเอกสารราคา MiniMax
- **ต้นทุน:** ราคาค่าอินพุตเท่ากัน แต่ Lightning มีค่าการส่งออกสูงกว่า
- **การกำหนดเส้นทางแผนเขียนโค้ด:** แบ็กเอนด์ Lightning ไม่ได้เปิดให้ใช้โดยตรงในแผนเขียนโค้ดของ MiniMax โดย MiniMax จะกำหนดเส้นทางคำขอส่วนใหญ่ไปยัง Lightning อัตโนมัติ แต่จะสลับกลับไปใช้แบ็กเอนด์ M2.1 ปกติเมื่อมีทราฟฟิกพุ่งสูง MiniMax จะกำหนดเส้นทางคำขอส่วนใหญ่ไปที่ Lightning โดยอัตโนมัติ แต่จะย้อนกลับไปใช้แบ็กเอนด์ M2.1 ปกติในช่วงที่มีทราฟฟิกสูง

## เลือกการตั้งค่า

### MiniMax OAuth (Coding Plan) — แนะนำ

**เหมาะสำหรับ:** ตั้งค่าได้รวดเร็วด้วย MiniMax Coding Plan ผ่าน OAuth ไม่ต้องใช้คีย์API

เปิดใช้ปลั๊กอิน OAuth ที่มากับระบบและทำการยืนยันตัวตน:

```bash
openclaw plugins enable minimax-portal-auth  # skip if already loaded.
openclaw gateway restart  # restart if gateway is already running
openclaw onboard --auth-choice minimax-portal
```

ระบบจะให้คุณเลือกเอ็นด์พอยต์:

- **Global** - ผู้ใช้นานาชาติ (`api.minimax.io`)
- **CN** - ผู้ใช้ในจีน (`api.minimaxi.com`)

ดูรายละเอียดได้ที่ [MiniMax OAuth plugin README](https://github.com/openclaw/openclaw/tree/main/extensions/minimax-portal-auth)

### MiniMax M2.1 (API key)

**เหมาะสำหรับ:** MiniMax แบบโฮสต์ที่ใช้ API ที่เข้ากันได้กับ Anthropic

ตั้งค่าผ่าน CLI:

- รัน `openclaw configure`
- เลือก **Model/auth**
- เลือก **MiniMax M2.1**

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "minimax/MiniMax-M2.1" } } },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### MiniMax M2.1 เป็นตัวสำรอง (Opus เป็นตัวหลัก)

**เหมาะสำหรับ:** ใช้ Opus 4.6 เป็นตัวหลัก และสลับไป MiniMax M2.1 เมื่อเกิดความล้มเหลว

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "minimax/MiniMax-M2.1": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["minimax/MiniMax-M2.1"],
      },
    },
  },
}
```

### ตัวเลือก: Local ผ่าน LM Studio (ตั้งค่าด้วยตนเอง)

**เหมาะที่สุดสำหรับ:** การประมวลผลแบบโลคัลด้วย LM Studio
**เหมาะสำหรับ:** การรันอินเฟอเรนซ์แบบ local ด้วย LM Studio  
เราพบผลลัพธ์ที่ดีมากกับ MiniMax M2.1 บนฮาร์ดแวร์ที่ทรงพลัง (เช่น เดสก์ท็อป/เซิร์ฟเวอร์) โดยใช้ local server ของ LM Studio

ตั้งค่าด้วยตนเองผ่าน `openclaw.json`:

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: { "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## ตั้งค่าผ่าน `openclaw configure`

ใช้วิซาร์ดการตั้งค่าแบบอินเทอร์แอ็กทีฟเพื่อกำหนด MiniMax โดยไม่ต้องแก้ไข JSON:

1. รัน `openclaw configure`
2. เลือก **Model/auth**
3. เลือก **MiniMax M2.1**
4. เลือกโมเดลเริ่มต้นเมื่อระบบถาม

## ตัวเลือกการกำหนดค่า

- `models.providers.minimax.baseUrl`: แนะนำ `https://api.minimax.io/anthropic` (เข้ากันได้กับ Anthropic); `https://api.minimax.io/v1` เป็นตัวเลือกสำหรับเพย์โหลดที่เข้ากันได้กับ OpenAI
- `models.providers.minimax.api`: แนะนำ `anthropic-messages`; `openai-completions` เป็นตัวเลือกสำหรับเพย์โหลดที่เข้ากันได้กับ OpenAI
- `models.providers.minimax.apiKey`: คีย์API ของ MiniMax (`MINIMAX_API_KEY`)
- `models.providers.minimax.models`: กำหนด `id`, `name`, `reasoning`, `contextWindow`, `maxTokens`, `cost`
- `agents.defaults.models`: ตั้งชื่อแฝงโมเดลที่คุณต้องการในรายการอนุญาต
- `models.mode`: คงค่า `merge` หากคุณต้องการเพิ่ม MiniMax ควบคู่กับโมเดลที่มากับระบบ

## หมายเหตุ

- การอ้างอิงโมเดลคือ `minimax/<model>`
- API การใช้งาน Coding Plan: `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (ต้องใช้คีย์ของ coding plan)
- อัปเดตราคาค่าใช้จ่ายใน `models.json` หากต้องการติดตามต้นทุนอย่างแม่นยำ
- ลิงก์แนะนำ MiniMax Coding Plan (ลด 10%): [https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
- ดู [/concepts/model-providers](/concepts/model-providers) สำหรับกฎของผู้ให้บริการ
- ใช้ `openclaw models list` และ `openclaw models set minimax/MiniMax-M2.1` เพื่อสลับการใช้งาน

## การแก้ไขปัญหา

### “Unknown model: minimax/MiniMax-M2.1”

โดยทั่วไปหมายความว่า **ยังไม่ได้กำหนดค่า MiniMax provider** (ไม่มีรายการ provider และไม่พบโปรไฟล์การยืนยันตัวตน/คีย์ env ของ MiniMax) การแก้ไขสำหรับการตรวจจับนี้อยู่ในเวอร์ชัน **2026.1.12** (ยังไม่ปล่อยในขณะเขียน) แก้ไขได้โดย: การแก้ไขสำหรับการตรวจจับนี้อยู่ในเวอร์ชัน **2026.1.12** (ยังไม่เผยแพร่ในขณะที่เขียน) แก้ไขโดย:

- อัปเกรดเป็น **2026.1.12** (หรือรันจากซอร์ส `main`) แล้วรีสตาร์ท Gateway
- รัน `openclaw configure` และเลือก **MiniMax M2.1** หรือ
- เพิ่มบล็อก `models.providers.minimax` ด้วยตนเอง หรือ
- ตั้งค่า `MINIMAX_API_KEY` (หรือโปรไฟล์ยืนยันตัวตน MiniMax) เพื่อให้ระบบสามารถใส่ provider ได้

ตรวจสอบให้แน่ใจว่า model id **คำนึงถึงตัวพิมพ์เล็ก-ใหญ่**:

- `minimax/MiniMax-M2.1`
- `minimax/MiniMax-M2.1-lightning`

จากนั้นตรวจสอบอีกครั้งด้วย:

```bash
openclaw models list
```
