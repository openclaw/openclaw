---
summary: "รัน OpenClaw บน LLM ภายในเครื่อง (LM Studio, vLLM, LiteLLM, เอ็นด์พอยต์ OpenAI แบบกำหนดเอง)"
read_when:
  - คุณต้องการให้บริการโมเดลจากเครื่อง GPU ของคุณเอง
  - คุณกำลังเชื่อมต่อ LM Studio หรือพร็อกซีที่เข้ากันได้กับ OpenAI
  - คุณต้องการคำแนะนำโมเดลภายในเครื่องที่ปลอดภัยที่สุด
title: "Local Models"
---

# Local models

Local is doable, but OpenClaw expects large context + strong defenses against prompt injection. Small cards truncate context and leak safety. Aim high: **≥2 maxed-out Mac Studios or equivalent GPU rig (~$30k+)**. A single **24 GB** GPU works only for lighter prompts with higher latency. Use the **largest / full-size model variant you can run**; aggressively quantized or “small” checkpoints raise prompt-injection risk (see [Security](/gateway/security)).

## แนะนำ: LM Studio + MiniMax M2.1 (Responses API, ขนาดเต็ม)

Best current local stack. สแตกภายในเครื่องที่ดีที่สุดในปัจจุบัน โหลด MiniMax M2.1 ใน LM Studio เปิดเซิร์ฟเวอร์ภายในเครื่อง(ค่าเริ่มต้น `http://127.0.0.1:1234`) และใช้ Responses API เพื่อแยกการให้เหตุผลออกจากข้อความสุดท้าย

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" },
      },
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

**เช็กลิสต์การตั้งค่า**

- ติดตั้ง LM Studio: [https://lmstudio.ai](https://lmstudio.ai)
- ใน LM Studio ดาวน์โหลด **MiniMax M2.1 เวอร์ชันที่ใหญ่ที่สุดที่มี**(หลีกเลี่ยงเวอร์ชัน “small”/ที่ควอนไทซ์หนัก) เริ่มเซิร์ฟเวอร์ และยืนยันว่า `http://127.0.0.1:1234/v1/models` แสดงรายการแล้ว
- คงสถานะโหลดโมเดลไว้; การ cold-load จะเพิ่มความหน่วงตอนเริ่ม
- ปรับ `contextWindow`/`maxTokens` หากบิลด์ LM Studio ของคุณแตกต่าง
- สำหรับ WhatsApp ให้ใช้ Responses API เพื่อให้ส่งเฉพาะข้อความสุดท้าย

คงการตั้งค่าโมเดลแบบโฮสต์ไว้แม้จะรันแบบโลคัล; ใช้ `models.mode: "merge"` เพื่อให้ฟอลแบ็กยังพร้อมใช้งาน

### คอนฟิกแบบไฮบริด: โฮสต์เป็นหลัก โลคัลเป็นฟอลแบ็ก

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-5",
        fallbacks: ["lmstudio/minimax-m2.1-gs32", "anthropic/claude-opus-4-6"],
      },
      models: {
        "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
        "lmstudio/minimax-m2.1-gs32": { alias: "MiniMax Local" },
        "anthropic/claude-opus-4-6": { alias: "Opus" },
      },
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

### โลคัลเป็นหลักพร้อมตาข่ายความปลอดภัยจากโฮสต์

สลับลำดับหลักและฟอลแบ็ก; ใช้บล็อกผู้ให้บริการเดิมและ `models.mode: "merge"` เพื่อให้สามารถฟอลแบ็กไปที่ Sonnet หรือ Opus ได้เมื่อกล่องโลคัลล่ม

### การโฮสต์ตามภูมิภาค/การกำหนดเส้นทางข้อมูล

- Hosted MiniMax/Kimi/GLM variants also exist on OpenRouter with region-pinned endpoints (e.g., US-hosted). MiniMax/Kimi/GLM แบบโฮสต์ก็มีบน OpenRouter พร้อมเอ็นด์พอยต์ที่ปักหมุดภูมิภาค(เช่น โฮสต์ในสหรัฐฯ) เลือกเวอร์ชันตามภูมิภาคที่นั่นเพื่อคงทราฟฟิกไว้ในเขตอำนาจที่คุณเลือก ขณะเดียวกันยังใช้ `models.mode: "merge"` สำหรับฟอลแบ็ก Anthropic/OpenAI
- โลคัลล้วนยังเป็นเส้นทางความเป็นส่วนตัวที่แข็งแกร่งที่สุด; การกำหนดเส้นทางแบบโฮสต์ตามภูมิภาคคือทางสายกลางเมื่อคุณต้องการฟีเจอร์ผู้ให้บริการแต่ต้องการควบคุมการไหลของข้อมูล

## พร็อกซีภายในเครื่องที่เข้ากันได้กับ OpenAI อื่นๆ

vLLM, LiteLLM, OAI-proxy หรือเกตเวย์แบบกำหนดเองใช้ได้ หากเปิดเอ็นด์พอยต์สไตล์ OpenAI แบบ `/v1` แทนที่บล็อกผู้ให้บริการด้านบนด้วยเอ็นด์พอยต์และโมเดล ID ของคุณ: Replace the provider block above with your endpoint and model ID:

```json5
{
  models: {
    mode: "merge",
    providers: {
      local: {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "sk-local",
        api: "openai-responses",
        models: [
          {
            id: "my-local-model",
            name: "Local Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 120000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

คง `models.mode: "merge"` เพื่อให้โมเดลแบบโฮสต์ยังพร้อมใช้งานเป็นฟอลแบ็ก

## การแก้ไขปัญหา

- Gateway เข้าถึงพร็อกซีได้หรือไม่? `curl http://127.0.0.1:1234/v1/models`.
- โมเดลใน LM Studio ถูกอันโหลด? โหลดใหม่; การเริ่มแบบ cold start เป็นสาเหตุ “ค้าง” ที่พบบ่อย
- ข้อผิดพลาดบริบท? ลด `contextWindow` หรือเพิ่มขีดจำกัดเซิร์ฟเวอร์ของคุณ
- ความปลอดภัย: โมเดลโลคัลข้ามฟิลเตอร์ฝั่งผู้ให้บริการ; ทำให้เอเจนต์แคบและเปิดการบีบอัดเพื่อจำกัดรัศมีผลกระทบของ prompt injection
