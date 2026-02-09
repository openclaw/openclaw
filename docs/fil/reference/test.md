---
summary: "Paano patakbuhin ang mga test nang lokal (vitest) at kung kailan gagamit ng force/coverage modes"
read_when:
  - Kapag nagpapatakbo o nag-aayos ng mga test
title: "Mga Test"
---

# Mga Test

- Buong testing kit (suites, live, Docker): [Testing](/help/testing)

- `pnpm test:force`: Kills any lingering gateway process holding the default control port, then runs the full Vitest suite with an isolated gateway port so server tests don’t collide with a running instance. Use this when a prior gateway run left port 18789 occupied.

- `pnpm test:coverage`: Runs Vitest with V8 coverage. Global thresholds are 70% lines/branches/functions/statements. Coverage excludes integration-heavy entrypoints (CLI wiring, gateway/telegram bridges, webchat static server) to keep the target focused on unit-testable logic.

- `pnpm test:e2e`: Pinapatakbo ang gateway end-to-end smoke tests (multi-instance WS/HTTP/node pairing).

- `pnpm test:live`: Runs provider live tests (minimax/zai). Requires API keys and `LIVE=1` (or provider-specific `*_LIVE_TEST=1`) to unskip.

## Bench ng latency ng model (mga lokal na key)

Script: [`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

Paggamit:

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- Opsyonal na env: `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `ANTHROPIC_API_KEY`
- Default prompt: “Reply with a single word: ok. No punctuation or extra text.”

Huling run (2025-12-31, 20 run):

- minimax median 1279ms (min 1114, max 2431)
- opus median 2454ms (min 1224, max 3170)

## Onboarding E2E (Docker)

Opsyonal ang Docker; kailangan lang ito para sa mga containerized onboarding smoke test.

Buong cold-start flow sa isang malinis na Linux container:

```bash
scripts/e2e/onboard-docker.sh
```

Pinapatakbo ng script na ito ang interactive wizard sa pamamagitan ng isang pseudo-tty, bine-verify ang mga config/workspace/session file, pagkatapos ay sinisimulan ang gateway at pinapatakbo ang `openclaw health`.

## QR import smoke (Docker)

Tinitiyak na naglo-load ang `qrcode-terminal` sa ilalim ng Node 22+ sa Docker:

```bash
pnpm test:docker:qr
```
