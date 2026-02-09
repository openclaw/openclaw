---
summary: "Hoe je tests lokaal uitvoert (vitest) en wanneer je force-/coverage-modi gebruikt"
read_when:
  - Tests uitvoeren of oplossen
title: "Tests"
---

# Tests

- Volledige testkit (suites, live, Docker): [Testing](/help/testing)

- `pnpm test:force`: Beëindigt alle achterblijvende gateway-processen die de standaard control-poort bezet houden en voert vervolgens de volledige Vitest-suite uit met een geïsoleerde gateway-poort, zodat servertests niet botsen met een draaiende instantie. Gebruik dit wanneer een eerdere gateway-run poort 18789 bezet heeft achtergelaten.

- `pnpm test:coverage`: Voert Vitest uit met V8-coverage. Globale drempels zijn 70% voor lines/branches/functions/statements. Coverage sluit integratie-zware entrypoints uit (CLI-wiring, gateway/telegram-bridges, webchat statische server) om de doelstelling te richten op unit-testbare logica.

- `pnpm test:e2e`: Voert gateway end-to-end smoketests uit (multi-instance WS/HTTP/node-koppeling).

- `pnpm test:live`: Voert provider live tests uit (minimax/zai). Vereist API-sleutels en `LIVE=1` (of provider-specifieke `*_LIVE_TEST=1`) om uitgeschakelde tests te activeren.

## Model-latencybench (lokale sleutels)

Script: [`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

Gebruik:

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- Optionele env: `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `ANTHROPIC_API_KEY`
- Standaardprompt: “Antwoord met één woord: ok. Geen leestekens of extra tekst.”

Laatste run (2025-12-31, 20 runs):

- minimax mediaan 1279ms (min 1114, max 2431)
- opus mediaan 2454ms (min 1224, max 3170)

## Onboarding E2E (Docker)

Docker is optioneel; dit is alleen nodig voor gecontaineriseerde onboarding-smoketests.

Volledige cold-start flow in een schone Linux-container:

```bash
scripts/e2e/onboard-docker.sh
```

Dit script stuurt de interactieve wizard aan via een pseudo-tty, verifieert config-/werkruimte-/sessiebestanden en start vervolgens de gateway en voert `openclaw health` uit.

## QR-import smoke (Docker)

Zorgt ervoor dat `qrcode-terminal` laadt onder Node 22+ in Docker:

```bash
pnpm test:docker:qr
```
