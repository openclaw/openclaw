---
title: "Pi-utvecklingsarbetsflöde"
x-i18n:
  source_path: pi-dev.md
  source_hash: b6c44672306d8867
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:55Z
---

# Pi-utvecklingsarbetsflöde

Den här guiden sammanfattar ett sunt arbetsflöde för att arbeta med Pi-integrationen i OpenClaw.

## Typkontroll och lintning

- Typkontroll och build: `pnpm build`
- Lint: `pnpm lint`
- Formatkontroll: `pnpm format`
- Full gate innan push: `pnpm lint && pnpm build && pnpm test`

## Köra Pi-tester

Använd det dedikerade skriptet för Pi-integrationens testuppsättning:

```bash
scripts/pi/run-tests.sh
```

För att inkludera live-testet som utövar verkligt leverantörsbeteende:

```bash
scripts/pi/run-tests.sh --live
```

Skriptet kör alla Pi-relaterade enhetstester via dessa globbar:

- `src/agents/pi-*.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-extensions/*.test.ts`

## Manuell testning

Rekommenderat flöde:

- Kör gateway (nätverksgateway) i dev-läge:
  - `pnpm gateway:dev`
- Trigga agenten direkt:
  - `pnpm openclaw agent --message "Hello" --thinking low`
- Använd TUI:n för interaktiv felsökning:
  - `pnpm tui`

För verktygsanropsbeteende, prompta för en `read`- eller `exec`-åtgärd så att du kan se verktygsstreaming och hantering av payload.

## Återställning till tomt läge

Tillstånd lagras under OpenClaws tillståndskatalog. Standard är `~/.openclaw`. Om `OPENCLAW_STATE_DIR` är satt används den katalogen i stället.

För att återställa allt:

- `openclaw.json` för konfig
- `credentials/` för autentiseringsprofiler och token
- `agents/<agentId>/sessions/` för agentsessionshistorik
- `agents/<agentId>/sessions.json` för sessionsindex
- `sessions/` om äldre sökvägar finns
- `workspace/` om du vill ha en tom arbetsyta

Om du bara vill återställa sessioner, ta bort `agents/<agentId>/sessions/` och `agents/<agentId>/sessions.json` för den agenten. Behåll `credentials/` om du inte vill autentisera igen.

## Referenser

- [https://docs.openclaw.ai/testing](https://docs.openclaw.ai/testing)
- [https://docs.openclaw.ai/start/getting-started](https://docs.openclaw.ai/start/getting-started)
