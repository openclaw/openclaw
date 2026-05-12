---
summary: "Developer workflow for OpenClaw embedded agent runtime changes"
title: "Embedded agent runtime development workflow"
read_when:
  - Working on embedded agent runtime code or tests
  - Running agent runtime lint, typecheck, and live test flows
---

A sane workflow for working on OpenClaw's embedded agent runtime. Some files and
tests still use historical `pi-*` names because the runtime imports selected
upstream Pi packages, but session state, transcripts, tools, prompts, and
persistence are OpenClaw-owned.

## Type checking and linting

- Default local gate: `pnpm check`
- Build gate: `pnpm build` when the change can affect build output, packaging, or lazy-loading/module boundaries
- Full landing gate for broad agent-runtime changes: `pnpm check && pnpm test`

## Running embedded runtime tests

Run the focused runtime test set through the repo test wrapper:

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

This covers the main embedded runtime unit suites:

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
- `state/openclaw.sqlite#table/auth_profile_stores/<agentDir>` for model auth profiles (API keys + OAuth)
- `credentials/` for provider/channel state that still lives outside the auth profile store
- `state/openclaw.sqlite` for shared gateway state, device/pairing state, and push registration state
- `agents/<agentId>/agent/openclaw-agent.sqlite` for agent session history, transcript events, VFS scratch state, and artifacts
- `agents/<agentId>/sessions/` or `sessions/` only if you are clearing legacy imports/debug exports
- `workspace/` if you want a blank workspace

If you only want to reset sessions, delete
`agents/<agentId>/agent/openclaw-agent.sqlite` for that agent after stopping the
gateway. If you want to keep auth, leave `state/openclaw.sqlite` and any
provider state under `credentials/` in place.

## References

- [Testing](/help/testing)
- [Getting Started](/start/getting-started)

## Related

- [Embedded agent runtime architecture](/pi)
