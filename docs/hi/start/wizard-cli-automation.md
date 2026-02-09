---
summary: "OpenClaw CLI के लिए स्क्रिप्टेड ऑनबोर्डिंग और एजेंट सेटअप"
read_when:
  - आप स्क्रिप्ट या CI में ऑनबोर्डिंग को स्वचालित कर रहे हों
  - आपको विशिष्ट प्रदाताओं के लिए गैर-इंटरैक्टिव उदाहरणों की आवश्यकता हो
title: "CLI स्वचालन"
sidebarTitle: "CLI automation"
---

# CLI स्वचालन

`--non-interactive` का उपयोग करके `openclaw onboard` को स्वचालित करें।

<Note>
`--json` का मतलब non-interactive मोड नहीं होता। स्क्रिप्ट्स के लिए `--non-interactive` (और `--workspace`) का उपयोग करें।
</Note>

## आधारभूत गैर-इंटरैक्टिव उदाहरण

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

मशीन-पठनीय सारांश के लिए `--json` जोड़ें।

## प्रदाता-विशिष्ट उदाहरण

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

## एक और एजेंट जोड़ें

`openclaw agents add <name>` का उपयोग करके एक अलग एजेंट बनाएं, जिसका अपना workspace, sessions और auth profiles हों। `--workspace` के बिना चलाने पर विज़ार्ड लॉन्च होता है।

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

यह क्या सेट करता है:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

नोट्स:

- डिफ़ॉल्ट वर्कस्पेस `~/.openclaw/workspace-<agentId>` का पालन करते हैं।
- इनबाउंड संदेशों को रूट करने के लिए `bindings` जोड़ें (विज़ार्ड यह कर सकता है)।
- गैर-इंटरैक्टिव फ़्लैग्स: `--model`, `--agent-dir`, `--bind`, `--non-interactive`।

## संबंधित दस्तावेज़

- ऑनबोर्डिंग हब: [Onboarding Wizard (CLI)](/start/wizard)
- पूर्ण संदर्भ: [CLI Onboarding Reference](/start/wizard-cli-reference)
- कमांड संदर्भ: [`openclaw onboard`](/cli/onboard)
