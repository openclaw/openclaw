---
summary: "Gescripte onboarding en agentinstallatie voor de OpenClaw CLI"
read_when:
  - Je automatiseert onboarding in scripts of CI
  - Je hebt niet-interactieve voorbeelden nodig voor specifieke providers
title: "CLI-automatisering"
sidebarTitle: "CLI automation"
---

# CLI-automatisering

Gebruik `--non-interactive` om `openclaw onboard` te automatiseren.

<Note>
`--json` impliceert geen niet-interactieve modus. Gebruik `--non-interactive` (en `--workspace`) voor scripts.
</Note>

## Basis niet-interactief voorbeeld

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

Voeg `--json` toe voor een machineleesbare samenvatting.

## Providerspecifieke voorbeelden

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

## Nog een agent toevoegen

Gebruik `openclaw agents add <name>` om een afzonderlijke agent te maken met een eigen werkruimte,
sessies en authenticatieprofielen. Uitvoeren zonder `--workspace` start de wizard.

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

Wat het instelt:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

Notities:

- Standaardwerkruimtes volgen `~/.openclaw/workspace-<agentId>`.
- Voeg `bindings` toe om inkomende berichten te routeren (de wizard kan dit doen).
- Niet-interactieve flags: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## Gerelateerde documentatie

- Onboarding-hub: [Onboarding Wizard (CLI)](/start/wizard)
- Volledige referentie: [CLI Onboarding Reference](/start/wizard-cli-reference)
- Opdrachtenreferentie: [`openclaw onboard`](/cli/onboard)
