---
summary: "„Skriptgesteuertes Onboarding und Agent-Einrichtung für die OpenClaw CLI“"
read_when:
  - Sie automatisieren das Onboarding in Skripten oder CI
  - Sie benötigen nicht‑interaktive Beispiele für bestimmte Anbieter
title: "„CLI‑Automatisierung“"
sidebarTitle: "„CLI‑Automatisierung“"
---

# CLI‑Automatisierung

Verwenden Sie `--non-interactive`, um `openclaw onboard` zu automatisieren.

<Note>
`--json` bedeutet nicht den nicht‑interaktiven Modus. Verwenden Sie `--non-interactive` (und `--workspace`) für Skripte.
</Note>

## Basisbeispiel (nicht‑interaktiv)

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

Fügen Sie `--json` für eine maschinenlesbare Zusammenfassung hinzu.

## Anbieter­spezifische Beispiele

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

## Weiteren Agent hinzufügen

Verwenden Sie `openclaw agents add <name>`, um einen separaten Agenten mit eigenem Workspace,
Sitzungen und Auth‑Profilen zu erstellen. Das Ausführen ohne `--workspace` startet den Assistenten.

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

Was gesetzt wird:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

Hinweise:

- Standard‑Workspaces folgen `~/.openclaw/workspace-<agentId>`.
- Fügen Sie `bindings` hinzu, um eingehende Nachrichten zu routen (der Assistent kann dies erledigen).
- Nicht‑interaktive Flags: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## Zugehörige Dokumente

- Onboarding‑Hub: [Onboarding Wizard (CLI)](/start/wizard)
- Vollständige Referenz: [CLI‑Onboarding‑Referenz](/start/wizard-cli-reference)
- Befehlsreferenz: [`openclaw onboard`](/cli/onboard)
