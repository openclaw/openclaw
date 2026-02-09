---
summary: "Skryptowe wdrażanie i konfiguracja agentów dla CLI OpenClaw"
read_when:
  - Automatyzujesz wdrażanie w skryptach lub CI
  - Potrzebujesz nieinteraktywnych przykładów dla konkretnych dostawców
title: "Automatyzacja CLI"
sidebarTitle: "CLI automation"
---

# Automatyzacja CLI

Użyj `--non-interactive`, aby zautomatyzować `openclaw onboard`.

<Note>
`--json` nie oznacza trybu nieinteraktywnego. Do skryptów użyj `--non-interactive` (oraz `--workspace`).
</Note>

## Podstawowy przykład nieinteraktywny

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

Dodaj `--json`, aby uzyskać podsumowanie czytelne dla maszyn.

## Przykłady specyficzne dla dostawców

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

## Dodawanie kolejnego agenta

Użyj `openclaw agents add <name>`, aby utworzyć osobnego agenta z własnym obszarem roboczym,
sesjami i profilami uwierzytelniania. Uruchomienie bez `--workspace` uruchamia kreatora.

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

Co jest ustawiane:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

Uwagi:

- Domyślne obszary robocze są zgodne z `~/.openclaw/workspace-<agentId>`.
- Dodaj `bindings`, aby kierować wiadomości przychodzące (kreator może to zrobić).
- Flagi nieinteraktywne: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## Powiązana dokumentacja

- Centrum wdrażania: [Kreator wdrażania (CLI)](/start/wizard)
- Pełna referencja: [Referencja wdrażania CLI](/start/wizard-cli-reference)
- Referencja poleceń: [`openclaw onboard`](/cli/onboard)
