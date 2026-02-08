---
summary: "Skriptad introduktion och agentkonfigurering för OpenClaw CLI"
read_when:
  - Du automatiserar introduktion i skript eller CI
  - Du behöver icke-interaktiva exempel för specifika leverantörer
title: "CLI-automatisering"
sidebarTitle: "CLI automation"
x-i18n:
  source_path: start/wizard-cli-automation.md
  source_hash: 5b5463359a87cfe6
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:30Z
---

# CLI-automatisering

Använd `--non-interactive` för att automatisera `openclaw onboard`.

<Note>
`--json` innebär inte icke-interaktivt läge. Använd `--non-interactive` (och `--workspace`) för skript.
</Note>

## Grundläggande icke-interaktivt exempel

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

Lägg till `--json` för en maskinläsbar sammanfattning.

## Leverantörsspecifika exempel

<AccordionGroup>
  <Accordion title="Gemini-exempel">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI-exempel">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI Gateway-exempel">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI Gateway-exempel">
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
  <Accordion title="Moonshot-exempel">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Syntetiskt exempel">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode Zen-exempel">
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

## Lägg till ytterligare en agent

Använd `openclaw agents add <name>` för att skapa en separat agent med egen arbetsyta,
sessioner och autentiseringsprofiler. Att köra utan `--workspace` startar guiden.

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

Vad den ställer in:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

Noteringar:

- Standardarbetsytor följer `~/.openclaw/workspace-<agentId>`.
- Lägg till `bindings` för att routa inkommande meddelanden (guiden kan göra detta).
- Icke-interaktiva flaggor: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## Relaterad dokumentation

- Introduktionsnav: [Introduktionsguide (CLI)](/start/wizard)
- Fullständig referens: [CLI-introduktionsreferens](/start/wizard-cli-reference)
- Kommandoreferens: [`openclaw onboard`](/cli/onboard)
