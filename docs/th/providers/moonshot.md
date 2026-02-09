---
summary: "กำหนดค่า Moonshot K2 เทียบกับ Kimi Coding (ผู้ให้บริการและคีย์แยกกัน)"
read_when:
  - คุณต้องการตั้งค่า Moonshot K2 (Moonshot Open Platform) เทียบกับ Kimi Coding
  - คุณต้องการทำความเข้าใจเอ็นด์พอยต์ คีย์ และการอ้างอิงโมเดลที่แยกกัน
  - คุณต้องการคอนฟิกแบบคัดลอก/วางสำหรับผู้ให้บริการใดผู้ให้บริการหนึ่ง
title: "Moonshot AI"
---

# Moonshot AI (Kimi)

Moonshot ให้บริการ Kimi API พร้อมเอ็นด์พอยต์ที่เข้ากันได้กับ OpenAI Moonshot ให้บริการ Kimi API ที่มีเอ็นด์พอยต์เข้ากันได้กับ OpenAI กำหนดค่า
ผู้ให้บริการและตั้งค่าโมเดลเริ่มต้นเป็น `moonshot/kimi-k2.5` หรือใช้
Kimi Coding กับ `kimi-coding/k2p5`.

รหัสโมเดล Kimi K2 ปัจจุบัน:

{/_moonshot-kimi-k2-ids:start_/ && null}

- `kimi-k2.5`
- `kimi-k2-0905-preview`
- `kimi-k2-turbo-preview`
- `kimi-k2-thinking`
- `kimi-k2-thinking-turbo`
  {/_moonshot-kimi-k2-ids:end_/ && null}

```bash
openclaw onboard --auth-choice moonshot-api-key
```

Kimi Coding:

```bash
openclaw onboard --auth-choice kimi-code-api-key
```

หมายเหตุ: Moonshot และ Kimi Coding เป็นผู้ให้บริการแยกจากกัน หมายเหตุ: Moonshot และ Kimi Coding เป็นผู้ให้บริการคนละราย คีย์ไม่สามารถใช้แทนกันได้ เอ็นด์พอยต์แตกต่างกัน และการอ้างอิงโมเดลแตกต่างกัน (Moonshot ใช้ `moonshot/...` ส่วน Kimi Coding ใช้ `kimi-coding/...`).

## Config snippet (Moonshot API)

```json5
{
  env: { MOONSHOT_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "moonshot/kimi-k2.5" },
      models: {
        // moonshot-kimi-k2-aliases:start
        "moonshot/kimi-k2.5": { alias: "Kimi K2.5" },
        "moonshot/kimi-k2-0905-preview": { alias: "Kimi K2" },
        "moonshot/kimi-k2-turbo-preview": { alias: "Kimi K2 Turbo" },
        "moonshot/kimi-k2-thinking": { alias: "Kimi K2 Thinking" },
        "moonshot/kimi-k2-thinking-turbo": { alias: "Kimi K2 Thinking Turbo" },
        // moonshot-kimi-k2-aliases:end
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        models: [
          // moonshot-kimi-k2-models:start
          {
            id: "kimi-k2.5",
            name: "Kimi K2.5",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          {
            id: "kimi-k2-0905-preview",
            name: "Kimi K2 0905 Preview",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          {
            id: "kimi-k2-turbo-preview",
            name: "Kimi K2 Turbo",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          {
            id: "kimi-k2-thinking",
            name: "Kimi K2 Thinking",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          {
            id: "kimi-k2-thinking-turbo",
            name: "Kimi K2 Thinking Turbo",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          // moonshot-kimi-k2-models:end
        ],
      },
    },
  },
}
```

## Kimi Coding

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "kimi-coding/k2p5" },
      models: {
        "kimi-coding/k2p5": { alias: "Kimi K2.5" },
      },
    },
  },
}
```

## Notes

- การอ้างอิงโมเดลของ Moonshot ใช้ `moonshot/<modelId>` การอ้างอิงโมเดลของ Moonshot ใช้ `moonshot/<modelId>` การอ้างอิงโมเดลของ Kimi Coding ใช้ `kimi-coding/<modelId>`.
- สามารถแทนที่ข้อมูลราคาและเมทาดาทาคอนเท็กซ์ใน `models.providers` ได้หากจำเป็น
- หาก Moonshot เผยแพร่ขีดจำกัดคอนเท็กซ์ที่แตกต่างกันสำหรับโมเดลใด ให้ปรับ
  `contextWindow` ให้สอดคล้อง
- ใช้ `https://api.moonshot.ai/v1` สำหรับเอ็นด์พอยต์สากล และ `https://api.moonshot.cn/v1` สำหรับเอ็นด์พอยต์ประเทศจีน
