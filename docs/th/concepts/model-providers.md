---
summary: "ภาพรวมผู้ให้บริการโมเดลพร้อมคอนฟิกตัวอย่างและโฟลว์ CLI"
read_when:
  - คุณต้องการเอกสารอ้างอิงการตั้งค่าโมเดลแยกตามผู้ให้บริการ
  - คุณต้องการตัวอย่างคอนฟิกหรือคำสั่ง CLI สำหรับเริ่มต้นใช้งานผู้ให้บริการโมเดล
title: "ผู้ให้บริการโมเดล"
---

# ผู้ให้บริการโมเดล

หน้านี้ครอบคลุม **ผู้ให้บริการ LLM/โมเดล** (ไม่ใช่ช่องทางแชตอย่าง WhatsApp/Telegram)
สำหรับกฎการเลือกโมเดล ดูที่ [/concepts/models](/concepts/models)
For model selection rules, see [/concepts/models](/concepts/models).

## กฎแบบย่อ

- การอ้างอิงโมเดลใช้ `provider/model` (ตัวอย่าง: `opencode/claude-opus-4-6`)
- หากตั้งค่า `agents.defaults.models` จะกลายเป็นรายการอนุญาต
- ตัวช่วย CLI: `openclaw onboard`, `openclaw models list`, `openclaw models set <provider/model>`

## ผู้ให้บริการที่มีมาให้ (แคตตาล็อก pi‑ai)

OpenClaw ships with the pi‑ai catalog. OpenClaw มาพร้อมแคตตาล็อก pi‑ai ผู้ให้บริการเหล่านี้ **ไม่ต้อง**
ตั้งค่า `models.providers`; เพียงตั้งค่าการยืนยันตัวตนและเลือกโมเดล

### OpenAI

- ผู้ให้บริการ: `openai`
- การยืนยันตัวตน: `OPENAI_API_KEY`
- โมเดลตัวอย่าง: `openai/gpt-5.1-codex`
- CLI: `openclaw onboard --auth-choice openai-api-key`

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

### Anthropic

- ผู้ให้บริการ: `anthropic`
- การยืนยันตัวตน: `ANTHROPIC_API_KEY` หรือ `claude setup-token`
- โมเดลตัวอย่าง: `anthropic/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice token` (วาง setup-token) หรือ `openclaw models auth paste-token --provider anthropic`

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

### OpenAI Code (Codex)

- ผู้ให้บริการ: `openai-codex`
- การยืนยันตัวตน: OAuth (ChatGPT)
- โมเดลตัวอย่าง: `openai-codex/gpt-5.3-codex`
- CLI: `openclaw onboard --auth-choice openai-codex` หรือ `openclaw models auth login --provider openai-codex`

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

### OpenCode Zen

- ผู้ให้บริการ: `opencode`
- การยืนยันตัวตน: `OPENCODE_API_KEY` (หรือ `OPENCODE_ZEN_API_KEY`)
- โมเดลตัวอย่าง: `opencode/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice opencode-zen`

