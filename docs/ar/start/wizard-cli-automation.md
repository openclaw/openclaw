---
summary: "التهيئة الأولية المُبرمجة وإعداد الوكيل لـ OpenClaw CLI"
read_when:
  - "أنت تُؤتمت التهيئة الأولية في السكربتات أو CI"
  - "تحتاج إلى أمثلة غير تفاعلية لموفّرين محددين"
title: "أتمتة CLI"
sidebarTitle: "CLI automation"
x-i18n:
  source_path: start/wizard-cli-automation.md
  source_hash: 5b5463359a87cfe6
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:43Z
---

# أتمتة CLI

استخدم `--non-interactive` لأتمتة `openclaw onboard`.

<Note>
`--json` لا يعني الوضع غير التفاعلي. استخدم `--non-interactive` (و`--workspace`) للسكربتات.
</Note>

## مثال أساسي غير تفاعلي

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

أضِف `--json` للحصول على ملخّص قابل للقراءة آليًا.

## أمثلة خاصة بالموفّر

<AccordionGroup>
  <Accordion title="مثال Gemini">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="مثال Z.AI">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="مثال Vercel AI Gateway">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="مثال Cloudflare AI Gateway">
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
  <Accordion title="مثال Moonshot">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="مثال Synthetic">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="مثال OpenCode Zen">
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

## إضافة وكيل آخر

استخدم `openclaw agents add <name>` لإنشاء وكيل منفصل بمساحة عمل خاصة به،
وجلسات، وملفات تعريف مصادقة. التشغيل دون `--workspace` يطلق معالج الإعداد.

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

ما الذي يضبطه:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

ملاحظات:

- تتبع مساحات العمل الافتراضية `~/.openclaw/workspace-<agentId>`.
- أضِف `bindings` لتوجيه الرسائل الواردة (يمكن لمعالج الإعداد القيام بذلك).
- أعلام الوضع غير التفاعلي: `--model`، `--agent-dir`، `--bind`، `--non-interactive`.

## مستندات ذات صلة

- مركز التهيئة الأولية: [Onboarding Wizard (CLI)](/start/wizard)
- المرجع الكامل: [CLI Onboarding Reference](/start/wizard-cli-reference)
- مرجع الأوامر: [`openclaw onboard`](/cli/onboard)
