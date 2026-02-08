---
title: "Pi-udviklingsworkflow"
x-i18n:
  source_path: pi-dev.md
  source_hash: b6c44672306d8867
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:22Z
---

# Pi-udviklingsworkflow

Denne guide opsummerer et fornuftigt workflow til arbejde med pi-integrationen i OpenClaw.

## Typekontrol og linting

- Typekontrol og build: `pnpm build`
- Lint: `pnpm lint`
- Formatkontrol: `pnpm format`
- Fuld gate før push: `pnpm lint && pnpm build && pnpm test`

## Kørsel af Pi-tests

Brug det dedikerede script til pi-integrationstest-sættet:

```bash
scripts/pi/run-tests.sh
```

For at inkludere live-testen, der afprøver reel udbyderadfærd:

```bash
scripts/pi/run-tests.sh --live
```

Scriptet kører alle pi-relaterede unit-tests via disse globs:

- `src/agents/pi-*.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-extensions/*.test.ts`

## Manuel test

Anbefalet flow:

- Kør gateway i dev-tilstand:
  - `pnpm gateway:dev`
- Trigger agenten direkte:
  - `pnpm openclaw agent --message "Hello" --thinking low`
- Brug TUI’en til interaktiv debugging:
  - `pnpm tui`

For tool call-adfærd kan du prompte efter en `read`- eller `exec`-handling, så du kan se tool-streaming og håndtering af payloads.

## Nulstilling til ren start

Tilstand ligger under OpenClaws state-mappe. Standard er `~/.openclaw`. Hvis `OPENCLAW_STATE_DIR` er sat, bruges den mappe i stedet.

For at nulstille alt:

- `openclaw.json` for konfiguration
- `credentials/` for autentificeringsprofiler og tokens
- `agents/<agentId>/sessions/` for agentens sessionshistorik
- `agents/<agentId>/sessions.json` for sessionsindekset
- `sessions/` hvis ældre stier findes
- `workspace/` hvis du vil have et tomt workspace

Hvis du kun vil nulstille sessioner, så slet `agents/<agentId>/sessions/` og `agents/<agentId>/sessions.json` for den agent. Behold `credentials/`, hvis du ikke vil genautentificere.

## Referencer

- [https://docs.openclaw.ai/testing](https://docs.openclaw.ai/testing)
- [https://docs.openclaw.ai/start/getting-started](https://docs.openclaw.ai/start/getting-started)
