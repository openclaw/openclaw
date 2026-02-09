---
summary: "ผู้ให้บริการโมเดล (LLMs) ที่ OpenClaw รองรับ"
read_when:
  - คุณต้องการเลือกผู้ให้บริการโมเดล
  - คุณต้องการตัวอย่างการตั้งค่าอย่างรวดเร็วสำหรับการยืนยันตัวตน LLM และการเลือกโมเดล
title: "เริ่มต้นอย่างรวดเร็วสำหรับผู้ให้บริการโมเดล"
---

# ผู้ให้บริการโมเดล

OpenClaw สามารถใช้ผู้ให้บริการ LLM ได้หลายราย OpenClaw สามารถใช้งานผู้ให้บริการ LLM ได้หลายราย เลือกหนึ่งราย ทำการยืนยันตัวตน จากนั้นตั้งค่า
โมเดลเริ่มต้นเป็น `provider/model`.

## ไฮไลต์: Venice (Venice AI)

Venice คือการตั้งค่า Venice AI ที่เราแนะนำ สำหรับการประมวลผลแบบคำนึงถึงความเป็นส่วนตัวเป็นหลัก พร้อมตัวเลือกในการใช้ Opus สำหรับงานที่ยากที่สุด

- ค่าเริ่มต้น: `venice/llama-3.3-70b`
- ดีที่สุดโดยรวม: `venice/claude-opus-45` (Opus ยังคงแข็งแกร่งที่สุด)

ดูรายละเอียดได้ที่ [Venice AI](/providers/venice)

## เริ่มต้นอย่างรวดเร็ว (สองขั้นตอน)

1. ยืนยันตัวตนกับผู้ให้บริการ (โดยปกติผ่าน `openclaw onboard`).
2. ตั้งค่าโมเดลเริ่มต้น:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## ผู้ให้บริการที่รองรับ (ชุดเริ่มต้น)

- [OpenAI (API + Codex)](/providers/openai)
- [Anthropic (API + Claude Code CLI)](/providers/anthropic)
- [OpenRouter](/providers/openrouter)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
- [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
- [Synthetic](/providers/synthetic)
- [OpenCode Zen](/providers/opencode)
- [Z.AI](/providers/zai)
- [GLM models](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice (Venice AI)](/providers/venice)
- [Amazon Bedrock](/providers/bedrock)
- [Qianfan](/providers/qianfan)

สำหรับแคตตาล็อกผู้ให้บริการทั้งหมด (xAI, Groq, Mistral ฯลฯ) และการกำหนดค่าขั้นสูง
ดูที่ [Model providers](/concepts/model-providers). และการกำหนดค่าขั้นสูง ดูที่ [Model providers](/concepts/model-providers)
