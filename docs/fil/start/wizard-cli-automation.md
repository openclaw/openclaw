---
summary: "Scripted na onboarding at setup ng agent para sa OpenClaw CLI"
read_when:
  - Nag-a-automate ka ng onboarding sa mga script o CI
  - Kailangan mo ng mga non-interactive na halimbawa para sa mga partikular na provider
title: "CLI Automation"
sidebarTitle: "CLI automation"
x-i18n:
  source_path: start/wizard-cli-automation.md
  source_hash: 5b5463359a87cfe6
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:55Z
---

# CLI Automation

Gamitin ang `--non-interactive` para i-automate ang `openclaw onboard`.

<Note>
Hindi ipinapahiwatig ng `--json` ang non-interactive mode. Gamitin ang `--non-interactive` (at `--workspace`) para sa mga script.
</Note>

## Baseline na non-interactive na halimbawa

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

Magdagdag ng `--json` para sa isang machine-readable na buod.

## Mga halimbawa na partikular sa provider

<AccordionGroup>
  <Accordion title="Halimbawa ng Gemini">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Halimbawa ng Z.AI">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Halimbawa ng Vercel AI Gateway">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Halimbawa ng Cloudflare AI Gateway">
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
  <Accordion title="Halimbawa ng Moonshot">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Halimbawa ng Synthetic">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Halimbawa ng OpenCode Zen">
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

## Magdagdag ng isa pang agent

Gamitin ang `openclaw agents add <name>` para lumikha ng hiwalay na agent na may sarili nitong workspace,
mga session, at mga auth profile. Ang pagtakbo nang walang `--workspace` ay maglulunsad ng wizard.

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

Ano ang ise-set nito:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

Mga tala:

- Ang mga default na workspace ay sumusunod sa `~/.openclaw/workspace-<agentId>`.
- Magdagdag ng `bindings` para i-route ang mga papasok na mensahe (kaya rin ito ng wizard).
- Mga non-interactive na flag: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## Kaugnay na docs

- Onboarding hub: [Onboarding Wizard (CLI)](/start/wizard)
- Buong reference: [CLI Onboarding Reference](/start/wizard-cli-reference)
- Reference ng command: [`openclaw onboard`](/cli/onboard)
