---
title: "Cloudflare AI Gateway"
summary: "การตั้งค่าCloudflare AI Gateway(การยืนยันตัวตน+การเลือกโมเดล)"
read_when:
  - คุณต้องการใช้Cloudflare AI GatewayกับOpenClaw
  - คุณต้องการaccount ID, gateway IDหรือAPI key env var
---

# Cloudflare AI Gateway

Cloudflare AI Gatewayทำหน้าที่อยู่หน้าสุดของAPIจากผู้ให้บริการและช่วยให้คุณเพิ่มการวิเคราะห์ การแคช และการควบคุมต่างๆสำหรับAnthropicนั้นOpenClawจะใช้Anthropic Messages APIผ่านGateway endpointของคุณ For Anthropic, OpenClaw uses the Anthropic Messages API through your Gateway endpoint.

- Provider: `cloudflare-ai-gateway`
- Base URL: `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`
- Default model: `cloudflare-ai-gateway/claude-sonnet-4-5`
- API key: `CLOUDFLARE_AI_GATEWAY_API_KEY`(คีย์APIของผู้ให้บริการของคุณสำหรับคำขอที่ส่งผ่านGateway)

สำหรับโมเดลAnthropicให้ใช้Anthropic API keyของคุณ

## เริ่มต้นอย่างรวดเร็ว

1. ตั้งค่าAPI keyของผู้ให้บริการและรายละเอียดGateway:

```bash
openclaw onboard --auth-choice cloudflare-ai-gateway-api-key
```

2. ตั้งค่าโมเดลเริ่มต้น:

```json5
{
  agents: {
    defaults: {
      model: { primary: "cloudflare-ai-gateway/claude-sonnet-4-5" },
    },
  },
}
```

## ตัวอย่างแบบไม่โต้ตอบ

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice cloudflare-ai-gateway-api-key \
  --cloudflare-ai-gateway-account-id "your-account-id" \
  --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
  --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY"
```

## Gatewayที่มีการยืนยันตัวตน

หากคุณเปิดใช้งานการยืนยันตัวตนของGatewayในCloudflareให้เพิ่มเฮดเดอร์`cf-aig-authorization`(ซึ่งเป็นส่วนเพิ่มเติมจากAPI keyของผู้ให้บริการของคุณ)

```json5
{
  models: {
    providers: {
      "cloudflare-ai-gateway": {
        headers: {
          "cf-aig-authorization": "Bearer <cloudflare-ai-gateway-token>",
        },
      },
    },
  },
}
```

## หมายเหตุด้านสภาพแวดล้อม

หากGatewayทำงานเป็นdaemon(launchd/systemd)ให้ตรวจสอบว่า`CLOUDFLARE_AI_GATEWAY_API_KEY`พร้อมใช้งานสำหรับโปรเซสนั้น(ตัวอย่างเช่นใน`~/.openclaw/.env`หรือผ่าน`env.shellEnv`)
