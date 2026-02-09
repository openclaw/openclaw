---
summary: "การเริ่มต้นใช้งานแบบสคริปต์และการตั้งค่าเอเจนต์สำหรับ OpenClaw CLI"
read_when:
  - คุณกำลังทำการเริ่มต้นใช้งานแบบอัตโนมัติในสคริปต์หรือ CI
  - คุณต้องการตัวอย่างแบบไม่โต้ตอบสำหรับผู้ให้บริการเฉพาะ
title: "การทำงานอัตโนมัติของ CLI"
sidebarTitle: "CLI automation"
---

# การทำงานอัตโนมัติของ CLI

ใช้ `--non-interactive` เพื่อทำให้ `openclaw onboard` เป็นอัตโนมัติ

<Note>

`--json` ไม่ได้หมายความว่าเป็นโหมดไม่โต้ตอบ ใช้ `--non-interactive` (และ `--workspace`) สำหรับสคริปต์
 ใช้ `--non-interactive` (และ `--workspace`) สำหรับสคริปต์
</Note>

## ตัวอย่างพื้นฐานแบบไม่โต้ตอบ

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice apiKey \
  --anthropic-api-key "$ANTHROPIC_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback \
  --install-daemon \
  --daemon-runtime node \
  --skip-skills
```

เพิ่ม `--json` เพื่อสรุปผลในรูปแบบที่เครื่องอ่านได้

## ตัวอย่างเฉพาะผู้ให้บริการ

<AccordionGroup>
  <Accordion title="Gemini example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI Gateway example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI Gateway example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice cloudflare-ai-gateway-api-key \
      --cloudflare-ai-gateway-account-id "your-account-id" \
      --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
      --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Moonshot example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Synthetic example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode Zen example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice opencode-zen \
      --opencode-zen-api-key "$OPENCODE_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
</AccordionGroup>

## เพิ่มเอเจนต์อีกหนึ่งตัว

ใช้ `openclaw agents add <name>` เพื่อสร้างเอเจนต์แยกต่างหากที่มีเวิร์กสเปซ เซสชัน และโปรไฟล์การยืนยันตัวตนของตนเอง การรันโดยไม่ใช้ `--workspace` จะเปิดวิซาร์ด การรันโดยไม่ใช้ `--workspace` จะเปิดวิซาร์ด

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

สิ่งที่ตั้งค่าให้:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

หมายเหตุ:

- เวิร์กสเปซค่าเริ่มต้นเป็นไปตาม `~/.openclaw/workspace-<agentId>`.
- เพิ่ม `bindings` เพื่อกำหนดเส้นทางข้อความขาเข้า(วิซาร์ดสามารถทำได้)
- แฟล็กแบบไม่โต้ตอบ: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## เอกสารที่เกี่ยวข้อง

- ศูนย์รวมการเริ่มต้นใช้งาน: [Onboarding Wizard (CLI)](/start/wizard)
- เอกสารอ้างอิงฉบับเต็ม: [CLI Onboarding Reference](/start/wizard-cli-reference)
- เอกสารอ้างอิงคำสั่ง: [`openclaw onboard`](/cli/onboard)
