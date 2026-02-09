---
title: "Vercel AI Gateway"
summary: "การตั้งค่าVercel AI Gateway(การยืนยันตัวตน+การเลือกโมเดล)"
read_when:
  - คุณต้องการใช้Vercel AI GatewayกับOpenClaw
  - คุณต้องการตัวแปรสภาพแวดล้อมคีย์APIหรือทางเลือกการยืนยันตัวตนผ่านCLI
---

# Vercel AI Gateway

[Vercel AI Gateway](https://vercel.com/ai-gateway) ให้APIแบบรวมศูนย์เพื่อเข้าถึงโมเดลหลายร้อยรายการผ่านเอ็นด์พอยต์เดียว

- ผู้ให้บริการ: `vercel-ai-gateway`
- การยืนยันตัวตน: `AI_GATEWAY_API_KEY`
- API: เข้ากันได้กับAnthropic Messages

## เริ่มต้นอย่างรวดเร็ว

1. ตั้งค่าคีย์API(แนะนำ: จัดเก็บไว้สำหรับGateway):

```bash
openclaw onboard --auth-choice ai-gateway-api-key
```

2. ตั้งค่าโมเดลเริ่มต้น:

```json5
{
  agents: {
    defaults: {
      model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
    },
  },
}
```

## ตัวอย่างแบบไม่โต้ตอบ

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice ai-gateway-api-key \
  --ai-gateway-api-key "$AI_GATEWAY_API_KEY"
```

## หมายเหตุด้านสภาพแวดล้อม

หากGatewayทำงานเป็นเดมอน(launchd/systemd) ให้ตรวจสอบว่า `AI_GATEWAY_API_KEY`
พร้อมใช้งานสำหรับโปรเซสนั้น(เช่น ใน `~/.openclaw/.env` หรือผ่าน
`env.shellEnv`)
