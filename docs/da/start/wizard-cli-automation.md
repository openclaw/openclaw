---
summary: "Scriptbaseret introduktion og agentopsætning for OpenClaw CLI"
read_when:
  - Du automatiserer introduktion i scripts eller CI
  - Du har brug for ikke-interaktive eksempler for specifikke udbydere
title: "CLI-automatisering"
sidebarTitle: "CLI automation"
x-i18n:
  source_path: start/wizard-cli-automation.md
  source_hash: 5b5463359a87cfe6
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:40Z
---

# CLI-automatisering

Brug `--non-interactive` til at automatisere `openclaw onboard`.

<Note>
`--json` indebærer ikke ikke-interaktiv tilstand. Brug `--non-interactive` (og `--workspace`) til scripts.
</Note>

## Grundlæggende ikke-interaktivt eksempel

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

Tilføj `--json` for et maskinlæsbart resumé.

## Udbyderspecifikke eksempler

<AccordionGroup>
  <Accordion title="Gemini-eksempel">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI-eksempel">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI Gateway-eksempel">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI Gateway-eksempel">
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
  <Accordion title="Moonshot-eksempel">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Syntetisk eksempel">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode Zen-eksempel">
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

## Tilføj en anden agent

Brug `openclaw agents add <name>` til at oprette en separat agent med sit eget workspace,
sessioner og autentificeringsprofiler. Kørsel uden `--workspace` starter opsætningsguiden.

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

Det sætter:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

Noter:

- Standard-workspaces følger `~/.openclaw/workspace-<agentId>`.
- Tilføj `bindings` for at route indgående beskeder (opsætningsguiden kan gøre dette).
- Ikke-interaktive flag: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## Relaterede dokumenter

- Introduktionshub: [Onboarding Wizard (CLI)](/start/wizard)
- Fuld reference: [CLI Onboarding Reference](/start/wizard-cli-reference)
- Kommandoreference: [`openclaw onboard`](/cli/onboard)
