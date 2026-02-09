---
title: "Pi-ontwikkelworkflow"
---

# Pi-ontwikkelworkflow

Deze gids vat een verstandige workflow samen voor het werken aan de Pi-integratie in OpenClaw.

## Typecontrole en linting

- Typecontrole en build: `pnpm build`
- Lint: `pnpm lint`
- Formaatcontrole: `pnpm format`
- Volledige gate vóór het pushen: `pnpm lint && pnpm build && pnpm test`

## Pi-tests uitvoeren

Gebruik het speciale script voor de Pi-integratietestset:

```bash
scripts/pi/run-tests.sh
```

Om de live test op te nemen die echt provider-gedrag test:

```bash
scripts/pi/run-tests.sh --live
```

Het script voert alle Pi-gerelateerde unit tests uit via deze globs:

- `src/agents/pi-*.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-extensions/*.test.ts`

## Handmatig testen

Aanbevolen flow:

- Start de Gateway in dev-modus:
  - `pnpm gateway:dev`
- Trigger de agent direct:
  - `pnpm openclaw agent --message "Hello" --thinking low`
- Gebruik de TUI voor interactieve debugging:
  - `pnpm tui`

Voor tool-aanroepgedrag, prompt om een `read`- of `exec`-actie zodat je toolstreaming en payload-afhandeling kunt zien.

## Reset naar een schone lei

Status staat onder de OpenClaw-statusdirectory. Standaard is dit `~/.openclaw`. Als `OPENCLAW_STATE_DIR` is ingesteld, gebruik dan die directory.

Om alles te resetten:

- `openclaw.json` voor config
- `credentials/` voor auth-profielen en tokens
- `agents/<agentId>/sessions/` voor agent-sessiegeschiedenis
- `agents/<agentId>/sessions.json` voor de sessie-index
- `sessions/` als legacy paden bestaan
- `workspace/` als je een lege werkruimte wilt

Als je alleen sessies wilt resetten, verwijder dan `agents/<agentId>/sessions/` en `agents/<agentId>/sessions.json` voor die agent. Behoud `credentials/` als je niet opnieuw wilt authenticeren.

## Referenties

- [https://docs.openclaw.ai/testing](https://docs.openclaw.ai/testing)
- [https://docs.openclaw.ai/start/getting-started](https://docs.openclaw.ai/start/getting-started)
