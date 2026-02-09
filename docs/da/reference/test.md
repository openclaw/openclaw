---
summary: "Sådan kører du tests lokalt (vitest), og hvornår du skal bruge force-/coverage-tilstande"
read_when:
  - Kørsel eller rettelse af tests
title: "Tests"
---

# Tests

- Fuldt testkit (suiter, live, Docker): [Testing](/help/testing)

- `pnpm test:force`: Dræber enhver dinglende gateway proces holde standard kontrol port, derefter kører den fulde Vitest suite med en isoleret gateway port, så servertest ikke kolliderer med en løbende instans. Brug dette, når en forudgående gateway køre venstre port 18789 optaget.

- `pnpm test:coverage`: Kører Vitest med V8 dækning. Globale tærskler er 70 % linjer/grene / funktioner/udsagn. Dækning udelukker integration-tunge indgangspunkter (CLI ledning, gateway/telegram broer, webchat statisk server) for at holde målet fokuseret på unit-testbar logik.

- `pnpm test:e2e`: Kører gateway end-to-end smoke-tests (multi-instans WS/HTTP/node-parring).

- `pnpm test:live`: Kører udbyder live test (minimax/zai). Kræver API-nøgler og `LIVE=1` (eller udbyder-specifik `*_LIVE_TEST=1`) for at unskippe.

## Model-latenstest (lokale nøgler)

Script: [`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

Brug:

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- Valgfri env: `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `ANTHROPIC_API_KEY`
- Standard prompt: “Svar med et enkelt ord: ok. Ingen tegnsætning eller ekstra tekst.”

Seneste kørsel (2025-12-31, 20 kørsler):

- minimax median 1279 ms (min 1114, maks 2431)
- opus median 2454 ms (min 1224, maks 3170)

## Introduktion E2E (Docker)

Docker er valgfrit; dette er kun nødvendigt for containeriserede introduktions-smoke-tests.

Fuldt cold-start-flow i en ren Linux-container:

```bash
scripts/e2e/onboard-docker.sh
```

Dette script styrer den interaktive opsætningsguide via en pseudo-tty, verificerer konfigurations-/workspace-/sessionsfiler, starter derefter gatewayen og kører `openclaw health`.

## QR-import smoke (Docker)

Sikrer, at `qrcode-terminal` indlæses under Node 22+ i Docker:

```bash
pnpm test:docker:qr
```
