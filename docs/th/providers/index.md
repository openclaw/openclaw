---
summary: "ผู้ให้บริการโมเดล(LLMs)ที่ OpenClaw รองรับ"
read_when:
  - คุณต้องการเลือกผู้ให้บริการโมเดล
  - คุณต้องการภาพรวมอย่างรวดเร็วของแบ็กเอนด์LLMที่รองรับ
title: "ผู้ให้บริการโมเดล"
---

# ผู้ให้บริการโมเดล

OpenClaw สามารถใช้ผู้ให้บริการ LLM ได้หลายราย OpenClawสามารถใช้ผู้ให้บริการLLMได้หลายราย เลือกผู้ให้บริการ ทำการยืนยันตัวตน จากนั้นตั้งค่า
โมเดลเริ่มต้นเป็น `provider/model`.

กำลังมองหาเอกสารช่องทางแชต(WhatsApp/Telegram/Discord/Slack/Mattermost(ปลั๊กอิน)/ฯลฯ)? ดูที่ [Channels](/channels).

## ไฮไลต์: Venice(Venice AI)

Veniceคือการตั้งค่า Venice AI ที่เราแนะนำสำหรับการประมวลผลที่คำนึงถึงความเป็นส่วนตัวเป็นหลัก พร้อมตัวเลือกในการใช้ Opus สำหรับงานที่ยาก

- ค่าเริ่มต้น: `venice/llama-3.3-70b`
- ดีที่สุดโดยรวม: `venice/claude-opus-45` (Opusยังคงแข็งแกร่งที่สุด)

ดูที่ [Venice AI](/providers/venice).

## เริ่มต้นอย่างรวดเร็ว

1. ยืนยันตัวตนกับผู้ให้บริการ(โดยปกติผ่าน `openclaw onboard`).
2. ตั้งค่าโมเดลเริ่มต้น:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## เอกสารผู้ให้บริการ

- [OpenAI (API + Codex)](/providers/openai)
- [Anthropic (API + Claude Code CLI)](/providers/anthropic)
- [Qwen (OAuth)](/providers/qwen)
- [OpenRouter](/providers/openrouter)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
- [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
- [OpenCode Zen](/providers/opencode)
- [Amazon Bedrock](/providers/bedrock)
- [Z.AI](/providers/zai)
- [Xiaomi](/providers/xiaomi)
- [GLM models](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice (Venice AI, เน้นความเป็นส่วนตัว)](/providers/venice)
- [Ollama (โมเดลภายในเครื่อง)](/providers/ollama)
- [Qianfan](/providers/qianfan)

## ผู้ให้บริการถอดเสียง

- [Deepgram (การถอดเสียงจากเสียง)](/providers/deepgram)

## เครื่องมือจากชุมชน

- [Claude Max API Proxy](/providers/claude-max-api-proxy) - ใช้การสมัครสมาชิก Claude Max/Pro เป็นเอ็นด์พอยต์APIที่เข้ากันได้กับ OpenAI

สำหรับแคตตาล็อกผู้ให้บริการทั้งหมด(xAI, Groq, Mistral, ฯลฯ)และการกำหนดค่าขั้นสูง
ดูที่ [Model providers](/concepts/model-providers). และการกำหนดค่าขั้นสูง ดูที่ [Model providers](/concepts/model-providers)
