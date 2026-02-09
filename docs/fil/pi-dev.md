---
title: "Workflow ng Pag-develop para sa Pi"
---

# Workflow ng Pag-develop para sa Pi

Ang gabay na ito ay nagbubuod ng isang maayos na workflow para sa pagtatrabaho sa pi integration sa OpenClaw.

## Type Checking at Linting

- Type check at build: `pnpm build`
- Lint: `pnpm lint`
- Format check: `pnpm format`
- Full gate bago mag-push: `pnpm lint && pnpm build && pnpm test`

## Pagpapatakbo ng Mga Pi Test

Gamitin ang nakalaang script para sa pi integration test set:

```bash
scripts/pi/run-tests.sh
```

Upang isama ang live test na sumusubok sa totoong behavior ng provider:

```bash
scripts/pi/run-tests.sh --live
```

Pinapatakbo ng script ang lahat ng pi-related unit test sa pamamagitan ng mga glob na ito:

- `src/agents/pi-*.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-extensions/*.test.ts`

## Manu-manong Testing

Inirerekomendang daloy:

- Patakbuhin ang Gateway sa dev mode:
  - `pnpm gateway:dev`
- I-trigger ang agent nang direkta:
  - `pnpm openclaw agent --message "Hello" --thinking low`
- Gamitin ang TUI para sa interactive debugging:
  - `pnpm tui`

Para sa behavior ng tool call, mag-prompt para sa isang `read` o `exec` na aksyon upang makita mo ang tool streaming at paghawak ng payload.

## Clean Slate Reset

Nakatira ang state sa ilalim ng OpenClaw state directory. Ang default ay `~/.openclaw`. Kung nakatakda ang `OPENCLAW_STATE_DIR`, gamitin ang direktoryong iyon sa halip.

Upang i-reset ang lahat:

- `openclaw.json` para sa config
- `credentials/` para sa mga auth profile at token
- `agents/<agentId>/sessions/` para sa history ng agent session
- `agents/<agentId>/sessions.json` para sa session index
- `sessions/` kung may umiiral na legacy path
- `workspace/` kung gusto mo ng blangkong workspace

Kung ang gusto mo lang ay i‑reset ang mga session, burahin ang `agents/<agentId>/sessions/` at `agents/<agentId>/sessions.json` para sa agent na iyon. Keep `credentials/` if you do not want to reauthenticate.

## Mga Sanggunian

- [https://docs.openclaw.ai/testing](https://docs.openclaw.ai/testing)
- [https://docs.openclaw.ai/start/getting-started](https://docs.openclaw.ai/start/getting-started)