```json5
{
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

### Google Gemini (API key)

- ผู้ให้บริการ: `google`
- การยืนยันตัวตน: `GEMINI_API_KEY`
- โมเดลตัวอย่าง: `google/gemini-3-pro-preview`
- CLI: `openclaw onboard --auth-choice gemini-api-key`

### Google Vertex, Antigravity และ Gemini CLI

- ผู้ให้บริการ: `google-vertex`, `google-antigravity`, `google-gemini-cli`
- การยืนยันตัวตน: Vertex ใช้ gcloud ADC; Antigravity/Gemini CLI ใช้โฟลว์ยืนยันตัวตนของแต่ละรายการ
- OAuth ของ Antigravity ถูกจัดส่งเป็นปลั๊กอินแบบรวม (`google-antigravity-auth`, ปิดใช้งานเป็นค่าเริ่มต้น)
  - เปิดใช้งาน: `openclaw plugins enable google-antigravity-auth`
  - เข้าสู่ระบบ: `openclaw models auth login --provider google-antigravity --set-default`
- OAuth ของ Gemini CLI ถูกจัดส่งเป็นปลั๊กอินแบบรวม (`google-gemini-cli-auth`, ปิดใช้งานเป็นค่าเริ่มต้น)
  - เปิดใช้งาน: `openclaw plugins enable google-gemini-cli-auth`
  - เข้าสู่ระบบ: `openclaw models auth login --provider google-gemini-cli --set-default`
  - หมายเหตุ: คุณ **ไม่ต้อง** วาง client id หรือ secret ลงใน `openclaw.json` โฟลว์การเข้าสู่ระบบของ CLI จะจัดเก็บโทเคนไว้ในโปรไฟล์การยืนยันตัวตนบนโฮสต์Gateway The CLI login flow stores
    tokens in auth profiles on the gateway host.

### Z.AI (GLM)

- ผู้ให้บริการ: `zai`
- การยืนยันตัวตน: `ZAI_API_KEY`
- โมเดลตัวอย่าง: `zai/glm-4.7`
- CLI: `openclaw onboard --auth-choice zai-api-key`
  - ชื่อเรียกแทน: `z.ai/*` และ `z-ai/*` จะถูกปรับให้เป็น `zai/*`

### Vercel AI Gateway

- ผู้ให้บริการ: `vercel-ai-gateway`
- การยืนยันตัวตน: `AI_GATEWAY_API_KEY`
- โมเดลตัวอย่าง: `vercel-ai-gateway/anthropic/claude-opus-4.6`
- CLI: `openclaw onboard --auth-choice ai-gateway-api-key`

### ผู้ให้บริการที่มีมาให้อื่นๆ

- OpenRouter: `openrouter` (`OPENROUTER_API_KEY`)
- โมเดลตัวอย่าง: `openrouter/anthropic/claude-sonnet-4-5`
- xAI: `xai` (`XAI_API_KEY`)
- Groq: `groq` (`GROQ_API_KEY`)
- Cerebras: `cerebras` (`CEREBRAS_API_KEY`)
  - โมเดล GLM บน Cerebras ใช้ไอดี `zai-glm-4.7` และ `zai-glm-4.6`
  - base URL ที่เข้ากันได้กับ OpenAI: `https://api.cerebras.ai/v1`
- Mistral: `mistral` (`MISTRAL_API_KEY`)
- GitHub Copilot: `github-copilot` (`COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`)

## ผู้ให้บริการผ่าน `models.providers` (URL แบบกำหนดเอง/ฐาน)

ใช้ `models.providers` (หรือ `models.json`) เพื่อเพิ่มผู้ให้บริการ **แบบกำหนดเอง**
หรือพร็อกซีที่เข้ากันได้กับ OpenAI/Anthropic

### Moonshot AI (Kimi)

Moonshot ใช้เอ็นด์พอยต์ที่เข้ากันได้กับ OpenAI ดังนั้นให้ตั้งค่าเป็นผู้ให้บริการแบบกำหนดเอง:

- ผู้ให้บริการ: `moonshot`
- การยืนยันตัวตน: `MOONSHOT_API_KEY`
- โมเดลตัวอย่าง: `moonshot/kimi-k2.5`

ไอดีโมเดล Kimi K2:

{/_moonshot-kimi-k2-model-refs:start_/ && null}

- `moonshot/kimi-k2.5`
- `moonshot/kimi-k2-0905-preview`
- `moonshot/kimi-k2-turbo-preview`
- `moonshot/kimi-k2-thinking`
- `moonshot/kimi-k2-thinking-turbo`
  {/_moonshot-kimi-k2-model-refs:end_/ && null}

```json5
{
  agents: {
    defaults: { model: { primary: "moonshot/kimi-k2.5" } },
  },
  models: {
    mode: "merge",
    providers: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        models: [{ id: "kimi-k2.5", name: "Kimi K2.5" }],
      },
    },
  },
}
```

### Kimi Coding

Kimi Coding ใช้เอ็นด์พอยต์ที่เข้ากันได้กับ Anthropic ของ Moonshot AI:

- ผู้ให้บริการ: `kimi-coding`
- การยืนยันตัวตน: `KIMI_API_KEY`
- โมเดลตัวอย่าง: `kimi-coding/k2p5`

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: { model: { primary: "kimi-coding/k2p5" } },
  },
}
```

### Qwen OAuth (ฟรี)

Qwen ให้การเข้าถึงแบบ OAuth สำหรับ Qwen Coder + Vision ผ่านโฟลว์ device-code
ให้เปิดใช้งานปลั๊กอินแบบรวม แล้วเข้าสู่ระบบ:
Enable the bundled plugin, then log in:

```bash
openclaw plugins enable qwen-portal-auth
openclaw models auth login --provider qwen-portal --set-default
```

การอ้างอิงโมเดล:

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

ดู [/providers/qwen](/providers/qwen) สำหรับรายละเอียดการตั้งค่าและหมายเหตุ

### Synthetic

Synthetic ให้บริการโมเดลที่เข้ากันได้กับ Anthropic ผ่านผู้ให้บริการ `synthetic`:

- ผู้ให้บริการ: `synthetic`
- การยืนยันตัวตน: `SYNTHETIC_API_KEY`
- โมเดลตัวอย่าง: `synthetic/hf:MiniMaxAI/MiniMax-M2.1`
- CLI: `openclaw onboard --auth-choice synthetic-api-key`

```json5
{
  agents: {
    defaults: { model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.1" } },
  },
  models: {
    mode: "merge",
    providers: {
      synthetic: {
        baseUrl: "https://api.synthetic.new/anthropic",
        apiKey: "${SYNTHETIC_API_KEY}",
        api: "anthropic-messages",
        models: [{ id: "hf:MiniMaxAI/MiniMax-M2.1", name: "MiniMax M2.1" }],
      },
    },
  },
}
```

### MiniMax

MiniMax ถูกกำหนดค่าผ่าน `models.providers` เนื่องจากใช้เอ็นด์พอยต์แบบกำหนดเอง:

- MiniMax (เข้ากันได้กับ Anthropic): `--auth-choice minimax-api`
- การยืนยันตัวตน: `MINIMAX_API_KEY`

ดู [/providers/minimax](/providers/minimax) สำหรับรายละเอียดการตั้งค่า ตัวเลือกโมเดล และตัวอย่างคอนฟิก

### Ollama

Ollama เป็นรันไทม์ LLM ภายในเครื่องที่ให้ API ที่เข้ากันได้กับ OpenAI:

- ผู้ให้บริการ: `ollama`
- การยืนยันตัวตน: ไม่ต้องใช้ (เซิร์ฟเวอร์ภายในเครื่อง)
- โมเดลตัวอย่าง: `ollama/llama3.3`
- การติดตั้ง: [https://ollama.ai](https://ollama.ai)

```bash
# Install Ollama, then pull a model:
ollama pull llama3.3
```

```json5
{
  agents: {
    defaults: { model: { primary: "ollama/llama3.3" } },
  },
}
```

Ollama จะถูกตรวจพบโดยอัตโนมัติเมื่อรันภายในเครื่องที่ `http://127.0.0.1:11434/v1` ดู [/providers/ollama](/providers/ollama) สำหรับคำแนะนำโมเดลและการกำหนดค่าแบบกำหนดเอง See [/providers/ollama](/providers/ollama) for model recommendations and custom configuration.

### พร็อกซีภายในเครื่อง (LM Studio, vLLM, LiteLLM ฯลฯ)

ตัวอย่าง (เข้ากันได้กับ OpenAI):

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: { "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" } },
    },
  },
  models: {
    providers: {
      lmstudio: {
        baseUrl: "http://localhost:1234/v1",
        apiKey: "LMSTUDIO_KEY",
        api: "openai-completions",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

หมายเหตุ:

- สำหรับผู้ให้บริการแบบกำหนดเอง `reasoning`, `input`, `cost`, `contextWindow` และ `maxTokens` เป็นตัวเลือกไม่บังคับ
  เมื่อไม่ระบุ OpenClaw จะใช้ค่าเริ่มต้น:
  When omitted, OpenClaw defaults to:
  - `reasoning: false`
  - `input: ["text"]`
  - `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
  - `contextWindow: 200000`
  - `maxTokens: 8192`
- แนะนำ: ตั้งค่าค่าที่ชัดเจนให้ตรงกับข้อจำกัดของพร็อกซี/โมเดลของคุณ

## ตัวอย่าง CLI

```bash
openclaw onboard --auth-choice opencode-zen
openclaw models set opencode/claude-opus-4-6
openclaw models list
```

ดูเพิ่มเติม: [/gateway/configuration](/gateway/configuration) สำหรับตัวอย่างการกำหนดค่าแบบครบถ้วน
