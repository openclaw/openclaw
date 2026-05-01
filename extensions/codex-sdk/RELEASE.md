# Release Notes

## Repository

Recommended public repository name:

```text
openclaw-codex-sdk
```

Recommended description:

```text
Native OpenClaw Codex runtime powered by @openai/codex-sdk.
```

Recommended topics:

```text
openclaw, codex, codex-sdk, acp, mcp, agent-runtime
```

## OpenClaw PR Draft

Title:

```text
Add native Codex SDK runtime plugin
```

Body:

```markdown
## Summary

- Adds a standalone `codex-sdk` plugin powered by `@openai/codex-sdk`.
- Registers a first-class `codex-sdk` ACP backend with Codex route aliases.
- Adds Codex CLI, chat command, Gateway RPC, Control UI, session replay/export,
  proposal inbox, compatibility, and smoke-test surfaces.
- Adds an MCP backchannel so Codex can read OpenClaw status, create proposals,
  and call explicitly allowlisted Gateway methods.

## Verification

- `pnpm exec tsgo --noEmit`
- `pnpm exec vitest run extensions/codex-sdk/src/*.test.ts src/commands/agent.acp.test.ts src/gateway/method-scopes.test.ts src/gateway/server-methods/chat.directive-tags.test.ts ui/src/ui/views/codex.test.ts`
- `pnpm smoke:codex-sdk`
- `OPENCLAW_CODEX_LIVE_SMOKE=1 pnpm smoke:codex-sdk`
- Manual Control UI proof: `/codex` shows `codex/default` with effective model/reasoning and live session records.

## Notes

Codex authentication stays with Codex. Operators run `codex login` once; OpenClaw
does not run a second OpenAI Codex OAuth flow for the plugin unless `apiKeyEnv`
is intentionally configured.
```

## X Announcement Draft

```text
Built a native Codex runtime for OpenClaw.

It uses @openai/codex-sdk, adds a first-class codex-sdk ACP backend, persistent Codex sessions, Control UI + CLI + Gateway surfaces, route/model visibility, replay/export, proposal inbox execution, and an MCP backchannel so Codex and OpenClaw can talk both ways.

Standalone, public, and built so anyone running OpenClaw can make Codex feel native.
```
