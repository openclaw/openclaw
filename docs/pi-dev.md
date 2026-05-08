---
summary: "Developer workflow for Pi integration: build, test, and live validation"
title: "Pi development workflow"
read_when:
  - Working on Pi integration code or tests
  - Running Pi-specific lint, typecheck, and live test flows
---

A sane workflow for working on the Pi integration in OpenClaw.

## Type checking and linting

- Default local gate: `pnpm check`
- Build gate: `pnpm build` when the change can affect build output, packaging, or lazy-loading/module boundaries
- Full landing gate for Pi-heavy changes: `pnpm check && pnpm test`

## Running Pi tests

Run the Pi-focused test set directly with Vitest:

```bash
pnpm test \
  "src/agents/pi-*.test.ts" \
  "src/agents/pi-embedded-*.test.ts" \
  "src/agents/pi-tools*.test.ts" \
  "src/agents/pi-settings.test.ts" \
  "src/agents/pi-tool-definition-adapter*.test.ts" \
  "src/agents/pi-hooks/**/*.test.ts"
```

To include the live provider exercise:

```bash
OPENCLAW_LIVE_TEST=1 pnpm test src/agents/pi-embedded-runner-extraparams.live.test.ts
```

This covers the main Pi unit suites:

- `src/agents/pi-*.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-hooks/*.test.ts`

## Manual testing

Recommended flow:

- Run the gateway in dev mode:
  - `pnpm gateway:dev`
- Trigger the agent directly:
  - `pnpm openclaw agent --message "Hello" --thinking low`
- Use the TUI for interactive debugging:
  - `pnpm tui`

For tool call behavior, prompt for a `read` or `exec` action so you can see tool streaming and payload handling.

## Clean slate reset

State lives under the OpenClaw state directory. Default is `~/.openclaw`. If `OPENCLAW_STATE_DIR` is set, use that directory instead.

To reset everything:

- `openclaw.json` for config
- `agents/<agentId>/agent/auth-profiles.json` for model auth profiles (API keys + OAuth)
- `credentials/` for provider/channel state that still lives outside the auth profile store
- `state/openclaw.sqlite` for shared gateway state, device/pairing state, and push registration state
- `agents/<agentId>/agent/openclaw-agent.sqlite` for agent session history, transcript events, VFS scratch state, and artifacts
- `agents/<agentId>/sessions/` or `sessions/` only if you are clearing legacy imports/debug exports
- `workspace/` if you want a blank workspace

If you only want to reset sessions, delete `agents/<agentId>/agent/openclaw-agent.sqlite` for that agent after stopping the gateway. If you want to keep auth, leave `agents/<agentId>/agent/auth-profiles.json` and any provider state under `credentials/` in place.

## References

- [Testing](/help/testing)
- [Getting Started](/start/getting-started)

## Related

- [Pi integration architecture](/pi)
