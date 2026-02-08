---
summary: "Paano patakbuhin ang mga test nang lokal (vitest) at kung kailan gagamit ng force/coverage modes"
read_when:
  - Kapag nagpapatakbo o nag-aayos ng mga test
title: "Mga Test"
x-i18n:
  source_path: reference/test.md
  source_hash: 814cc52aae0788eb
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:52Z
---

# Mga Test

- Buong testing kit (suites, live, Docker): [Testing](/help/testing)

- `pnpm test:force`: Pinapatay ang anumang natitirang proseso ng gateway na humahawak sa default control port, pagkatapos ay pinapatakbo ang buong Vitest suite gamit ang isang hiwalay na gateway port para hindi magbanggaan ang mga server test sa isang tumatakbong instance. Gamitin ito kapag ang naunang gateway run ay nag-iwan ng port 18789 na okupado.
- `pnpm test:coverage`: Pinapatakbo ang Vitest na may V8 coverage. Ang mga global threshold ay 70% para sa lines/branches/functions/statements. Hindi kasama sa coverage ang mga entrypoint na mabigat sa integration (CLI wiring, gateway/telegram bridges, webchat static server) para manatiling nakatuon ang target sa lohika na nasusukat sa unit test.
- `pnpm test:e2e`: Pinapatakbo ang gateway end-to-end smoke tests (multi-instance WS/HTTP/node pairing).
- `pnpm test:live`: Pinapatakbo ang provider live tests (minimax/zai). Nangangailangan ng mga API key at `LIVE=1` (o provider-specific na `*_LIVE_TEST=1`) para ma-unskip.

## Bench ng latency ng model (mga lokal na key)

Script: [`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

Paggamit:

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- Opsyonal na env: `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `ANTHROPIC_API_KEY`
- Default na prompt: “Sumagot gamit ang isang salita: ok. Walang bantas o dagdag na teksto.”

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
